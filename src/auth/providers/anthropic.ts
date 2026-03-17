/**
 * src/auth/providers/anthropic.ts
 * Anthropic PKCE OAuth 2.0 provider.
 * Implements the authorization-code flow with S256 PKCE and token refresh.
 * Uses a local HTTP callback server (Option A) matching the Claude Code CLI reference.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { generatePKCE } from '../pkce.js';
import type { OAuthTokens, OAuthLoginCallbacks } from '../types.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e' as const;

// Claude.ai OAuth authorize URL — this endpoint grants the user:inference scope
// needed for API calls. The Console URL (platform.claude.com/oauth/authorize)
// only grants org:create_api_key + user:profile and does NOT support inference.
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize' as const;
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token' as const;

const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = '/callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}` as const;

// Claude.ai scopes — user:inference is required for making model API calls.
// These match the scopes used by Claude Code CLI for Claude.ai subscribers.
const SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload' as const;
const OAUTH_BETA_HEADER = 'oauth-2025-04-20' as const;

// ── Internal token-response shape ──────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: string;
}

interface ParsedAuthorizationInput {
  code: string;
  state?: string;
}

function parsedAuthorizationInput(code: string, state?: string): ParsedAuthorizationInput {
  return state ? { code, state } : { code };
}

// ── Local callback server ──────────────────────────────────────────────────────

interface CallbackResult {
  code: string;
  state: string;
}

interface CallbackServer {
  server: Server;
  waitForCode(): Promise<CallbackResult | null>;
  cancelWait(): void;
}

function startCallbackServer(expectedState: string): CallbackServer {
  let result: CallbackResult | null = null;
  let cancelled = false;

  const server = createServer((req, res) => {
    const reqUrl = req.url ?? '';
    const urlObj = new URL(reqUrl, `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);

    if (urlObj.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const code = urlObj.searchParams.get('code');
    const state = urlObj.searchParams.get('state') ?? '';

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<html><body><p>Error: missing code parameter.</p></body></html>');
      return;
    }

    if (state !== expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<html><body><p>Error: state mismatch. Please restart login and try again.</p></body></html>');
      return;
    }

    result = { code, state };

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<html><body><p>Authentication successful. Return to your terminal to continue.</p></body></html>',
    );
  });

  server.listen(CALLBACK_PORT, CALLBACK_HOST);

  function waitForCode(): Promise<CallbackResult | null> {
    return new Promise((resolve) => {
      (function poll() {
        if (result !== null) {
          resolve(result);
          return;
        }
        if (cancelled) {
          resolve(null);
          return;
        }
        setTimeout(poll, 100);
      })();
    });
  }

  function cancelWait(): void {
    cancelled = true;
  }

  return { server, waitForCode, cancelWait };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function postTokenEndpoint(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-beta': OAUTH_BETA_HEADER,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '(unreadable body)');
    throw new Error(`OAuth token endpoint returned ${response.status}: ${text}`);
  }

  const json: unknown = await response.json();
  if (
    json === null ||
    typeof json !== 'object' ||
    !('access_token' in json) ||
    !('refresh_token' in json) ||
    !('expires_in' in json)
  ) {
    throw new Error(`Unexpected token response shape: ${JSON.stringify(json)}`);
  }
  return json as TokenResponse;
}

function parseAuthorizationInput(input: string): ParsedAuthorizationInput {
  const raw = input.trim();
  if (!raw) {
    throw new Error('Authorization code was empty.');
  }

  // Support full callback URL paste, e.g.:
  // http://localhost:53692/callback?code=...&state=...
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error('Authorization input looked like a URL, but was not valid.');
    }

    const queryCode = url.searchParams.get('code');
    const queryState = url.searchParams.get('state') ?? undefined;
    if (queryCode) {
      return parsedAuthorizationInput(queryCode, queryState);
    }

    // Some providers may return params in the fragment.
    const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    if (fragment) {
      const fragmentParams = new URLSearchParams(fragment);
      const hashCode = fragmentParams.get('code');
      const hashState = fragmentParams.get('state') ?? undefined;
      if (hashCode) {
        return parsedAuthorizationInput(hashCode, hashState);
      }
    }

    throw new Error('Callback URL did not contain a code parameter.');
  }

  // Support convenience format shown in bootstrap prompt: code#state
  const hashIndex = raw.indexOf('#');
  if (hashIndex > 0) {
    const code = raw.slice(0, hashIndex).trim();
    const state = raw.slice(hashIndex + 1).trim() || undefined;
    if (code) {
      return parsedAuthorizationInput(code, state);
    }
  }

  // Support query-style paste without full URL: code=...&state=...
  if (raw.includes('code=')) {
    const params = new URLSearchParams(raw);
    const code = params.get('code');
    const state = params.get('state') ?? undefined;
    if (code) {
      return parsedAuthorizationInput(code, state);
    }
  }

  // Default: raw authorization code
  return { code: raw };
}

function toOAuthTokens(resp: TokenResponse): OAuthTokens {
  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    expires_at: Date.now() + resp.expires_in * 1000,
    provider: 'claude-oauth',
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Run the full interactive PKCE authorization-code flow.
 * Starts a local HTTP callback server on localhost:53692 to receive the OAuth
 * redirect automatically. Falls back to manual code paste via callbacks.onCode
 * if the browser is on a different machine.
 */
export async function anthropicLogin(callbacks: OAuthLoginCallbacks): Promise<OAuthTokens> {
  const { verifier, challenge } = await generatePKCE();

  // Random state parameter to prevent CSRF
  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const state = Buffer.from(stateBytes).toString('hex');

  const callbackServer = startCallbackServer(state);

  try {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    const authorizeUrl = `${AUTHORIZE_URL}?${params.toString()}`;

    // Send the URL to the user (bot posts it to the chat)
    await callbacks.onUrl(authorizeUrl);

    // Race: local callback server vs manual code paste fallback
    let parsed: ParsedAuthorizationInput;

    if (callbacks.onCode) {
      // Both paths available — race them
      let serverCancelled = false;
      let manualCancelled = false;

      const serverPromise: Promise<ParsedAuthorizationInput | null> = callbackServer
        .waitForCode()
        .then((r) => {
          if (r === null || serverCancelled) return null;
          return parsedAuthorizationInput(r.code, r.state);
        });

      const manualPromise: Promise<ParsedAuthorizationInput | null> = callbacks
        .onCode()
        .then((input) => {
          if (manualCancelled) return null;
          return parseAuthorizationInput(input);
        });

      const winner = await Promise.race([serverPromise, manualPromise]);

      if (winner !== null) {
        // Cancel the loser
        callbackServer.cancelWait();
        serverCancelled = true;
        manualCancelled = true;
        parsed = winner;
      } else {
        // Both returned null — should not happen in normal flow
        throw new Error('OAuth login was cancelled.');
      }
    } else {
      // No manual fallback — wait for callback server only
      const r = await callbackServer.waitForCode();
      if (r === null) {
        throw new Error('OAuth login was cancelled.');
      }
      parsed = parsedAuthorizationInput(r.code, r.state);
    }

    if (parsed.state && parsed.state !== state) {
      throw new Error('OAuth state mismatch. Please restart login and try again.');
    }

    const tokenResp = await postTokenEndpoint({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: parsed.code,
      state,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });

    return toOAuthTokens(tokenResp);
  } finally {
    callbackServer.server.close();
  }
}

/**
 * Use the stored refresh_token to silently obtain a new access_token.
 */
export async function anthropicRefresh(currentTokens: OAuthTokens): Promise<OAuthTokens> {
  const tokenResp = await postTokenEndpoint({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: currentTokens.refresh_token,
    scope: SCOPES,
  });
  return toOAuthTokens(tokenResp);
}
