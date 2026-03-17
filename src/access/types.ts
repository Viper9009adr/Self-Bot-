/**
 * src/access/types.ts
 * Shared types and utilities for the access control layer.
 *
 * Defines the data shapes for the allowlist store, the guard configuration,
 * and a helper for constructing guard replies that mirror the originating message.
 */
import type { UnifiedMessage, UnifiedResponse } from '../types/message.js';

/**
 * A single entry in the allowlist.
 * User IDs are always platform-prefixed (e.g. `"tg:123456789"`) so that the
 * same store can hold entries from multiple platforms without collision.
 */
export interface AllowlistEntry {
  /** Platform-prefixed user identifier, e.g. `"tg:123456789"`. */
  userId: string;
  /** ISO 8601 timestamp of when access was granted. */
  grantedAt: string;
  /** Platform-prefixed user ID of the owner who issued the grant. */
  grantedBy: string;
  /** Optional human-readable note attached to the entry. */
  note?: string;
}

/**
 * Root structure of the `.allowlist.json` persistence file.
 * The `version` field is fixed at `1` for forward-compatibility checks.
 */
export interface AllowlistData {
  version: 1;
  entries: AllowlistEntry[];
}

/**
 * Contract for an allowlist store implementation.
 * All mutating methods (`grant`, `revoke`) must persist changes durably before
 * resolving so that a crash after the call does not lose the update.
 */
export interface IAllowlistStore {
  /** Load persisted entries from the backing store. Must be called once at startup. */
  load(): Promise<void>;
  /** Return `true` if `userId` has an active allowlist entry. */
  isAllowed(userId: string): Promise<boolean>;
  /**
   * Grant access to `userId`. Idempotent — if the user already has an entry,
   * `grantedAt` and `grantedBy` are updated in place.
   */
  grant(userId: string, grantedBy: string): Promise<void>;
  /** Remove the allowlist entry for `userId`. No-op if the user is not listed. */
  revoke(userId: string): Promise<void>;
  /** Return a snapshot of all current allowlist entries. */
  list(): Promise<AllowlistEntry[]>;
  /** Flush any pending writes and release resources. Awaits the internal write queue. */
  close(): Promise<void>;
}

/**
 * Runtime configuration for `AccessGuard`.
 * Sourced from the `access` block of the application config schema.
 */
export interface AccessConfig {
  /** Platform-prefixed user ID of the bot owner (e.g. `"tg:123456789"`). */
  ownerUserId: string;
  /** Filesystem path to the JSON allowlist file (e.g. `".allowlist.json"`). */
  allowlistPath: string;
  /**
   * When `true` (default), unauthorized messages are silently dropped.
   * When `false`, the bot replies with `rejectionMessage`.
   */
  silentReject: boolean;
  /** Custom rejection reply text. Only used when `silentReject` is `false`. */
  rejectionMessage?: string;
}

/**
 * Callback signature used by `AccessGuard` to send a reply back to the user.
 * Matches the responder interface used by the Telegram adapter.
 */
export type SendResponseFn = (response: UnifiedResponse) => Promise<void>;

/**
 * Build a `UnifiedResponse` that replies to `message` with the given `text`.
 *
 * Copies `id`, `userId`, `conversationId`, and `platform` from the source
 * message so the response is routed back to the correct chat and user.
 *
 * @param message - The incoming message being responded to.
 * @param text    - Plain-text reply body.
 * @returns A `UnifiedResponse` ready to pass to a `SendResponseFn`.
 */
export function makeGuardResponse(message: UnifiedMessage, text: string): UnifiedResponse {
  return {
    inReplyTo: message.id,
    userId: message.userId,
    conversationId: message.conversationId,
    text,
    format: 'text',
    platform: message.platform,
  };
}
