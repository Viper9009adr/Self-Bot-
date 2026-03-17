/**
 * src/access/store.ts
 * File-backed implementation of `IAllowlistStore`.
 *
 * Persists the allowlist as a pretty-printed JSON file (`.allowlist.json` by
 * default). Writes are serialised through a promise chain so concurrent
 * mutations never interleave on disk. A corrupt or structurally invalid file
 * is logged and treated as an empty allowlist — the bot continues running
 * rather than crashing at startup.
 */
import type { IAllowlistStore, AllowlistEntry, AllowlistData } from './types.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger({ module: 'access:store' });

/**
 * JSON-file-backed allowlist store.
 *
 * Reads and writes a single JSON file whose shape matches `AllowlistData`.
 * All in-memory mutations are immediately followed by an enqueued disk write,
 * so the file is always consistent with the in-memory state after the current
 * write queue drains.
 *
 * @example
 * ```ts
 * const store = new FileAllowlistStore('.allowlist.json');
 * await store.load();
 * await store.grant('tg:123456789', 'tg:987654321');
 * await store.close(); // flush before process exit
 * ```
 */
export class FileAllowlistStore implements IAllowlistStore {
  private data: AllowlistData = { version: 1, entries: [] };
  /** Serialises disk writes — each write waits for the previous one to finish. */
  private _writeQueue: Promise<void> = Promise.resolve();

  /**
   * @param filePath - Absolute or relative path to the JSON allowlist file.
   *                   The file is created on the first write if it does not exist.
   */
  constructor(private readonly filePath: string) {}

  /**
   * Read the allowlist file into memory.
   *
   * - If the file does not exist, the store starts with an empty allowlist (no error).
   * - If the file is corrupt JSON or has an invalid structure, a warning/error is
   *   logged and the store starts empty. The error is not re-thrown.
   *
   * Must be called once before any other method.
   */
  async load(): Promise<void> {
    if (!(await Bun.file(this.filePath).exists())) {
      return;
    }
    const raw = await Bun.file(this.filePath).text();
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray((parsed as AllowlistData)?.entries)) {
        log.warn({ filePath: this.filePath }, 'Allowlist file has invalid structure — starting with empty allowlist');
        return;
      }
      this.data = parsed as AllowlistData;
    } catch (err) {
      log.error({ err, filePath: this.filePath }, 'Allowlist file is corrupt — starting with empty allowlist');
      // do NOT rethrow; leave this.data at default
    }
  }

  /**
   * Check whether `userId` has an active allowlist entry.
   *
   * @param userId - Platform-prefixed user ID (e.g. `"tg:123456789"`).
   * @returns `true` if an entry exists for this user, `false` otherwise.
   */
  async isAllowed(userId: string): Promise<boolean> {
    return this.data.entries.some(e => e.userId === userId);
  }

  /**
   * Grant access to `userId`. Idempotent — if the user already has an entry,
   * `grantedAt` and `grantedBy` are refreshed to the current values.
   * Enqueues a disk write after updating the in-memory state.
   *
   * @param userId    - Platform-prefixed user ID to grant access to.
   * @param grantedBy - Platform-prefixed user ID of the owner issuing the grant.
   */
  async grant(userId: string, grantedBy: string): Promise<void> {
    const idx = this.data.entries.findIndex(e => e.userId === userId);
    const now = new Date().toISOString();
    if (idx >= 0) {
      this.data.entries[idx]!.grantedAt = now;
      this.data.entries[idx]!.grantedBy = grantedBy;
    } else {
      this.data.entries.push({ userId, grantedAt: now, grantedBy });
    }
    this.enqueueWrite();
  }

  /**
   * Remove the allowlist entry for `userId`.
   * No-op if the user is not currently listed.
   * Enqueues a disk write after updating the in-memory state.
   *
   * @param userId - Platform-prefixed user ID to revoke.
   */
  async revoke(userId: string): Promise<void> {
    this.data.entries = this.data.entries.filter(e => e.userId !== userId);
    this.enqueueWrite();
  }

  /**
   * Return a shallow copy of all current allowlist entries.
   * Mutations to the returned array do not affect the store's internal state.
   */
  async list(): Promise<AllowlistEntry[]> {
    return [...this.data.entries];
  }

  /**
   * Wait for all pending disk writes to complete.
   * Call this before process exit to avoid losing the last mutation.
   */
  async close(): Promise<void> {
    await this._writeQueue;
  }

  /** Write `data` to disk as pretty-printed JSON. */
  private async write(data: AllowlistData): Promise<void> {
    await Bun.write(this.filePath, JSON.stringify(data, null, 2));
  }

  /**
   * Append a write task to the serial write queue.
   * Errors are caught and logged so a failed write does not break the queue chain.
   */
  private enqueueWrite(): void {
    this._writeQueue = this._writeQueue
      .then(() => this.write(this.data))
      .catch((err: unknown) => log.error({ err }, 'Allowlist write failed'));
  }
}
