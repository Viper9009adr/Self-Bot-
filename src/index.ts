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
import { MCPToolRegistry } from './mcp/registry.js';
import { MCPServer } from './mcp/server.js';
import { TaskQueue } from './queue/task-queue.js';
import { AgentCore } from './agent/index.js';
import { OAuthManager } from './auth/index.js';
import { ScrapeWebsiteTool } from './mcp/tools/scrape-website.js';
import { FillFormTool } from './mcp/tools/fill-form.js';
import { LoginAccountTool } from './mcp/tools/login-account.js';
import { RegisterAccountTool } from './mcp/tools/register-account.js';
import { BookAppointmentTool } from './mcp/tools/book-appointment.js';
import { createInterface } from 'node:readline';
import type { UnifiedMessage, UnifiedResponse } from './types/index.js';
import { AccessGuard, FileAllowlistStore } from './access/index.js';
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
  const sessionStore = createSessionStore(config.session.store, {
    ttlSeconds: config.session.ttlSeconds,
    redisUrl: config.redis.url,
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
  ]);
  log.info({ tools: toolRegistry.listNames() }, 'Tools registered');

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

  // ── 6b. Access Guard ──────────────────────────────────────────────────────
  const allowlistStore = new FileAllowlistStore(config.access.allowlistPath);
  await allowlistStore.load();

  const accessGuard = new AccessGuard(allowlistStore, {
    ownerUserId: config.access.ownerUserId,
    allowlistPath: config.access.allowlistPath,
    silentReject: config.access.silentReject,
    ...(config.access.rejectionMessage !== undefined
      ? { rejectionMessage: config.access.rejectionMessage }
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

      // Show typing indicator for Telegram
      if (message.platform.platform === 'telegram') {
        telegramAdapter['bot']?.api
          ?.sendChatAction?.(
            (message.platform as { chatId: number }).chatId,
            'typing',
          )
          .catch(() => undefined);
      }

      const response: UnifiedResponse = await agent.handleMessage(message);
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

  const guardedHandler = accessGuard.wrap(
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
