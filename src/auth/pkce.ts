/**
 * src/auth/pkce.ts
 * PKCE S256 code verifier + challenge generator.
 * Uses Web Crypto API (native in Bun). Zero npm dependencies.
 */

import type { PKCEPair } from './types.js';

/**
 * Generate a cryptographically random PKCE code verifier (32 bytes → 43-char base64url).
 */
function generateVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // Use Buffer for reliable base64url encoding in Bun/Node
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Compute S256 challenge: BASE64URL(SHA256(ASCII(verifier)))
 */
async function computeChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Buffer.from(new Uint8Array(digest)).toString('base64url');
}

/**
 * Generate a fresh PKCE verifier+challenge pair.
 */
export async function generatePKCE(): Promise<PKCEPair> {
  const verifier = generateVerifier();
  const challenge = await computeChallenge(verifier);
  return { verifier, challenge };
}
