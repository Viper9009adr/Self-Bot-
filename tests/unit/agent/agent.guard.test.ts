/**
 * tests/unit/agent/agent.guard.test.ts
 * Unit tests for the safeContent guard in AgentCore.handleMessage (src/agent/index.ts).
 *
 * The guard expression is:
 *   const safeContent = message.text.trim() ||
 *     (message.attachments.length > 0
 *       ? (message.attachments.length === 1 ? '[Sent 1 attachment]' : `[Sent ${message.attachments.length} attachments]`)
 *       : '[Empty message]');
 *
 * These tests exercise the logic directly as a pure function to avoid requiring
 * full AgentCore instantiation (LLM mocking, session manager, etc.).
 */
import { describe, it, expect } from 'bun:test';
import type { Attachment } from '../../../src/types/message.js';

// ─── Pure extraction of the guard logic ───────────────────────────────────────
function computeSafeContent(text: string, attachments: Attachment[]): string {
  return text.trim() ||
    (attachments.length > 0
      ? (attachments.length === 1 ? '[Sent 1 attachment]' : `[Sent ${attachments.length} attachments]`)
      : '[Empty message]');
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('agent safeContent guard', () => {
  it('uses [Sent 1 attachment] for single attachment with empty text', () => {
    const attachments: Attachment[] = [{ type: 'document', fileId: 'doc1' }];
    const result = computeSafeContent('', attachments);
    expect(result).toBe('[Sent 1 attachment]');
  });

  it('uses [Sent 3 attachments] for multiple attachments with empty text', () => {
    const attachments: Attachment[] = [
      { type: 'image', fileId: 'img1' },
      { type: 'image', fileId: 'img2' },
      { type: 'document', fileId: 'doc1' },
    ];
    const result = computeSafeContent('', attachments);
    expect(result).toBe('[Sent 3 attachments]');
  });

  it('uses [Empty message] for empty text with no attachments', () => {
    const result = computeSafeContent('', []);
    expect(result).toBe('[Empty message]');
  });

  it('preserves non-empty text unchanged', () => {
    const attachments: Attachment[] = [{ type: 'image', fileId: 'img1' }];
    const result = computeSafeContent('Please summarize this image', attachments);
    expect(result).toBe('Please summarize this image');
  });

  it('trims whitespace-only text and falls back to attachment label', () => {
    const attachments: Attachment[] = [{ type: 'document', fileId: 'doc1' }];
    const result = computeSafeContent('   ', attachments);
    expect(result).toBe('[Sent 1 attachment]');
  });
});
