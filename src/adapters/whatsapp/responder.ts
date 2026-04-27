/**
 * src/adapters/whatsapp/responder.ts
 * Convert UnifiedResponse to whatsapp-web.js client.sendMessage calls.
 */
import { createRequire } from 'module';
import type { Client } from 'whatsapp-web.js';
import type { UnifiedResponse, WhatsAppMetadata } from '../../types/message.js';

const _require = createRequire(import.meta.url);
// MessageMedia is not accessible as a named TS export from this package version;
// load it at runtime via require and cast to a compatible structural type.
type WASendableMedia = { mimetype: string; data: string; filename?: string | null };
type MessageMediaConstructor = new (mimetype: string, data: string, filename?: string | null) => WASendableMedia;
const { MessageMedia } = _require('whatsapp-web.js') as { MessageMedia: MessageMediaConstructor };
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ module: 'whatsapp:responder' });

const MAX_MESSAGE_LENGTH = 4096;
const WA_AUDIO_FALLBACK_TEXT = '🎤 Voice reply is ready, but WhatsApp audio delivery is not yet supported in this build.';

function splitMessage(text: string, maxLen = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export async function sendWAResponse(client: Client, response: UnifiedResponse): Promise<void> {
  if (response.platform.platform !== 'whatsapp') {
    log.warn({ platform: response.platform.platform }, 'Non-WhatsApp response sent to WA responder');
    return;
  }

  const meta = response.platform as WhatsAppMetadata;
  const chatId = meta.chatId;

  const audioAttachments = response.attachments?.filter((att) => att.type === 'audio') ?? [];
  if (audioAttachments.length > 0) {
    log.warn(
      { chatId, attachmentCount: audioAttachments.length },
      'WhatsApp audio delivery is not yet implemented; audio attachment dropped',
    );

    try {
      await client.sendMessage(chatId, WA_AUDIO_FALLBACK_TEXT);
    } catch (err) {
      log.error({ chatId, err }, 'Failed to send WhatsApp audio fallback message');
      throw err;
    }
  }

  // Send images before text so media appears above the caption in the chat thread.
  const imageAttachments = response.attachments?.filter(
    (att) => att.type === 'image' && 'data' in att && att.data
  ) ?? [];
  for (const attachment of imageAttachments) {
    try {
      const media = new MessageMedia(
        attachment.mimeType ?? 'image/jpeg',
        (attachment as { data: string }).data,
        'image.jpg'
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await client.sendMessage(chatId, media as any);
    } catch (err) {
      log.error({ chatId, err }, 'Failed to send WhatsApp image');
    }
  }

  const chunks = splitMessage(response.text);

  for (const chunk of chunks) {
    if (!chunk) continue;
    try {
      await client.sendMessage(chatId, chunk);
    } catch (err) {
      log.error({ chatId, err }, 'Failed to send WhatsApp message');
      throw err;
    }
  }
}
