/**
 * src/session/meridian-store.ts
 * MCP-backed SessionStore that persists sessions to a Meridian MCP server.
 */
import { MCPClient } from '../mcp/client.js';
import type { SessionStore, UserSession } from '../types/session.js';
import type { ToolContext } from '../types/tool.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger({ module: 'session:meridian-store' });

/**
 * NOTE: MERIDIAN_CTX.taskId is a tracer-style identifier, NOT the Meridian protocol task_id parameter.
 * The task_id parameter for each callTool call is passed in the input object separately.
 */
const MERIDIAN_CTX: ToolContext = {
  userId: 'system',
  taskId: 'session-store',
  conversationId: 'session-store',
};

const SESSION_INDEX_TASK_ID = 'session-index';
const SESSION_KEY_PREFIX = 'session:';
const AGENT_CODE = 'SES';

interface StoredSession {
  session: UserSession;
  expiresAt: number; // Unix epoch milliseconds
}

/**
 * MCP-backed SessionStore that persists sessions to a Meridian MCP server.
 *
 * ARCHITECTURE:
 * - Each session stored as Meridian context entry with task_id = "session:<userId>"
 * - Index entry (task_id = "session-index") tracks all known userIds for keys() and flush()
 * - In-memory cache (Map) avoids round-trips on hot read paths
 * - Per-userId promise chain (_withLock) serializes concurrent set()/delete() for same user
 * - Shared indexLock promise chain (_withIndexLock) serializes _indexAdd/_indexRemove
 *
 * KNOWN LIMITATIONS (v1):
 * - Cross-process TTL enforcement not supported: keys() may return expired userIds from other processes
 * - indexLock is in-process only: concurrent processes may cause duplicate/missing index entries
 * - callTool never throws — all paths inspect result.success and degrade gracefully without throwing
 */
export class MeridianSessionStore implements SessionStore {
  private readonly client: MCPClient;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, StoredSession>();
  private readonly locks = new Map<string, Promise<void>>();
  private indexLock: Promise<void> = Promise.resolve();

  /**
   * @param serverUrl - Base URL of the Meridian MCP server (e.g. `https://meridian.example.com`).
   * @param ttlSeconds - Session TTL in seconds. Defaults to 3600 (1 hour).
   */
  constructor(serverUrl: string, ttlSeconds = 3600) {
    this.client = new MCPClient({ serverUrl, clientName: 'self-bot-session-store' });
    this.ttlMs = ttlSeconds * 1000;
  }

  /**
   * Connect to the Meridian MCP server.
   * NOT part of SessionStore interface — called by factory.
   */
  async load(): Promise<void> {
    try {
      await this.client.connect();
      log.info('MeridianSessionStore: connected to Meridian MCP');
    } catch (err) {
      log.warn({ err }, 'MeridianSessionStore: Meridian MCP unreachable — starting with ephemeral cache only');
    }
  }

  /**
   * Retrieve the session for a user, checking the in-memory cache first then
   * fetching from Meridian on a cache miss. Returns `null` if the session does
   * not exist or has expired. Expired cache entries are evicted lazily (no
   * immediate remote delete).
   *
   * @param userId - Platform-prefixed user identifier (e.g. `tg:123456789`).
   * @returns The stored `UserSession`, or `null` if absent or expired.
   */
  async get(userId: string): Promise<UserSession | null> {
    // 1. Cache hit — check TTL
    const cached = this.cache.get(userId);
    if (cached) {
      if (Date.now() < cached.expiresAt) {
        return cached.session;
      }
      this.cache.delete(userId);
      // Fall through to remote fetch — do NOT call delete() here (lazy cleanup only)
    }

    // 2. Fetch from Meridian
    const result = await this.client.callTool(
      'fetch_context',
      { task_id: `${SESSION_KEY_PREFIX}${userId}`, agent: AGENT_CODE, mode: 'latest' },
      MERIDIAN_CTX,
    );

    if (!result.success) {
      log.warn({ userId, error: result.error }, 'MeridianSessionStore.get: fetch_context failed');
      return null;
    }

    // 3. Extract the first item — Meridian may return an array or a single object
    const firstItem = this._extractFirstItem(result.data);
    if (!firstItem) return null;

    // 4. Deserialize
    const stored = this._deserialize(firstItem.content);
    if (!stored) return null;

    // 5. Check TTL
    if (Date.now() >= stored.expiresAt) {
      // Expired in Meridian — lazy cleanup (no immediate remote delete to avoid write-on-read)
      this.cache.delete(userId);
      return null;
    }

    // 6. Populate cache and return
    this.cache.set(userId, stored);
    log.info(
      { userId },
      'MeridianSessionStore.get: loaded from Meridian',
    );
    return stored.session;
  }

  /**
   * Persist a session for a user. Updates the in-memory cache immediately
   * (write-through) and asynchronously persists to Meridian via `store_context`.
   * If persistence fails, the cache is still updated and the failure is logged
   * as a warning (no throw). Concurrent calls for the same `userId` are
   * serialized via a per-user promise lock.
   *
   * @param userId - Platform-prefixed user identifier.
   * @param session - Session data to store.
   */
  async set(userId: string, session: UserSession): Promise<void> {
    return this._withLock(userId, async () => {
      const stored: StoredSession = {
        session,
        expiresAt: Date.now() + this.ttlMs,
      };

      // Track whether this is a new userId for index management
      const isNew = !this.cache.has(userId);

      // Update local cache immediately (write-through)
      this.cache.set(userId, stored);

      // Persist to Meridian
      const result = await this.client.callTool(
        'store_context',
        {
          task_id: `${SESSION_KEY_PREFIX}${userId}`,
          agent: AGENT_CODE,
          content: this._buildSessionDsl(userId, stored),
          format: 'dsl',
        },
        MERIDIAN_CTX,
      );

      if (!result.success) {
        log.warn(
          { userId, error: result.error },
          'MeridianSessionStore.set: store_context failed — local cache updated only',
        );
      } else {
        log.info(
          { userId, sessionId: (result.data as Record<string, unknown>)?.['session_id'] },
          'MeridianSessionStore.set: persisted to Meridian',
        );
      }

      // Add to session index on first set only
      if (isNew) {
        void this._indexAdd(userId);
      }
    });
  }

  /**
   * Delete the session for a user. Removes the entry from the in-memory cache
   * and calls `delete_context` on Meridian. If the remote delete fails, the
   * failure is logged as a warning (no throw). The session index is updated
   * asynchronously. Concurrent calls for the same `userId` are serialized.
   *
   * @param userId - Platform-prefixed user identifier.
   */
  async delete(userId: string): Promise<void> {
    return this._withLock(userId, async () => {
      this.cache.delete(userId);

      const result = await this.client.callTool(
        'delete_context',
        { task_id: `${SESSION_KEY_PREFIX}${userId}` },
        MERIDIAN_CTX,
      );

      if (!result.success) {
        log.warn(
          { userId, error: result.error },
          'MeridianSessionStore.delete: delete_context failed — removed from local cache only',
        );
      }

      void this._indexRemove(userId);
    });
  }

  /**
   * Returns `true` if a non-expired session exists for the user.
   * Delegates to `get()` — incurs the same cache/remote lookup cost.
   *
   * @param userId - Platform-prefixed user identifier.
   */
  async has(userId: string): Promise<boolean> {
    return (await this.get(userId)) !== null;
  }

  /**
   * Returns all known userIds from the Meridian session index.
   *
   * NOTE: may include expired sessions from other processes —
   * cross-process TTL enforcement is not supported. Callers must not rely on
   * returned IDs being live sessions.
   */
  async keys(): Promise<string[]> {
    return this._fetchIndex();
  }

  /**
   * Flush (CLEAR) all sessions — matches SessionStore interface contract.
   */
  async flush(): Promise<void> {
    // Get all known userIds
    const userIds = await this._fetchIndex();

    // Delete each session from Meridian
    await Promise.allSettled(
      userIds.map(async (userId) => {
        const result = await this.client.callTool(
          'delete_context',
          { task_id: `${SESSION_KEY_PREFIX}${userId}` },
          MERIDIAN_CTX,
        );
        if (!result.success) {
          log.warn(
            { userId, error: result.error },
            'MeridianSessionStore.flush: delete_context failed for userId',
          );
        }
      }),
    );

    // Delete the index itself
    const indexResult = await this.client.callTool(
      'delete_context',
      { task_id: SESSION_INDEX_TASK_ID },
      MERIDIAN_CTX,
    );
    if (!indexResult.success) {
      log.warn(
        { error: indexResult.error },
        'MeridianSessionStore.flush: delete_context for session-index failed',
      );
    }

    // Clear local cache and locks
    this.cache.clear();
    this.locks.clear();

    log.info({ count: userIds.length }, 'MeridianSessionStore.flush: all sessions cleared');
  }

  /**
   * Gracefully shut down the store. Persists all in-memory sessions to Meridian
   * (write-back, not flush/delete), disconnects the MCP client, and clears
   * local state. Unlike `flush()`, sessions are preserved in Meridian for use
   * by future process instances.
   */
  async close(): Promise<void> {
    // Persist in-memory sessions to Meridian before disconnecting
    // Do NOT call flush() — that would delete sessions; close() preserves them
    try {
      await this._persistAll();
    } catch (err) {
      log.warn({ err }, 'MeridianSessionStore.close: _persistAll failed — some sessions may not be persisted');
    }

    await this.client.disconnect();
    this.cache.clear();
    this.locks.clear();

    log.info('MeridianSessionStore: closed');
  }

  private _withLock(userId: string, fn: () => Promise<void>): Promise<void> {
    const existing = this.locks.get(userId) ?? Promise.resolve();
    const next = existing.then(fn, fn);
    this.locks.set(userId, next.catch(() => undefined));
    return next;
  }

  private _withIndexLock(fn: () => Promise<void>): Promise<void> {
    const next = this.indexLock.then(fn, fn);
    this.indexLock = next.catch(() => undefined);
    return next;
  }

  private _indexAdd(userId: string): Promise<void> {
    return this._withIndexLock(async () => {
      const current = await this._fetchIndex();
      if (current.includes(userId)) return;
      const updated = [...current, userId];
      const result = await this.client.callTool(
        'store_context',
        {
          task_id: SESSION_INDEX_TASK_ID,
          agent: AGENT_CODE,
          content: this._buildIndexDsl(updated),
          format: 'dsl',
        },
        MERIDIAN_CTX,
      );
      if (!result.success) {
        log.warn({ userId, error: result.error }, 'MeridianSessionStore._indexAdd: store_context failed');
      }
    });
  }

  private _indexRemove(userId: string): Promise<void> {
    return this._withIndexLock(async () => {
      const current = await this._fetchIndex();
      const updated = current.filter((id) => id !== userId);
      if (updated.length === current.length) return; // not present, no-op
      const result = await this.client.callTool(
        'store_context',
        {
          task_id: SESSION_INDEX_TASK_ID,
          agent: AGENT_CODE,
          content: this._buildIndexDsl(updated),
          format: 'dsl',
        },
        MERIDIAN_CTX,
      );
      if (!result.success) {
        log.warn({ userId, error: result.error }, 'MeridianSessionStore._indexRemove: store_context failed');
      }
    });
  }

  private async _fetchIndex(): Promise<string[]> {
    const result = await this.client.callTool(
      'fetch_context',
      { task_id: SESSION_INDEX_TASK_ID, agent: AGENT_CODE, mode: 'latest' },
      MERIDIAN_CTX,
    );

    if (!result.success) {
      log.warn({ error: result.error }, 'MeridianSessionStore._fetchIndex: fetch_context failed — returning []');
      return [];
    }

    const firstIndexItem = this._extractFirstItem(result.data);
    if (!firstIndexItem) return [];

    try {
      const match = firstIndexItem.content.match(/¶index:([A-Za-z0-9+/=]*)¶/);
      if (!match || match[1] === undefined) return [];
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((v): v is string => typeof v === 'string');
    } catch (err) {
      log.warn({ err }, 'MeridianSessionStore._fetchIndex: parse failed — returning []');
      return [];
    }
  }

  /**
   * Extract the first item from a Meridian fetch_context response.
   * FastMCP may return results as a JSON array OR serialize each element as a
   * separate MCP content block (so callTool sees only the first element as a
   * plain object). This helper normalizes both shapes.
   */
  private _extractFirstItem(data: unknown): { content: string } | null {
    if (!data) return null;
    // Array shape: [{session_id, content, ...}, ...]
    if (Array.isArray(data)) {
      const first = data[0] as { content?: string } | undefined;
      if (!first || typeof first.content !== 'string') return null;
      return first as { content: string };
    }
    // Single-object shape: {session_id, content, ...}
    const obj = data as Record<string, unknown>;
    if (typeof obj['content'] === 'string') {
      return { content: obj['content'] as string };
    }
    return null;
  }

  private _deserialize(content: string): StoredSession | null {
    try {
      const match = content.match(/¶data:([A-Za-z0-9+/=]*)¶/);
      if (!match || match[1] === undefined) {
        log.warn('MeridianSessionStore._deserialize: no data field in DSL content');
        return null;
      }
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const parsed = JSON.parse(decoded) as StoredSession;
      if (!parsed.session || typeof parsed.expiresAt !== 'number') {
        log.warn('MeridianSessionStore._deserialize: invalid StoredSession shape');
        return null;
      }
      return parsed;
    } catch (err) {
      log.warn({ err }, 'MeridianSessionStore._deserialize: parse failed');
      return null;
    }
  }

  private _buildSessionDsl(userId: string, stored: StoredSession): string {
    return (
      `§F:${AGENT_CODE}|T:${AGENT_CODE}|I:${SESSION_KEY_PREFIX}${userId}|P:1|S:C\n` +
      `¶data:${Buffer.from(JSON.stringify(stored)).toString('base64')}¶\n` +
      `§`
    );
  }

  private async _persistAll(): Promise<void> {
    const entries = Array.from(this.cache.entries());
    await Promise.allSettled(
      entries.map(async ([userId, stored]) => {
        const result = await this.client.callTool(
          'store_context',
          {
            task_id: `${SESSION_KEY_PREFIX}${userId}`,
            agent: AGENT_CODE,
            content: this._buildSessionDsl(userId, stored),
            format: 'dsl',
          },
          MERIDIAN_CTX,
        );
        if (!result.success) {
          log.warn(
            { userId, error: result.error },
            'MeridianSessionStore._persistAll: store_context failed for userId',
          );
        }
      }),
    );
    log.info({ count: entries.length }, 'MeridianSessionStore._persistAll: sessions persisted');
  }

  private _buildIndexDsl(userIds: string[]): string {
    return (
      `§F:${AGENT_CODE}|T:${AGENT_CODE}|I:${SESSION_INDEX_TASK_ID}|P:1|S:C\n` +
      `¶index:${Buffer.from(JSON.stringify(userIds)).toString('base64')}¶\n` +
      `§`
    );
  }
}
