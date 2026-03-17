import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { AccessGuard } from '../../../src/access/guard.js';
import { FileAllowlistStore } from '../../../src/access/store.js';
import type { IAllowlistStore, AllowlistEntry, AccessConfig, SendResponseFn } from '../../../src/access/types.js';
import type { UnifiedMessage, UnifiedResponse } from '../../../src/types/message.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: 'msg-1',
    userId: 'tg:999',
    conversationId: 'conv-1',
    text: 'hello',
    attachments: [],
    timestamp: new Date().toISOString(),
    platform: { platform: 'telegram', chatId: 1, messageId: 1, chatType: 'private' },
    isCommand: false,
    ...overrides,
  };
}

/**
 * Returns partial overrides for a command message.
 * Spread this into makeMessage() overrides — userId must be set separately.
 */
function commandOverrides(command: string, args: string[] = []): Partial<UnifiedMessage> {
  return {
    isCommand: true,
    command,
    commandArgs: args,
    text: `/${command}${args.length ? ' ' + args.join(' ') : ''}`,
  };
}

function makeMockStore(overrides: Partial<IAllowlistStore> = {}): IAllowlistStore {
  return {
    load: mock(async () => {}),
    isAllowed: mock(async (_userId: string) => false),
    grant: mock(async (_userId: string, _grantedBy: string) => {}),
    revoke: mock(async (_userId: string) => {}),
    list: mock(async () => [] as AllowlistEntry[]),
    close: mock(async () => {}),
    ...overrides,
  };
}

const OWNER_ID = 'tg:owner123';

function makeConfig(overrides: Partial<AccessConfig> = {}): AccessConfig {
  return {
    ownerUserId: OWNER_ID,
    allowlistPath: '.allowlist.json',
    silentReject: true,
    ...overrides,
  };
}

// ─── AccessGuard Tests ────────────────────────────────────────────────────────

describe('AccessGuard', () => {

  describe('isPermitted()', () => {
    it('returns true for owner userId regardless of allowlist', async () => {
      const store = makeMockStore({ isAllowed: mock(async () => false) });
      const guard = new AccessGuard(store, makeConfig());
      const result = await guard.isPermitted(OWNER_ID);
      expect(result).toBe(true);
      // store.isAllowed should NOT be called for owner (short-circuit)
      expect((store.isAllowed as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    });

    it('returns false for unknown userId not in allowlist', async () => {
      const store = makeMockStore({ isAllowed: mock(async () => false) });
      const guard = new AccessGuard(store, makeConfig());
      const result = await guard.isPermitted('tg:stranger');
      expect(result).toBe(false);
    });

    it('returns true for userId that has been granted', async () => {
      const store = makeMockStore({ isAllowed: mock(async () => true) });
      const guard = new AccessGuard(store, makeConfig());
      const result = await guard.isPermitted('tg:granted-user');
      expect(result).toBe(true);
    });

    it('returns false for userId that was granted then revoked', async () => {
      const store = makeMockStore({ isAllowed: mock(async () => false) });
      const guard = new AccessGuard(store, makeConfig());
      const result = await guard.isPermitted('tg:revoked-user');
      expect(result).toBe(false);
    });
  });

  describe('wrap() — access control', () => {
    it('silently drops message from unauthorized user (handler not called)', async () => {
      const store = makeMockStore({ isAllowed: mock(async () => false) });
      const guard = new AccessGuard(store, makeConfig({ silentReject: true }));
      const handler = mock(async (_msg: UnifiedMessage) => {});
      const sendResponse = mock(async (_r: UnifiedResponse) => {});
      const wrapped = guard.wrap(handler, sendResponse);

      await wrapped(makeMessage({ userId: 'tg:stranger' }));

      expect(handler.mock.calls.length).toBe(0);
      expect(sendResponse.mock.calls.length).toBe(0);
    });

    it('sends rejection message when silentReject=false and user is unauthorized', async () => {
      const store = makeMockStore({ isAllowed: mock(async () => false) });
      const guard = new AccessGuard(store, makeConfig({ silentReject: false, rejectionMessage: 'No access.' }));
      const handler = mock(async (_msg: UnifiedMessage) => {});
      const sendResponse = mock(async (_r: UnifiedResponse) => {});
      const wrapped = guard.wrap(handler, sendResponse);

      await wrapped(makeMessage({ userId: 'tg:stranger' }));

      expect(handler.mock.calls.length).toBe(0);
      expect(sendResponse.mock.calls.length).toBe(1);
      const response = sendResponse.mock.calls[0]![0] as UnifiedResponse;
      expect(response.text).toBe('No access.');
    });

    it('forwards message to inner handler for authorized non-owner user', async () => {
      const store = makeMockStore({ isAllowed: mock(async () => true) });
      const guard = new AccessGuard(store, makeConfig());
      const handler = mock(async (_msg: UnifiedMessage) => {});
      const sendResponse = mock(async (_r: UnifiedResponse) => {});
      const wrapped = guard.wrap(handler, sendResponse);

      const msg = makeMessage({ userId: 'tg:allowed-user' });
      await wrapped(msg);

      expect(handler.mock.calls.length).toBe(1);
      expect(handler.mock.calls[0]![0]).toBe(msg);
    });

    it('forwards message to inner handler for owner user (non-command)', async () => {
      const store = makeMockStore();
      const guard = new AccessGuard(store, makeConfig());
      const handler = mock(async (_msg: UnifiedMessage) => {});
      const sendResponse = mock(async (_r: UnifiedResponse) => {});
      const wrapped = guard.wrap(handler, sendResponse);

      const msg = makeMessage({ userId: OWNER_ID, isCommand: false });
      await wrapped(msg);

      expect(handler.mock.calls.length).toBe(1);
    });

    it('on store.isAllowed() throw: fails closed, drops message, does not call handler', async () => {
      const store = makeMockStore({
        isAllowed: mock(async () => { throw new Error('DB error'); }),
      });
      const guard = new AccessGuard(store, makeConfig());
      const handler = mock(async (_msg: UnifiedMessage) => {});
      const sendResponse = mock(async (_r: UnifiedResponse) => {});
      const wrapped = guard.wrap(handler, sendResponse);

      await wrapped(makeMessage({ userId: 'tg:stranger' }));

      expect(handler.mock.calls.length).toBe(0);
      expect(sendResponse.mock.calls.length).toBe(0);
    });
  });

  describe('wrap() — owner commands', () => {
    it('/grant <userId> by owner: calls store.grant and sends confirmation reply', async () => {
      const store = makeMockStore();
      const guard = new AccessGuard(store, makeConfig());
      const handler = mock(async (_msg: UnifiedMessage) => {});
      const sendResponse = mock(async (_r: UnifiedResponse) => {});
      const wrapped = guard.wrap(handler, sendResponse);

      await wrapped(makeMessage({ ...commandOverrides('grant', ['tg:newuser']), userId: OWNER_ID }));

      expect((store.grant as ReturnType<typeof mock>).mock.calls.length).toBe(1);
      expect((store.grant as ReturnType<typeof mock>).mock.calls[0]![0]).toBe('tg:newuser');
      expect(sendResponse.mock.calls.length).toBe(1);
      const response = sendResponse.mock.calls[0]![0] as UnifiedResponse;
      expect(response.text).toContain('✅ Granted access to tg:newuser');
      expect(handler.mock.calls.length).toBe(0);
    });

    it('/grant with no argument: replies with usage hint, does not call store.grant', async () => {
      const store = makeMockStore();
      const guard = new AccessGuard(store, makeConfig());
      const handler = mock(async (_msg: UnifiedMessage) => {});
      const sendResponse = mock(async (_r: UnifiedResponse) => {});
      const wrapped = guard.wrap(handler, sendResponse);

      await wrapped(makeMessage({ ...commandOverrides('grant', []), userId: OWNER_ID }));

      expect((store.grant as ReturnType<typeof mock>).mock.calls.length).toBe(0);
      expect(sendResponse.mock.calls.length).toBe(1);
      const response = sendResponse.mock.calls[0]![0] as UnifiedResponse;
      expect(response.text).toContain('Usage: /grant');
    });

    it('/grant with bare numeric (no prefix): replies with format error', async () => {
      const store = makeMockStore();
      const guard = new AccessGuard(store, makeConfig());
      const handler = mock(async (_msg: UnifiedMessage) => {});
      const sendResponse = mock(async (_r: UnifiedResponse) => {});
      const wrapped = guard.wrap(handler, sendResponse);

      await wrapped(makeMessage({ ...commandOverrides('grant', ['123456789']), userId: OWNER_ID }));

      expect((store.grant as ReturnType<typeof mock>).mock.calls.length).toBe(0);
      expect(sendResponse.mock.calls.length).toBe(1);
      const response = sendResponse.mock.calls[0]![0] as UnifiedResponse;
      expect(response.text).toContain('platform-prefixed');
    });

    it('/revoke <userId> by owner: calls store.revoke and sends confirmation reply', async () => {
      const store = makeMockStore();
      const guard = new AccessGuard(store, makeConfig());
      const handler = mock(async (_msg: UnifiedMessage) => {});
      const sendResponse = mock(async (_r: UnifiedResponse) => {});
      const wrapped = guard.wrap(handler, sendResponse);

      await wrapped(makeMessage({ ...commandOverrides('revoke', ['tg:olduser']), userId: OWNER_ID }));

      expect((store.revoke as ReturnType<typeof mock>).mock.calls.length).toBe(1);
      expect((store.revoke as ReturnType<typeof mock>).mock.calls[0]![0]).toBe('tg:olduser');
      expect(sendResponse.mock.calls.length).toBe(1);
      const response = sendResponse.mock.calls[0]![0] as UnifiedResponse;
      expect(response.text).toContain('✅ Revoked access from tg:olduser');
    });

    it('/revoke with no argument: replies with usage hint', async () => {
      const store = makeMockStore();
      const guard = new AccessGuard(store, makeConfig());
      const handler = mock(async (_msg: UnifiedMessage) => {});
      const sendResponse = mock(async (_r: UnifiedResponse) => {});
      const wrapped = guard.wrap(handler, sendResponse);

      await wrapped(makeMessage({ ...commandOverrides('revoke', []), userId: OWNER_ID }));

      expect((store.revoke as ReturnType<typeof mock>).mock.calls.length).toBe(0);
      expect(sendResponse.mock.calls.length).toBe(1);
      const response = sendResponse.mock.calls[0]![0] as UnifiedResponse;
      expect(response.text).toContain('Usage: /revoke');
    });

    it('/listusers by owner with entries: replies with numbered list', async () => {
      const entries: AllowlistEntry[] = [
        { userId: 'tg:user1', grantedAt: '2026-01-01T00:00:00.000Z', grantedBy: OWNER_ID },
        { userId: 'tg:user2', grantedAt: '2026-01-02T00:00:00.000Z', grantedBy: OWNER_ID },
      ];
      const store = makeMockStore({ list: mock(async () => entries) });
      const guard = new AccessGuard(store, makeConfig());
      const handler = mock(async (_msg: UnifiedMessage) => {});
      const sendResponse = mock(async (_r: UnifiedResponse) => {});
      const wrapped = guard.wrap(handler, sendResponse);

      await wrapped(makeMessage({ ...commandOverrides('listusers'), userId: OWNER_ID }));

      expect(sendResponse.mock.calls.length).toBe(1);
      const response = sendResponse.mock.calls[0]![0] as UnifiedResponse;
      expect(response.text).toContain('1. tg:user1');
      expect(response.text).toContain('2. tg:user2');
    });

    it('/listusers by owner with empty list: replies "No users granted."', async () => {
      const store = makeMockStore({ list: mock(async () => []) });
      const guard = new AccessGuard(store, makeConfig());
      const handler = mock(async (_msg: UnifiedMessage) => {});
      const sendResponse = mock(async (_r: UnifiedResponse) => {});
      const wrapped = guard.wrap(handler, sendResponse);

      await wrapped(makeMessage({ ...commandOverrides('listusers'), userId: OWNER_ID }));

      expect(sendResponse.mock.calls.length).toBe(1);
      const response = sendResponse.mock.calls[0]![0] as UnifiedResponse;
      expect(response.text).toBe('No users granted.');
    });

    it('/grant by non-owner: silently dropped (handler not called, store not mutated)', async () => {
      const store = makeMockStore({ isAllowed: mock(async () => false) });
      const guard = new AccessGuard(store, makeConfig({ silentReject: true }));
      const handler = mock(async (_msg: UnifiedMessage) => {});
      const sendResponse = mock(async (_r: UnifiedResponse) => {});
      const wrapped = guard.wrap(handler, sendResponse);

      await wrapped(makeMessage({ ...commandOverrides('grant', ['tg:victim']), userId: 'tg:stranger' }));

      expect(handler.mock.calls.length).toBe(0);
      expect((store.grant as ReturnType<typeof mock>).mock.calls.length).toBe(0);
      expect(sendResponse.mock.calls.length).toBe(0);
    });

    it('unrecognized command from owner is forwarded to inner handler (not consumed)', async () => {
      const store = makeMockStore();
      const guard = new AccessGuard(store, makeConfig());
      const handler = mock(async (_msg: UnifiedMessage) => {});
      const sendResponse = mock(async (_r: UnifiedResponse) => {});
      const wrapped = guard.wrap(handler, sendResponse);

      const msg = makeMessage({ ...commandOverrides('unknowncmd', ['arg1']), userId: OWNER_ID });
      await wrapped(msg);

      expect(handler.mock.calls.length).toBe(1);
      expect(handler.mock.calls[0]![0]).toBe(msg);
      expect(sendResponse.mock.calls.length).toBe(0);
    });
  });

});

// ─── FileAllowlistStore Tests ─────────────────────────────────────────────────

describe('FileAllowlistStore', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'allowlist-test-'));
    tmpFile = path.join(tmpDir, 'allowlist.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('load() on missing file initializes empty allowlist without throwing', async () => {
    const store = new FileAllowlistStore(tmpFile);
    await expect(store.load()).resolves.toBeUndefined();
    expect(await store.isAllowed('tg:anyone')).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it('load() with malformed JSON logs error and initializes empty allowlist without throwing', async () => {
    await Bun.write(tmpFile, '{ this is not valid json ');
    const store = new FileAllowlistStore(tmpFile);
    await expect(store.load()).resolves.toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('load() with valid JSON but missing entries array logs warning and initializes empty allowlist', async () => {
    await Bun.write(tmpFile, JSON.stringify({ version: 1, entries: 'not-an-array' }));
    const store = new FileAllowlistStore(tmpFile);
    await expect(store.load()).resolves.toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('grant() persists entry across close()+load() cycle (temp file)', async () => {
    const store = new FileAllowlistStore(tmpFile);
    await store.load();
    await store.grant('tg:user1', OWNER_ID);
    await store.close();

    const store2 = new FileAllowlistStore(tmpFile);
    await store2.load();
    expect(await store2.isAllowed('tg:user1')).toBe(true);
    const entries = await store2.list();
    expect(entries.length).toBe(1);
    expect(entries[0]!.userId).toBe('tg:user1');
    expect(entries[0]!.grantedBy).toBe(OWNER_ID);
  });

  it('grant() is idempotent: second grant updates grantedAt, does not duplicate entry', async () => {
    const store = new FileAllowlistStore(tmpFile);
    await store.load();
    await store.grant('tg:user1', OWNER_ID);
    const firstList = await store.list();
    const firstGrantedAt = firstList[0]!.grantedAt;

    // Small delay to ensure timestamp differs
    await new Promise(r => setTimeout(r, 10));
    await store.grant('tg:user1', OWNER_ID);
    await store.close();

    const entries = await store.list();
    expect(entries.length).toBe(1);
    expect(entries[0]!.grantedAt).not.toBe(firstGrantedAt);
  });

  it('revoke() removes entry; isAllowed returns false after revoke', async () => {
    const store = new FileAllowlistStore(tmpFile);
    await store.load();
    await store.grant('tg:user1', OWNER_ID);
    expect(await store.isAllowed('tg:user1')).toBe(true);

    await store.revoke('tg:user1');
    expect(await store.isAllowed('tg:user1')).toBe(false);
    expect(await store.list()).toEqual([]);
    await store.close();
  });

  it('close() awaits pending write before returning', async () => {
    const store = new FileAllowlistStore(tmpFile);
    await store.load();
    await store.grant('tg:user1', OWNER_ID);
    // close() must await the enqueued write
    await store.close();

    // File must exist and contain the entry
    const raw = await Bun.file(tmpFile).text();
    const parsed = JSON.parse(raw) as { entries: AllowlistEntry[] };
    expect(parsed.entries.length).toBe(1);
    expect(parsed.entries[0]!.userId).toBe('tg:user1');
  });
});
