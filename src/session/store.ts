/**
 * src/session/store.ts
 * SessionStore implementations: InMemorySessionStore, RedisSessionStore,
 * and the createSessionStore factory that also supports MeridianSessionStore.
 */
import { MeridianSessionStore } from './meridian-store.js';
import type { SessionStore, UserSession } from '../types/session.js';
import { SessionError } from '../utils/errors.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger({ module: 'session:store' });

// ─── InMemorySessionStore ─────────────────────────────────────────────────────
export class InMemorySessionStore implements SessionStore {
  private readonly store = new Map<string, { session: UserSession; expiresAt: number }>();
  private readonly ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ttlSeconds = 3600) {
    this.ttlMs = ttlSeconds * 1000;
    // Periodic cleanup of expired sessions
    this.cleanupTimer = setInterval(() => this.evictExpired(), 60_000);
    // Allow process to exit even if interval is active
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  async get(userId: string): Promise<UserSession | null> {
    const entry = this.store.get(userId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(userId);
      return null;
    }
    return entry.session;
  }

  async set(userId: string, session: UserSession): Promise<void> {
    this.store.set(userId, {
      session,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  async delete(userId: string): Promise<void> {
    this.store.delete(userId);
  }

  async has(userId: string): Promise<boolean> {
    const entry = this.store.get(userId);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(userId);
      return false;
    }
    return true;
  }

  async keys(): Promise<string[]> {
    this.evictExpired();
    return Array.from(this.store.keys());
  }

  async flush(): Promise<void> {
    this.store.clear();
  }

  async close(): Promise<void> {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.store.clear();
  }

  private evictExpired(): void {
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        evicted++;
      }
    }
    if (evicted > 0) {
      log.debug({ evicted }, 'Evicted expired sessions');
    }
  }

  /** Returns current store size (active sessions) */
  size(): number {
    this.evictExpired();
    return this.store.size;
  }
}

// ─── RedisSessionStore ────────────────────────────────────────────────────────
export class RedisSessionStore implements SessionStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any | null = null;
  private readonly ttlSeconds: number;
  private readonly keyPrefix = 'self-bot:session:';

  constructor(redisUrl: string, ttlSeconds = 3600) {
    this.ttlSeconds = ttlSeconds;
    this.initClient(redisUrl);
  }

  private initClient(redisUrl: string): void {
    // Dynamic import to avoid hard dependency when Redis is not used
    import('ioredis')
      .then(({ default: Redis }) => {
        this.client = new Redis(redisUrl, {
          lazyConnect: true,
          enableReadyCheck: true,
          maxRetriesPerRequest: 3,
        });
        this.client.on('error', (err: Error) => {
          log.error({ err }, 'Redis client error');
        });
        return this.client.connect();
      })
      .catch((err: unknown) => {
        log.error({ err }, 'Failed to initialize Redis client');
      });
  }

  private key(userId: string): string {
    return `${this.keyPrefix}${userId}`;
  }

  private ensureClient(): void {
    if (this.client === null) {
      throw new SessionError('Redis client not initialized');
    }
  }

  async get(userId: string): Promise<UserSession | null> {
    this.ensureClient();
    try {
      const raw = await this.client.get(this.key(userId));
      if (!raw) return null;
      return JSON.parse(raw) as UserSession;
    } catch (err) {
      log.error({ err, userId }, 'Redis get failed');
      throw new SessionError(`Failed to get session for ${userId}`);
    }
  }

  async set(userId: string, session: UserSession): Promise<void> {
    this.ensureClient();
    try {
      await this.client.set(
        this.key(userId),
        JSON.stringify(session),
        'EX',
        this.ttlSeconds,
      );
    } catch (err) {
      log.error({ err, userId }, 'Redis set failed');
      throw new SessionError(`Failed to save session for ${userId}`);
    }
  }

  async delete(userId: string): Promise<void> {
    this.ensureClient();
    await this.client.del(this.key(userId));
  }

  async has(userId: string): Promise<boolean> {
    this.ensureClient();
    const exists = await this.client.exists(this.key(userId));
    return exists === 1;
  }

  async keys(): Promise<string[]> {
    this.ensureClient();
    const keys: string[] = await this.client.keys(`${this.keyPrefix}*`);
    return keys.map((k: string) => k.slice(this.keyPrefix.length));
  }

  async flush(): Promise<void> {
    this.ensureClient();
    const keys: string[] = await this.client.keys(`${this.keyPrefix}*`);
    if (keys.length > 0) {
      await this.client.del(...keys);
    }
  }

  async close(): Promise<void> {
    if (this.client !== null) {
      await this.client.quit();
      this.client = null;
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────
/**
 * Instantiate and return a `SessionStore` for the given backend type.
 *
 * - `'memory'`   — `InMemorySessionStore`. No external dependencies. Data is
 *                  lost on process restart. Default when `SESSION_STORE` is unset.
 * - `'redis'`    — `RedisSessionStore`. Requires a running Redis instance.
 *                  Pass `redisUrl` (defaults to `redis://localhost:6379`).
 * - `'meridian'` — `MeridianSessionStore`. Persists sessions to a Meridian MCP
 *                  server. Requires `meridianUrl` (`MERIDIAN_SESSION_URL` env var).
 *                  Throws if `meridianUrl` is absent. Gracefully degrades to an
 *                  in-memory-only mode if the Meridian server is unreachable at
 *                  startup (logged as a warning rather than throwing).
 *
 * @param type    - Backend selector: `'memory'`, `'redis'`, or `'meridian'`.
 * @param options - Backend-specific configuration.
 * @param options.ttlSeconds   - Session TTL in seconds (default: 3600).
 * @param options.redisUrl     - Redis connection string (redis type only).
 * @param options.meridianUrl  - Meridian MCP server base URL (meridian type only).
 * @returns A ready-to-use `SessionStore` instance.
 * @throws {Error} When `type === 'meridian'` and `options.meridianUrl` is not provided.
 */
export async function createSessionStore(
  type: 'memory' | 'redis' | 'meridian',
  options: { ttlSeconds?: number; redisUrl?: string; meridianUrl?: string } = {},
): Promise<SessionStore> {
  if (type === 'meridian') {
    const url = options.meridianUrl;
    if (!url) {
      throw new Error(
        'createSessionStore: meridianUrl is required when SESSION_STORE=meridian. Set MERIDIAN_SESSION_URL env var.',
      );
    }
    const store = new MeridianSessionStore(url, options.ttlSeconds);
    await store.load();
    return store;
  }

  if (type === 'redis') {
    const url = options.redisUrl ?? 'redis://localhost:6379';
    return new RedisSessionStore(url, options.ttlSeconds);
  }
  return new InMemorySessionStore(options.ttlSeconds);
}
