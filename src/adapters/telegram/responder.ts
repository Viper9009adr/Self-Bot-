/**
 * src/adapters/telegram/responder.ts
 * Convert UnifiedResponse to Grammy API calls.
 */
import type { Bot } from 'grammy';
import type { UnifiedResponse, TelegramMetadata } from '../../types/message.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ module: 'telegram:responder' });

const MAX_MESSAGE_LENGTH = 4096;

/**
 * Split a long message into chunks of at most `maxLen` characters.
 * Tries to split on newlines first, then on spaces.
 */
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

/**
 * Map our ResponseFormat to Telegram parse_mode.
 */
function toParseMode(
  format: UnifiedResponse['format'],
): 'Markdown' | 'HTML' | undefined {
  if (format === 'markdown') return 'Markdown';
  if (format === 'html') return 'HTML';
  return undefined;
}

/**
 * Send a UnifiedResponse through the Grammy bot.
 * Uses the Grammy Bot type generically to avoid deep type constraints.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sendTelegramResponse(
  bot: Bot,
  response: UnifiedResponse,
): Promise<void> {
  if (response.platform.platform !== 'telegram') {
    log.warn({ platform: response.platform.platform }, 'Non-Telegram response sent to Telegram responder');
    return;
  }

  const meta = response.platform as TelegramMetadata;
  const chatId = meta.chatId;
  const parseMode = toParseMode(response.format);

  const chunks = splitMessage(response.text);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    try {
      await bot.api.sendMessage(chatId, chunk, {
        // Only reply to original message for first chunk
        ...(i === 0 && meta.messageId
          ? { reply_parameters: { message_id: meta.messageId } }
          : {}),
        ...(parseMode !== undefined ? { parse_mode: parseMode } : {}),
      });
    } catch (err) {
      // Fallback: retry without parse_mode if Markdown/HTML parsing fails
      if (parseMode && err instanceof Error && err.message.includes('parse')) {
        log.warn({ chatId, err: err.message }, 'Retrying without parse_mode');
        await bot.api.sendMessage(chatId, chunk);
      } else {
        log.error({ chatId, err }, 'Failed to send Telegram message');
        throw err;
      }
    }
  }

  // Send attachments if present
  if (response.attachments && response.attachments.length > 0) {
    for (const attachment of response.attachments) {
      try {
        if (attachment.type === 'image' && 'fileId' in attachment) {
          await bot.api.sendPhoto(chatId, attachment.fileId);
        } else if (attachment.type === 'document' && 'fileId' in attachment) {
          await bot.api.sendDocument(chatId, attachment.fileId);
        }
      } catch (err) {
        log.error({ chatId, attachmentType: attachment.type, err }, 'Failed to send attachment');
      }
    }
  }
}
