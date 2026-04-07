/**
 * src/session/manager.ts
 * SessionManager: create, get, update, and evict user sessions.
 */
import { nanoid } from 'nanoid';
import type { SessionStore, UserSession, MemoryPolicy } from '../types/session.js';
import { DEFAULT_MEMORY_POLICY } from '../types/session.js';
import type { HistoryMessage } from '../types/message.js';
import { SessionError } from '../utils/errors.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger({ module: 'session:manager' });

export interface SessionManagerOptions {
  store: SessionStore;
  defaultMaxHistoryTokens?: number;
  defaultMemoryPolicy?: MemoryPolicy;
}

export class SessionManager {
  private readonly store: SessionStore;
  private readonly defaultMaxHistoryTokens: number;
  private readonly defaultMemoryPolicy: MemoryPolicy;

  constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.defaultMaxHistoryTokens = options.defaultMaxHistoryTokens ?? 8000;
    this.defaultMemoryPolicy = options.defaultMemoryPolicy ?? DEFAULT_MEMORY_POLICY;
  }

  /**
   * Get an existing session or create a new one.
   *
   * Important memory-fix behavior: this method only creates a new session when
   * the store returns `null` (canonical reset path). If `store.get()` throws an
   * indeterminate fetch error (for example transient Meridian transport/parse
   * failures), the error is propagated and no reset session is created.
   */
  async getOrCreate(userId: string): Promise<UserSession> {
    const existing = await this.store.get(userId);
    if (existing) {
      log.trace({ userId }, 'Session hit');
      return existing;
    }
    return this.create(userId);
  }

  /**
   * Create a fresh session for a user.
   */
  async create(userId: string): Promise<UserSession> {
    const now = new Date().toISOString();
    const session: UserSession = {
      userId,
      history: [],
      maxHistoryTokens: this.defaultMaxHistoryTokens,
      memoryPolicy: { ...this.defaultMemoryPolicy, maxTokens: this.defaultMaxHistoryTokens },
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      meta: {},
      activeTaskIds: [],
      rateLimited: false,
      concurrentTaskCount: 0,
    };
    await this.store.set(userId, session);
    log.debug({ userId }, 'Session created');
    return session;
  }

  /**
   * Get a session by userId (returns null if not found/expired).
   */
  async get(userId: string): Promise<UserSession | null> {
    return this.store.get(userId);
  }

  /**
   * Persist an updated session.
   */
  async update(session: UserSession): Promise<void> {
    const updated: UserSession = {
      ...session,
      updatedAt: new Date().toISOString(),
    };
    await this.store.set(session.userId, updated);
  }

  /**
   * Append a message to history, trimming if over token limit.
   * Credentials must NEVER be passed here (enforced by HistoryMessage type).
   */
  async appendMessage(
    userId: string,
    message: Omit<HistoryMessage, 'timestamp'>,
  ): Promise<void> {
    const session = await this.getOrCreate(userId);

    const historyMessage: HistoryMessage = {
      ...message,
      timestamp: new Date().toISOString(),
    };

    session.history.push(historyMessage);
    session.messageCount += 1;

    // Trim history to stay within token limits using sliding window
    this.trimHistory(session);

    await this.update(session);
  }

  /**
   * Remove old messages to stay within maxHistoryTokens.
   * Uses a rough estimate: 1 token ≈ 4 characters.
   */
  private trimHistory(session: UserSession): void {
    const maxTokens =
      session.maxHistoryTokens -
      session.memoryPolicy.reservedResponseTokens;

    while (session.history.length > 2) {
      const totalChars = session.history.reduce(
        (acc, m) => acc + m.content.length,
        0,
      );
      const estimatedTokens = Math.ceil(totalChars / 4);
      if (estimatedTokens <= maxTokens) break;

      // Remove the oldest non-system message
      const firstNonSystem = session.history.findIndex((m) => m.role !== 'system');
      if (firstNonSystem === -1) break;
      session.history.splice(firstNonSystem, 1);
    }
  }

  /**
   * Evict (delete) a session.
   */
  async evict(userId: string): Promise<void> {
    await this.store.delete(userId);
    log.debug({ userId }, 'Session evicted');
  }

  /**
   * Clear all sessions.
   */
  async flush(): Promise<void> {
    await this.store.flush();
    log.info('All sessions flushed');
  }

  /**
   * Register a task as active for a user.
   */
  async addActiveTask(userId: string, taskId: string): Promise<void> {
    const session = await this.getOrCreate(userId);
    if (!session.activeTaskIds.includes(taskId)) {
      session.activeTaskIds.push(taskId);
      session.concurrentTaskCount = session.activeTaskIds.length;
    }
    await this.update(session);
  }

  /**
   * Unregister a completed task from a user's session.
   */
  async removeActiveTask(userId: string, taskId: string): Promise<void> {
    const session = await this.store.get(userId);
    if (!session) return;

    session.activeTaskIds = session.activeTaskIds.filter((id) => id !== taskId);
    session.concurrentTaskCount = session.activeTaskIds.length;
    await this.update(session);
  }

  /**
   * Get the number of concurrent tasks for a user.
   */
  async getConcurrentTaskCount(userId: string): Promise<number> {
    const session = await this.store.get(userId);
    return session?.concurrentTaskCount ?? 0;
  }

  /**
   * Update a session's metadata.
   */
  async updateMeta(userId: string, meta: Record<string, unknown>): Promise<void> {
    const session = await this.getOrCreate(userId);
    session.meta = { ...session.meta, ...meta };
    await this.update(session);
  }

  /**
   * List all active user IDs.
   */
  async listUsers(): Promise<string[]> {
    return this.store.keys();
  }

  /**
   * Generate a unique task ID.
   */
  generateTaskId(): string {
    return `task_${nanoid(12)}`;
  }

  /**
   * Close the underlying store.
   */
  async close(): Promise<void> {
    await this.store.close();
  }
}
