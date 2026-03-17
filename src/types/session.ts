/**
 * src/types/session.ts
 * UserSession, SessionStore interface, and MemoryPolicy.
 */
import type { HistoryMessage } from './message.js';

// ─── MemoryPolicy ─────────────────────────────────────────────────────────────
/**
 * Defines how conversation history is managed in a session.
 * Must be defined before UserSession to avoid circular dependencies.
 */
export interface MemoryPolicy {
  /** Maximum tokens allowed in history window */
  maxTokens: number;
  /** Strategy for evicting old messages when limit is reached */
  evictionStrategy: 'sliding_window' | 'summarize' | 'trim_oldest';
  /** Whether to include system message in token count */
  countSystemPrompt: boolean;
  /** Reserved tokens for the LLM response */
  reservedResponseTokens: number;
}

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = {
  maxTokens: 8000,
  evictionStrategy: 'sliding_window',
  countSystemPrompt: false,
  reservedResponseTokens: 1000,
};

// ─── UserSession ──────────────────────────────────────────────────────────────
export interface UserSession {
  /** Stable user identifier */
  userId: string;
  /** Current conversation history (never contains raw credentials) */
  history: HistoryMessage[];
  /** Maximum tokens allowed in this session's history */
  maxHistoryTokens: number;
  /** Memory management policy */
  memoryPolicy: MemoryPolicy;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last-activity timestamp */
  updatedAt: string;
  /** Number of messages processed in this session */
  messageCount: number;
  /** Metadata bag for platform-specific state */
  meta: Record<string, unknown>;
  /** Active task IDs currently processing */
  activeTaskIds: string[];
  /** Whether this user is currently rate-limited */
  rateLimited: boolean;
  /** Number of concurrent tasks for this user */
  concurrentTaskCount: number;
}

// ─── SessionStore ─────────────────────────────────────────────────────────────
export interface SessionStore {
  get(userId: string): Promise<UserSession | null>;
  set(userId: string, session: UserSession): Promise<void>;
  delete(userId: string): Promise<void>;
  has(userId: string): Promise<boolean>;
  /** Return all active user IDs (for maintenance/metrics) */
  keys(): Promise<string[]>;
  /** Flush all sessions (use with care) */
  flush(): Promise<void>;
  /** Close/disconnect underlying store */
  close(): Promise<void>;
}
