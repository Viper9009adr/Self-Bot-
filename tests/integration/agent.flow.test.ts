/**
 * tests/integration/agent.flow.test.ts
 * Integration test for the full AgentCore message handling flow.
 * Uses mocked LLM and tool calls.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { SessionManager } from '../../src/session/manager.js';
import { InMemorySessionStore } from '../../src/session/store.js';
import { MCPToolRegistry } from '../../src/mcp/registry.js';
import { TaskQueue } from '../../src/queue/task-queue.js';
import { AgentCore } from '../../src/agent/index.js';
import type { UnifiedMessage } from '../../src/types/message.js';
import { ToolErrorCode } from '../../src/types/tool.js';
import type { SessionStore, UserSession } from '../../src/types/session.js';

// ─── Mock Vercel AI SDK ───────────────────────────────────────────────────────
// We mock the 'ai' module to avoid real LLM calls
const mockStreamText = mock((options: {
  system: string;
  messages: unknown[];
  tools?: Record<string, unknown>;
  onStepFinish?: (step: { toolCalls: unknown[]; text: string }) => Promise<void>;
}) => {
  // Simulate a simple response stream
  const responseText = 'I have processed your request successfully.';

  // Call onStepFinish if provided (simulate a step)
  if (options.onStepFinish) {
    void options.onStepFinish({ toolCalls: [], text: responseText });
  }

  async function* textGen() {
    yield responseText;
  }

  return {
    textStream: textGen(),
    text: Promise.resolve(responseText),
  };
});

// Mock the ai module
mock.module('ai', () => ({
  streamText: mockStreamText,
}));

// Mock the LLM factory
mock.module('../../src/agent/llm.js', () => ({
  createLLMModel: () => ({ provider: 'test', model: 'test-model' }),
  describeModel: () => 'test/test-model',
}));

// ─── Test Fixtures ────────────────────────────────────────────────────────────
function makeConfig() {
  return {
    nodeEnv: 'test' as const,
    logLevel: 'silent' as const,
    telegram: {
      botToken: 'test-token' as unknown as import('../../src/config/schema.js').SecretString,
      mode: 'polling' as const,
      webhookPort: 8080,
    },
    llm: {
      provider: 'openai' as const,
      model: 'gpt-4o',
      openaiApiKey: 'sk-test' as unknown as import('../../src/config/schema.js').SecretString,
    },
    agent: {
      maxSteps: 5,
      maxHistoryTokens: 8000,
      systemPromptExtra: '',
    },
    session: {
      ttlSeconds: 3600,
      store: 'memory' as const,
    },
    redis: { url: 'redis://localhost:6379' },
    mcp: { serverPort: 3001, serverHost: '127.0.0.1' },
    browserWorker: { url: 'http://localhost:3002', timeoutMs: 30000 },
    queue: { concurrency: 2, perUserConcurrency: 1 },
  };
}

function makeMessage(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: 'msg-test-001',
    userId: 'user-test-001',
    conversationId: 'conv-test-001',
    text: 'Hello, can you help me?',
    attachments: [],
    timestamp: new Date().toISOString(),
    platform: {
      platform: 'telegram',
      chatId: 12345,
      messageId: 1,
      chatType: 'private',
    },
    isCommand: false,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('AgentCore integration', () => {
  let sessionManager: SessionManager;
  let toolRegistry: MCPToolRegistry;
  let taskQueue: TaskQueue;
  let agent: AgentCore;

  beforeEach(() => {
    const store = new InMemorySessionStore(3600);
    sessionManager = new SessionManager({ store, defaultMaxHistoryTokens: 8000 });
    toolRegistry = new MCPToolRegistry();
    const config = makeConfig();
    taskQueue = new TaskQueue(config as unknown as import('../../src/config/index.js').Config);

    agent = new AgentCore({
      config: config as unknown as import('../../src/config/index.js').Config,
      sessionManager,
      toolRegistry,
      taskQueue,
    });

    mockStreamText.mockClear();
  });

  afterEach(async () => {
    await sessionManager.close();
    taskQueue.clear();
  });

  describe('basic message handling', () => {
    it('processes a simple message and returns response', async () => {
      const message = makeMessage({ text: 'Hello!' });
      const response = await agent.handleMessage(message);

      expect(response).toBeDefined();
      expect(response.text).toBeTruthy();
      expect(response.userId).toBe(message.userId);
      expect(response.inReplyTo).toBe(message.id);
      expect(response.conversationId).toBe(message.conversationId);
    });

    it('mirrors platform metadata in response', async () => {
      const message = makeMessage();
      const response = await agent.handleMessage(message);

      expect(response.platform.platform).toBe('telegram');
    });

    it('returns markdown format', async () => {
      const message = makeMessage();
      const response = await agent.handleMessage(message);

      expect(response.format).toBe('markdown');
    });
  });

  describe('session management', () => {
    it('creates a session for new users', async () => {
      const message = makeMessage({ userId: 'new-user-xyz' });
      await agent.handleMessage(message);

      const session = await sessionManager.get('new-user-xyz');
      expect(session).not.toBeNull();
      expect(session!.userId).toBe('new-user-xyz');
    });

    it('appends message to history', async () => {
      const message = makeMessage({ userId: 'history-test-user' });
      await agent.handleMessage(message);

      const session = await sessionManager.get('history-test-user');
      expect(session).not.toBeNull();
      // Should have user message + assistant response
      expect(session!.history.length).toBeGreaterThanOrEqual(2);
      expect(session!.history.some((m) => m.role === 'user')).toBe(true);
      expect(session!.history.some((m) => m.role === 'assistant')).toBe(true);
    });

    it('accumulates history across multiple messages', async () => {
      const userId = 'multi-message-user';
      const msg1 = makeMessage({ userId, text: 'First message' });
      const msg2 = makeMessage({ userId, id: 'msg-002', text: 'Second message' });

      await agent.handleMessage(msg1);
      await agent.handleMessage(msg2);

      const session = await sessionManager.get(userId);
      expect(session!.history.length).toBeGreaterThanOrEqual(4); // 2 user + 2 assistant
    });

    it('removes active task after completion', async () => {
      const message = makeMessage({ userId: 'task-tracking-user' });
      await agent.handleMessage(message);

      const session = await sessionManager.get('task-tracking-user');
      expect(session!.activeTaskIds).toHaveLength(0);
      expect(session!.concurrentTaskCount).toBe(0);
    });
  });

  describe('streaming callback', () => {
    it('calls stream callback with chunks', async () => {
      const chunks: Array<{ text: string; isFinal: boolean }> = [];
      const callback = async (text: string, isFinal: boolean) => {
        chunks.push({ text, isFinal });
      };

      const message = makeMessage();
      await agent.handleMessage(message, callback);

      expect(chunks.length).toBeGreaterThan(0);
      // At least one final call
      expect(chunks.some((c) => c.isFinal)).toBe(true);
    });
  });

  describe('LLM invocation', () => {
    it('calls streamText with system prompt', async () => {
      const message = makeMessage();
      await agent.handleMessage(message);

      expect(mockStreamText).toHaveBeenCalledTimes(1);
      const callArgs = mockStreamText.mock.calls[0]![0] as { system: string };
      expect(callArgs.system).toContain('Self-BOT');
    });

    it('passes maxSteps from config', async () => {
      const message = makeMessage();
      await agent.handleMessage(message);

      const callArgs = mockStreamText.mock.calls[0]![0] as unknown as { maxSteps: number };
      expect(callArgs.maxSteps).toBe(5); // from makeConfig
    });

    it('passes conversation history', async () => {
      const userId = 'history-llm-user';
      // First message
      await agent.handleMessage(makeMessage({ userId, text: 'First' }));
      // Second message
      await agent.handleMessage(makeMessage({ userId, id: 'msg-002', text: 'Second' }));

      expect(mockStreamText).toHaveBeenCalledTimes(2);
      // Second call should have more messages
      const secondCallArgs = mockStreamText.mock.calls[1]![0] as { messages: unknown[] };
      expect(secondCallArgs.messages.length).toBeGreaterThan(0);
    });
  });

  describe('tool registry integration', () => {
    it('passes tools to streamText when registry has tools', async () => {
      // Register a mock tool
      const mockTool = {
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: {
          safeParse: (v: unknown) => ({ success: true, data: v }),
          parse: (v: unknown) => v,
        } as unknown as import('zod').ZodType,
        execute: async () => ({ success: true, data: 'test result' }),
      };

      toolRegistry.register(mockTool);

      const message = makeMessage({ text: 'Use the test tool' });
      await agent.handleMessage(message);

      const callArgs = mockStreamText.mock.calls[0]![0] as { tools: Record<string, unknown> };
      expect(callArgs.tools).toBeDefined();
      expect(Object.keys(callArgs.tools)).toContain('test_tool');
    });
  });

  describe('error handling', () => {
    it('handles LLM error gracefully', async () => {
      mockStreamText.mockImplementationOnce(() => {
        throw new Error('LLM API error');
      });

      const message = makeMessage({ userId: 'error-test-user' });

      await expect(agent.handleMessage(message)).rejects.toThrow();

      // Active task should be cleaned up even on error
      const session = await sessionManager.get('error-test-user');
      if (session) {
        expect(session.activeTaskIds).toHaveLength(0);
      }
    });

    it('does not reset session on transient store.get failure', async () => {
      let created = 0;
      const transientStore: SessionStore = {
        async get(): Promise<UserSession | null> {
          throw new Error('Session fetch indeterminate: transient_failure');
        },
        async set(): Promise<void> {
          created += 1;
        },
        async delete(): Promise<void> {},
        async has(): Promise<boolean> { return false; },
        async keys(): Promise<string[]> { return []; },
        async flush(): Promise<void> {},
        async close(): Promise<void> {},
      };

      const transientSessionManager = new SessionManager({
        store: transientStore,
        defaultMaxHistoryTokens: 8000,
      });

      await expect(transientSessionManager.getOrCreate('transient-user')).rejects.toThrow(
        'Session fetch indeterminate',
      );
      expect(created).toBe(0);
    });
  });
});
