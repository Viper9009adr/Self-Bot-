/**
 * src/access/guard.ts
 * Middleware that enforces access control on every incoming message.
 *
 * `AccessGuard` wraps an inner `MessageHandler` and gates it behind an
 * allowlist check. The owner always passes. Allowlisted users pass. Everyone
 * else is either silently dropped or sent a rejection reply, depending on
 * `AccessConfig.silentReject`.
 *
 * The owner also gets three built-in management commands that are intercepted
 * before the inner handler sees them: `/grant`, `/revoke`, and `/listusers`.
 */
import type { MessageHandler } from '../adapters/base.js';
import type { UnifiedMessage } from '../types/message.js';
import type { IAllowlistStore, AccessConfig, SendResponseFn } from './types.js';
import { makeGuardResponse } from './types.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger({ module: 'access:guard' });

/**
 * Access control middleware for a personal Telegram bot.
 *
 * Wraps any `MessageHandler` so that only the configured owner and explicitly
 * granted users can interact with the bot. The guard fails closed — if the
 * allowlist store throws, the message is silently dropped rather than
 * accidentally permitted.
 *
 * @example
 * ```ts
 * const guard = new AccessGuard(store, config.access);
 * const protectedHandler = guard.wrap(agentHandler, sendResponse);
 * adapter.onMessage(protectedHandler);
 * ```
 */
export class AccessGuard {
  /**
   * @param store  - Allowlist store used to check and manage granted users.
   * @param config - Access control configuration (owner ID, silent reject, etc.).
   */
  constructor(private readonly store: IAllowlistStore, private readonly config: AccessConfig) {}

  /**
   * Wrap `handler` with access control and owner command routing.
   *
   * The returned handler executes the following pipeline for every message:
   * 1. **Permission check** — calls `isPermitted`. Fails closed on store error.
   * 2. **Rejection** — unauthorized users are dropped (or sent a reply if
   *    `silentReject` is `false`).
   * 3. **Owner commands** — if the sender is the owner and the message is a
   *    command, `handleOwnerCommand` is tried first. If it consumes the
   *    command, the inner handler is skipped.
   * 4. **Inner handler** — all other permitted messages are forwarded to `handler`.
   *
   * @param handler      - The downstream message handler to protect.
   * @param sendResponse - Callback used to send replies (rejection messages,
   *                       command responses).
   * @returns A new `MessageHandler` that enforces access control.
   */
  wrap(handler: MessageHandler, sendResponse: SendResponseFn): MessageHandler {
    return async (message: UnifiedMessage): Promise<void> => {
      // 1. Check permission — fail closed on error
      let permitted: boolean;
      try {
        permitted = await this.isPermitted(message.userId);
      } catch (err) {
        log.error({ err, userId: message.userId }, 'AccessGuard store error — failing closed');
        return;
      }

      // 2. Reject unauthorized users
      if (!permitted) {
        if (!this.config.silentReject) {
          await sendResponse(makeGuardResponse(message, this.config.rejectionMessage ?? 'Access denied.'));
        }
        return;
      }

      // 3. Owner command handling
      if (this.isOwner(message.userId) && message.isCommand) {
        const consumed = await this.handleOwnerCommand(message, sendResponse);
        if (consumed) return;
        // consumed === false: unrecognized command, fall through to step 4
      }

      // 4. Forward to inner handler
      await handler(message);
    };
  }

  /**
   * Determine whether `userId` is permitted to interact with the bot.
   *
   * Returns `true` if the user is the owner OR has an active allowlist entry.
   * The `await` on `store.isAllowed` is mandatory — omitting it would make the
   * expression always truthy (a Promise object is truthy), bypassing the gate.
   *
   * @param userId - Platform-prefixed user ID to check.
   * @returns `true` if the user is permitted, `false` otherwise.
   */
  async isPermitted(userId: string): Promise<boolean> {
    // CRITICAL: the `await` is mandatory. Without it, store.isAllowed returns a Promise
    // object (always truthy), bypassing the access gate for all non-owner users.
    return this.isOwner(userId) || await this.store.isAllowed(userId);
  }

  /** Return `true` if `userId` matches the configured owner ID. */
  private isOwner(userId: string): boolean {
    return userId === this.config.ownerUserId;
  }

  /**
   * Attempt to handle an owner-only management command.
   *
   * Recognised commands:
   * - `/grant <userId>` — add a platform-prefixed user to the allowlist.
   * - `/revoke <userId>` — remove a user from the allowlist.
   * - `/listusers` — reply with the current allowlist.
   *
   * @param message      - The incoming owner command message.
   * @param sendResponse - Callback used to send the command reply.
   * @returns `true` if the command was recognised and handled (caller should
   *          stop processing), `false` if the command is unknown (caller should
   *          fall through to the inner handler).
   */
  private async handleOwnerCommand(message: UnifiedMessage, sendResponse: SendResponseFn): Promise<boolean> {
    switch (message.command) {
      case 'grant': {
        const arg = message.commandArgs?.[0];
        if (!arg) {
          await sendResponse(makeGuardResponse(message, '❌ Usage: /grant <userId>'));
          return true;
        }
        if (!/^[a-z]+:.+/.test(arg)) {
          await sendResponse(makeGuardResponse(message, '❌ userId must be platform-prefixed (e.g. tg:123456789)'));
          return true;
        }
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
        return false; // NOT consumed; wrap() falls through to step 4
    }
  }
}
