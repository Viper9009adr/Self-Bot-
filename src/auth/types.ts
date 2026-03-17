/**
 * src/auth/types.ts
 * Core types for the PKCE OAuth 2.0 module.
 */

export interface OAuthTokens {
  /** Bearer token used as Anthropic API key */
  access_token: string;
  /** Used to obtain new access tokens without re-login */
  refresh_token: string;
  /** Unix epoch milliseconds. Compare with Date.now() */
  expires_at: number;
  /** Provider discriminator */
  provider: 'claude-oauth';
}

/**
 * Caller-supplied callbacks that drive the interactive login flow.
 * onUrl  — receives the authorization URL (bot sends it to the user).
 * onCode — optional fallback for when the browser is on a different machine;
 *          prompts the user to paste the full redirect URL or bare code.
 *          If omitted, the flow waits for the local callback server only.
 */
export interface OAuthLoginCallbacks {
  /** Called with the authorization URL — bot should send this to the user */
  onUrl(url: string): Promise<void>;
  /**
   * Called only if the local callback server did not receive the code automatically.
   * Should prompt the user to paste the full redirect URL or bare code.
   * Optional — if not provided, the flow waits for the callback server only.
   */
  onCode?(): Promise<string>;
}

export interface PKCEPair {
  verifier: string;
  challenge: string;
}
