/**
 * tests/unit/adapters/adapter-boundary-contract.test.ts
 * Contract tests for adapter boundary migration helpers.
 */
import { describe, it, expect, mock } from 'bun:test';
import type { UnifiedMessage, UnifiedResponse } from '../../../src/types/message.js';
import type { IAdapter, MessageHandler } from '../../../src/adapters/base.js';
import { toAdapterBoundaryContract } from '../../../src/adapters/base.js';

function makeMockAdapter(): IAdapter {
  let handler: MessageHandler | null = null;
  let running = false;

  return {
    name: 'telegram',
    initialize: mock(async () => {
      running = true;
    }),
    sendResponse: mock(async (_response: UnifiedResponse) => {}),
    onMessage: mock((next: MessageHandler) => {
      handler = next;
      return () => {
        handler = null;
      };
    }),
    shutdown: mock(async () => {
      running = false;
    }),
    isRunning: mock(() => running),
  };
}

function makeMessage(): UnifiedMessage {
  return {
    id: 'm-1',
    userId: 'tg:1',
    conversationId: 'tg:chat:1',
    text: 'hello',
    attachments: [],
    timestamp: new Date().toISOString(),
    platform: {
      platform: 'telegram',
      chatId: 1,
      messageId: 1,
      chatType: 'private',
    },
    isCommand: false,
  };
}

describe('adapter boundary contract', () => {
  it('exposes migration-friendly channel + sendResponse surface', () => {
    const adapter = makeMockAdapter();
    const boundary = toAdapterBoundaryContract(adapter) as unknown as Record<string, unknown>;

    expect(boundary['channel']).toBe('telegram');
    expect(typeof boundary['sendResponse']).toBe('function');
    expect(boundary['send']).toBeUndefined();
  });

  it('maps name -> channel and forwards lifecycle calls', async () => {
    const adapter = makeMockAdapter();
    const boundary = toAdapterBoundaryContract(adapter);

    expect(boundary.channel).toBe('telegram');
    expect(boundary.isRunning()).toBe(false);

    await boundary.initialize();
    expect(boundary.isRunning()).toBe(true);

    await boundary.shutdown();
    expect(boundary.isRunning()).toBe(false);
  });

  it('forwards onMessage/sendResponse and preserves disposer behavior', async () => {
    const adapter = makeMockAdapter();
    const boundary = toAdapterBoundaryContract(adapter);

    let called = 0;
    const disposer = boundary.onMessage(async (_msg) => {
      called += 1;
    });

    // Exercise forwarded sendResponse path
    const response: UnifiedResponse = {
      inReplyTo: 'm-1',
      userId: 'tg:1',
      conversationId: 'tg:chat:1',
      text: 'ok',
      format: 'text',
      platform: {
        platform: 'telegram',
        chatId: 1,
        messageId: 1,
        chatType: 'private',
      },
    };
    await boundary.sendResponse(response);

    // Ensure handler wiring works through adapter mock
    const onMessageMock = adapter.onMessage as ReturnType<typeof mock>;
    const registeredHandler = onMessageMock.mock.calls[0]?.[0] as MessageHandler;
    await registeredHandler(makeMessage());
    expect(called).toBe(1);

    disposer();
  });
});
