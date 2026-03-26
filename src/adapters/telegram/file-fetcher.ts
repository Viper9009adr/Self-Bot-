/**
 * src/adapters/telegram/file-fetcher.ts
 * Fetch a file from Telegram servers using the Grammy Api instance.
 */
import type { Api } from 'grammy';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ module: 'telegram:file-fetcher' });

const EXTENSION_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif',
  ogg: 'audio/ogg', mp3: 'audio/mpeg', mp4: 'audio/mp4',
  wav: 'audio/wav', m4a: 'audio/x-m4a',
};

export async function fetchTelegramFile(
  api: Api,
  token: string,
  fileId: string,
): Promise<{ data: Buffer; mimeType?: string }> {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error(`No file_path for fileId: ${fileId}`);

  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  log.debug({ fileId, url }, 'Fetching Telegram file');

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);

  const ext = file.file_path.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = EXTENSION_MIME[ext];

  const ab = await response.arrayBuffer();
  const result: { data: Buffer; mimeType?: string } = { data: Buffer.from(ab) };
  if (mimeType !== undefined) result.mimeType = mimeType;
  return result;
}
