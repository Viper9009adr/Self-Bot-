/**
 * tests/integration/migration-compat-bootstrap.test.ts
 * Verifies migration flag bootstrap compatibility defaults.
 */
type BunTestModule = typeof import('bun:test');

const bunTest: BunTestModule | null =
  typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ? await import('bun:test') : null;

const describe = bunTest?.describe ?? (() => {}) as unknown as BunTestModule['describe'];
const it = bunTest?.it ?? (() => {}) as unknown as BunTestModule['it'];
const expect = bunTest?.expect ?? ((() => {
  throw new Error('expect() is unavailable outside Bun runtime');
}) as unknown as BunTestModule['expect']);
import { loadConfig, resetConfig } from '../../src/config/index.js';

const MANAGED_ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'BOT_OWNER_ID',
  'MIGRATION_ADAPTER_BOUNDARY',
  'MIGRATION_MOBILE_RUNTIME',
  // Clear conditional blocks to keep this test deterministic.
  'WA_ENABLED',
  'WA_OWNER_NUMBER',
  'WEB_ENABLED',
  'WEB_OWNER_USERNAME',
  'WEB_OWNER_PASSWORD',
  'MEDIA_IMAGE_MODEL',
  'MEDIA_STT_MODEL',
  'MEDIA_TTS_MODEL',
  'MEDIA_TTS_ENABLED',
  'MEDIA_NVIDIA_NIM_IMAGE_MODEL',
  // Keep terminal defaults deterministic in config bootstrap tests.
  'TERMINAL_SKILLS_PATH',
  'TERMINAL_COMMAND_ALLOWLIST',
  'TERMINAL_CWD_ALLOWLIST',
  'TERMINAL_ENV_BLOCKLIST',
  'TERMINAL_DEFAULT_TIMEOUT',
  'TERMINAL_MAX_CONCURRENT_SESSIONS',
] as const;

async function withManagedEnv(
  values: Partial<Record<(typeof MANAGED_ENV_KEYS)[number], string>>,
  run: () => void | Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of MANAGED_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  process.env['TELEGRAM_BOT_TOKEN'] = values['TELEGRAM_BOT_TOKEN'] ?? 'test-bot-token';
  process.env['BOT_OWNER_ID'] = values['BOT_OWNER_ID'] ?? 'tg:123456789';

  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }

  resetConfig();
  try {
    await run();
  } finally {
    resetConfig();
    for (const key of MANAGED_ENV_KEYS) {
      const before = previous.get(key);
      if (before === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = before;
      }
    }
  }
}

describe('migration compat bootstrap', () => {
  it('defaults migration flags to false when unset', async () => {
    await withManagedEnv({}, () => {
      const config = loadConfig();
      expect(config.migration.adapterBoundary).toBe(false);
      expect(config.migration.mobileRuntime).toBe(false);
    });
  });

  it('coerces migration flags from env when set', async () => {
    await withManagedEnv(
      {
        MIGRATION_ADAPTER_BOUNDARY: 'true',
        MIGRATION_MOBILE_RUNTIME: '1',
      },
      () => {
        const config = loadConfig();
        expect(config.migration.adapterBoundary).toBe(true);
        expect(config.migration.mobileRuntime).toBe(true);
      },
    );
  });
});
