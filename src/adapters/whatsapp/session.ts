/**
 * src/adapters/whatsapp/session.ts
 * WhatsApp client factory: creates Client with LocalAuth, handles QR/ready/auth_failure.
 */
import { Client, LocalAuth } from 'whatsapp-web.js';
import { childLogger } from '../../utils/logger.js';
import { AdapterError } from '../../utils/errors.js';

const log = childLogger({ module: 'whatsapp:session' });

/**
 * Create and initialize a whatsapp-web.js Client.
 * Resolves with the ready Client, rejects on auth_failure.
 * onQR callback is called with the QR string for display (transport-agnostic).
 */
export function createWAClient(
  sessionPath: string,
  onQR: (qr: string) => void,
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: sessionPath }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });

    client.on('qr', (qr) => {
      log.info('WhatsApp QR code ready — scan with your phone');
      onQR(qr);
    });

    client.on('loading_screen', (percent: number, message: string) => {
      log.debug({ percent, message }, 'WA loading');
    });

    client.on('ready', () => {
      log.info('WhatsApp client ready');
      resolve(client);
    });

    client.on('auth_failure', (msg: string) => {
      log.error({ msg }, 'WhatsApp auth failure');
      reject(new AdapterError(`WhatsApp auth failure: ${msg}`, 'whatsapp', {
        code: 'AUTH_FAILURE',
        isRetryable: false,
      }));
    });

    client.initialize().catch((err: unknown) => {
      reject(new AdapterError(
        `WhatsApp client initialization failed: ${String(err)}`,
        'whatsapp',
        { code: 'INIT_ERROR', isRetryable: false },
      ));
    });
  });
}
