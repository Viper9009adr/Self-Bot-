/**
 * src/terminal/executor.ts
 * Execute terminal commands with proper argument handling and security.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { childLogger } from '../utils/logger.js';
import type { SkillDefinition, TerminalConfig, TerminalOutput, ShellQuotingRule, SkillTransformation } from './types.js';
import { buildCommandArgs } from './validator.js';

const log = childLogger({ module: 'terminal:executor' });

/**
 * Safely escape a string for use in shell commands using single-quote wrapping.
 * Single quotes prevent ALL shell substitution and expansion.
 * 
 * @param str - The string to escape
 * @returns The escaped string wrapped in single quotes
 */
export function shellQuote(str: string): string {
  // Replace each single quote with '\'' (end quote, escaped quote, start quote)
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/**
 * Apply position-based shell quoting rules to command arguments.
 * 
 * Evaluates shell quoting rules (if provided) to determine which arguments should
 * be escaped for shell execution. Flags (arguments starting with '-') are ALWAYS
 * unquoted regardless of rules. Without rules, all non-flag arguments are quoted.
 * 
 * Supports both positive indices (0, 1, 2...) and negative indices for counting
 * from the end of the array (-1 = last, -2 = second-to-last, etc.).
 * 
 * @param args - Array of command arguments to process
 * @param rules - Optional array of ShellQuotingRule objects specifying which positions
 *   should/shouldn't be quoted. If not provided or empty, all non-flag arguments
 *   are quoted by default (backward compatible behavior).
 * @returns Array of arguments with quoting applied according to rules
 * 
 * @example
 * // Don't quote position 0 (subcommand), do quote last position (prompt)
 * const rules: ShellQuotingRule[] = [
 *   { position: 0, quote: false },
 *   { position: -1, quote: true }
 * ];
 * const result = applyShellQuotingRules(['run', '--flag', 'prompt'], rules);
 * // Returns: ['run', '--flag', "'prompt'"]
 * 
 * @example
 * // Backward compatible: no rules means quote everything except flags
 * const result = applyShellQuotingRules(['cmd', '--flag', 'value']);
 * // Returns: ["'cmd'", '--flag', "'value'"]
 */
export function applyShellQuotingRules(
  args: string[],
  rules?: ShellQuotingRule[]
): string[] {
  return args.map((arg, index) => {
    if (arg.startsWith('-')) return arg;
    if (rules && rules.length > 0) {
      const rule = rules.find(r => {
        const rulePos = (r.position >= 0) ? r.position : args.length + r.position;
        return rulePos === index;
      });
      return (rule?.quote === false) ? arg : shellQuote(arg);
    }
    return shellQuote(arg);
  });
}

/**
 * Apply declarative transformations to command arguments.
 * 
 * Transforms arguments based on skill definition's subcommand, approveFlag,
 * and transformations array. This replaces hardcoded command-specific logic
 * with a declarative approach.
 * 
 * @param args - Array of command arguments to transform
 * @param skill - SkillDefinition with transformation configuration
 * @returns Transformed array of arguments
 */
function applyTransformations(args: string[], skill: SkillDefinition): string[] {
  const result = [...args];

  // 1. Inject subcommand at the beginning if specified and not present
  if (skill.subcommand && !result.includes(skill.subcommand)) {
    result.unshift(skill.subcommand);
  }

  // 2. Handle approve flag transformation
  let approveValue: string | undefined;
  if (skill.approveFlag) {
    const approveIndex = result.findIndex(arg => arg === '--approve');
    if (approveIndex !== -1) {
      approveValue = result[approveIndex + 1];
      // Remove both --approve and its value
      result.splice(approveIndex, 2);
    }
  }

  // 3. Apply transformation rules
  if (skill.transformations) {
    for (const transform of skill.transformations) {
      applySingleTransformation(result, transform);
    }
  }

  // 4. If skill defines approveFlag, always inject it (no --approve arg required)
  if (skill.approveFlag && result.length > 1) {
    // Insert after subcommand (position 1)
    result.splice(1, 0, skill.approveFlag);
  }

  // 5. Reorder flags based on flagPosition
  if (skill.flagPosition && skill.subcommand) {
    const subIdx = result.indexOf(skill.subcommand);
    if (subIdx === -1) return result;
    
    if (skill.flagPosition === 'before-subcommand') {
      // Flags are AFTER subcommand, move them BEFORE
      const afterSub = result.slice(subIdx + 1);
      const flags = afterSub.filter(arg => arg.startsWith('-'));
      const others = afterSub.filter(arg => !arg.startsWith('-'));
      if (flags.length > 0) {
        result.splice(subIdx + 1, afterSub.length, ...flags, ...others);
      }
    } else if (skill.flagPosition === 'after-subcommand') {
      // Flags are BEFORE subcommand, move them AFTER
      const beforeSub = result.slice(1, subIdx);
      const flags = beforeSub.filter(arg => arg.startsWith('-'));
      const others = beforeSub.filter(arg => !arg.startsWith('-'));
      if (flags.length > 0) {
        result.splice(1, subIdx - 1, ...others, ...flags);
      }
    }
  }

  return result;
}

/**
 * Apply a single transformation rule to the argument array.
 */
function applySingleTransformation(args: string[], transform: SkillTransformation): void {
  switch (transform.type) {
    case 'prepend': {
      // Prepend value to args if flag is found and matches value
      const idx = args.indexOf(transform.flag);
      if (idx !== -1) {
        const matchValue = transform.value === undefined || args[idx + 1] === transform.value;
        if (matchValue && transform.value) {
          args.splice(idx + 1, 0, transform.value);
        }
      }
      break;
    }
    case 'append': {
      // Append value to args if flag is found
      const idx = args.indexOf(transform.flag);
      if (idx !== -1 && transform.value) {
        args.splice(idx + 2, 0, transform.value);
      }
      break;
    }
    case 'remove-flag': {
      // Remove flag and optionally its value
      const idx = args.indexOf(transform.flag);
      if (idx !== -1) {
        // Check if next arg is a value (not a flag)
        const nextArg = args[idx + 1];
        const removeValue = transform.value === undefined || nextArg === transform.value;
        if (removeValue && nextArg && !nextArg.startsWith('-')) {
          args.splice(idx, 2);
        } else {
          args.splice(idx, 1);
        }
      }
      break;
    }
    case 'convert-flag': {
      // Convert one flag to another
      const idx = args.indexOf(transform.flag);
      if (idx !== -1 && transform.targetFlag) {
        args[idx] = transform.targetFlag;
      }
      break;
    }
    case 'positional': {
      // Convert flag to positional argument (move value to end)
      const idx = args.indexOf(transform.flag);
      if (idx !== -1) {
        const value = args[idx + 1];
        // Remove flag and its value
        args.splice(idx, 2);
        // Add value as positional at the end
        if (value && !value.startsWith('-')) {
          args.push(value);
        }
      }
      break;
    }
  }
}

/**
 * Execute a skill command with proper argument handling.
 */
export function executeSkill(
  skill: SkillDefinition,
  config: TerminalConfig,
  userArgs?: Record<string, string>,
  customCwd?: string,
  customTimeout?: number,
  normalizedCwd?: string
): { process: ChildProcess; promise: Promise<TerminalOutput> } {
  // Build command and arguments
  const command = skill.command;
  let args = buildCommandArgs(skill, userArgs);

  // Apply declarative transformations if defined
  if (skill.transformations || skill.subcommand || skill.approveFlag) {
    args = applyTransformations(args, skill);
  }

   log.info({ command, args, cwd: normalizedCwd }, 'Executing terminal command');

  // Check if skill requires shell mode
  let proc: ChildProcess;
  
  if (skill.requiresShellMode === true) {
    // Shell mode: use cd && command pattern for tools that need explicit cwd context
    const cwd = normalizedCwd ?? customCwd ?? skill.cwd ?? process.cwd();
    const escapedCwd = shellQuote(cwd);
     const escapedArgs = applyShellQuotingRules(args, skill.shellQuoting?.argRules);
    const shellCommand = `cd ${escapedCwd} && ${command} ${escapedArgs.join(' ')}`;
    
    log.info({ shellCommand }, `Executing ${command} via shell with cwd: ${cwd}`);

    // Use 'ignore' for stdin to signal EOF immediately to interactive CLIs.
    // This is equivalent to </dev/null and prevents the process from hanging
    // while waiting for piped stdin input that never arrives.
    proc = spawn('/bin/bash', ['-c', shellCommand], {
      env: {
        ...process.env,
        ...skill.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    // Direct spawn mode: use standard process spawn with cwd parameter
    proc = spawn(command, args, {
      cwd: normalizedCwd ?? customCwd ?? skill.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...skill.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }


  // Log PATH for debugging
  const env = {
    ...process.env,
    ...skill.env,
  };
  log.info({ PATH: env.PATH }, '[Executor] env.PATH');

  // SharedError container to capture spawn errors
  let spawnError: Error | null = null;

  // Outer error handler captures the error into the container
  proc.on('error', (err: Error) => {
    spawnError = err;
    log.error(`[Spawn Error] ${(err as any).code}: ${err.message}`);
  });

  // Set up timeout
  const timeout = customTimeout ?? skill.timeout ?? config.defaultTimeout;
  let timeoutId: NodeJS.Timeout | undefined;

  if (timeout > 0) {
    timeoutId = setTimeout(() => {
      log.warn({ sessionId: proc.pid }, 'Process timeout reached, terminating');
      terminateProcess(proc);
    }, timeout);
  }

  // Collect output
  const stdout: string[] = [];
  const stderr: string[] = [];

  proc.stdout?.on('data', (data: Buffer) => {
    stdout.push(data.toString());
  });

  proc.stderr?.on('data', (data: Buffer) => {
    stderr.push(data.toString());
  });

  // Create promise that resolves when process exits
  const promise = new Promise<TerminalOutput>((resolve, reject) => {
    // Check if spawn error already occurred synchronously
    if (spawnError) {
      if (timeoutId) clearTimeout(timeoutId);
      reject(spawnError);
      return;
    }

    proc.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      
      resolve({
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        exitCode: code,
        timedOut: false,
      } as TerminalOutput);
    });
  });

  return { process: proc, promise };
}

/**
 * Send input to a running process.
 */
export function sendInput(proc: ChildProcess, input: string): boolean {
  if (proc.killed || proc.exitCode !== null) {
    return false;
  }

  if (proc.stdin) {
    proc.stdin.write(input);
    return true;
  }

  return false;
}

/**
 * Terminate a process.
 */
export function terminateProcess(proc: ChildProcess): void {
  if (!proc.killed && proc.exitCode === null) {
    proc.kill('SIGTERM');
    
    // Force kill after 5 seconds if still running
    setTimeout(() => {
      if (!proc.killed && proc.exitCode === null) {
        proc.kill('SIGKILL');
      }
    }, 5000);
  }
}

/**
 * Check if a process is still running.
 */
export function isProcessRunning(proc: ChildProcess): boolean {
  return !proc.killed && proc.exitCode === null;
}