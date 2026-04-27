/**
 * src/adapters/whatsapp/normalizer.ts
 * Convert whatsapp-web.js Message objects to UnifiedMessage.
 */
import type { Message } from 'whatsapp-web.js';
import { nanoid } from 'nanoid';
import type { FileAttachment, UnifiedMessage, WhatsAppMetadata } from '../../types/message.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ module: 'whatsapp:normalizer' });

/** Extract clean phone number from WA JID (e.g. '14155551234@c.us' → '14155551234') */
function extractPhone(jid: string): string {
  const raw = jid.split('@')[0] ?? jid;
  // WhatsApp now uses @lid for privacy. Real number lookup happens elsewhere.
  // For now, return raw number without + prefix
  return raw.startsWith('+') ? raw.slice(1) : raw;
}

/** Build stable userId from a JID */
export function waUserId(jid: string): string {
  return `wa:+${extractPhone(jid)}`;
}

/** Build conversationId from chat JID */
export function waChatId(chatJid: string): string {
  return `wa:chat:${chatJid}`;
}

/** Parse slash command from text */
function parseCommand(text: string): { isCommand: boolean; command?: string; args?: string[] } {
  if (!text.startsWith('/')) return { isCommand: false };
  const parts = text.slice(1).split(/\s+/);
  const command = (parts[0] ?? '').split('@')[0] ?? '';
  return { isCommand: true, command, args: parts.slice(1) };
}

/**
 * Convert a whatsapp-web.js Message to UnifiedMessage.
 * Returns null if the message should not be processed.
 *
 * Behavior implemented by IMP in this phase:
 * - skips self/status messages,
 * - preserves plain-text command parsing,
 * - conditionally maps WhatsApp document metadata into a unified attachment
 *   (`fileId`, optional `mimeType`, optional `fileName`, optional `size`).
 *
 * The document metadata mapping is intentionally defensive and does not block
 * text normalization when media metadata is malformed.
 */
export function normalizeWAMessage(msg: Message): UnifiedMessage | null {
  // Guard: skip own messages and status updates
  if (msg.fromMe) return null;
  // isStatus may not be typed — check safely
  if ((msg as { isStatus?: boolean }).isStatus) return null;

  const isGroup = msg.from.endsWith('@g.us');
  // For group messages, msg.author is the sender; for DMs, msg.from is the sender
  const senderJid = (isGroup && msg.author) ? msg.author : msg.from;
  const phoneNumber = extractPhone(senderJid);
  const userId = waUserId(senderJid);
  const conversationId = waChatId(msg.from);

  const text = msg.body ?? '';
  const { isCommand, command, args } = parseCommand(text);
  const attachments: FileAttachment[] = [];

  // WA document mapping (Phase 4): map metadata into unified attachment.
  // Keep this resilient to whatsapp-web.js private field shape changes.
  try {
    const maybeDocument = (msg.type === 'document')
      || ((msg as unknown as { _data?: { mimetype?: string } })._data?.mimetype?.startsWith('application/') ?? false);

    if (maybeDocument) {
      const raw = msg as unknown as {
        id?: { _serialized?: string };
        _data?: { mimetype?: string; filename?: string; size?: number };
      };

      attachments.push({
        type: 'document',
        fileId: raw.id?._serialized ?? '',
        ...(raw._data?.mimetype ? { mimeType: raw._data.mimetype } : {}),
        ...(raw._data?.filename ? { fileName: raw._data.filename } : {}),
        ...(typeof raw._data?.size === 'number' ? { size: raw._data.size } : {}),
      });
    }
  } catch (err: unknown) {
    log.warn({ err, messageType: msg.type }, 'Malformed WhatsApp document metadata; continuing without document attachment');
  }

  const metadata: WhatsAppMetadata = {
    platform: 'whatsapp',
    phoneNumber,
    chatId: msg.from,
    isGroup,
    // Contact name not available without async fetch — omit for now
  };

  const unifiedMessage: UnifiedMessage = {
    id: nanoid(),
    userId,
    conversationId,
    text,
    attachments,
    timestamp: new Date().toISOString(),
    platform: metadata,
    isCommand,
    ...(command !== undefined ? { command } : {}),
    ...(args !== undefined && args.length > 0 ? { commandArgs: args } : {}),
  };

  return unifiedMessage;
}
