import { describe, expect, it } from 'bun:test';
import { runTerminalSessionGates } from '../terminal/session.js';

describe('terminal session gates', () => {
  it('passes all phases for opencode intent', () => {
    const result = runTerminalSessionGates({
      text: 'opencode: fix lint errors',
      availableSkills: ['opencode'],
      commandAllowlist: ['opencode'],
      whichFn: () => ({ pass: true, command: 'opencode', resolvedPath: '/bin/opencode' }),
      cwdFn: () => ({ pass: true, cwd: '/tmp' }),
    });

    expect(result.pass).toBe(true);
    if (result.pass) {
      expect(result.skillName).toBe('opencode');
      expect(result.payload).toBe('fix lint errors');
    }
  });

  it('uses alias fallback code_editor -> opencode', () => {
    const result = runTerminalSessionGates({
      text: 'code_editor: run task',
      availableSkills: ['opencode'],
      commandAllowlist: ['opencode'],
      whichFn: () => ({ pass: true, command: 'opencode', resolvedPath: '/bin/opencode' }),
      cwdFn: () => ({ pass: true, cwd: '/tmp' }),
    });

    expect(result.pass).toBe(true);
    if (result.pass) {
      expect(result.skillName).toBe('opencode');
      expect(result.usedFallback).toBe(true);
    }
  });

  it('fails at which phase and rolls back intent+alias', () => {
    const rolled: string[] = [];
    const result = runTerminalSessionGates({
      text: 'opencode: hello',
      availableSkills: ['opencode'],
      commandAllowlist: ['opencode'],
      whichFn: () => ({ pass: false, command: 'opencode', error: 'missing binary' }),
      cwdFn: () => ({ pass: true, cwd: '/tmp' }),
      rollback: {
        intent: () => rolled.push('intent'),
        alias: () => rolled.push('alias'),
      },
    });

    expect(result.pass).toBe(false);
    if (!result.pass) {
      expect(result.phase).toBe('which');
      expect(result.rolledBack).toEqual(['alias', 'intent']);
      expect(rolled).toEqual(['alias', 'intent']);
    }
  });

  it('fails at cwd phase and rolls back which+alias+intent', () => {
    const rolled: string[] = [];
    const result = runTerminalSessionGates({
      text: 'opencode: hello',
      availableSkills: ['opencode'],
      commandAllowlist: ['opencode'],
      whichFn: () => ({ pass: true, command: 'opencode', resolvedPath: '/bin/opencode' }),
      cwdFn: () => ({ pass: false, error: 'cwd invalid' }),
      rollback: {
        intent: () => rolled.push('intent'),
        alias: () => rolled.push('alias'),
        which: () => rolled.push('which'),
      },
    });

    expect(result.pass).toBe(false);
    if (!result.pass) {
      expect(result.phase).toBe('cwd');
      expect(result.rolledBack).toEqual(['which', 'alias', 'intent']);
      expect(rolled).toEqual(['which', 'alias', 'intent']);
    }
  });

  it('fails at val phase and rolls back cwd+which+alias+intent', () => {
    const result = runTerminalSessionGates({
      text: 'opencode: hello',
      availableSkills: ['opencode'],
      commandAllowlist: ['opencode'],
      whichFn: () => ({ pass: true, command: 'opencode', resolvedPath: '/bin/opencode' }),
      cwdFn: () => ({ pass: true, cwd: '/tmp' }),
      validate: () => ({ pass: false, error: 'validation failed' }),
      rollback: {
        intent: () => undefined,
        alias: () => undefined,
        which: () => undefined,
        cwd: () => undefined,
      },
    });

    expect(result.pass).toBe(false);
    if (!result.pass) {
      expect(result.phase).toBe('val');
      expect(result.rolledBack).toEqual(['cwd', 'which', 'alias', 'intent']);
    }
  });
});
