/**
 * tests/unit/config/terminal-config-regression.test.ts
 * Regression coverage for TERMINAL_* env parsing/default semantics.
 */
import { describe, it, expect } from 'bun:test';
import { loadConfig, resetConfig } from '../../../src/config/index.js';

const MANAGED_ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'BOT_OWNER_ID',
  // Clear conditional blocks to keep tests deterministic.
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
  // Terminal vars under test.
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

describe('terminal config regression', () => {
  it('uses schema defaults when TERMINAL_* vars are unset', async () => {
    await withManagedEnv({}, () => {
      const config = loadConfig();
      expect(config.terminal.skillsPath).toBe('./terminal-skills');
      expect(config.terminal.commandAllowlist).toEqual(['opencode', 'claude', 'codex', 'git']);
      expect(config.terminal.cwdAllowlist).toEqual(['/home', '/tmp']);
      expect(config.terminal.envBlocklist).toEqual(['AWS_', 'SECRET_', 'TOKEN_', 'API_KEY']);
      expect(config.terminal.defaultTimeout).toBe(300000);
      expect(config.terminal.maxConcurrentSessions).toBe(5);
    });
  });

  it('parses TERMINAL_* overrides with trimming and number coercion', async () => {
    await withManagedEnv(
      {
        TERMINAL_SKILLS_PATH: '/opt/terminal-skills',
        TERMINAL_COMMAND_ALLOWLIST: 'git, codex , opencode',
        TERMINAL_CWD_ALLOWLIST: '/repo,/tmp/work',
        TERMINAL_ENV_BLOCKLIST: 'SECRET_, TOKEN_ ,AWS_',
        TERMINAL_DEFAULT_TIMEOUT: '45000',
        TERMINAL_MAX_CONCURRENT_SESSIONS: '7',
      },
      () => {
        const config = loadConfig();
        expect(config.terminal.skillsPath).toBe('/opt/terminal-skills');
        expect(config.terminal.commandAllowlist).toEqual(['git', 'codex', 'opencode']);
        expect(config.terminal.cwdAllowlist).toEqual(['/repo', '/tmp/work']);
        expect(config.terminal.envBlocklist).toEqual(['SECRET_', 'TOKEN_', 'AWS_']);
        expect(config.terminal.defaultTimeout).toBe(45000);
        expect(config.terminal.maxConcurrentSessions).toBe(7);
      },
    );
  });

  it('treats empty TERMINAL list env vars as unset and applies defaults', async () => {
    await withManagedEnv(
      {
        TERMINAL_COMMAND_ALLOWLIST: '',
        TERMINAL_CWD_ALLOWLIST: '',
        TERMINAL_ENV_BLOCKLIST: '',
      },
      () => {
        const config = loadConfig();
        expect(config.terminal.commandAllowlist).toEqual(['opencode', 'claude', 'codex', 'git']);
        expect(config.terminal.cwdAllowlist).toEqual(['/home', '/tmp']);
        expect(config.terminal.envBlocklist).toEqual(['AWS_', 'SECRET_', 'TOKEN_', 'API_KEY']);
      },
    );
  });
});
