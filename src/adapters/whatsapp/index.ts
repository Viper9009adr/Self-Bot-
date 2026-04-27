/**
 * src/adapters/whatsapp/index.ts
 * WhatsAppAdapter: implements IAdapter for WhatsApp via whatsapp-web.js.
 */
import type { Client, Message } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import type { IAdapter, MessageHandler, MessageHandlerDisposer } from '../base.js';
import type { UnifiedResponse } from '../../types/message.js';
import type { Config } from '../../config/index.js';
import { createWAClient } from './session.js';
import { normalizeWAMessage } from './normalizer.js';
import { sendWAResponse } from './responder.js';
import { childLogger } from '../../utils/logger.js';
import { AdapterError } from '../../utils/errors.js';

const log = childLogger({ module: 'whatsapp:adapter' });

export class WhatsAppAdapter implements IAdapter {
  public readonly name = 'whatsapp';

  private client!: Client;
  private readonly handlers = new Set<MessageHandler>();
  private readonly userConcurrency = new Map<string, number>();
  private readonly maxPerUserConcurrency: number;
  private running = false;

  constructor(private readonly config: Config) {
    this.maxPerUserConcurrency = config.queue.perUserConcurrency;
  }

  private getLidResolver(): { getContactLidAndPhone(jids: string[]): Promise<Array<{ pn?: string }>> } | null {
    const client = this.client as Client & {
      getContactLidAndPhone?: (jids: string[]) => Promise<Array<{ pn?: string }>>;
    };
    return typeof client.getContactLidAndPhone === 'function'
      ? { getContactLidAndPhone: client.getContactLidAndPhone.bind(client) }
      : null;
  }

  async initialize(): Promise<void> {
    // CRITICAL: Guard against unconfigured adapter
    if (!this.config.whatsapp) {
      throw new AdapterError(
        'WhatsApp not configured — set WA_ENABLED=true and WA_OWNER_NUMBER in .env',
        'whatsapp',
        { code: 'CONFIG_ERROR', isRetryable: false },
      );
    }

    const sessionPath = this.config.whatsapp.sessionPath;

    // Display QR in terminal using qrcode-terminal (MINOR-1: called here, not in session.ts)
    const onQR = (qr: string): void => {
      console.log('\n╔══════════════════════════════════════════════════════╗');
      console.log('║        📱 WhatsApp QR Code — Scan with your phone    ║');
      console.log('╚══════════════════════════════════════════════════════╝\n');
      qrcode.generate(qr, { small: true });
    };

    // createWAClient resolves on 'ready', rejects on 'auth_failure'
    this.client = await createWAClient(sessionPath, onQR);

    // Wire per-user rate limiting + message dispatch
    this.client.on('message', async (msg: Message) => {
      // WhatsApp now uses @lid for privacy - try to resolve real number
      let resolvedFrom = msg.from;
      if (msg.from.endsWith('@lid')) {
        try {
          const lidResolver = this.getLidResolver();
          const result = lidResolver ? await lidResolver.getContactLidAndPhone([msg.from]) : null;
          if (result && result[0]?.pn) {
            resolvedFrom = result[0].pn; // Returns phone number with @c.us suffix
          }
        } catch (err) {
          log.warn({ err }, 'Failed to resolve WhatsApp LID');
        }
      }

      // Create modified message with resolved sender if available
      const message = normalizeWAMessage({ ...msg, from: resolvedFrom });
      if (!message) return;

      const userId = message.userId;
      const current = this.userConcurrency.get(userId) ?? 0;
      if (current >= this.maxPerUserConcurrency) {
        log.warn({ userId, current }, 'WA per-user concurrency limit reached');
        await this.client.sendMessage(
          (message.platform as { chatId: string }).chatId,
          'I\'m currently processing your previous request. Please wait.',
        ).catch(() => undefined);
        return;
      }

      this.userConcurrency.set(userId, current + 1);
      try {
        await Promise.allSettled(
          Array.from(this.handlers).map((handler) =>
            handler(message).catch((err: unknown) => {
              log.error({ err, userId }, 'WA message handler error');
            }),
          ),
        );
      } finally {
        const after = this.userConcurrency.get(userId) ?? 1;
        if (after <= 1) {
          this.userConcurrency.delete(userId);
        } else {
          this.userConcurrency.set(userId, after - 1);
        }
      }
    });

    // Wire disconnected event (has this.running reference — must live here)
    this.client.on('disconnected', (reason: string) => {
      this.running = false;
      log.warn({ reason }, 'WhatsApp disconnected');
    });

    this.running = true;
    log.info({ sessionPath }, 'WhatsAppAdapter initialized');
  }

  async sendResponse(response: UnifiedResponse): Promise<void> {
    if (!this.client) {
      throw new AdapterError('WhatsAppAdapter not initialized', 'whatsapp', {
        code: 'NOT_INITIALIZED',
        isRetryable: false,
      });
    }
    await sendWAResponse(this.client, response);
  }

  onMessage(handler: MessageHandler): MessageHandlerDisposer {
    this.handlers.add(handler);
    log.debug({ handlerCount: this.handlers.size }, 'WA message handler registered');
    return () => {
      this.handlers.delete(handler);
      log.debug({ handlerCount: this.handlers.size }, 'WA message handler disposed');
    };
  }

  async shutdown(): Promise<void> {
    if (!this.running) return;
    try {
      await this.client.destroy();
    } catch (err) {
      log.error({ err }, 'WhatsApp client destroy error');
    }
    this.handlers.clear();
    this.userConcurrency.clear();
    this.running = false;
    log.info('WhatsAppAdapter shut down');
  }

  isRunning(): boolean {
    return this.running;
  }
}
