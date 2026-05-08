import { describe, expect, it } from 'bun:test';
import { toTelegramUserResponseFromPollError } from '../../src/adapters/telegram/index.js';

describe('opencode poll_err user response', () => {
  it('formats poll_err into user-facing warning text', () => {
    const text = toTelegramUserResponseFromPollError('Timed out waiting for session output (3 polls)');
    expect(text).toBe('⚠️ OpenCode result polling failed: Timed out waiting for session output (3 polls)');
  });
});
