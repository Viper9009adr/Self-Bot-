/**
 * src/adapters/whatsapp/responder.ts
 * Convert UnifiedResponse to whatsapp-web.js client.sendMessage calls.
 */
import type { Client } from 'whatsapp-web.js';
import type { UnifiedResponse, WhatsAppMetadata } from '../../types/message.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ module: 'whatsapp:responder' });

const MAX_MESSAGE_LENGTH = 4096;

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
