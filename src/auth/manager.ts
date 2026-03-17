/**
 * src/auth/manager.ts
 * OAuthManager: single entry-point for OAuth token lifecycle.
 */

import { TokenStore } from './store.js';
import { anthropicLogin, anthropicRefresh } from './providers/anthropic.js';
import type { OAuthTokens, OAuthLoginCallbacks } from './types.js';

/** 5-minute buffer: refresh before the token actually expires */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export class OAuthManager {
  private store: TokenStore;
  private cached: OAuthTokens | null = null;

  constructor(tokenFilePath: string) {
    this.store = new TokenStore(tokenFilePath);
  }

  /**
   * Guarantee a valid access token is available.
   * Decision tree:
   *  1. Load from cache (in-memory) or disk.
   *  2. Fresh token → done.
   *  3. Expiring token → attempt silent refresh.
   *  4. No token or refresh failed → interactive login.
   *
   * `callbacks` are only invoked when interactive login is required.
   */
  async ensureAuthenticated(callbacks: OAuthLoginCallbacks): Promise<void> {
    if (!this.cached) {
      this.cached = await this.store.load();
    }

    if (this.cached && this.isTokenFresh(this.cached)) {
      return;
    }

    if (this.cached && !this.isTokenFresh(this.cached)) {
      try {
        const refreshed = await anthropicRefresh(this.cached);
        this.cached = refreshed;
        await this.store.save(refreshed);
        return;
      } catch {
        this.cached = null;
        await this.store.clear();
      }
    }

    const tokens = await anthropicLogin(callbacks);
    this.cached = tokens;
    await this.store.save(tokens);
  }

  /**
   * Get a valid access token, refreshing if needed.
   * This async version is safe to call per-request to handle mid-session expiry.
   */
  async getValidAccessToken(callbacks: OAuthLoginCallbacks): Promise<string> {
    await this.ensureAuthenticated(callbacks);
    return this.getAccessToken();
  }

  /**
   * Returns the current access token synchronously.
   * Callers MUST call `ensureAuthenticated` first.
   * Throws if no token is present (programming error).
   */
  getAccessToken(): string {
    if (!this.cached) {
      throw new Error(
        'OAuthManager: no access token available. ' +
          'Call ensureAuthenticated() before getAccessToken().',
      );
    }
    return this.cached.access_token;
  }

  /**
   * Force logout: clear in-memory cache and delete token file.
   */
  async logout(): Promise<void> {
    this.cached = null;
    await this.store.clear();
  }

  private isTokenFresh(tokens: OAuthTokens): boolean {
    return Date.now() < tokens.expires_at - EXPIRY_BUFFER_MS;
  }
}
