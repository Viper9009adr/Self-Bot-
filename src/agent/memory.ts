/**
 * src/agent/memory.ts
 * ConversationMemory with sliding window and token counting.
 * MemoryPolicy is defined here and imported by session types.
 */
import type { HistoryMessage } from '../types/message.js';
import type { MemoryPolicy } from '../types/session.js';
import { DEFAULT_MEMORY_POLICY } from '../types/session.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger({ module: 'agent:memory' });

// ─── Token counting ───────────────────────────────────────────────────────────
/**
 * Rough token count estimate: 1 token ≈ 4 characters (English text).
 * For production, replace with tiktoken or similar.
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens for a list of messages.
 */
export function estimateMessagesTokenCount(messages: HistoryMessage[]): number {
  return messages.reduce((acc, m) => {
    // Add 4 tokens per message for message envelope (role, separators)
    return acc + estimateTokenCount(m.content) + 4;
  }, 0);
}

// ─── ConversationMemory ───────────────────────────────────────────────────────
export class ConversationMemory {
  private messages: HistoryMessage[] = [];
  private readonly policy: MemoryPolicy;

  constructor(
    initialMessages: HistoryMessage[] = [],
    policy: MemoryPolicy = DEFAULT_MEMORY_POLICY,
  ) {
    this.policy = policy;
    this.messages = [...initialMessages];
  }

  /**
   * Add a message and trim to fit within the token budget.
   */
  append(message: Omit<HistoryMessage, 'timestamp'>): void {
    const fullMessage: HistoryMessage = {
      ...message,
      timestamp: new Date().toISOString(),
    };

    this.messages.push(fullMessage);
    this.trim();
  }

  /**
   * Get all messages (respecting the policy window).
   */
  getMessages(): HistoryMessage[] {
    return [...this.messages];
  }

  /**
   * Get messages formatted for LLM API consumption.
   * Returns objects with role and content fields only.
   */
  getLLMMessages(): Array<{ role: string; content: string }> {
    return this.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }

  /**
   * Get current token count estimate.
   */
  getTokenCount(): number {
    return estimateMessagesTokenCount(this.messages);
  }

  /**
   * Available token budget for next message + response.
   */
  getAvailableTokens(): number {
    const used = this.getTokenCount();
    const budget = this.policy.maxTokens - this.policy.reservedResponseTokens;
    return Math.max(0, budget - used);
  }

  /**
   * Check if adding a message would exceed the token budget.
   */
  wouldExceedBudget(message: string): boolean {
    const msgTokens = estimateTokenCount(message) + 4;
    return this.getAvailableTokens() < msgTokens;
  }

  /**
   * Clear all messages.
   */
  clear(): void {
    this.messages = [];
  }

  /**
   * Number of messages in the window.
   */
  get length(): number {
    return this.messages.length;
  }

  /**
   * Trim messages using the configured eviction strategy.
   */
  private trim(): void {
    switch (this.policy.evictionStrategy) {
      case 'sliding_window':
        this.trimSlidingWindow();
        break;
      case 'trim_oldest':
        this.trimOldest();
        break;
      case 'summarize':
        // Summarize is a no-op here — requires LLM call, handled at agent level
        this.trimSlidingWindow();
        break;
    }
  }

  private trimSlidingWindow(): void {
    const budget = this.policy.maxTokens - this.policy.reservedResponseTokens;
    let trimCount = 0;

    while (this.messages.length > 2) {
      const currentTokens = estimateMessagesTokenCount(this.messages);
      if (currentTokens <= budget) break;

      // Find first non-system message to remove
      const firstNonSystem = this.messages.findIndex((m) => m.role !== 'system');
      if (firstNonSystem === -1) break;

      this.messages.splice(firstNonSystem, 1);
      trimCount++;
    }

    if (trimCount > 0) {
      log.debug({ trimCount, remaining: this.messages.length }, 'Trimmed conversation history');
    }
  }

  private trimOldest(): void {
    const budget = this.policy.maxTokens - this.policy.reservedResponseTokens;

    while (
      this.messages.length > 1 &&
      estimateMessagesTokenCount(this.messages) > budget
    ) {
      this.messages.shift();
    }
  }

  /**
   * Snapshot current state (for persistence).
   */
  toSnapshot(): { messages: HistoryMessage[]; policy: MemoryPolicy } {
    return {
      messages: [...this.messages],
      policy: { ...this.policy },
    };
  }

  /**
   * Restore from a snapshot.
   */
  static fromSnapshot(snapshot: {
    messages: HistoryMessage[];
    policy: MemoryPolicy;
  }): ConversationMemory {
    return new ConversationMemory(snapshot.messages, snapshot.policy);
  }
}
