/**
 * src/terminal/validator.ts
 * Validate skills, commands, and paths for security.
 */

import * as path from 'node:path';
import { statSync } from 'node:fs';
import type { SkillDefinition, ValidationResult, TerminalConfig } from './types.js';

type SessionValidationResult = ValidationResult & {
  normalizedCwd: string;
  invalidCwd: boolean;
};

/**
 * Validate a skill definition.
 */
export function validateSkillDefinition(definition: SkillDefinition): ValidationResult {
  const errors: string[] = [];

  // Name is required
  if (!definition.name || definition.name.trim() === '') {
    errors.push('Skill name is required');
  }

  // Command is required
  if (!definition.command || definition.command.trim() === '') {
    errors.push('Command is required');
  }

  // Description is recommended
  if (!definition.description || definition.description.trim() === '') {
    errors.push('Description is recommended');
  }

  // Validate command doesn't contain shell operators
  if (definition.command.includes('|') ||
      definition.command.includes('&&') ||
      definition.command.includes(';') ||
      definition.command.includes('>') ||
      definition.command.includes('<')) {
    errors.push('Command must not contain shell operators');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a command against the allowlist.
 *
 * Extracts the base command name (first word) from the input string and checks if it
 * exists in the allowlist using exact matching (case-sensitive).
 *
 * Args:
 *   command: Command string to validate (may contain arguments)
 *   allowlist: Array of allowed command names (e.g., ['opencode', 'claude', 'git'])
 *
 * Returns:
 *   ValidationResult with `valid: true` if the base command is in the allowlist,
 *   or `valid: false` with an error message listing the command and allowed options.
 *
 * Example:
 *   validateCommand('opencode --yes', ['opencode', 'git'])
 *   => { valid: true, errors: [] }
 *
 *   validateCommand('rm -rf /', ['opencode', 'git'])
 *   => { valid: false, errors: ["Command 'rm' is not in the allowlist: [opencode, git]"] }
 */
export function validateCommand(
  command: string,
  allowlist: string[]
): ValidationResult {
  const errors: string[] = [];

  // Extract base command (first word)
  const baseCommand = path.basename(command.trim().split(/\s+/)[0] ?? '');

  // Check if command is in allowlist (exact match)
  if (!allowlist.includes(baseCommand)) {
    errors.push(
      `Command '${baseCommand}' is not in the allowlist: [${allowlist.join(', ')}]`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a working directory against the allowlist.
 *
 * Uses prefix matching after resolving the path with `path.resolve()`.
 * Matching is case-sensitive on Linux/Mac and case-insensitive on Windows.
 *
 * Args:
 *   cwd: Working directory path to validate (relative or absolute)
 *   allowlist: Array of allowed directory prefix paths (e.g., ['/home', '/tmp'])
 *
 * Returns:
 *   ValidationResult with `valid: true` if the resolved path starts with any allowlist prefix,
 *   or `valid: false` with error messages describing why validation failed:
 *   - Path not in allowlist
 *   - Path contains traversal attempt (..)
 *   - Invalid path format
 *
 * Example:
 *   validateCwd('/home/user/Dev', ['/home', '/tmp'])
 *   => { valid: true, errors: [] }
 *
 *   validateCwd('/var/lib', ['/home', '/tmp'])
 *   => { valid: false, errors: ["Working directory '/var/lib' is not in the allowlist: [/home, /tmp]"] }
 */
export function validateCwd(
  cwd: string,
  allowlist: string[]
): ValidationResult {
  const errors: string[] = [];

  try {
    // Resolve the path to an absolute path
    const resolvedCwd = path.resolve(cwd);

    // Check if resolved path starts with any allowlist prefix
    const isAllowed = allowlist.some(prefix => resolvedCwd.startsWith(prefix));

    if (!isAllowed) {
      errors.push(
        `Working directory '${resolvedCwd}' is not in the allowlist: [${allowlist.join(', ')}]`
      );
    }

    // Check for path escape attempts
    if (cwd.includes('..')) {
      errors.push('Path traversal detected (..)');
    }
  } catch (err) {
    errors.push(`Invalid working directory: ${(err as Error).message}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Filter environment variables, removing blocked patterns.
 */
export function filterEnvVars(
  env: Record<string, string>,
  blocklist: string[]
): Record<string, string> {
  const filtered: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    // Check if key matches any blocklist pattern
    const isBlocked = blocklist.some(pattern => {
      // Pattern can be a prefix (e.g., "AWS_") or exact match
      return key === pattern || key.startsWith(pattern);
    });

    if (!isBlocked) {
      filtered[key] = value;
    }
  }

  return filtered;
}

/**
 * Validate skill arguments against the skill's argument schema.
 */
export function validateArgs(
  providedArgs: Record<string, string> | undefined,
  schema: SkillDefinition['arguments']
): ValidationResult {
  const errors: string[] = [];

  if (!schema || schema.length === 0) {
    // No schema means any args are allowed
    return { valid: true, errors: [] };
  }

  if (!providedArgs) {
    providedArgs = {};
  }

  // Check required arguments
  for (const arg of schema) {
    if (arg.required && !(arg.name in providedArgs)) {
      errors.push(`Required argument '${arg.name}' is missing`);
    }
  }

  // Validate argument types
  for (const [name, value] of Object.entries(providedArgs)) {
    const argDef = schema.find(a => a.name === name);
    if (!argDef) {
      errors.push(`Unknown argument '${name}'`);
      continue;
    }

    // Type validation (basic)
    if (argDef.type === 'number' && isNaN(Number(value))) {
      errors.push(`Argument '${name}' must be a number`);
    }

    if (argDef.type === 'boolean' && !['true', 'false', '0', '1'].includes(value.toLowerCase())) {
      errors.push(`Argument '${name}' must be a boolean`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Build command arguments from skill definition and user input.
 */
export function buildCommandArgs(
  skill: SkillDefinition,
  userArgs?: Record<string, string>
): string[] {
  const args: string[] = [];

  // Add default args from skill definition
  if (skill.args) {
    args.push(...skill.args);
  }

  // Add user-provided args
  if (userArgs && skill.arguments) {
    for (const argDef of skill.arguments) {
      const value = userArgs[argDef.name];
      if (value !== undefined) {
        args.push(`--${argDef.name}`, value);
      } else if (argDef.default !== undefined) {
        args.push(`--${argDef.name}`, argDef.default);
      }
    }
  }

  return args;
}

/**
 * Validate all inputs for starting a terminal session.
 */
export function validateSessionInput(
  skill: SkillDefinition,
  config: TerminalConfig,
  userArgs?: Record<string, string>,
  customCwd?: string
): SessionValidationResult {
  const errors: string[] = [];

  // Validate command
  const cmdValidation = validateCommand(skill.command, config.commandAllowlist);
  errors.push(...cmdValidation.errors);

  // Validate working directory
  const cwd = customCwd ?? skill.cwd ?? process.cwd();
  const cwdValidation = validateCwd(cwd, config.cwdAllowlist);
  errors.push(...cwdValidation.errors);

  const normalizedCwd = path.resolve(cwd);
  const strictCwdValidation = ('strictCwdValidation' in config)
    ? Boolean((config as TerminalConfig & { strictCwdValidation?: boolean }).strictCwdValidation)
    : true;

  if (strictCwdValidation) {
    try {
      const stats = statSync(normalizedCwd);
      if (!stats.isDirectory()) {
        errors.push(`INVALID_CWD: '${normalizedCwd}' is not a directory`);
      }
    } catch {
      errors.push(`INVALID_CWD: '${normalizedCwd}' does not exist`);
    }
  }

  // Validate arguments
  const argsValidation = validateArgs(userArgs, skill.arguments);
  errors.push(...argsValidation.errors);

  return {
    valid: errors.length === 0,
    errors,
    normalizedCwd,
    invalidCwd: errors.some((error) => error.startsWith('INVALID_CWD:')),
  };
}
