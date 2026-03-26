/**
 * src/adapters/telegram/normalizer.ts
 * Convert Grammy Update objects to UnifiedMessage.
 */
import type { Context } from 'grammy';
import type { Message, User } from 'grammy/types';
import { nanoid } from 'nanoid';
import type { UnifiedMessage, TelegramMetadata, Attachment } from '../../types/message.js';

/**
 * Derive a stable userId string from Telegram user.
 */
function telegramUserId(user: User): string {
  return `tg:${user.id}`;
}

/**
 * Derive conversationId from chat.
 */
function telegramConversationId(chatId: number): string {
  return `tg:chat:${chatId}`;
}

/**
 * Extract attachments from a Telegram message.
 */
function extractAttachments(msg: Message): Attachment[] {
  const attachments: Attachment[] = [];

  if (msg.photo && msg.photo.length > 0) {
    // Use the largest photo
    const photo = msg.photo[msg.photo.length - 1];
    if (photo) {
      attachments.push({
        type: 'image',
        fileId: photo.file_id,
        mimeType: 'image/jpeg',
        size: photo.file_size,
      });
    }
  }

  if (msg.document) {
    attachments.push({
      type: 'document',
      fileId: msg.document.file_id,
      fileName: msg.document.file_name,
      mimeType: msg.document.mime_type,
      size: msg.document.file_size,
    });
  }

  if (msg.audio) {
    attachments.push({
      type: 'audio',
      audioSubtype: 'audio' as const,
      fileId: msg.audio.file_id,
      fileName: msg.audio.file_name,
      mimeType: msg.audio.mime_type,
      size: msg.audio.file_size,
    });
  }

  if (msg.voice) {
    attachments.push({
      type: 'audio',
      audioSubtype: 'voice' as const,
      fileId: msg.voice.file_id,
      mimeType: 'audio/ogg',
      ...(msg.voice.file_size !== undefined ? { size: msg.voice.file_size } : {}),
    });
  }

  if (msg.video) {
    attachments.push({
      type: 'video',
      fileId: msg.video.file_id,
      mimeType: msg.video.mime_type,
      size: msg.video.file_size,
    });
  }

  if (msg.sticker) {
    attachments.push({
      type: 'sticker',
      fileId: msg.sticker.file_id,
      mimeType: msg.sticker.is_animated ? 'application/x-tgsticker' : 'image/webp',
    });
  }

  if (msg.location) {
    attachments.push({
      type: 'location',
      latitude: msg.location.latitude,
      longitude: msg.location.longitude,
    });
  }

  return attachments;
}

/**
 * Build a human-readable fallback text for attachment-only messages with no caption.
 * Prevents empty-string content from being sent to the LLM API (which rejects it with HTTP 400).
 *
 * Called only when `msg.text` and `msg.caption` are both absent or whitespace-only.
 * Each attachment type produces a distinct descriptor so the LLM has meaningful context:
 * - Photo → `[Image]`
 * - Document → `[Document: <filename> (<mime-type>)]`
 * - Audio → `[Audio: <filename>]`
 * - Video → `[Video]`
 * - Sticker (with emoji) → `[Sticker: <emoji>]`, without → `[Sticker]`
 * - Location → `[Location: <lat>, <lon>]`
 * - Unknown/unhandled → `[Attachment]`
 *
 * @param msg - The raw Grammy `Message` object from the incoming Telegram update.
 * @returns A non-empty string describing the attachment. Never returns an empty string.
 */
function buildAttachmentFallbackText(msg: Message): string {
  if (msg.photo) return '[Image]';
  if (msg.document) {
    const name = msg.document.file_name ?? 'document';
    const mime = msg.document.mime_type ?? 'file';
    return `[Document: ${name} (${mime})]`;
  }
  if (msg.audio) {
    const name = msg.audio.file_name ?? 'audio';
    return `[Audio: ${name}]`;
  }
  if (msg.video) return '[Video]';
  if (msg.sticker) {
    const emoji = msg.sticker.emoji ?? '';
    return emoji ? `[Sticker: ${emoji}]` : '[Sticker]';
  }
  if (msg.location) return `[Location: ${msg.location.latitude}, ${msg.location.longitude}]`;
  if (msg.voice) return '[Voice message]';
  return '[Attachment]';
}

/**
 * Parse command from message text.
 */
function parseCommand(text: string): { isCommand: boolean; command?: string; args?: string[] } {
  if (!text.startsWith('/')) return { isCommand: false };

  const parts = text.slice(1).split(/\s+/);
  const commandWithMention = parts[0] ?? '';
  // Handle /command@botname format
  const command = commandWithMention.split('@')[0] ?? commandWithMention;
  const args = parts.slice(1);

  return { isCommand: true, command, args };
}

/**
 * Convert a Grammy Context to a UnifiedMessage.
 * Returns null if the update cannot be processed as a user message.
 */
export function normalizeGrammyContext(ctx: Context): UnifiedMessage | null {
  const msg = ctx.message ?? ctx.editedMessage;
  if (!msg) return null;

  const from = msg.from;
  if (!from || from.is_bot) return null;

  const rawText = msg.text ?? msg.caption ?? '';
  // If there is no text/caption but there are attachments, synthesize a descriptive
  // placeholder so the LLM API never receives an empty content block (HTTP 400).
  const text = rawText.trim() !== '' ? rawText : buildAttachmentFallbackText(msg);
  const { isCommand, command, args } = parseCommand(text);

  const chatType = msg.chat.type as TelegramMetadata['chatType'];

  const metadata: TelegramMetadata = {
    platform: 'telegram',
    chatId: msg.chat.id,
    messageId: msg.message_id,
    chatType,
    ...(from.username !== undefined ? { username: from.username } : {}),
    ...(from.first_name !== undefined ? { firstName: from.first_name } : {}),
    ...(from.last_name !== undefined ? { lastName: from.last_name } : {}),
  };

  const unifiedMessage: UnifiedMessage = {
    id: nanoid(),
    userId: telegramUserId(from),
    conversationId: telegramConversationId(msg.chat.id),
    text,
    attachments: extractAttachments(msg),
    timestamp: new Date(msg.date * 1000).toISOString(),
    platform: metadata,
    isCommand,
    ...(command !== undefined ? { command } : {}),
    ...(args !== undefined && args.length > 0 ? { commandArgs: args } : {}),
  };

  return unifiedMessage;
}
