/**
 * src/auth/__tests__/store.test.ts
 * Tests for TokenStore — atomic JSON file persistence.
 * Run with: bun test
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TokenStore } from '../store';
import type { OAuthTokens } from '../types';

function makeTempPath(): string {
  return join(tmpdir(), `token-store-test-${randomBytes(8).toString('hex')}.json`);
}

function makeFreshTokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    access_token: 'sk-ant-test-access-token',
    refresh_token: 'sk-ant-test-refresh-token',
    expires_at: Date.now() + 3_600_000, // 1 hour from now
    provider: 'claude-oauth',
    ...overrides,
  };
}

describe('TokenStore', () => {
  const tempPaths: string[] = [];

  function tempPath(): string {
    const p = makeTempPath();
    tempPaths.push(p);
    return p;
  }

  afterEach(async () => {
    await Promise.all(
      tempPaths.splice(0).map(async (p) => {
        await new TokenStore(p).clear().catch(() => {});
        await new TokenStore(`${p}.tmp`).clear().catch(() => {});
      }),
    );
  });

  // ── load() ──────────────────────────────────────────────────────────────────

  describe('load()', () => {
    it('returns null when the file does not exist', async () => {
      const store = new TokenStore(tempPath());
      expect(await store.load()).toBeNull();
    });

    it('returns null when the file contains invalid JSON', async () => {
      const path = tempPath();
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, '{ not valid json }', 'utf-8');
      expect(await new TokenStore(path).load()).toBeNull();
    });

    it('returns null when JSON is valid but missing required fields', async () => {
      const path = tempPath();
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, JSON.stringify({ access_token: 'tok' }), 'utf-8');
      expect(await new TokenStore(path).load()).toBeNull();
    });
  });

  // ── save() + load() round-trip ───────────────────────────────────────────────

  describe('save() + load() round-trip', () => {
    it('persists and retrieves all OAuthTokens fields correctly', async () => {
      const store = new TokenStore(tempPath());
      const tokens = makeFreshTokens();

      await store.save(tokens);
      const loaded = await store.load();

      expect(loaded).not.toBeNull();
      expect(loaded!.access_token).toBe(tokens.access_token);
      expect(loaded!.refresh_token).toBe(tokens.refresh_token);
      expect(loaded!.expires_at).toBe(tokens.expires_at);
      expect(loaded!.provider).toBe('claude-oauth');
    });

    it('overwrites existing tokens on subsequent saves', async () => {
      const store = new TokenStore(tempPath());

      await store.save(makeFreshTokens({ access_token: 'token-v1' }));
      await store.save(makeFreshTokens({ access_token: 'token-v2' }));

      const loaded = await store.load();
      expect(loaded!.access_token).toBe('token-v2');
    });
  });

  // ── clear() ─────────────────────────────────────────────────────────────────

  describe('clear()', () => {
    it('deletes the token file; subsequent load() returns null', async () => {
      const path = tempPath();
      const store = new TokenStore(path);

      await store.save(makeFreshTokens());
      expect(existsSync(path)).toBe(true);

      await store.clear();

      expect(existsSync(path)).toBe(false);
      expect(await store.load()).toBeNull();
    });

    it('does not throw when file does not exist (ENOENT silenced)', async () => {
      const store = new TokenStore(tempPath());
      await expect(store.clear()).resolves.toBeUndefined();
    });
  });

  // ── Atomic save (no leftover .tmp) ──────────────────────────────────────────

  describe('atomic save', () => {
    it('does not leave a .tmp file behind after save()', async () => {
      const path = tempPath();
      await new TokenStore(path).save(makeFreshTokens());
      expect(existsSync(`${path}.tmp`)).toBe(false);
    });

    it('the saved file exists at the target path (not the .tmp path)', async () => {
      const path = tempPath();
      await new TokenStore(path).save(makeFreshTokens());
      expect(existsSync(path)).toBe(true);
    });
  });
});
