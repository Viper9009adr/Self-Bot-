/**
 * src/auth/__tests__/pkce.test.ts
 * Tests for generatePKCE() — PKCE S256 verifier + challenge generator.
 * Run with: bun test
 */

import { describe, it, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { generatePKCE } from '../pkce';

const URL_SAFE_BASE64_RE = /^[A-Za-z0-9_-]+$/;

describe('generatePKCE()', () => {
  it('returns an object with non-empty verifier and challenge strings', async () => {
    const pair = await generatePKCE();

    expect(typeof pair.verifier).toBe('string');
    expect(pair.verifier.length).toBeGreaterThan(0);

    expect(typeof pair.challenge).toBe('string');
    expect(pair.challenge.length).toBeGreaterThan(0);
  });

  it('verifier is URL-safe base64 (no +, /, or = characters)', async () => {
    const { verifier } = await generatePKCE();
    expect(URL_SAFE_BASE64_RE.test(verifier)).toBe(true);
  });

  it('challenge is URL-safe base64 (no +, /, or = characters)', async () => {
    const { challenge } = await generatePKCE();
    expect(URL_SAFE_BASE64_RE.test(challenge)).toBe(true);
  });

  it('produces different verifiers on successive calls (randomness)', async () => {
    const pair1 = await generatePKCE();
    const pair2 = await generatePKCE();
    expect(pair1.verifier).not.toBe(pair2.verifier);
  });

  it('challenge is SHA-256(verifier) encoded as base64url', async () => {
    const { verifier, challenge } = await generatePKCE();

    const expectedChallenge = createHash('sha256')
      .update(verifier)
      .digest()
      .toString('base64url');

    expect(challenge).toBe(expectedChallenge);
  });

  it('verifier is 43 characters (32 bytes → base64url without padding)', async () => {
    // 32 bytes * 4/3 = ~42.67, rounded up to 43 with base64url (no padding)
    const { verifier } = await generatePKCE();
    expect(verifier.length).toBe(43);
  });
});
