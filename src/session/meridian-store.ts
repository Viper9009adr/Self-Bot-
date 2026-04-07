/**
 * src/session/meridian-store.ts
 * MCP-backed SessionStore that persists sessions to a Meridian MCP server.
 */
import { MCPClient } from '../mcp/client.js';
import type { SessionStore, UserSession } from '../types/session.js';
import type { ToolContext } from '../types/tool.js';
import { MeridianFetchOutcome, ToolErrorCode } from '../types/tool.js';
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

interface FetchSnapshot {
  content: string;
  outcome: MeridianFetchOutcome;
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
 * KNOWN LIMITATIONS:
 * - Cross-process TTL enforcement not supported: keys() may return expired userIds from other processes
 * - indexLock is in-process only: concurrent processes may cause duplicate/missing index entries
 * - callTool never throws — all paths inspect result.success and degrade gracefully without throwing
 *
 * OFFLINE MODE:
 * - When Meridian is unreachable, the store enters "offline mode" using in-memory cache only
 * - isOnline() method indicates current connectivity status
 * - Connection failures are logged appropriately
 */
export class MeridianSessionStore implements SessionStore {
  private readonly client: MCPClient;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, StoredSession>();
  private readonly locks = new Map<string, Promise<void>>();
  private indexLock: Promise<void> = Promise.resolve();
  /** Flag indicating whether Meridian is reachable */
  private online = true;

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
      this.online = true;
      log.info('MeridianSessionStore: connected to Meridian MCP');
    } catch (err) {
      this.online = false;
      log.warn({ err }, 'MeridianSessionStore: Meridian MCP unreachable — starting with ephemeral cache only');
    }
  }

  /**
   * Check if the store is currently online (connected to Meridian).
   * Returns false if Meridian is unreachable (cache-only mode).
   */
  isOnline(): boolean {
    return this.online;
  }

  /**
   * Mark the store as offline (used when connection errors are detected).
   */
  private _setOffline(): void {
    if (this.online) {
      this.online = false;
      log.warn('MeridianSessionStore: switched to offline mode (cache-only)');
    }
  }

  /**
   * Check if an error indicates the MCP client is not connected.
   */
  private _isNotConnectedError(errorCode: ToolErrorCode | undefined, errorMessage: string | undefined): boolean {
    return errorCode === ToolErrorCode.WORKER_UNAVAILABLE && errorMessage === 'MCP client not connected';
  }

  /**
   * Retrieve the session for a user, checking the in-memory cache first then
   * fetching from Meridian on a cache miss. Returns `null` if the session does
   * not exist or has expired. Expired cache entries are evicted lazily (no
   * immediate remote delete).
   *
   * When offline (Meridian unreachable), only uses in-memory cache.
   *
   * @param userId - Platform-prefixed user identifier (e.g. `tg:123456789`).
   * @returns The stored `UserSession`, or `null` only for canonical terminal
   * fetch outcomes (`not_found`, `ttl_expired`) and local TTL expiry.
   * @throws Error When fetch outcome is indeterminate (transport/parsing/
   * malformed payload paths). This is intentional so callers do not silently
   * treat transient faults as reset-worthy misses.
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

    // 2. If offline, skip remote fetch and return null (cache miss)
    if (!this.online) {
      log.debug({ userId }, 'MeridianSessionStore.get: offline, skipping remote fetch');
      return null;
    }

    // 3. Fetch from Meridian (with one retry on transient failure)
    let result = await this.client.callTool(
      'fetch_context',
      { task_id: `${SESSION_KEY_PREFIX}${userId}`, agent: AGENT_CODE, mode: 'latest' },
      MERIDIAN_CTX,
    );

    // Retry once on any non-connection failure (e.g. transient gRPC errors on cold start)
    if (!result.success && !this._isNotConnectedError(result.errorCode, result.error)) {
      log.warn({ userId, error: result.error }, 'MeridianSessionStore.get: fetch_context failed, retrying once');
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      result = await this.client.callTool(
        'fetch_context',
        { task_id: `${SESSION_KEY_PREFIX}${userId}`, agent: AGENT_CODE, mode: 'latest' },
        MERIDIAN_CTX,
      );
    }

    // 4. Handle connection failure - mark offline and do not treat as reset
    if (!result.success) {
      // Check for "not connected" error specifically
      if (this._isNotConnectedError(result.errorCode, result.error)) {
        this._setOffline();
        log.warn({ userId, error: result.error }, 'MeridianSessionStore.get: connection failed, using cache-only mode');
        throw new Error('Session fetch indeterminate: transport unavailable');
      }

      log.warn({ userId, error: result.error }, 'MeridianSessionStore.get: fetch_context failed after retry (non-terminal)');
      throw new Error(`Session fetch indeterminate: ${result.error ?? 'unknown fetch_context failure'}`);
    }

    // 5. Extract normalized snapshot (v2 text+outcome, fallback v1 content)
    const snapshot = this._extractFirstItem(result.data);
    if (!snapshot) {
      throw new Error('Session fetch indeterminate: empty fetch_context payload');
    }

    if (snapshot.outcome === MeridianFetchOutcome.NOT_FOUND) {
      return null;
    }
    if (snapshot.outcome === MeridianFetchOutcome.TTL_EXPIRED) {
      this.cache.delete(userId);
      return null;
    }
    if (snapshot.outcome !== MeridianFetchOutcome.OK) {
      throw new Error(`Session fetch indeterminate: outcome=${snapshot.outcome}`);
    }

    // 6. Deserialize
    const stored = this._deserialize(snapshot.content);
    if (!stored) {
      throw new Error('Session fetch indeterminate: malformed stored session payload');
    }

    // 7. Check TTL
    if (Date.now() >= stored.expiresAt) {
      // Expired in Meridian — lazy cleanup (no immediate remote delete to avoid write-on-read)
      this.cache.delete(userId);
      return null;
    }

    // 8. Populate cache and return
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
   * When offline, only updates local cache (Meridian persistence skipped).
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

      // Skip Meridian persistence if offline
      if (!this.online) {
        log.debug({ userId }, 'MeridianSessionStore.set: offline, local cache updated only');
        return;
      }

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
        // Check for connection failure
        if (this._isNotConnectedError(result.errorCode, result.error)) {
          this._setOffline();
          log.warn(
            { userId, error: result.error },
            'MeridianSessionStore.set: connection failed, switching to cache-only mode',
          );
        } else {
          log.warn(
            { userId, error: result.error },
            'MeridianSessionStore.set: store_context failed — local cache updated only',
          );
        }
      } else {
        log.info(
          { userId, sessionId: (result.data as Record<string, unknown>)?.['session_id'] },
          'MeridianSessionStore.set: persisted to Meridian',
        );
      }

      // Add to session index on first set only (if online)
      if (isNew && this.online) {
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

      // Skip Meridian if offline
      if (!this.online) {
        log.debug({ userId }, 'MeridianSessionStore.delete: offline, removed from cache only');
        return;
      }

      const result = await this.client.callTool(
        'delete_context',
        { task_id: `${SESSION_KEY_PREFIX}${userId}` },
        MERIDIAN_CTX,
      );

      if (!result.success) {
        // Check for connection failure
        if (this._isNotConnectedError(result.errorCode, result.error)) {
          this._setOffline();
          log.warn(
            { userId, error: result.error },
            'MeridianSessionStore.delete: connection failed, switching to cache-only mode',
          );
        } else {
          log.warn(
            { userId, error: result.error },
            'MeridianSessionStore.delete: delete_context failed — removed from local cache only',
          );
        }
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
   *
   * Returns empty array if offline.
   */
  async keys(): Promise<string[]> {
    // Return empty array if offline
    if (!this.online) {
      log.debug('MeridianSessionStore.keys: offline, returning []');
      return [];
    }
    return this._fetchIndex();
  }

  /**
   * Flush (CLEAR) all sessions — matches SessionStore interface contract.
   *
   * Skips remote operations if offline (only clears local cache).
   */
  async flush(): Promise<void> {
    // If offline, just clear local cache
    if (!this.online) {
      log.debug('MeridianSessionStore.flush: offline, clearing cache only');
      this.cache.clear();
      this.locks.clear();
      return;
    }

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
      // Skip if offline
      if (!this.online) {
        return;
      }

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
        // Check for connection failure
        if (this._isNotConnectedError(result.errorCode, result.error)) {
          this._setOffline();
        }
        log.warn({ userId, error: result.error }, 'MeridianSessionStore._indexAdd: store_context failed');
      }
    });
  }

  private _indexRemove(userId: string): Promise<void> {
    return this._withIndexLock(async () => {
      // Skip if offline
      if (!this.online) {
        return;
      }

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
        // Check for connection failure
        if (this._isNotConnectedError(result.errorCode, result.error)) {
          this._setOffline();
        }
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
      // Check for connection failure
      if (this._isNotConnectedError(result.errorCode, result.error)) {
        this._setOffline();
      }
      log.warn({ error: result.error }, 'MeridianSessionStore._fetchIndex: fetch_context failed — returning []');
      return [];
    }

    const firstIndexItem = this._extractFirstItem(result.data);
    if (!firstIndexItem) return [];
    if (firstIndexItem.outcome !== MeridianFetchOutcome.OK) {
      return [];
    }

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
   * Extract and normalize the first fetch_context item.
   * FastMCP may return results as a JSON array OR serialize each element as a
   * separate MCP content block (so callTool sees only the first element as a
   * plain object). This helper normalizes both shapes.
   *
   * Compatibility contract:
   * - v2 payloads: `{ text, outcome }` (preferred, explicit outcome semantics)
   * - v1 payloads: `{ content }` (legacy fallback, treated as OK parse path)
   *
   * For mixed payloads, `text` is preferred over `content` to preserve v2
   * semantics and avoid silently overriding explicit outcomes.
   */
  private _extractFirstItem(data: unknown): FetchSnapshot | null {
    if (!data) return null;

    log.debug({
      dataType: Array.isArray(data) ? 'array' : typeof data,
      dataShape: Array.isArray(data) ? `array[${(data as unknown[]).length}]` : Object.keys(data as object),
      dataPreview: JSON.stringify(data).substring(0, 200),
    }, '_extractFirstItem: parsing data');
    
    // Array shape: [{session_id, content, ...}, ...]
    if (Array.isArray(data)) {
      const first = data[0] as { text?: string; content?: string; outcome?: string } | undefined;
      if (!first) return null;

      // v2: prefer text+outcome. v1 fallback: content implies OK parse path.
      const content = typeof first.text === 'string' ? first.text : first.content;
      if (typeof content !== 'string') return null;
      const outcome = this._normalizeOutcome(first.outcome, typeof first.text === 'string');
      
      log.debug({ 
        hasText: !!first.text, 
        hasContent: !!first.content,
        contentLength: content.length 
      }, '_extractFirstItem: extracted from array');
      
      return { content, outcome };
    }
    
    // Single-object shape: {session_id, content, ...} or {text: "...", ...}
    const obj = data as Record<string, unknown>;
    
    // Check text field first, then content field for backward compatibility.
    const content = typeof obj['text'] === 'string' ? obj['text'] : obj['content'];
    if (typeof content !== 'string') return null;
    const outcome = this._normalizeOutcome(
      typeof obj['outcome'] === 'string' ? obj['outcome'] : undefined,
      typeof obj['text'] === 'string',
    );
    
    log.debug({ 
      hasText: !!obj['text'], 
      hasContent: !!obj['content'],
      contentLength: content.length 
    }, '_extractFirstItem: extracted from object');
    
    return { content: content as string, outcome };
  }

  private _normalizeOutcome(rawOutcome: string | undefined, hasTextField: boolean): MeridianFetchOutcome {
    if (rawOutcome === MeridianFetchOutcome.NOT_FOUND) return MeridianFetchOutcome.NOT_FOUND;
    if (rawOutcome === MeridianFetchOutcome.TTL_EXPIRED) return MeridianFetchOutcome.TTL_EXPIRED;
    if (rawOutcome === MeridianFetchOutcome.OK) return MeridianFetchOutcome.OK;
    if (rawOutcome === MeridianFetchOutcome.EMPTY) return MeridianFetchOutcome.EMPTY;
    if (rawOutcome === MeridianFetchOutcome.MALFORMED) return MeridianFetchOutcome.MALFORMED;
    if (rawOutcome === MeridianFetchOutcome.TRANSIENT_FAILURE) return MeridianFetchOutcome.TRANSIENT_FAILURE;
    // v1 fallback path: content-only payloads had no explicit outcome.
    // Unknown/missing outcomes on v2-style payloads are treated as MALFORMED
    // (non-terminal) so callers do not reset session state by accident.
    return hasTextField ? MeridianFetchOutcome.MALFORMED : MeridianFetchOutcome.OK;
  }

  private _deserialize(content: string): StoredSession | null {
    // Validate this is DSL content before attempting regex match
    if (!content.startsWith('§F:')) {
      log.warn({
        rawContentPreview: content.substring(0, 200) + (content.length > 200 ? '...' : ''),
      }, 'MeridianSessionStore._deserialize: content does not start with §F: — not DSL content');
      return null;
    }

    const match = content.match(/¶data:([^¶]*)¶/);
    if (!match || match[1] === undefined) {
      log.warn('MeridianSessionStore._deserialize: no data field in DSL content');
      return null;
    }

    log.debug({
      dataFieldLength: match[1].length,
      dataFieldPreview: match[1].substring(0, 50) + (match[1].length > 50 ? '...' : ''),
    }, '_deserialize: extracted data field');

    try {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const parsed = JSON.parse(decoded) as StoredSession;

      if (!parsed.session || typeof parsed.expiresAt !== 'number') {
        // Fallback: attempt double-decode (content was base64-encoded twice)
        try {
          const doubleDecoded = Buffer.from(decoded, 'base64').toString('utf8');
          const doubleParsed = JSON.parse(doubleDecoded) as StoredSession;
          if (doubleParsed.session && typeof doubleParsed.expiresAt === 'number') {
            log.warn('MeridianSessionStore._deserialize: detected double-encoded session; recovered');
            return doubleParsed;
          }
        } catch { /* ignore — fall through to null */ }
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
      `¶outcome:${MeridianFetchOutcome.OK}¶\n` +
      `¶data:${Buffer.from(JSON.stringify(stored)).toString('base64')}¶\n` +
      `§`
    );
  }

  private async _persistAll(): Promise<void> {
    // Skip if offline
    if (!this.online) {
      log.debug('MeridianSessionStore._persistAll: offline, skipping persistence');
      return;
    }

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
          // Check for connection failure
          if (this._isNotConnectedError(result.errorCode, result.error)) {
            this._setOffline();
          }
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
