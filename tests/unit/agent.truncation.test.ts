/**
 * tests/unit/agent.truncation.test.ts
 * Verifies pre-call token-budget truncation with reserved margin.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { SessionManager } from '../../src/session/manager.js';
import { InMemorySessionStore } from '../../src/session/store.js';
import { MCPToolRegistry } from '../../src/mcp/registry.js';
import { TaskQueue } from '../../src/queue/task-queue.js';
import { AgentCore } from '../../src/agent/index.js';
import type { UnifiedMessage } from '../../src/types/message.js';

const mockStreamText = mock((options: { messages: unknown[] }) => {
  async function* textGen() {
    yield 'ok';
  }
  return {
    textStream: textGen(),
    text: Promise.resolve('ok'),
  };
});

mock.module('ai', () => ({
  streamText: mockStreamText,
}));

mock.module('../../src/agent/llm.js', () => ({
  createLLMModel: () => ({ provider: 'test', model: 'test-model' }),
  describeModel: () => 'test/test-model',
}));

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
      maxSteps: 3,
      maxHistoryTokens: 1600,
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
    id: 'msg-trunc-001',
    userId: 'user-trunc-001',
    conversationId: 'conv-trunc-001',
    text: 'hello',
    attachments: [],
    timestamp: new Date().toISOString(),
    platform: {
      platform: 'telegram',
      chatId: 100,
      messageId: 1,
      chatType: 'private',
    },
    isCommand: false,
    ...overrides,
  };
}

function estimateMessagesTokens(messages: Array<{ content: unknown }>): number {
  return messages.reduce((acc, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return acc + Math.ceil(content.length / 4) + 4;
  }, 0);
}

describe('AgentCore pre-call truncation', () => {
  let sessionManager: SessionManager;
  let taskQueue: TaskQueue;
  let agent: AgentCore;

  beforeEach(() => {
    const store = new InMemorySessionStore(3600);
    sessionManager = new SessionManager({ store, defaultMaxHistoryTokens: 1600 });
    const config = makeConfig();
    taskQueue = new TaskQueue(config as unknown as import('../../src/config/index.js').Config);
    agent = new AgentCore({
      config: config as unknown as import('../../src/config/index.js').Config,
      sessionManager,
      toolRegistry: new MCPToolRegistry(),
      taskQueue,
    });
    mockStreamText.mockClear();
  });

  afterEach(async () => {
    await sessionManager.close();
    taskQueue.clear();
  });

  it('truncates prompt messages to token budget before model call', async () => {
    const longText = 'x'.repeat(700);
    for (let i = 0; i < 8; i += 1) {
      await agent.handleMessage(makeMessage({ id: `warm-${i}`, text: `${longText}-${i}` }));
    }

    mockStreamText.mockClear();
    await agent.handleMessage(makeMessage({ id: 'final', text: `${longText}-final` }));

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    const callArgs = mockStreamText.mock.calls[0]![0] as { messages: Array<{ content: unknown }> };
    const promptTokens = estimateMessagesTokens(callArgs.messages);
    expect(promptTokens).toBeLessThanOrEqual(600);
  });
});
