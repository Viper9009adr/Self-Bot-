/**
 * src/agent/index.ts
 * AgentCore: the main agent loop that processes messages using LLM + tools.
 * Implements the streamText() multi-turn tool call loop.
 */
import { streamText, type CoreMessage, type ToolCallPart, type ToolResultPart } from 'ai';
import type { UnifiedMessage, UnifiedResponse } from '../types/message.js';
import type { ToolContext } from '../types/tool.js';
import type { Config } from '../config/index.js';
import type { SessionManager } from '../session/manager.js';
import type { MCPToolRegistry } from '../mcp/registry.js';
import type { TaskQueue } from '../queue/task-queue.js';
import type { OAuthManager } from '../auth/index.js';
import { ConversationMemory } from './memory.js';
import { CoTPromptBuilder } from './cot.js';
import { createLLMModel } from './llm.js';
import { stripCoTBlocks } from './format.js';
import { childLogger } from '../utils/logger.js';
import { AgentError, normalizeError } from '../utils/errors.js';
import { nanoid } from 'nanoid';

const log = childLogger({ module: 'agent:core' });
const LLM_TIMEOUT_MS = 90_000;

export interface AgentCoreOptions {
  config: Config;
  sessionManager: SessionManager;
  toolRegistry: MCPToolRegistry;
  taskQueue: TaskQueue;
  oauthManager?: OAuthManager | undefined;
}

export interface AgentResponse {
  text: string;
  taskId: string;
  toolCallCount: number;
  durationMs: number;
}

/**
 * Callback for streaming intermediate results to the user.
 */
export type StreamCallback = (chunk: string, isFinal: boolean) => Promise<void>;

export class AgentCore {
  private readonly config: Config;
  private readonly sessionManager: SessionManager;
  private readonly toolRegistry: MCPToolRegistry;
  private readonly taskQueue: TaskQueue;
  private readonly cotBuilder: CoTPromptBuilder;
  private readonly oauthManager: OAuthManager | undefined;
  /** Pre-built model for non-OAuth providers. Undefined for claude-oauth (built per-request). */
  private readonly model: ReturnType<typeof createLLMModel> | undefined;

  constructor(options: AgentCoreOptions) {
    this.config = options.config;
    this.sessionManager = options.sessionManager;
    this.toolRegistry = options.toolRegistry;
    this.taskQueue = options.taskQueue;
    this.oauthManager = options.oauthManager;

    const extra = options.config.agent.systemPromptExtra || undefined;
    this.cotBuilder = new CoTPromptBuilder({
      toolRegistry: options.toolRegistry,
      ...(extra !== undefined ? { extraInstructions: extra } : {}),
    });

    // Only pre-build model for non-OAuth providers (OAuth builds per-request for token freshness)
    this.model = options.config.llm.provider !== 'claude-oauth'
      ? createLLMModel(options.config)
      : undefined;
  }

  /**
   * Main message handling entry point.
   *
   * Flow:
   * 1. Get/create user session
   * 2. Append user message to history
   * 3. Build prompt via CoTPromptBuilder
   * 4. Call streamText() with tools (maxSteps=10 for multi-turn tool use)
   * 5. For each tool call, enqueue in TaskQueue
   * 6. Collect final text response
   * 7. Save updated session
   * 8. Return UnifiedResponse
   */
  async handleMessage(
    message: UnifiedMessage,
    streamCallback?: StreamCallback,
  ): Promise<UnifiedResponse> {
    const startMs = Date.now();
    const taskId = this.sessionManager.generateTaskId();

    const childLog = log.child({
      taskId,
      userId: message.userId,
      conversationId: message.conversationId,
    });

    childLog.info({ text: message.text.slice(0, 100) }, 'Handling message');

    // 1. Get or create session
    const session = await this.sessionManager.getOrCreate(message.userId);

    // 2. Append user message to history.
    // Guard: LLM APIs reject empty content blocks (HTTP 400). Layer 1 (normalizer) already
    // ensures non-empty text for Telegram messages. This is defense-in-depth for CLI/API
    // adapters where normalizer.ts does not run.
    const safeContent = message.text.trim() ||
      (message.attachments.length > 0
        ? (message.attachments.length === 1 ? '[Sent 1 attachment]' : `[Sent ${message.attachments.length} attachments]`)
        : '[Empty message]');
    await this.sessionManager.appendMessage(message.userId, {
      role: 'user',
      content: safeContent,
    });

    // Fast-path command handling for basic Telegram bot UX
    if (message.isCommand && (message.command === 'start' || message.command === 'help')) {
      const commandText = message.command === 'start'
        ? '👋 Hi! I\'m online and ready. Send me a task in plain language (for example: "summarize this page <url>" or "help me fill this form").'
        : 'ℹ️ Send me what you want to do, and I\'ll handle it step-by-step.\n\nExamples:\n- summarize a webpage\n- fill a form\n- log into a site\n- book an appointment';

      await this.sessionManager.appendMessage(message.userId, {
        role: 'assistant',
        content: commandText,
      });

      return {
        inReplyTo: message.id,
        userId: message.userId,
        conversationId: message.conversationId,
        text: commandText,
        format: 'text',
        platform: message.platform,
      };
    }

    // Track active task
    await this.sessionManager.addActiveTask(message.userId, taskId);

    try {
      // 3. Build prompt
      const updatedSession = await this.sessionManager.getOrCreate(message.userId);
      const memory = new ConversationMemory(updatedSession.history, updatedSession.memoryPolicy);
      const { system, messages: historyMessages } = this.cotBuilder.build(memory.getMessages());

      // Convert to CoreMessage format for Vercel AI SDK
      const coreMessages: CoreMessage[] = historyMessages.map((m) => {
        if (m.role === 'user') return { role: 'user' as const, content: m.content };
        if (m.role === 'assistant') return { role: 'assistant' as const, content: m.content };
        // Tool messages require specific format
        return { role: 'assistant' as const, content: m.content };
      });

      // 4. Convert registry tools to AI SDK format
      const aiSdkTools = this.buildAISdkTools(message.userId, taskId, message.conversationId);

      let fullText = '';
      let toolCallCount = 0;

      // Resolve model (per-request for claude-oauth to handle token refresh)
      let model: ReturnType<typeof createLLMModel>;
      if (this.config.llm.provider === 'claude-oauth') {
        if (!this.oauthManager) {
          throw new AgentError('oauthManager is required for claude-oauth provider');
        }
        // Provide console fallback callbacks for token refresh scenarios
        const token = await this.oauthManager.getValidAccessToken({
          onUrl: async (url: string) => {
            childLog.warn({ url }, 'OAuth re-authentication required. Open URL in browser.');
            console.warn('\n🔐 OAuth re-authentication required:\n', url, '\n');
          },
          onCode: async () => {
            throw new AgentError(
              'OAuth token expired and interactive re-authentication is not available in this context. ' +
                'Restart the bot to re-authenticate.',
            );
          },
        });
        model = createLLMModel(this.config, token);
      } else {
        model = this.model!;
      }

      // 5. Stream with multi-turn tool support
      try {
        childLog.info({ timeoutMs: LLM_TIMEOUT_MS }, 'Starting LLM stream');
        const abortController = new AbortController();
        const timeout = setTimeout(() => abortController.abort('LLM request timed out'), LLM_TIMEOUT_MS);

        // Capture any error the SDK reports via callback (textStream silently
        // swallows errors and yields an empty stream instead of throwing).
        let streamError: unknown = null;

        const effectiveSystem = system;

        const result = streamText({
          model,
          system: effectiveSystem,
          messages: coreMessages,
          tools: aiSdkTools,
          maxSteps: this.config.agent.maxSteps,
          abortSignal: abortController.signal,
          onError: (event) => {
            streamError = event.error;
            childLog.error({ err: event.error }, 'LLM stream error (onError callback)');
          },
          onStepFinish: async (step) => {
            // Count tool calls and log at info level for visibility
            if (step.toolCalls && step.toolCalls.length > 0) {
              toolCallCount += step.toolCalls.length;
              for (const tc of step.toolCalls as ToolCallPart[]) {
                childLog.info(
                  {
                    tool: tc.toolName,
                    args: JSON.stringify(tc.args).slice(0, 300),
                    step: toolCallCount,
                  },
                  `🔧 Tool call: ${tc.toolName}`,
                );
              }
            }

            // Log tool results at info level
            if (step.toolResults && step.toolResults.length > 0) {
              for (const tr of step.toolResults as ToolResultPart[]) {
                const resultStr = JSON.stringify(tr.result).slice(0, 300);
                const success = typeof tr.result === 'object' && tr.result !== null && 'success' in tr.result
                  ? (tr.result as { success: boolean }).success
                  : undefined;
                childLog.info(
                  {
                    tool: tr.toolName,
                    success,
                    resultPreview: resultStr,
                  },
                  `📋 Tool result: ${tr.toolName} → ${success === false ? '❌ FAILED' : '✅ OK'}`,
                );
              }
            }

            // Log intermediate text generation
            if (step.text) {
              childLog.info(
                { textLength: step.text.length, preview: step.text.slice(0, 150) },
                '💬 Step produced text',
              );
            }

            // Stream intermediate text to user if callback provided
            if (streamCallback && step.text) {
              await streamCallback(step.text, false);
            }
          },
        });

        try {
          // Collect streaming text
          for await (const chunk of result.textStream) {
            fullText += chunk;
            if (streamCallback) {
              await streamCallback(chunk, false).catch((err: unknown) => {
                childLog.warn({ err }, 'Stream callback error');
              });
            }
          }
        } finally {
          clearTimeout(timeout);
        }

        // Ensure we have the final text
        const finalText = await result.text;
        if (finalText && finalText !== fullText) {
          fullText = finalText;
        }

        // Check for warnings/errors the SDK may have captured silently.
        // If the stream produced no text and no tool calls, it likely means
        // the API returned an error (e.g. 403/404) that was silently consumed.
        if (!fullText.trim() && toolCallCount === 0) {
          if (streamError) {
            const errMsg = streamError instanceof Error ? streamError.message : String(streamError);
            childLog.error({ err: streamError }, 'LLM stream failed silently');
            throw new AgentError(`LLM call failed: ${errMsg}`, { cause: streamError });
          }
          childLog.warn('LLM stream produced no text and no tool calls — possible silent API error');
        }

      } catch (llmErr) {
        const normalized = normalizeError(llmErr);
        childLog.error({ err: normalized.toJSON() }, 'LLM call failed');
        throw new AgentError('LLM call failed: ' + normalized.message, {
          cause: llmErr,
          isRetryable: normalized.isRetryable,
        });
      }

      if (!fullText.trim()) {
        fullText = '⚠️ I was unable to generate a response. This may be due to an authentication or API issue. Please check the bot logs for details.';
      }

      // Strip internal CoT reasoning blocks before sending to user.
      // The raw text (with CoT) is kept in memory for better conversation continuity.
      const rawText = fullText;
      fullText = stripCoTBlocks(fullText);

      // 6. Append assistant response to history (keep raw for context continuity)
      await this.sessionManager.appendMessage(message.userId, {
        role: 'assistant',
        content: fullText,
      });

      const durationMs = Date.now() - startMs;
      childLog.info(
        {
          durationMs,
          toolCallCount,
          rawLength: rawText.length,
          cleanedLength: fullText.length,
          cotStripped: rawText.length !== fullText.length,
        },
        `✅ Message handled (${toolCallCount} tool calls, ${durationMs}ms)`,
      );

      // 7. Build UnifiedResponse
      const response: UnifiedResponse = {
        inReplyTo: message.id,
        userId: message.userId,
        conversationId: message.conversationId,
        text: fullText,
        format: 'markdown',
        platform: message.platform,
      };

      if (streamCallback) {
        await streamCallback(fullText, true);
      }

      return response;
    } finally {
      // Always remove active task tracking
      await this.sessionManager.removeActiveTask(message.userId, taskId);
    }
  }

  /**
   * Build Vercel AI SDK tool definitions from the registry.
   * Each tool's execute function runs through the TaskQueue.
   */
  private buildAISdkTools(
    userId: string,
    taskId: string,
    conversationId: string,
  ): Record<string, {
    description: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parameters: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (input: any) => Promise<unknown>;
  }> {
    const result: Record<string, {
      description: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: (input: any) => Promise<unknown>;
    }> = {};

    for (const tool of this.toolRegistry.listAll()) {
      const toolName = tool.name;
      result[toolName] = {
        description: tool.description,
        parameters: tool.inputSchema,
        execute: async (input: Record<string, unknown>) => {
          const context: ToolContext = {
            userId,
            taskId: `${taskId}-${toolName}-${nanoid(6)}`,
            conversationId,
            logger: log,
          };

          log.info(
            { tool: toolName, taskId: context.taskId, input: JSON.stringify(input).slice(0, 200) },
            `⚙️  Executing tool: ${toolName}`,
          );

          // Execute through TaskQueue for proper concurrency control
          return this.taskQueue.enqueue(async () => {
            const startMs = Date.now();
            const result = await tool.execute(input as never, context);
            const durationMs = Date.now() - startMs;
            log.info(
              { tool: toolName, durationMs, success: (result as { success?: boolean }).success },
              `⚙️  Tool ${toolName} finished (${durationMs}ms)`,
            );
            return result;
          });
        },
      };
    }

    return result;
  }
}
