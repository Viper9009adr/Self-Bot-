import { statSync } from 'node:fs';
import path from 'node:path';

/**
 * Normalizes a requested cwd with `path.resolve()` and verifies it exists as a directory.
 *
 * This function is used in the terminal gate pipeline (phase 4) to ensure the working directory
 * is valid before spawning a terminal session.
 *
 * Args:
 *   rawCwd: The working directory path to normalize (can be relative or absolute, or undefined)
 *   fallbackCwd: Directory to use if rawCwd is empty or falsy (defaults to process.cwd())
 *
 * Returns:
 *   CwdPhase with:
 *   - pass: true and cwd: <absolute path> if path exists and is a directory
 *   - pass: false and error: <message> if path doesn't exist, is not a directory, or is invalid
 *
 * Error cases:
 *   - "cwd does not exist: <path>" — The directory path cannot be found on the filesystem
 *   - "cwd is not a directory: <path>" — The path points to a file, not a directory
 *
 * Example:
 *   normalizeAndValidateCwd('/home/user/Dev')
 *   => { pass: true, cwd: '/home/user/Dev' }
 *
 *   normalizeAndValidateCwd('/nonexistent/path')
 *   => { pass: false, error: 'cwd does not exist: /nonexistent/path' }
 */

export type CwdPhase = {
  pass: boolean;
  cwd?: string;
  error?: string;
};

export function normalizeAndValidateCwd(rawCwd: string | undefined, fallbackCwd = process.cwd()): CwdPhase {
  const source = (rawCwd ?? '').trim();
  const candidate = source.length > 0 ? source : fallbackCwd;
  const normalized = path.resolve(candidate);

  try {
    const stats = statSync(normalized);
    if (!stats.isDirectory()) {
      return { pass: false, error: `cwd is not a directory: ${normalized}` };
    }
    return { pass: true, cwd: normalized };
  } catch {
    return { pass: false, error: `cwd does not exist: ${normalized}` };
  }
}
