/**
 * src/auth/__tests__/manager.test.ts
 * Tests for OAuthManager — token lifecycle orchestration.
 * Run with: bun test
 *
 * Strategy:
 *  - Use a real TokenStore pointed at a temp file for disk operations.
 *  - Mock `anthropicLogin` and `anthropicRefresh` via bun:test mock.module().
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OAuthManager } from '../manager';
import { TokenStore } from '../store';
import type { OAuthTokens, OAuthLoginCallbacks } from '../types';
import * as anthropicProvider from '../providers/anthropic';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTempPath(): string {
  return join(tmpdir(), `oauth-manager-test-${randomBytes(8).toString('hex')}.json`);
}

function makeFreshTokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    access_token: 'fresh-access-token',
    refresh_token: 'fresh-refresh-token',
    expires_at: Date.now() + 3_600_000, // 1 hour — well within freshness window
    provider: 'claude-oauth',
    ...overrides,
  };
}

function makeStaleTokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    access_token: 'stale-access-token',
    refresh_token: 'stale-refresh-token',
    expires_at: Date.now() - 1_000, // already expired
    provider: 'claude-oauth',
    ...overrides,
  };
}

function makeCallbacks(code = 'auth-code-123'): OAuthLoginCallbacks & {
  onUrlCalls: string[];
  onCodeCalled: boolean;
} {
  const onUrlCalls: string[] = [];
  let onCodeCalled = false;
  return {
    onUrl: async (url: string) => { onUrlCalls.push(url); },
    onCode: async () => { onCodeCalled = true; return code; },
    get onUrlCalls() { return onUrlCalls; },
    get onCodeCalled() { return onCodeCalled; },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('OAuthManager', () => {
  let tempPath: string;
  let store: TokenStore;
  let manager: OAuthManager;
  let loginSpy: ReturnType<typeof spyOn>;
  let refreshSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tempPath = makeTempPath();
    store = new TokenStore(tempPath);
    manager = new OAuthManager(tempPath);
    loginSpy = spyOn(anthropicProvider, 'anthropicLogin');
    refreshSpy = spyOn(anthropicProvider, 'anthropicRefresh');
  });

  afterEach(async () => {
    await store.clear().catch(() => {});
    mock.restore();
  });

  // ── ensureAuthenticated() ────────────────────────────────────────────────

  describe('ensureAuthenticated()', () => {
    it('calls callbacks.onUrl and callbacks.onCode when no token file exists', async () => {
      const loginTokens = makeFreshTokens({ access_token: 'new-token-from-login' });

      loginSpy.mockImplementation(async (cbs: OAuthLoginCallbacks) => {
        await cbs.onUrl('https://claude.ai/oauth/authorize?...');
        await cbs.onCode?.();
        return loginTokens;
      });

      const callbacks = makeCallbacks();
      await manager.ensureAuthenticated(callbacks);

      expect(loginSpy).toHaveBeenCalledTimes(1);
      expect(callbacks.onUrlCalls.length).toBe(1);
      expect(callbacks.onCodeCalled).toBe(true);
    });

    it('does NOT call any callbacks when a fresh token exists on disk', async () => {
      await store.save(makeFreshTokens());

      const callbacks = makeCallbacks();
      await manager.ensureAuthenticated(callbacks);

      expect(loginSpy).not.toHaveBeenCalled();
      expect(refreshSpy).not.toHaveBeenCalled();
      expect(callbacks.onUrlCalls.length).toBe(0);
      expect(callbacks.onCodeCalled).toBe(false);
    });

    it('calls anthropicRefresh (not login) when stale token is on disk and refresh succeeds', async () => {
      await store.save(makeStaleTokens());

      const refreshedTokens = makeFreshTokens({ access_token: 'refreshed-token' });
      refreshSpy.mockResolvedValue(refreshedTokens);

      const callbacks = makeCallbacks();
      await manager.ensureAuthenticated(callbacks);

      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(loginSpy).not.toHaveBeenCalled();
      expect(callbacks.onUrlCalls.length).toBe(0);
    });

    it('saves the refreshed token to disk after a successful refresh', async () => {
      await store.save(makeStaleTokens());

      const refreshedTokens = makeFreshTokens({ access_token: 'refreshed-and-saved' });
      refreshSpy.mockResolvedValue(refreshedTokens);

      await manager.ensureAuthenticated(makeCallbacks());

      const onDisk = await store.load();
      expect(onDisk!.access_token).toBe('refreshed-and-saved');
    });

    it('falls back to anthropicLogin when stale token exists but refresh fails', async () => {
      await store.save(makeStaleTokens());

      refreshSpy.mockRejectedValue(new Error('refresh_token expired'));

      const loginTokens = makeFreshTokens({ access_token: 'login-fallback-token' });
      loginSpy.mockImplementation(async (cbs: OAuthLoginCallbacks) => {
        await cbs.onUrl('https://claude.ai/oauth/authorize?...');
        await cbs.onCode?.();
        return loginTokens;
      });

      const callbacks = makeCallbacks();
      await manager.ensureAuthenticated(callbacks);

      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(loginSpy).toHaveBeenCalledTimes(1);
      expect(callbacks.onUrlCalls.length).toBe(1);
    });

    it('persists the newly logged-in token to disk after interactive login', async () => {
      const loginTokens = makeFreshTokens({ access_token: 'just-logged-in' });
      loginSpy.mockResolvedValue(loginTokens);

      await manager.ensureAuthenticated(makeCallbacks());

      const onDisk = await store.load();
      expect(onDisk!.access_token).toBe('just-logged-in');
    });
  });

  // ── getAccessToken() ────────────────────────────────────────────────────

  describe('getAccessToken()', () => {
    it('throws before ensureAuthenticated() is called', () => {
      expect(() => manager.getAccessToken()).toThrow(/call ensureAuthenticated\(\) before getAccessToken\(\)/i);
    });

    it('returns the access token after ensureAuthenticated() completes', async () => {
      const tokens = makeFreshTokens({ access_token: 'valid-token-abc' });
      await store.save(tokens);

      await manager.ensureAuthenticated(makeCallbacks());

      expect(manager.getAccessToken()).toBe('valid-token-abc');
    });
  });

  // ── getValidAccessToken() ───────────────────────────────────────────────

  describe('getValidAccessToken()', () => {
    it('returns the access token when a fresh token exists', async () => {
      await store.save(makeFreshTokens({ access_token: 'valid-via-get-valid' }));

      const callbacks = makeCallbacks();
      const token = await manager.getValidAccessToken(callbacks);

      expect(token).toBe('valid-via-get-valid');
      expect(loginSpy).not.toHaveBeenCalled();
    });
  });

  // ── logout() ────────────────────────────────────────────────────────────

  describe('logout()', () => {
    it('clears the in-memory cache so getAccessToken() throws afterward', async () => {
      await store.save(makeFreshTokens());
      await manager.ensureAuthenticated(makeCallbacks());
      expect(() => manager.getAccessToken()).not.toThrow();

      await manager.logout();

      expect(() => manager.getAccessToken()).toThrow(/call ensureAuthenticated/i);
    });

    it('deletes the token file from disk', async () => {
      await store.save(makeFreshTokens());
      await manager.ensureAuthenticated(makeCallbacks());

      await manager.logout();

      expect(await store.load()).toBeNull();
    });

    it('does not throw when logout is called with no token on disk', async () => {
      await expect(manager.logout()).resolves.toBeUndefined();
    });
  });
});
