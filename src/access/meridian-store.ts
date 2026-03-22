/**
 * src/access/meridian-store.ts
 * MCP-backed allowlist store that persists grants/revocations to a Meridian
 * MCP server using the Meridian DSL v0.1 wire format.
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
 * Stores allowlist state in a Meridian MCP server tool ("meridian_allowlist").
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
    const dsl =
      `§F:AUTH|T:GW|I:${userId}|P:1|S:C\n` +
      `¶action:grant¶\n` +
      `¶granted_by:${grantedBy}¶\n` +
      `¶granted_at:${now}¶\n` +
      `§`;

    // CRITICAL: inspect result.success — callTool never throws
    const result = await this.client.callTool('meridian_allowlist', { payload: dsl }, MERIDIAN_CTX);
    if (!result.success) {
      log.error(
        { userId, grantedBy, error: result.error },
        'MeridianAllowlistStore.grant: MCP call failed — updating local snapshot only',
      );
    }

    // Optimistic local state — update snapshot regardless of MCP result
    this.snapshot.set(userId, { userId, grantedAt: now, grantedBy });
  }

  /**
   * Revoke access for userId. Persists to Meridian MCP, then removes from snapshot.
   *
   * NOTE: S:C always (S:X is undefined in Meridian DSL grammar).
   * ¶action:revoke¶ is the semantic discriminator for revocation intent.
   *
   * CRITICAL: Inspect result.success after callTool(). MCPClient.callTool never throws.
   */
  async revoke(userId: string): Promise<void> {
    const now = new Date().toISOString();
    const dsl =
      `§F:AUTH|T:GW|I:${userId}|P:1|S:C\n` +
      `¶action:revoke¶\n` +
      `¶revoked_at:${now}¶\n` +
      `§`;

    // CRITICAL: inspect result.success — callTool never throws
    const result = await this.client.callTool('meridian_allowlist', { payload: dsl }, MERIDIAN_CTX);
    if (!result.success) {
      log.error(
        { userId, error: result.error },
        'MeridianAllowlistStore.revoke: MCP call failed — removing from local snapshot only',
      );
    }

    // Optimistic local state — remove from snapshot regardless of MCP result
    this.snapshot.delete(userId);
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
   * Fetch all allowlist entries from Meridian and repopulate the in-memory snapshot.
   *
   * CRITICAL: Inspect result.success after callTool(). MCPClient.callTool never throws.
   * If false: log.error and return — snapshot stays at current state.
   *
   * Expected result.data shape on success:
   *   { entries: Array<{ userId: string; grantedAt: string; grantedBy: string; note?: string }> }
   */
  private async _fetchAll(): Promise<void> {
    const dsl =
      `§F:AUTH|T:GW|I:system|P:1|S:C\n` +
      `¶action:list¶\n` +
      `§`;

    // CRITICAL: inspect result.success — callTool never throws
    const result = await this.client.callTool('meridian_allowlist', { payload: dsl }, MERIDIAN_CTX);
    if (!result.success) {
      log.error(
        { error: result.error },
        'MeridianAllowlistStore._fetchAll: MCP call failed — snapshot will be empty',
      );
      return;
    }

    // Parse entries from result.data
    const data = result.data as { entries?: AllowlistEntry[] } | null;
    if (!data || !Array.isArray(data.entries)) {
      log.warn(
        { data },
        'MeridianAllowlistStore._fetchAll: unexpected data shape — snapshot will be empty',
      );
      return;
    }

    this.snapshot.clear();
    for (const entry of data.entries) {
      if (entry.userId) {
        this.snapshot.set(entry.userId, entry);
      }
    }

    log.info({ count: this.snapshot.size }, 'MeridianAllowlistStore: snapshot loaded');
  }
}
