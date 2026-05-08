import { describe, expect, it } from 'bun:test';
import { TerminalSessionManager } from '../../src/terminal/manager.js';
import type { LoadedSkill, TerminalConfig, TerminalOutput } from '../../src/terminal/types.js';

class FakeManager extends TerminalSessionManager {
  private readonly outputs: TerminalOutput[];
  capturedTimeout: number | undefined;

  constructor(config: TerminalConfig, skills: Map<string, LoadedSkill>, outputs: TerminalOutput[]) {
    super(config, skills);
    this.outputs = [...outputs];
  }

  async startSessionBackground(): Promise<{ sessionId: string }> {
    this.capturedTimeout = arguments[3] as number | undefined;
    return { sessionId: 'sess-1' };
  }

  async output(sessionId: string): Promise<TerminalOutput> {
    const next = this.outputs.shift();
    if (next) {
      return { ...next, sessionId };
    }
    return {
      sessionId,
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
    };
  }
}

const config: TerminalConfig = {
  skillsPath: '.',
  commandAllowlist: ['opencode'],
  cwdAllowlist: ['/tmp', '/home'],
  envBlocklist: [],
  defaultTimeout: 1000,
  maxConcurrentSessions: 2,
};

const skills = new Map<string, LoadedSkill>();

describe('terminal manager opencode tool outcome', () => {
  it('normalizes opencode timeout values to minimum contract', async () => {
    const cases: Array<{ name: string; input: number | undefined; expected: number }> = [
      { name: 't_lt60000', input: 59_999, expected: 60_000 },
      { name: 't_eq60000', input: 60_000, expected: 60_000 },
      { name: 't_gt60000', input: 120_000, expected: 120_000 },
      { name: 't_inf', input: Number.POSITIVE_INFINITY, expected: 60_000 },
      { name: 't_nan', input: Number.NaN, expected: 60_000 },
      { name: 't_undef', input: undefined, expected: 60_000 },
    ];

    for (const testCase of cases) {
      const manager = new FakeManager(config, skills, []);
      const startInput = {
        action: 'start' as const,
        skillName: 'opencode',
        pollAttempts: 1,
        pollIntervalMs: 1,
        ...(testCase.input !== undefined ? { timeout: testCase.input } : {}),
      };
      await manager.executeTool(
        startInput,
      );
      expect(manager.capturedTimeout, testCase.name).toBe(testCase.expected);
    }
  });

  it('emits poll_err with timeout message when polling exhausts', async () => {
    const manager = new FakeManager(config, skills, [
      {
        sessionId: 'ignored',
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
      },
    ]);

    const events: Array<{ type: string; error?: string }> = [];
    await manager.executeTool(
      {
        action: 'start',
        skillName: 'opencode',
        pollAttempts: 1,
        pollIntervalMs: 1,
      },
      (event) => {
        if (event.type === 'poll_err') {
          events.push({ type: event.type, error: event.error });
          return;
        }
        events.push({ type: event.type });
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual([
      { type: 'poll_err', error: 'Timed out waiting for session output (1 polls)' },
    ]);
  });

  it('emits tool_outcome when completed output is observed', async () => {
    const manager = new FakeManager(config, skills, [
      {
        sessionId: 'ignored',
        stdout: 'done',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
    ]);

    const events: string[] = [];
    await manager.executeTool(
      {
        action: 'start',
        skillName: 'opencode',
        pollAttempts: 1,
        pollIntervalMs: 1,
      },
      (event) => {
        events.push(event.type);
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(['tool_outcome']);
  });

  it('swallows callback rejection from poll loop events', async () => {
    const manager = new FakeManager(config, skills, [
      {
        sessionId: 'ignored',
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
      },
    ]);

    const result = await manager.executeTool(
      {
        action: 'start',
        skillName: 'opencode',
        pollAttempts: 1,
        pollIntervalMs: 1,
      },
      async () => {
        throw new Error('callback failed');
      },
    );

    expect(result.success).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('keeps valid final text and falls back otherwise', () => {
    const resolveFinalText = (resultText: unknown, toolFallback: string): string =>
      typeof resultText === 'string' && resultText.trim().length > 0 ? resultText : toolFallback;

    expect(resolveFinalText(42, 'toolFallback')).toBe('toolFallback'); // f_nonstring
    expect(resolveFinalText(undefined, 'toolFallback')).toBe('toolFallback'); // f_undef
    expect(resolveFinalText('   ', 'toolFallback')).toBe('toolFallback'); // f_ws
    expect(resolveFinalText('Final answer', 'toolFallback')).toBe('Final answer'); // f_valid_keep
  });
});
