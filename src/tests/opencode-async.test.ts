import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildOpencodeTerminalSessionStart, resetOpencodeBridgeForTests } from '../mcp/opencode.js';

describe('opencode bridge flow', () => {
  let tempDir = '';
  let pathEnv = '';

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'self-bot-opencode-'));
    const fakeExecutable = path.join(tempDir, 'opencode');
    writeFileSync(fakeExecutable, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(fakeExecutable, 0o755);
    pathEnv = `${tempDir}${path.delimiter}${process.env.PATH ?? ''}`;
  });

  afterEach(() => {
    resetOpencodeBridgeForTests();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns tool input for telegram-like opencode prefix', () => {
    const result = buildOpencodeTerminalSessionStart({
      messageId: 'm1',
      text: 'opencode: implement feature',
      availableSkills: ['opencode'],
      commandAllowlist: ['opencode'],
      pathEnv,
    });

    expect(result.shouldHandle).toBe(true);
    if (result.shouldHandle && !result.duplicate) {
      expect(result.userError).toBeUndefined();
      expect(result.toolInput).toBeDefined();
    }
  });

  it('maps code_editor alias to opencode', () => {
    const result = buildOpencodeTerminalSessionStart({
      messageId: 'm2',
      text: 'code_editor: do refactor',
      availableSkills: ['opencode'],
      commandAllowlist: ['opencode'],
      pathEnv,
    });

    expect(result.shouldHandle).toBe(true);
    if (result.shouldHandle && !result.duplicate && result.toolInput) {
      expect(result.toolInput.skillName).toBe('opencode');
    }
  });

  it('returns deterministic executable error when missing', () => {
    const result = buildOpencodeTerminalSessionStart({
      messageId: 'm3',
      text: 'opencode: do refactor',
      availableSkills: ['opencode'],
      commandAllowlist: ['opencode'],
      pathEnv: '/tmp/definitely-not-real',
    });

    expect(result.shouldHandle).toBe(true);
    if (result.shouldHandle && !result.duplicate) {
      expect(result.userError).toContain("Missing executable 'opencode'");
    }
  });

  it('maps cwd gate failures to INVALID_CWD user error', () => {
    const result = buildOpencodeTerminalSessionStart({
      messageId: 'm3b',
      text: 'opencode: do refactor',
      availableSkills: ['opencode'],
      commandAllowlist: ['opencode'],
      gateRunner: () => ({
        pass: false,
        phase: 'cwd',
        error: 'cwd does not exist: /bad/path',
        rolledBack: ['which', 'alias', 'intent'],
      }),
    });

    expect(result.shouldHandle).toBe(true);
    if (result.shouldHandle && !result.duplicate) {
      expect(result.userError).toBe('INVALID_CWD: cwd does not exist: /bad/path');
    }
  });

  it('guards against double fire for same message', () => {
    const first = buildOpencodeTerminalSessionStart({
      messageId: 'm4',
      text: 'opencode: once',
      availableSkills: ['opencode'],
      commandAllowlist: ['opencode'],
      pathEnv,
    });
    const second = buildOpencodeTerminalSessionStart({
      messageId: 'm4',
      text: 'opencode: once',
      availableSkills: ['opencode'],
      commandAllowlist: ['opencode'],
      pathEnv,
    });

    expect(first.shouldHandle).toBe(true);
    expect(second.shouldHandle).toBe(true);
    if (second.shouldHandle) {
      expect(second.duplicate).toBe(true);
    }
  });

  it('extracts simple prompt from opencode run command', () => {
    const result = buildOpencodeTerminalSessionStart({
      messageId: 'm5',
      text: 'opencode run /tmp --prompt "simple"',
      availableSkills: ['opencode'],
      commandAllowlist: ['opencode'],
      cwd: '/tmp',
      pathEnv,
    });

    expect(result.shouldHandle).toBe(true);
    if (result.shouldHandle && !result.duplicate && result.toolInput) {
      expect((result.toolInput.args as Record<string, unknown>)?.prompt).toBe('simple');
      expect(result.toolInput.cwd).toBe('/tmp');
    }
  });

  it('extracts prompt with spaces', () => {
    const result = buildOpencodeTerminalSessionStart({
      messageId: 'm6',
      text: 'opencode run /tmp --prompt "with spaces"',
      availableSkills: ['opencode'],
      commandAllowlist: ['opencode'],
      cwd: '/tmp',
      pathEnv,
    });

    expect(result.shouldHandle).toBe(true);
    if (result.shouldHandle && !result.duplicate && result.toolInput) {
      expect((result.toolInput.args as Record<string, unknown>)?.prompt).toBe('with spaces');
    }
  });

  it('extracts prompt with escaped quotes', () => {
    const result = buildOpencodeTerminalSessionStart({
      messageId: 'm7',
      text: 'opencode run /tmp --prompt "with \\"escaped\\" quotes"',
      availableSkills: ['opencode'],
      commandAllowlist: ['opencode'],
      cwd: '/tmp',
      pathEnv,
    });

    expect(result.shouldHandle).toBe(true);
    if (result.shouldHandle && !result.duplicate && result.toolInput) {
      expect((result.toolInput.args as Record<string, unknown>)?.prompt).toBe('with \\"escaped\\" quotes');
    }
  });

  it('extracts complex prompt with escaped quotes in function call', () => {
    const result = buildOpencodeTerminalSessionStart({
      messageId: 'm8',
      text: 'opencode run /tmp --prompt "create hello.py with print(\\"hello world\\")"',
      availableSkills: ['opencode'],
      commandAllowlist: ['opencode'],
      cwd: '/tmp',
      pathEnv,
    });

    expect(result.shouldHandle).toBe(true);
    if (result.shouldHandle && !result.duplicate && result.toolInput) {
      expect((result.toolInput.args as Record<string, unknown>)?.prompt).toBe('create hello.py with print(\\"hello world\\")');
    }
  });

  it('extracts prompt and approve parameter', () => {
    const result = buildOpencodeTerminalSessionStart({
      messageId: 'm9',
      text: 'opencode run /tmp --prompt "setup project" --approve true',
      availableSkills: ['opencode'],
      commandAllowlist: ['opencode'],
      cwd: '/tmp',
      pathEnv,
    });

    expect(result.shouldHandle).toBe(true);
    if (result.shouldHandle && !result.duplicate && result.toolInput) {
      expect((result.toolInput.args as Record<string, unknown>)?.prompt).toBe('setup project');
      expect((result.toolInput.args as Record<string, unknown>)?.approve).toBe('true');
    }
  });

  it('extracts prompt and approve with escaped quotes', () => {
    const result = buildOpencodeTerminalSessionStart({
      messageId: 'm10',
      text: 'opencode run /tmp --prompt "create file with \\"content\\"" --approve true',
      availableSkills: ['opencode'],
      commandAllowlist: ['opencode'],
      cwd: '/tmp',
      pathEnv,
    });

    expect(result.shouldHandle).toBe(true);
    if (result.shouldHandle && !result.duplicate && result.toolInput) {
      expect((result.toolInput.args as Record<string, unknown>)?.prompt).toBe('create file with \\"content\\"');
      expect((result.toolInput.args as Record<string, unknown>)?.approve).toBe('true');
    }
  });

  it('handles opencode without run keyword', () => {
    const result = buildOpencodeTerminalSessionStart({
      messageId: 'm11',
      text: 'opencode /tmp --prompt "direct call"',
      availableSkills: ['opencode'],
      commandAllowlist: ['opencode'],
      cwd: '/tmp',
      pathEnv,
    });

    expect(result.shouldHandle).toBe(true);
    if (result.shouldHandle && !result.duplicate && result.toolInput) {
      expect((result.toolInput.args as Record<string, unknown>)?.prompt).toBe('direct call');
      expect(result.toolInput.cwd).toBe('/tmp');
    }
  });
});
