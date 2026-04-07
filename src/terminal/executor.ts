/**
 * src/terminal/executor.ts
 * Subprocess execution with security controls.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { childLogger } from '../utils/logger.js';
import type { SkillDefinition, TerminalConfig, TerminalOutput } from './types.js';
import { filterEnvVars, buildCommandArgs } from './validator.js';

const log = childLogger({ module: 'terminal:executor' });

/**
 * Execute a skill as a subprocess.
 */
export function executeSkill(
  skill: SkillDefinition,
  config: TerminalConfig,
  userArgs?: Record<string, string>,
  customCwd?: string,
  customTimeout?: number
): {
  process: ChildProcess;
  promise: Promise<TerminalOutput>;
} {
  // Build command and arguments
  const commandArgs = buildCommandArgs(skill, userArgs);
  const fullArgs = [...commandArgs];

  // Determine working directory
  const cwd = customCwd ?? skill.cwd ?? process.cwd();

  // Build environment
  const baseEnv = filterEnvVars(process.env as Record<string, string>, config.envBlocklist);
  const skillEnv = skill.env ? { ...baseEnv, ...skill.env } : baseEnv;

  // Determine timeout
  const timeout = customTimeout ?? skill.timeout ?? config.defaultTimeout;

  log.debug(
    { command: skill.command, args: fullArgs, cwd, timeout },
    'Executing skill'
  );

  // Create buffers for output
  let stdoutData = '';
  let stderrData = '';
  let timedOut = false;
  let resolveOutput: (output: TerminalOutput) => void;
  let rejectOutput: (err: Error) => void;

  const outputPromise = new Promise<TerminalOutput>((resolve, reject) => {
    resolveOutput = resolve;
    rejectOutput = reject;
  });

  // Spawn the process with shell: false for security
  const proc = spawn(skill.command, fullArgs, {
    cwd,
    env: skillEnv,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Set up timeout
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    log.warn({ sessionId: 'pending', skill: skill.name }, 'Process timed out, sending SIGTERM');

    // Send SIGTERM first
    proc.kill('SIGTERM');

    // Wait 5 seconds then SIGKILL
    setTimeout(() => {
      if (!proc.killed) {
        log.warn({ sessionId: 'pending', skill: skill.name }, 'Process did not terminate, sending SIGKILL');
        proc.kill('SIGKILL');
      }
    }, 5000);
  }, timeout);

  // Handle stdout
  proc.stdout?.on('data', (data: Buffer) => {
    const text = data.toString();
    stdoutData += text;
    log.debug({ stdout: text.slice(0, 200) }, 'Process stdout');
  });

  // Handle stderr
  proc.stderr?.on('data', (data: Buffer) => {
    const text = data.toString();
    stderrData += text;
    log.debug({ stderr: text.slice(200) }, 'Process stderr');
  });

  // Handle process exit
  proc.on('close', (code: number | null) => {
    clearTimeout(timeoutHandle);

    const output: TerminalOutput = {
      sessionId: 'pending', // Will be set by manager
      stdout: stdoutData,
      stderr: stderrData,
      exitCode: code,
      timedOut,
    };

    log.info(
      { exitCode: code, timedOut, stdoutLength: stdoutData.length, stderrLength: stderrData.length },
      'Process completed'
    );

    resolveOutput(output);
  });

  // Handle process error
  proc.on('error', (err: Error) => {
    clearTimeout(timeoutHandle);
    log.error({ err }, 'Process error');
    rejectOutput(err);
  });

  return {
    process: proc,
    promise: outputPromise,
  };
}

/**
 * Send input to a running process.
 */
export function sendInput(proc: ChildProcess, input: string): boolean {
  if (!proc.stdin || proc.stdin.destroyed) {
    return false;
  }

  try {
    proc.stdin.write(input);
    return true;
  } catch (err) {
    log.error({ err }, 'Failed to write to process stdin');
    return false;
  }
}

/**
 * Terminate a process gracefully.
 */
export function terminateProcess(proc: ChildProcess): void {
  try {
    // Send SIGTERM first
    proc.kill('SIGTERM');

    // Wait 5 seconds then SIGKILL
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL');
      }
    }, 5000);
  } catch (err) {
    log.error({ err }, 'Failed to terminate process');
    // Force kill if graceful termination fails
    try {
      proc.kill('SIGKILL');
    } catch {
      // Ignore - process may already be dead
    }
  }
}

/**
 * Check if a process is still running.
 */
export function isProcessRunning(proc: ChildProcess): boolean {
  return !proc.killed && proc.exitCode === null;
}