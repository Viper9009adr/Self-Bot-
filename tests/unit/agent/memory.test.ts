/**
 * tests/unit/agent/memory.test.ts
 * Unit tests for ConversationMemory.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ConversationMemory,
  estimateTokenCount,
  estimateMessagesTokenCount,
} from '../../../src/agent/memory.js';
import type { HistoryMessage } from '../../../src/types/message.js';
import type { MemoryPolicy } from '../../../src/types/session.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeMsg(
  role: HistoryMessage['role'],
  content: string,
): Omit<HistoryMessage, 'timestamp'> {
  return { role, content };
}

const TIGHT_POLICY: MemoryPolicy = {
  maxTokens: 100,
  evictionStrategy: 'sliding_window',
  countSystemPrompt: false,
  reservedResponseTokens: 20,
};

const LOOSE_POLICY: MemoryPolicy = {
  maxTokens: 10000,
  evictionStrategy: 'sliding_window',
  countSystemPrompt: false,
  reservedResponseTokens: 500,
};

// ─── Token counting tests ─────────────────────────────────────────────────────
describe('estimateTokenCount', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  it('estimates ~1 token per 4 chars', () => {
    expect(estimateTokenCount('abcd')).toBe(1);
    expect(estimateTokenCount('abcde')).toBe(2); // ceil(5/4)
    expect(estimateTokenCount('a'.repeat(100))).toBe(25);
  });
});

describe('estimateMessagesTokenCount', () => {
  it('returns 0 for empty array', () => {
    expect(estimateMessagesTokenCount([])).toBe(0);
  });

  it('adds 4 tokens per message envelope', () => {
    const msgs: HistoryMessage[] = [
      { role: 'user', content: 'test', timestamp: '' }, // 1 token content + 4 envelope = 5
    ];
    expect(estimateMessagesTokenCount(msgs)).toBe(5);
  });
});

// ─── ConversationMemory tests ─────────────────────────────────────────────────
describe('ConversationMemory', () => {
  describe('basic operations', () => {
    it('starts empty', () => {
      const mem = new ConversationMemory();
      expect(mem.length).toBe(0);
      expect(mem.getMessages()).toHaveLength(0);
    });

    it('appends messages', () => {
      const mem = new ConversationMemory([], LOOSE_POLICY);
      mem.append(makeMsg('user', 'Hello'));
      mem.append(makeMsg('assistant', 'Hi there!'));
      expect(mem.length).toBe(2);
    });

    it('adds timestamp to appended messages', () => {
      const mem = new ConversationMemory([], LOOSE_POLICY);
      mem.append(makeMsg('user', 'test'));
      const msgs = mem.getMessages();
      expect(msgs[0]!.timestamp).toBeTruthy();
      expect(msgs[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('returns a copy of messages (immutable)', () => {
      const mem = new ConversationMemory([], LOOSE_POLICY);
      mem.append(makeMsg('user', 'test'));
      const msgs1 = mem.getMessages();
      const msgs2 = mem.getMessages();
      expect(msgs1).not.toBe(msgs2); // different array references
      expect(msgs1).toEqual(msgs2);
    });

    it('clears all messages', () => {
      const mem = new ConversationMemory([], LOOSE_POLICY);
      mem.append(makeMsg('user', 'test1'));
      mem.append(makeMsg('assistant', 'reply'));
      mem.clear();
      expect(mem.length).toBe(0);
    });
  });

  describe('getLLMMessages', () => {
    it('returns role+content only', () => {
      const mem = new ConversationMemory([], LOOSE_POLICY);
      mem.append(makeMsg('user', 'Hello'));
      mem.append(makeMsg('assistant', 'Hi'));
      const llmMsgs = mem.getLLMMessages();
      expect(llmMsgs).toHaveLength(2);
      expect(llmMsgs[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(llmMsgs[1]).toEqual({ role: 'assistant', content: 'Hi' });
      // Should not have timestamp
      expect((llmMsgs[0] as Record<string, unknown>)['timestamp']).toBeUndefined();
    });
  });

  describe('sliding window eviction', () => {
    it('trims old messages when over budget', () => {
      const mem = new ConversationMemory([], TIGHT_POLICY);
      // Each message is ~25 chars → ~7 tokens + 4 envelope = 11 tokens
      // Budget: 100 - 20 = 80 tokens
      // Add many messages to exceed budget
      for (let i = 0; i < 20; i++) {
        mem.append(makeMsg(i % 2 === 0 ? 'user' : 'assistant', `Message number ${i} content here`));
      }
      // Should have trimmed
      expect(mem.length).toBeLessThan(20);
      expect(mem.getTokenCount()).toBeLessThanOrEqual(TIGHT_POLICY.maxTokens);
    });

    it('preserves system messages during trim', () => {
      const mem = new ConversationMemory([], TIGHT_POLICY);
      mem.append(makeMsg('system', 'You are a bot.'));
      // Add lots of user/assistant messages
      for (let i = 0; i < 20; i++) {
        mem.append(makeMsg(i % 2 === 0 ? 'user' : 'assistant', `Message number ${i} long content here`));
      }
      // System message should survive
      const msgs = mem.getMessages();
      const hasSystem = msgs.some((m) => m.role === 'system');
      expect(hasSystem).toBe(true);
    });

    it('retains at least 2 messages', () => {
      const mem = new ConversationMemory([], TIGHT_POLICY);
      // One huge message
      mem.append(makeMsg('user', 'a'.repeat(10000)));
      mem.append(makeMsg('assistant', 'b'.repeat(10000)));
      // Even though budget is blown, keep at least 2
      expect(mem.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('token budget', () => {
    it('returns correct available tokens', () => {
      const mem = new ConversationMemory([], LOOSE_POLICY);
      const initial = mem.getAvailableTokens();
      expect(initial).toBe(LOOSE_POLICY.maxTokens - LOOSE_POLICY.reservedResponseTokens);

      mem.append(makeMsg('user', 'a'.repeat(100))); // ~25 tokens + 4 = ~29
      const after = mem.getAvailableTokens();
      expect(after).toBeLessThan(initial);
    });

    it('wouldExceedBudget returns false when space available', () => {
      const mem = new ConversationMemory([], LOOSE_POLICY);
      expect(mem.wouldExceedBudget('short message')).toBe(false);
    });

    it('wouldExceedBudget returns true when full', () => {
      const tightMem = new ConversationMemory([], TIGHT_POLICY);
      // Fill it up
      for (let i = 0; i < 5; i++) {
        tightMem.append(makeMsg('user', 'a'.repeat(100)));
        tightMem.append(makeMsg('assistant', 'b'.repeat(100)));
      }
      // Now try adding a huge message
      expect(tightMem.wouldExceedBudget('a'.repeat(1000))).toBe(true);
    });
  });

  describe('snapshot / restore', () => {
    it('can serialize and restore', () => {
      const mem = new ConversationMemory([], LOOSE_POLICY);
      mem.append(makeMsg('user', 'Hello'));
      mem.append(makeMsg('assistant', 'Hi'));

      const snapshot = mem.toSnapshot();
      const restored = ConversationMemory.fromSnapshot(snapshot);

      expect(restored.length).toBe(mem.length);
      expect(restored.getMessages()).toEqual(mem.getMessages());
    });

    it('snapshot is a deep copy', () => {
      const mem = new ConversationMemory([], LOOSE_POLICY);
      mem.append(makeMsg('user', 'test'));

      const snapshot = mem.toSnapshot();
      // Mutate original
      mem.append(makeMsg('assistant', 'reply'));
      // Snapshot should be unaffected
      expect(snapshot.messages).toHaveLength(1);
    });
  });

  describe('initialization with existing history', () => {
    it('accepts initial messages', () => {
      const history: HistoryMessage[] = [
        { role: 'user', content: 'Hi', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'Hello!', timestamp: new Date().toISOString() },
      ];
      const mem = new ConversationMemory(history, LOOSE_POLICY);
      expect(mem.length).toBe(2);
    });
  });
});
