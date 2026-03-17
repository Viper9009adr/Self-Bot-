/**
 * tests/unit/adapters/telegram.normalizer.test.ts
 * Unit tests for the Telegram normalizer.
 */
import { describe, it, expect, mock } from 'bun:test';
import { normalizeGrammyContext } from '../../../src/adapters/telegram/normalizer.js';
import type { Context } from 'grammy';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeContext(overrides: Partial<{
  messageText: string;
  fromId: number;
  fromUsername: string;
  fromFirstName: string;
  chatId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  messageId: number;
  isBot: boolean;
  hasPhoto: boolean;
  hasDocument: boolean;
  hasLocation: boolean;
}>): Context {
  const opts = {
    messageText: 'Hello Bot',
    fromId: 12345,
    fromUsername: 'testuser',
    fromFirstName: 'Test',
    chatId: 12345,
    chatType: 'private' as const,
    messageId: 1,
    isBot: false,
    hasPhoto: false,
    hasDocument: false,
    hasLocation: false,
    ...overrides,
  };

  const msg: Record<string, unknown> = {
    message_id: opts.messageId,
    date: 1700000000,
    text: opts.messageText,
    from: {
      id: opts.fromId,
      username: opts.fromUsername,
      first_name: opts.fromFirstName,
      is_bot: opts.isBot,
    },
    chat: {
      id: opts.chatId,
      type: opts.chatType,
    },
  };

  if (opts.hasPhoto) {
    msg['photo'] = [
      { file_id: 'photo123', file_unique_id: 'u1', width: 100, height: 100, file_size: 1024 },
    ];
    delete msg['text'];
    msg['caption'] = opts.messageText;
  }

  if (opts.hasDocument) {
    msg['document'] = {
      file_id: 'doc123',
      file_unique_id: 'u2',
      file_name: 'test.pdf',
      mime_type: 'application/pdf',
      file_size: 2048,
    };
  }

  if (opts.hasLocation) {
    msg['location'] = { latitude: 48.8566, longitude: 2.3522 };
    delete msg['text'];
  }

  return {
    message: msg,
    editedMessage: undefined,
    from: msg['from'],
    chat: msg['chat'],
  } as unknown as Context;
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('telegram normalizer', () => {
  it('normalizes a plain text message', () => {
    const ctx = makeContext({ messageText: 'Hello World' });
    const result = normalizeGrammyContext(ctx);

    expect(result).not.toBeNull();
    expect(result!.text).toBe('Hello World');
    expect(result!.userId).toBe('tg:12345');
    expect(result!.conversationId).toBe('tg:chat:12345');
    expect(result!.platform.platform).toBe('telegram');
    expect(result!.isCommand).toBe(false);
    expect(result!.attachments).toHaveLength(0);
  });

  it('parses a command message', () => {
    const ctx = makeContext({ messageText: '/start hello world' });
    const result = normalizeGrammyContext(ctx);

    expect(result).not.toBeNull();
    expect(result!.isCommand).toBe(true);
    expect(result!.command).toBe('start');
    expect(result!.commandArgs).toEqual(['hello', 'world']);
  });

  it('parses command with bot mention', () => {
    const ctx = makeContext({ messageText: '/help@mybot' });
    const result = normalizeGrammyContext(ctx);

    expect(result!.isCommand).toBe(true);
    expect(result!.command).toBe('help');
  });

  it('returns null for bot messages', () => {
    const ctx = makeContext({ isBot: true });
    const result = normalizeGrammyContext(ctx);
    expect(result).toBeNull();
  });

  it('returns null when no message is present', () => {
    const ctx = {
      message: undefined,
      editedMessage: undefined,
    } as unknown as Context;
    const result = normalizeGrammyContext(ctx);
    expect(result).toBeNull();
  });

  it('extracts photo attachment', () => {
    const ctx = makeContext({ hasPhoto: true, messageText: 'Check this out' });
    const result = normalizeGrammyContext(ctx);

    expect(result).not.toBeNull();
    expect(result!.attachments).toHaveLength(1);
    expect(result!.attachments[0]!.type).toBe('image');
    expect(result!.text).toBe('Check this out'); // caption
  });

  it('extracts document attachment', () => {
    const ctx = makeContext({ hasDocument: true });
    const result = normalizeGrammyContext(ctx);

    expect(result).not.toBeNull();
    expect(result!.attachments).toHaveLength(1);
    expect(result!.attachments[0]!.type).toBe('document');
  });

  it('extracts location attachment', () => {
    const ctx = makeContext({ hasLocation: true });
    const result = normalizeGrammyContext(ctx);

    expect(result).not.toBeNull();
    expect(result!.attachments).toHaveLength(1);
    expect(result!.attachments[0]!.type).toBe('location');
    const loc = result!.attachments[0] as { type: string; latitude: number; longitude: number };
    expect(loc.latitude).toBeCloseTo(48.8566);
    expect(loc.longitude).toBeCloseTo(2.3522);
  });

  it('includes platform metadata', () => {
    const ctx = makeContext({
      fromId: 99999,
      fromUsername: 'jsmith',
      fromFirstName: 'John',
      chatId: -100123,
      chatType: 'supergroup',
      messageId: 42,
    });
    const result = normalizeGrammyContext(ctx);

    expect(result!.platform.platform).toBe('telegram');
    const meta = result!.platform as { platform: string; chatId: number; chatType: string; username: string; firstName: string; messageId: number };
    expect(meta.chatId).toBe(-100123);
    expect(meta.chatType).toBe('supergroup');
    expect(meta.username).toBe('jsmith');
    expect(meta.firstName).toBe('John');
    expect(meta.messageId).toBe(42);
  });

  it('handles message without username gracefully', () => {
    const ctx = makeContext({ fromUsername: '' });
    // Create a context where username is undefined
    const msg = (ctx.message as unknown as Record<string, unknown>);
    const from = msg['from'] as Record<string, unknown>;
    delete from['username'];

    const result = normalizeGrammyContext(ctx);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('tg:12345');
  });

  it('generates unique ids for each message', () => {
    const ctx = makeContext({});
    const r1 = normalizeGrammyContext(ctx);
    const r2 = normalizeGrammyContext(ctx);

    expect(r1!.id).not.toBe(r2!.id);
  });

  it('uses UTC ISO timestamp', () => {
    const ctx = makeContext({});
    const result = normalizeGrammyContext(ctx);
    // date=1700000000 → should be a valid ISO string
    expect(result!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // ─── Attachment fallback text (Fix 1) ───────────────────────────────────────

  it('returns [Image] for photo with no caption', () => {
    const ctx = makeContext({ hasPhoto: true, messageText: '' });
    const msg = ctx.message as unknown as Record<string, unknown>;
    delete msg['caption'];
    const result = normalizeGrammyContext(ctx);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('[Image]');
  });

  it('returns [Document: name (mime)] for document with no caption', () => {
    const ctx = makeContext({ hasDocument: true });
    const msg = ctx.message as unknown as Record<string, unknown>;
    delete msg['text'];
    const result = normalizeGrammyContext(ctx);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('[Document: test.pdf (application/pdf)]');
  });

  it('returns [Document: document (mime)] when document has no file_name', () => {
    const ctx = makeContext({ hasDocument: true });
    const msg = ctx.message as unknown as Record<string, unknown>;
    delete msg['text'];
    const doc = msg['document'] as Record<string, unknown>;
    delete doc['file_name'];
    const result = normalizeGrammyContext(ctx);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('[Document: document (application/pdf)]');
  });

  it('returns [Audio: filename] for audio with no caption', () => {
    const ctx = makeContext({});
    const msg = ctx.message as unknown as Record<string, unknown>;
    delete msg['text'];
    msg['audio'] = { file_id: 'aud1', file_unique_id: 'u3', duration: 10, file_name: 'voice.ogg', mime_type: 'audio/ogg', file_size: 512 };
    const result = normalizeGrammyContext(ctx);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('[Audio: voice.ogg]');
  });

  it('returns [Audio: audio] for audio with no file_name (voice message)', () => {
    const ctx = makeContext({});
    const msg = ctx.message as unknown as Record<string, unknown>;
    delete msg['text'];
    msg['audio'] = { file_id: 'aud2', file_unique_id: 'u4', duration: 5, mime_type: 'audio/ogg', file_size: 256 };
    const result = normalizeGrammyContext(ctx);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('[Audio: audio]');
  });

  it('returns [Video] for video with no caption', () => {
    const ctx = makeContext({});
    const msg = ctx.message as unknown as Record<string, unknown>;
    delete msg['text'];
    msg['video'] = { file_id: 'vid1', file_unique_id: 'u5', width: 1280, height: 720, duration: 30, mime_type: 'video/mp4', file_size: 4096 };
    const result = normalizeGrammyContext(ctx);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('[Video]');
  });

  it('returns [Sticker: emoji] for sticker with emoji', () => {
    const ctx = makeContext({});
    const msg = ctx.message as unknown as Record<string, unknown>;
    delete msg['text'];
    msg['sticker'] = { file_id: 'stk1', file_unique_id: 'u6', width: 512, height: 512, is_animated: false, is_video: false, type: 'regular', emoji: '😂' };
    const result = normalizeGrammyContext(ctx);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('[Sticker: 😂]');
  });

  it('returns [Sticker] for sticker with no emoji', () => {
    const ctx = makeContext({});
    const msg = ctx.message as unknown as Record<string, unknown>;
    delete msg['text'];
    msg['sticker'] = { file_id: 'stk2', file_unique_id: 'u7', width: 512, height: 512, is_animated: false, is_video: false, type: 'regular' };
    const result = normalizeGrammyContext(ctx);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('[Sticker]');
  });

  it('returns [Location: lat, lon] for location message', () => {
    const ctx = makeContext({ hasLocation: true });
    const result = normalizeGrammyContext(ctx);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('[Location: 48.8566, 2.3522]');
  });

  it('returns [Attachment] for unknown attachment type with no text', () => {
    const ctx = makeContext({});
    const msg = ctx.message as unknown as Record<string, unknown>;
    delete msg['text'];
    // No known attachment field set — triggers the final fallback
    const result = normalizeGrammyContext(ctx);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('[Attachment]');
  });

  it('preserves non-empty caption text without modification', () => {
    const ctx = makeContext({ hasPhoto: true, messageText: 'Look at this!' });
    const result = normalizeGrammyContext(ctx);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('Look at this!');
  });
});
