/**
 * src/auth/store.ts
 * Atomic JSON file persistence for OAuthTokens.
 */

import { readFile, writeFile, unlink, rename } from 'node:fs/promises';
import type { OAuthTokens } from './types.js';

export class TokenStore {
  constructor(private readonly filePath: string) {}

  /**
   * Load tokens from disk.
   * Returns null if the file does not exist or cannot be parsed.
   */
  async load(): Promise<OAuthTokens | null> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'access_token' in parsed &&
        'refresh_token' in parsed &&
        'expires_at' in parsed &&
        'provider' in parsed
      ) {
        return parsed as OAuthTokens;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Atomically persist tokens to disk (write to .tmp then rename).
   */
  async save(tokens: OAuthTokens): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(tokens, null, 2), 'utf-8');
    await rename(tmp, this.filePath);
  }

  /**
   * Delete the token file. Silently succeeds if file does not exist.
   */
  async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (err: unknown) {
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code !== 'ENOENT'
      ) {
        throw err;
      }
    }
  }
}
