/**
 * src/access/meridian-store.ts
 * MCP-backed allowlist store that persists grants/revocations to a Meridian
 * MCP server using store_context / fetch_context.
 *
 * FALLBACK CONTRACT:
 *   Every method that calls MCPClient.callTool() MUST inspect result.success.
 *   MCPClient.callTool() never throws — it returns { success: false } on all
 *   failures. Do NOT use try/catch as a substitute for result.success checks.
 *
 * KNOWN LIMITATION:
 *   External revocations performed directly on the Meridian server (not via
 *   this store's revoke() method) are not reflected in GatewayAuth's tokenCache
 *   until the affected JWT expires (TTL: 24 h).
 */
import { MCPClient } from '../mcp/client.js';
import type { IAllowlistStore, AllowlistEntry } from './types.js';
import type { ToolContext } from '../types/tool.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger({ module: 'access:meridian-store' });

/**
 * Typed ToolContext stub for all callTool() invocations from this store.
 * Module-level const — no cast, no `this.`, satisfies ToolContext fully.
 */
const MERIDIAN_CTX: ToolContext = {
  userId: 'system',
  taskId: 'meridian-store',
  conversationId: 'meridian-store',
};

/**
 * MCP-backed implementation of IAllowlistStore.
 * Stores allowlist state in a Meridian MCP server via store_context/fetch_context (task: self-bot-allowlist, agent: AUTH).
 * Falls back to an in-memory snapshot populated at load() time if MCP calls fail.
 */
export class MeridianAllowlistStore implements IAllowlistStore {
  private client: MCPClient;
  /** In-memory snapshot — populated by load(), kept eventually consistent by grant/revoke. */
  private snapshot: Map<string, AllowlistEntry> = new Map();

  /**
   * @param serverUrl - Base URL of the Meridian MCP server (e.g. "https://meridian.example.com").
   */
  constructor(serverUrl: string) {
    this.client = new MCPClient({ serverUrl, clientName: 'self-bot-meridian' });
  }

  /**
   * Connect to Meridian and load current allowlist into the in-memory snapshot.
   * Must be called once at startup before any other method.
   * On connect() failure: logs warn, snapshot stays empty, no throw.
   * On _fetchAll() failure: logs error, snapshot stays empty, no throw.
   */
  async load(): Promise<void> {
    try {
      await this.client.connect();
    } catch (err) {
      log.warn({ err }, 'Meridian MCP unreachable — starting with empty allowlist');
      return; // snapshot stays empty; owner still passes via isOwner() in GatewayAuth; no throw
    }
    await this._fetchAll();
  }

  /**
   * Return true if userId has an active allowlist entry.
   * Checks in-memory snapshot only — no MCP round-trip per request.
   */
  async isAllowed(userId: string): Promise<boolean> {
    return this.snapshot.has(userId);
  }

  /**
   * Grant access to userId. Persists to Meridian MCP, then updates snapshot.
   *
   * CRITICAL: Inspect result.success after callTool(). MCPClient.callTool never throws.
   * If false: log.error. Update snapshot regardless (optimistic local state).
   */
  async grant(userId: string, grantedBy: string): Promise<void> {
    const now = new Date().toISOString();
    // Update snapshot first (optimistic local state)
    this.snapshot.set(userId, { userId, grantedAt: now, grantedBy });
    // Persist full allowlist to Meridian
    const sessionId = await this._persist(Array.from(this.snapshot.values()));
    if (sessionId === null) {
      log.error(
        { userId, grantedBy },
        'MeridianAllowlistStore.grant: persist failed — local snapshot updated only',
      );
    } else {
      log.info({ userId, grantedBy, sessionId }, 'MeridianAllowlistStore: granted access');
    }
  }

  /**
   * Revoke access for userId. Persists to Meridian MCP, then removes from snapshot.
   *
   * CRITICAL: Inspect result.success after callTool(). MCPClient.callTool never throws.
   */
  async revoke(userId: string): Promise<void> {
    // Update snapshot first (optimistic local state)
    this.snapshot.delete(userId);
    // Persist full allowlist to Meridian
    const sessionId = await this._persist(Array.from(this.snapshot.values()));
    if (sessionId === null) {
      log.error(
        { userId },
        'MeridianAllowlistStore.revoke: persist failed — local snapshot updated only',
      );
    } else {
      log.info({ userId, sessionId }, 'MeridianAllowlistStore: revoked access');
    }
  }

  /**
   * Return a snapshot of all current allowlist entries.
   */
  async list(): Promise<AllowlistEntry[]> {
    return Array.from(this.snapshot.values());
  }

  /**
   * Disconnect from the Meridian MCP server.
   */
  async close(): Promise<void> {
    await this.client.disconnect();
  }

  /**
   * Persist the current allowlist to Meridian via store_context.
   *
   * NOTE: store_context is append-only — every call creates a new session.
   * mode='latest' on fetch always reads the most recently stored snapshot.
   * Session growth is unbounded but operationally acceptable for a personal bot.
   *
   * @returns session_id of the stored session, or null on MCP failure.
   */
  private async _persist(entries: AllowlistEntry[], dependsOn?: string): Promise<string | null> {
    const result = await this.client.callTool(
      'store_context',
      {
        task_id: 'self-bot-allowlist',
        agent: 'AUTH',
        content: JSON.stringify({ entries }),
        format: 'json',
        ...(dependsOn ? { depends_on: [dependsOn] } : {}),
      },
      MERIDIAN_CTX,
    );

    if (!result.success) {
      log.error({ error: result.error }, '_persist: store_context failed');
      return null;
    }

    // store_context returns { session_id, byte_size, ratio, session_seq } with no `success` field.
    // MCPClient wraps it as { success: true, data: { session_id, ... } }.
    const sessionId = (result.data as { session_id?: string })?.session_id ?? null;
    log.debug({ sessionId }, '_persist: stored successfully');
    return sessionId;
  }

  /**
   * Fetch the latest allowlist snapshot from Meridian and repopulate the in-memory snapshot.
   *
   * Uses fetch_context with mode='latest' to retrieve the most recently stored allowlist.
   * An empty result (no prior sessions) is treated as an empty allowlist, not an error.
   *
   * NOTE: FastMCP serializes each list element as a separate MCP content[] entry.
   * MCPClient reads only content[0].text — result.data is therefore the FIRST session
   * object (a plain dict), not an array. For mode='latest', this is the only session.
   * Empty result: FastMCP returns empty content[] → MCPClient wraps as { content: '[]' }.
   *
   * NOTE: _fetchAll is called only once, at startup via load(). The snapshot is guaranteed
   * empty at that point. Do not expose as a public refresh method without adding snapshot.clear()
   * before the empty-result early return.
   */
  private async _fetchAll(): Promise<void> {
    const result = await this.client.callTool(
      'fetch_context',
      {
        task_id: 'self-bot-allowlist',
        agent: 'AUTH',
        mode: 'latest',
      },
      MERIDIAN_CTX,
    );

    if (!result.success) {
      log.error(
        { error: result.error },
        'MeridianAllowlistStore._fetchAll: fetch_context failed — snapshot will be empty',
      );
      return;
    }

    // FastMCP serializes each list item as a separate MCP content[] entry.
    // MCPClient reads only content[0].text → result.data is the first session object (not an array).
    // For mode='latest', this is the only session we need.
    const sessionData = result.data as { content?: string } | null;

    // No prior sessions: empty content[] path or missing content field
    if (!sessionData || typeof sessionData.content !== 'string' || sessionData.content === '[]') {
      log.info('MeridianAllowlistStore._fetchAll: no prior sessions — starting with empty allowlist');
      return;
    }

    let parsed: { entries?: AllowlistEntry[] };
    try {
      parsed = JSON.parse(sessionData.content) as { entries?: AllowlistEntry[] };
    } catch {
      log.warn(
        { raw: sessionData.content },
        'MeridianAllowlistStore._fetchAll: content parse failed — snapshot will be empty',
      );
      return;
    }

    if (!parsed.entries || !Array.isArray(parsed.entries)) {
      log.warn(
        { parsed },
        'MeridianAllowlistStore._fetchAll: unexpected entries shape — snapshot will be empty',
      );
      return;
    }

    this.snapshot.clear();
    for (const entry of parsed.entries) {
      if (entry.userId) {
        this.snapshot.set(entry.userId, entry);
      }
    }
    log.info({ count: this.snapshot.size }, 'MeridianAllowlistStore: snapshot loaded');
  }
}
