import { constants as fsConstants } from 'node:fs';
import { accessSync } from 'node:fs';
import path from 'node:path';

export type WhichPhase = {
  pass: boolean;
  command: string;
  resolvedPath?: string;
  error?: string;
};

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Performs a deterministic executable precheck used by terminal gates.
 *
 * This function is executed in the "which" phase (phase 3 of 5) of the terminal gate pipeline.
 * It verifies that the requested command is available on the system and executable.
 *
 * For path-like commands (containing / or \), it checks the exact path.
 * For simple command names, it searches the PATH environment variable.
 *
 * Error semantics implemented by IMP (returned in deterministic order):
 * 1. "Executable name is empty" — command is empty or whitespace-only
 * 2. "Executable not found: <command>" — path-like command exists but is not executable
 * 3. "Missing executable '<command>'. Install it with: ..." — command not found in PATH
 *
 * Args:
 *   command: Command name (e.g., 'opencode', 'git', '/usr/bin/python')
 *   pathEnv: PATH environment variable (defaults to process.env.PATH)
 *
 * Returns:
 *   WhichPhase with:
 *   - pass: true and resolvedPath: <absolute path> if executable is found
 *   - pass: false and error: <message> if command is not found or not executable
 *
 * Example (command in PATH):
 *   precheckExecutable('opencode', '/usr/local/bin:/usr/bin:/bin')
 *   => { pass: true, command: 'opencode', resolvedPath: '/usr/local/bin/opencode' }
 *
 * Example (command not in PATH):
 *   precheckExecutable('nonexistent', '/usr/bin:/bin')
 *   => { pass: false, command: 'nonexistent', error: "Missing executable 'nonexistent'. Install it with: ..." }
 *
 * Example (path-like command not found):
 *   precheckExecutable('./missing', '/usr/bin:/bin')
 *   => { pass: false, command: './missing', error: 'Executable not found: ./missing' }
 */
export function precheckExecutable(command: string, pathEnv = process.env.PATH ?? ''): WhichPhase {

  const trimmed = command.trim();
  if (!trimmed) {
    return { pass: false, command: trimmed, error: 'Executable name is empty' };
  }

  if (trimmed.includes('/') || trimmed.includes('\\')) {
    const abs = path.resolve(trimmed);
    if (isExecutable(abs)) {
      return { pass: true, command: trimmed, resolvedPath: abs };
    }
    return { pass: false, command: trimmed, error: `Executable not found: ${trimmed}` };
  }

  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, trimmed);
    if (isExecutable(candidate)) {
      return { pass: true, command: trimmed, resolvedPath: candidate };
    }
  }

  return {
    pass: false,
    command: trimmed,
    error: `Missing executable '${trimmed}'. Install it with: npm install -g opencode`,
  };
}
