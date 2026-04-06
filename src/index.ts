/**
 * src/index.ts
 * Self-BOT entry point with ShutdownManager and full bootstrap sequence.
 */
import 'dotenv/config';
import { loadConfig } from './config/index.js';
import { getLogger } from './utils/logger.js';
import { createSessionStore } from './session/store.js';
import { SessionManager } from './session/manager.js';
import { AdapterRegistry } from './adapters/registry.js';
import { TelegramAdapter } from './adapters/telegram/index.js';
import { WhatsAppAdapter } from './adapters/whatsapp/index.js';
import { WebAdapter } from './adapters/website/index.js';
import { MCPToolRegistry } from './mcp/registry.js';
import { MCPServer } from './mcp/server.js';
import { TaskQueue } from './queue/task-queue.js';
import { AgentCore } from './agent/index.js';
import { ProgressReporter } from './agent/progress-reporter.js';
import { OAuthManager } from './auth/index.js';
import { ScrapeWebsiteTool } from './mcp/tools/scrape-website.js';
import { FillFormTool } from './mcp/tools/fill-form.js';
import { LoginAccountTool } from './mcp/tools/login-account.js';
import { RegisterAccountTool } from './mcp/tools/register-account.js';
import { BookAppointmentTool } from './mcp/tools/book-appointment.js';
import { RemoteMCPLoader } from './mcp/remote-loader.js';
import { createMediaService } from './media/index.js';
import {
  appendCapabilityNotice,
  isMediaCapabilityUnavailableError,
  prependCapabilityNotice,
} from './media/index.js';
import { fetchTelegramFile } from './adapters/telegram/file-fetcher.js';
import { waUserId } from './adapters/whatsapp/normalizer.js';
import { GenerateImageTool } from './mcp/tools/generate-image.js';
import { EditImageTool } from './mcp/tools/edit-image.js';
import { TranscribeAudioTool } from './mcp/tools/transcribe-audio.js';
import { SynthesizeSpeechTool } from './mcp/tools/synthesize-speech.js';
import { ReadPDFTool } from './mcp/tools/read-pdf.js';
import { createInterface } from 'node:readline';
import type { UnifiedMessage, UnifiedResponse } from './types/index.js';
import type { FileAttachment } from './types/message.js';
import { GatewayAuth, FileAllowlistStore, MeridianAllowlistStore } from './access/index.js';
import type { IAllowlistStore } from './access/index.js';
import type { MessageHandler } from './adapters/base.js';

// ─── ShutdownManager ──────────────────────────────────────────────────────────
class ShutdownManager {
  private readonly handlers: Array<() => Promise<void>> = [];
  private shutdownInProgress = false;

  register(handler: () => Promise<void>): void {
    this.handlers.push(handler);
  }

  async shutdown(signal: string): Promise<void> {
    if (this.shutdownInProgress) {
      log.warn({ signal }, 'Shutdown already in progress');
      return;
    }
    this.shutdownInProgress = true;
    log.info({ signal }, 'Graceful shutdown initiated');

    for (const handler of this.handlers.reverse()) {
      try {
        await Promise.race([
          handler(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('Shutdown handler timeout')), 10_000),
          ),
        ]);
      } catch (err) {
        log.error({ err }, 'Shutdown handler error');
      }
    }

    log.info('Shutdown complete');
  }
}

const log = getLogger();
const shutdown = new ShutdownManager();
const WA_AUDIO_FALLBACK_TEXT = '🎤 Voice reply is ready, but WhatsApp audio delivery is not yet supported in this build.';
// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function bootstrap(): Promise<void> {
  log.info('Self-BOT starting up...');

  // ── 1. Load configuration ────────────────────────────────────────────────
  const config = loadConfig();
  log.info(
    {
      provider: config.llm.provider,
      model: config.llm.model,
      mode: config.telegram.mode,
      sessionStore: config.session.store,
    },
    'Configuration loaded',
  );

  // ── 1a. Media Service ─────────────────────────────────────────────────────
  const mediaService = createMediaService(config);
  if (mediaService) {
    log.info('MediaService initialized');
  } else {
    log.info('MediaService unavailable — set LOCAL_IMAGE_URL/LOCAL_STT_URL/LOCAL_TTS_URL or OPENAI_API_KEY (plus MEDIA_TTS_ENABLED=true for TTS fallback)');
  }

  // ── 1b. OAuth bootstrap (claude-oauth provider) ───────────────────────────
  let oauthManager: OAuthManager | undefined;
  if (config.llm.provider === 'claude-oauth') {
    const tokenPath = config.llm.oauthTokensPath;
    oauthManager = new OAuthManager(tokenPath);

    await oauthManager.ensureAuthenticated({
      onUrl: async (url: string) => {
        console.log('\n╔══════════════════════════════════════════════════════╗');
        console.log('║        🔐 Anthropic OAuth Login Required             ║');
        console.log('╚══════════════════════════════════════════════════════╝');
        console.log('\nOpen this URL in your browser to authenticate:\n');
        console.log(url);
        console.log('\nAfter authorizing, paste the code shown on the page.');
        console.log('(Format: code#state or just the code value)\n');
      },
      onCode: async () => {
        return new Promise<string>((resolve) => {
          const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          rl.question('Paste authorization code: ', (answer: string) => {
            rl.close();
            resolve(answer.trim());
          });
        });
      },
    });

    log.info('OAuth authentication successful');
  }

  // ── 2. Session store + manager ───────────────────────────────────────────
  const sessionStore = await createSessionStore(config.session.store, {
    ttlSeconds: config.session.ttlSeconds,
    redisUrl: config.redis.url,
    ...(config.session.meridianUrl !== undefined
      ? { meridianUrl: config.session.meridianUrl }
      : {}),
  });
  const sessionManager = new SessionManager({
    store: sessionStore,
    defaultMaxHistoryTokens: config.agent.maxHistoryTokens,
  });

  shutdown.register(async () => {
    log.info('Closing session manager');
    await sessionManager.close();
  });

  // ── 3. MCP Tool Registry ─────────────────────────────────────────────────
  const toolRegistry = new MCPToolRegistry();
  toolRegistry.registerAll([
    new ScrapeWebsiteTool(),
    new FillFormTool(),
    new LoginAccountTool(),
    new RegisterAccountTool(),
    new BookAppointmentTool(),
    new GenerateImageTool(mediaService),
    new EditImageTool(mediaService),
    new TranscribeAudioTool(mediaService),
    new SynthesizeSpeechTool(mediaService),
    new ReadPDFTool(mediaService),
  ]);
  log.info({ tools: toolRegistry.listNames() }, 'Tools registered');

  // ── 3b. Remote MCP Tools ─────────────────────────────────────────────────
  const remoteMCPLoader = new RemoteMCPLoader(toolRegistry, config.mcp.remoteServers);
  await remoteMCPLoader.load();
  shutdown.register(async () => await remoteMCPLoader.dispose());

  // ── 4. Task Queue ────────────────────────────────────────────────────────
  const taskQueue = new TaskQueue(config);

  shutdown.register(async () => {
    log.info('Draining task queue');
    taskQueue.pause();
    await taskQueue.drain();
    log.info('Task queue drained');
  });

  // ── 5. Agent Core ─────────────────────────────────────────────────────────
  const agent = new AgentCore({
    config,
    sessionManager,
    toolRegistry,
    taskQueue,
    oauthManager,
    mediaService: mediaService ?? undefined,
  });

  // ── 6. MCP Server ─────────────────────────────────────────────────────────
  const mcpServer = new MCPServer({
    port: config.mcp.serverPort,
    host: config.mcp.serverHost,
    registry: toolRegistry,
  });
  await mcpServer.start();

  shutdown.register(async () => {
    log.info('Stopping MCP server');
    await mcpServer.stop();
  });

  // ── 6b. GatewayAuth (replaces AccessGuard) ───────────────────────────────
  // Select store: explicit via ALLOWLIST_STORE env var (meridianMcpUrl guaranteed by validateAllowlistStore)
  let allowlistStore: IAllowlistStore;
  if (config.access.allowlistStore === 'meridian') {
    // meridianMcpUrl guaranteed present by validateAllowlistStore()
    allowlistStore = new MeridianAllowlistStore(config.access.meridianMcpUrl!);
    log.info({ meridianMcpUrl: config.access.meridianMcpUrl }, 'Using MeridianAllowlistStore');
  } else {
    allowlistStore = new FileAllowlistStore(config.access.allowlistPath);
    log.info({ allowlistPath: config.access.allowlistPath }, 'Using FileAllowlistStore');
  }
  await allowlistStore.load();

  // Build multi-platform owner identity Set
  const ownerUserIds = new Set<string>([config.access.ownerUserId]);
  if (config.website) {
    ownerUserIds.add(`web:${config.website.ownerUsername}`);
  }
  if (config.whatsapp?.enabled && config.whatsapp.ownerNumber) {
    ownerUserIds.add(waUserId(config.whatsapp.ownerNumber));
  }
  log.info({ ownerUserIds: [...ownerUserIds] }, 'Owner identities configured');

  const gatewayAuth = new GatewayAuth(allowlistStore, {
    ownerUserId:  config.access.ownerUserId,
    ownerUserIds,
    silentReject: config.access.silentReject,
    ...(config.access.rejectionMessage !== undefined
      ? { rejectionMessage: config.access.rejectionMessage }
      : {}),
    ...(config.access.gatewayJwtSecret !== undefined
      ? { gatewayJwtSecret: config.access.gatewayJwtSecret }
      : {}),
  });

  shutdown.register(async () => {
    log.info('Flushing allowlist store');
    await allowlistStore.close();
  });

  // ── 7. Adapter Registry ───────────────────────────────────────────────────
  const adapterRegistry = new AdapterRegistry();
  const telegramAdapter = new TelegramAdapter(config);
  adapterRegistry.register(telegramAdapter);

  // ── WhatsApp Adapter (optional) ──────────────────────────────────────────
  if (config.whatsapp?.enabled) {
    const whatsappAdapter = new WhatsAppAdapter(config);
    adapterRegistry.register(whatsappAdapter);
    log.info('WhatsApp adapter registered');
  }

  // ── Website Adapter (optional) ───────────────────────────────────────────
  if (config.website?.enabled) {
    const webAdapter = new WebAdapter(config, sessionManager, allowlistStore);
    adapterRegistry.register(webAdapter);
    log.info('Website adapter registered');
  }

  shutdown.register(async () => {
    log.info('Shutting down adapters');
    await adapterRegistry.shutdownAll();
  });

  // ── 8. Wire message handler ───────────────────────────────────────────────
  const rawHandler: MessageHandler = async (message: UnifiedMessage) => {
    const childLog = log.child({
      userId: message.userId,
      platform: message.platform.platform,
    });

    childLog.info({ text: message.text.slice(0, 80) }, 'Incoming message');

    try {
      // Ignore stale Telegram messages from before current process start.
      if (message.platform.platform === 'telegram') {
        const messageTs = Date.parse(message.timestamp);
        const staleCutoffMs = Date.now() - 30_000;
        if (Number.isFinite(messageTs) && messageTs < staleCutoffMs) {
          childLog.info({ messageTimestamp: message.timestamp }, 'Ignoring stale Telegram message');
          return;
        }
      }

      // Shadow copy to allow text mutation without touching original message reference
      let currentMessage = message;

      // Fetch Telegram image attachments (populate .data field for vision)
      if (message.platform.platform === 'telegram') {
        const tgToken = config.telegram.botToken as unknown as string;
        const tgApi = telegramAdapter.getApi();
        if (tgApi) {
          for (const att of message.attachments) {
            if (att.type === 'image' && 'fileId' in att && att.fileId && !('data' in att && att.data)) {
              try {
                const fetched = await fetchTelegramFile(tgApi, tgToken, att.fileId);
                (att as FileAttachment).data = fetched.data.toString('base64');
                if (fetched.mimeType && !att.mimeType) {
                  (att as FileAttachment).mimeType = fetched.mimeType;
                }
              } catch (err) {
                childLog.warn({ err, fileId: att.fileId }, 'Failed to fetch Telegram image attachment');
              }
            }
          }
        }
      }

      // STT: fetch and transcribe Telegram audio attachments
      if (message.platform.platform === 'telegram') {
        const tgApiForAudio = telegramAdapter.getApi();
        const tgTokenForAudio = config.telegram.botToken as unknown as string;
        let warnedUnavailable = false;
        for (const att of currentMessage.attachments) {
          if (att.type === 'audio' && 'fileId' in att && (att as FileAttachment).fileId && !((att as FileAttachment).data)) {
            if (!mediaService) {
              if (!warnedUnavailable) {
                currentMessage = {
                  ...currentMessage,
                  text: prependCapabilityNotice(currentMessage.text, 'stt'),
                };
                warnedUnavailable = true;
              }
              continue;
            }
            try {
              const fetched = await fetchTelegramFile(tgApiForAudio!, tgTokenForAudio, (att as FileAttachment).fileId);
              (att as FileAttachment).data = fetched.data.toString('base64');
              if (fetched.mimeType && !(att as FileAttachment).mimeType) {
                (att as FileAttachment).mimeType = fetched.mimeType;
              }
              // Inject transcript into message text
              const transcript = await mediaService.transcribeAudio(fetched.data, fetched.mimeType ?? 'audio/ogg');
              const transcriptPrefix = `[Transcript: ${transcript.text}]`;
              currentMessage = {
                ...currentMessage,
                text: currentMessage.text.trim()
                  ? `${transcriptPrefix}\n${currentMessage.text}`
                  : transcriptPrefix,
              };
            } catch (err) {
              if (isMediaCapabilityUnavailableError(err)) {
                if (!warnedUnavailable) {
                  currentMessage = {
                    ...currentMessage,
                    text: prependCapabilityNotice(currentMessage.text, 'stt'),
                  };
                  warnedUnavailable = true;
                }
                continue;
              }
              childLog.warn({ err }, 'Failed to fetch/transcribe Telegram audio attachment');
            }
          }
        }
      }

      // WhatsApp document gate: keep text flow, reject unknown-size/unsupported/oversize documents.
      if (currentMessage.platform.platform === 'whatsapp' && currentMessage.attachments.length > 0) {
        const waDocumentMaxBytes = config.whatsapp?.documentMaxBytes ?? (10 * 1024 * 1024);
        const warnings: string[] = [];
        const allowedAttachments: import('./types/message.js').Attachment[] = [];

        for (const att of currentMessage.attachments) {
          if (att.type !== 'document') {
            allowedAttachments.push(att);
            continue;
          }

          const mime = att.mimeType ?? '';
          const unsupportedMime = mime.length > 0 && !mime.startsWith('application/');
          const unknownSize = typeof att.size !== 'number';
          const oversize = typeof att.size === 'number' && att.size > waDocumentMaxBytes;

          if (unknownSize) {
            warnings.push('⚠️ Document skipped: unknown file size.');
            childLog.warn(
              { attachmentType: att.type, mimeType: att.mimeType },
              'WhatsApp document rejected because size is missing',
            );
            continue;
          }

          if (unsupportedMime) {
            warnings.push('⚠️ Document skipped: unsupported MIME type.');
            childLog.warn({ attachmentType: att.type, mimeType: att.mimeType }, 'WhatsApp document rejected due to MIME type');
            continue;
          }
          if (oversize) {
            warnings.push('⚠️ Document skipped: file exceeds size limit.');
            childLog.warn(
              { size: att.size, waDocumentMaxBytes },
              'WhatsApp document rejected due to configured size limit',
            );
            continue;
          }

          allowedAttachments.push(att);
        }

        if (warnings.length > 0) {
          currentMessage = {
            ...currentMessage,
            attachments: allowedAttachments,
            text: `${warnings.join('\n')}${currentMessage.text.trim() ? `\n${currentMessage.text}` : ''}`,
          };
        }
      }

      // Determine if user sent a voice message (before any mutation)
      const isVoiceIn = message.attachments.some(
        (a) => a.type === 'audio' && 'audioSubtype' in a && (a as FileAttachment).audioSubtype === 'voice',
      );

      // Show typing indicator for Telegram
      if (message.platform.platform === 'telegram') {
        telegramAdapter.getApi()
          ?.sendChatAction?.(
            (message.platform as { chatId: number }).chatId,
            'typing',
          )
          .catch(() => undefined);
      }

      // Wire ProgressReporter for Telegram messages.
      // For each Telegram message a ProgressReporter is created and initialised
      // (sends the "⏳ Working…" indicator). Two hook closures are built:
      //   startHook — fired when a tool step begins  → edits message to "⚙ Step N — …"
      //   doneHook  — fired when a tool step finishes → edits message to "✓ Step N done (Xms) — …"
      // On cleanup (success or error), any remaining ⚙ lines become "⚠ Step N interrupted"
      // and the message is left in place (not deleted). Non-Telegram paths leave reporter null
      // and both hooks undefined, so AgentCore skips them entirely.
      let reporter: ProgressReporter | null = null;
      const progressMode: 'single' | 'history' = config.agent.progressReporterPersistHistory
        ? 'history'
        : 'single';
      const tgApi = message.platform.platform === 'telegram'
        ? telegramAdapter.getApi()
        : undefined;

      if (tgApi && message.platform.platform === 'telegram') {
        const chatId = (message.platform as { chatId: number }).chatId;
        reporter = new ProgressReporter(tgApi, chatId, progressMode);
        await reporter.init();
      }

      const startHook = reporter
        ? (stepN: number, toolName: string, args: Record<string, unknown>) =>
            reporter!.onStepStart(stepN, toolName, args)
        : undefined;

      const doneHook = reporter
        ? (stepN: number, toolName: string, durationMs: number, result: unknown) =>
            reporter!.onStepDone(stepN, toolName, durationMs, result)
        : undefined;

      let response: UnifiedResponse;
      try {
        response = await agent.handleMessage(currentMessage, undefined, startHook, doneHook);
      } finally {
        if (reporter) await reporter.cleanup().catch(() => undefined);
      }

      // TTS: auto-convert text response to voice for voice-in messages
      const hasToolAudio = response.attachments?.some((a) => a.type === 'audio') ?? false;
      if (isVoiceIn && !hasToolAudio) {
        if (!mediaService) {
          response = {
            ...response,
            text: appendCapabilityNotice(response.text, 'tts'),
          };
        } else {
          try {
            const synth = await mediaService.synthesizeSpeech(response.text);
            const audioAtt: import('./types/message.js').FileAttachment = {
              type: 'audio',
              audioSubtype: 'voice',
              fileId: '',
              data: synth.data.toString('base64'),
              mimeType: synth.mimeType,
            };
            response = {
              ...response,
              attachments: [...(response.attachments ?? []), audioAtt],
              text:
                message.platform.platform === 'whatsapp'
                  ? (response.text.trim() || WA_AUDIO_FALLBACK_TEXT)
                  : '',
            };
          } catch (err) {
            if (isMediaCapabilityUnavailableError(err)) {
              response = {
                ...response,
                text: appendCapabilityNotice(response.text, 'tts'),
              };
            } else {
              childLog.warn({ err }, 'TTS synthesis failed — falling back to text reply');
            }
          }
        }
      }

      if (
        message.platform.platform === 'whatsapp'
        && (response.attachments?.some((a) => a.type === 'audio') ?? false)
      ) {
        response = {
          ...response,
          text: response.text.trim() || WA_AUDIO_FALLBACK_TEXT,
        };
      }

      // Telegram-specific single-mode finalization gate:
      // if progress message edit to final response succeeds, skip adapter send to avoid duplicate.
      if (message.platform.platform === 'telegram' && progressMode === 'single' && reporter
          && !response.attachments?.some((a) => a.type === 'audio' || a.type === 'image')) {
        if (response.format === 'text' || response.format === 'markdown') {
          const finalized = await reporter.finalizeToResponse(response.text, response.format);
          if (finalized) return;
        }
      }

      await adapterRegistry.sendResponse(response);
    } catch (err) {
      childLog.error({ err }, 'Failed to handle message');

      // Send error response to user
      const errorResponse: UnifiedResponse = {
        inReplyTo: message.id,
        userId: message.userId,
        conversationId: message.conversationId,
        text: '⚠️ Sorry, I encountered an error processing your request. Please try again.',
        format: 'text',
        platform: message.platform,
      };

      await adapterRegistry.sendResponse(errorResponse).catch((sendErr: unknown) => {
        childLog.error({ sendErr }, 'Failed to send error response');
      });
    }
  };

  const guardedHandler = gatewayAuth.wrap(
    rawHandler,
    (r) => adapterRegistry.sendResponse(r),
  );

  const disposer = adapterRegistry.onMessage(guardedHandler);

  shutdown.register(async () => {
    // Dispose message handlers
    if (Array.isArray(disposer)) {
      for (const d of disposer) d();
    }
  });

  // ── 9. Initialize adapters ────────────────────────────────────────────────
  await adapterRegistry.initializeAll();

  log.info(
    {
      adapters: adapterRegistry.list(),
      mcpPort: config.mcp.serverPort,
    },
    'Self-BOT ready',
  );

  // ── 10. Process-level signal handlers ────────────────────────────────────
  const signalHandler = (signal: string) => {
    shutdown.shutdown(signal).then(() => {
      process.exit(0);
    }).catch((err: unknown) => {
      log.error({ err }, 'Shutdown failed');
      process.exit(1);
    });
  };

  process.once('SIGINT', () => signalHandler('SIGINT'));
  process.once('SIGTERM', () => signalHandler('SIGTERM'));

  process.on('uncaughtException', (err) => {
    log.error({ err }, 'Uncaught exception');
  });

  process.on('unhandledRejection', (reason) => {
    log.error({ reason }, 'Unhandled rejection');
  });
}

// ─── Run ──────────────────────────────────────────────────────────────────────
bootstrap().catch((err: unknown) => {
  log.error({ err }, 'Bootstrap failed');
  process.exit(1);
});
