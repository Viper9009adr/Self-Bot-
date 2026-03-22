/**
 * src/access/gateway-auth.ts
 * GatewayAuth — JWT-augmented access guard backed by IAllowlistStore.
 *
 * Extends the AccessGuard contract by issuing HS256 JWTs (via jose) for
 * permitted users and caching them for 24 h. The JWT serves as a lightweight
 * session token for downstream services; it is NOT used for the permission
 * check itself (store.isAllowed is the authoritative source).
 *
 * KNOWN LIMITATION: External revocations performed directly on the Meridian
 * server (bypassing this class's handleOwnerCommand /revoke path) are not
 * reflected in tokenCache until the affected JWT expires (TTL: 24 h). This
 * is a deliberate trade-off between latency and round-trip cost for a
 * personal single-instance bot.
 *
 * RACE CONDITION MITIGATION: Concurrent first messages from the same userId
 * are serialised via pendingIssuance. Only the first in-flight request issues
 * the JWT; subsequent concurrent requests skip issueJWT and return immediately
 * (user is already permitted; JWT will be populated shortly by first request).
 */
import { SignJWT } from 'jose';
import type { MessageHandler } from '../adapters/base.js';
import type { UnifiedMessage } from '../types/message.js';
import type { IAllowlistStore, AccessConfig, SendResponseFn } from './types.js';
import { makeGuardResponse } from './types.js';
import type { SecretString } from '../config/schema.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger({ module: 'access:gateway-auth' });

/** JWT cache entry. Stores the signed token string and its expiry epoch (ms). */
interface TokenCacheEntry {
  token: string;
  expiresAt: number; // Date.now() ms
}

/**
 * GatewayAuth configuration.
 *
 * Extends AccessConfig with optional GatewayAuth-specific fields.
 * allowlistPath is re-declared optional here because when MeridianAllowlistStore
 * is active the file path is irrelevant — the store handles its own persistence.
 */
export interface GatewayAuthConfig extends Omit<AccessConfig, 'allowlistPath'> {
  /** Filesystem path to the JSON allowlist file. Optional when using MeridianAllowlistStore. */
  allowlistPath?: string;
  /** HS256 JWT signing secret (SecretString, min 32 chars). Required for JWT issuance. */
  gatewayJwtSecret?: SecretString;
}

/** JWT TTL: 24 hours in milliseconds */
const JWT_TTL_MS = 24 * 60 * 60 * 1000;
/** JWT TTL: 24 hours as jose expiration string */
const JWT_TTL_STR = '24h';

/**
 * JWT-augmented access guard.
 *
 * Drop-in replacement for AccessGuard. Wire it identically via `.wrap()`.
 *
 * @example
 * ```ts
 * const auth = new GatewayAuth(store, config);
 * const protected = auth.wrap(agentHandler, sendResponse);
 * adapter.onMessage(protected);
 * ```
 */
export class GatewayAuth {
  /** In-memory JWT cache keyed by userId. Evicted on /revoke or natural expiry. */
  private tokenCache: Map<string, TokenCacheEntry> = new Map();

  /**
   * Per-userId in-flight issuance lock.
   * Before calling issueJWT, check pendingIssuance.has(userId).
   * If true, skip — concurrent request will populate the cache.
   */
  private pendingIssuance: Set<string> = new Set();

  constructor(
    private readonly store: IAllowlistStore,
    private readonly config: GatewayAuthConfig,
  ) {}

  /**
   * Wrap handler with JWT-aware access control and owner command routing.
   *
   * Pipeline per message:
   *   1. isPermitted check (fails closed on store error)
   *   2. Reject unauthorized
   *   3. Owner commands (grant/revoke/listusers)
   *   4. JWT issuance for permitted non-owner users (with pendingIssuance guard)
   *   5. Forward to inner handler
   */
  wrap(handler: MessageHandler, sendResponse: SendResponseFn): MessageHandler {
    return async (message: UnifiedMessage): Promise<void> => {
      // 1. Permission check — fails closed on error
      let permitted: boolean;
      try {
        permitted = await this.isPermitted(message.userId);
      } catch (err) {
        log.error({ err, userId: message.userId }, 'GatewayAuth store error — failing closed');
        return;
      }

      // 2. Reject unauthorized
      if (!permitted) {
        if (!this.config.silentReject) {
          await sendResponse(
            makeGuardResponse(message, this.config.rejectionMessage ?? 'Access denied.'),
          );
        }
        return;
      }

      // 3. Owner command handling
      if (this.isOwner(message.userId) && message.isCommand) {
        const consumed = await this.handleOwnerCommand(message, sendResponse);
        if (consumed) return;
      }

      // 4. JWT issuance for permitted non-owner users (fire-and-forget, non-blocking)
      if (!this.isOwner(message.userId) && this.config.gatewayJwtSecret) {
        await this.maybeIssueJWT(message.userId);
      }

      // 5. Forward to inner handler
      await handler(message);
    };
  }

  /**
   * Determine whether userId is permitted.
   * Owner always passes (hard bypass — no store call).
   * Others must have an active allowlist entry in the store.
   *
   * CRITICAL: the `await` on store.isAllowed is mandatory. Omitting it returns
   * a Promise object (always truthy), bypassing the gate for all non-owner users.
   */
  async isPermitted(userId: string): Promise<boolean> {
    return this.isOwner(userId) || await this.store.isAllowed(userId);
  }

  /**
   * Retrieve cached JWT for userId, or null if absent/expired.
   * Public so downstream services can extract the token if needed.
   */
  getCachedToken(userId: string): string | null {
    const entry = this.tokenCache.get(userId);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.token;
  }

  /** Return true if userId matches the configured owner ID. */
  private isOwner(userId: string): boolean {
    return userId === this.config.ownerUserId;
  }

  /**
   * Issue a JWT for userId if not already cached or if cache is stale.
   * Serialises concurrent issuance via pendingIssuance Set.
   *
   * If pendingIssuance.has(userId): skip — concurrent request is handling issuance.
   * User is already permitted; return immediately.
   */
  private async maybeIssueJWT(userId: string): Promise<void> {
    // Check cache — valid non-expired entry exists
    const cached = this.tokenCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return;
    }

    // Race condition guard: skip if another in-flight request is issuing
    if (this.pendingIssuance.has(userId)) {
      return;
    }

    this.pendingIssuance.add(userId);
    try {
      await this.issueJWT(userId);
    } finally {
      this.pendingIssuance.delete(userId);
    }
  }

  /**
   * Sign and cache a new JWT for userId using HS256 (jose).
   *
   * NOTE: jose requires secret as Uint8Array — NOT a raw string.
   * NOTE: crypto.randomUUID() is available natively in Bun without import.
   *
   * JWT claims:
   *   sub: userId
   *   jti: crypto.randomUUID() — unique token ID
   *   iat: issued-at (set automatically by jose)
   *   exp: iat + 24h
   *
   * CRITICAL: Does NOT call store.grant(). isAllowed() returning true is
   * sufficient proof the user is already granted. Calling store.grant() here
   * would pollute Meridian audit history on every process restart.
   * store.grant() is ONLY called from handleOwnerCommand /grant.
   */
  private async issueJWT(userId: string): Promise<void> {
    if (!this.config.gatewayJwtSecret) return;

    try {
      // jose requires Uint8Array — TextEncoder converts string to bytes
      const secretBytes = new TextEncoder().encode(this.config.gatewayJwtSecret as string);

      const token = await new SignJWT({ sub: userId })
        .setProtectedHeader({ alg: 'HS256' })
        .setJti(crypto.randomUUID())
        .setIssuedAt()
        .setExpirationTime(JWT_TTL_STR)
        .sign(secretBytes);

      this.tokenCache.set(userId, {
        token,
        expiresAt: Date.now() + JWT_TTL_MS,
      });

      log.debug({ userId }, 'GatewayAuth: JWT issued and cached');
    } catch (err) {
      // Non-fatal: user is still permitted; lack of JWT is a downstream degradation only
      log.error({ err, userId }, 'GatewayAuth: JWT issuance failed — user permitted but no token cached');
    }
  }

  /**
   * Handle owner-only management commands: /grant, /revoke, /listusers.
   *
   * /grant <userId>:
   *   - Validates platform-prefix format
   *   - Calls store.grant(arg, ownerUserId) — ONLY place store.grant() is called
   *
   * /revoke <userId>:
   *   - Calls store.revoke(arg)
   *   - Deletes tokenCache entry immediately — does NOT wait for JWT expiry
   *
   * /listusers:
   *   - Returns formatted list from store.list()
   *
   * Returns false for unrecognised commands (caller falls through to inner handler).
   */
  private async handleOwnerCommand(
    message: UnifiedMessage,
    sendResponse: SendResponseFn,
  ): Promise<boolean> {
    switch (message.command) {
      case 'grant': {
        const arg = message.commandArgs?.[0];
        if (!arg) {
          await sendResponse(makeGuardResponse(message, '❌ Usage: /grant <userId>'));
          return true;
        }
        if (!/^[a-z]+:.+/.test(arg)) {
          await sendResponse(
            makeGuardResponse(message, '❌ userId must be platform-prefixed (e.g. tg:123456789)'),
          );
          return true;
        }
        // ONLY place store.grant() is called — not in issueJWT
        await this.store.grant(arg, this.config.ownerUserId);
        await sendResponse(makeGuardResponse(message, `✅ Granted access to ${arg}`));
        return true;
      }

      case 'revoke': {
        const arg = message.commandArgs?.[0];
        if (!arg) {
          await sendResponse(makeGuardResponse(message, '❌ Usage: /revoke <userId>'));
          return true;
        }
        await this.store.revoke(arg);
        // Immediately invalidate local JWT cache — do not wait for expiry
        this.tokenCache.delete(arg);
        log.info({ userId: arg }, 'GatewayAuth: token cache evicted on /revoke');
        await sendResponse(makeGuardResponse(message, `✅ Revoked access from ${arg}`));
        return true;
      }

      case 'listusers': {
        const entries = await this.store.list();
        if (entries.length === 0) {
          await sendResponse(makeGuardResponse(message, 'No users granted.'));
        } else {
          const list = entries.map((e, i) => `${i + 1}. ${e.userId}`).join('\n');
          await sendResponse(makeGuardResponse(message, `Granted users:\n${list}`));
        }
        return true;
      }

      default:
        return false; // Not consumed; wrap() falls through to inner handler
    }
  }
}
