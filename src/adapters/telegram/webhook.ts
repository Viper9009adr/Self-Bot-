/**
 * src/adapters/telegram/webhook.ts
 * Grammy bot setup: webhook mode with secret token validation, or long-polling.
 */
import { Bot, webhookCallback } from 'grammy';
import type { Config, SecretString } from '../../config/index.js';
import { childLogger } from '../../utils/logger.js';
import { AdapterError } from '../../utils/errors.js';

const log = childLogger({ module: 'telegram:webhook' });

export interface TelegramBotSetup {
  bot: Bot;
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
}

/**
 * Create and configure the Grammy bot for webhook or polling mode.
 */
export function createTelegramBot(config: Config): TelegramBotSetup {
  const tokenStr = config.telegram.botToken as unknown as string;
  const bot = new Bot(tokenStr);

  let isListening = false;

  if (config.telegram.mode === 'webhook') {
    // ── Webhook mode ───────────────────────────────────────────────────────
    const webhookSecretStr = config.telegram.webhookSecret
      ? (config.telegram.webhookSecret as unknown as string)
      : undefined;

    if (!webhookSecretStr) {
      throw new AdapterError(
        'TELEGRAM_WEBHOOK_SECRET is required in webhook mode',
        'telegram',
        { code: 'CONFIG_ERROR', isRetryable: false },
      );
    }

    const webhookUrl = config.telegram.webhookUrl;
    if (!webhookUrl) {
      throw new AdapterError(
        'TELEGRAM_WEBHOOK_URL is required in webhook mode',
        'telegram',
        { code: 'CONFIG_ERROR', isRetryable: false },
      );
    }

    const port = config.telegram.webhookPort;

    // Grammy's built-in webhook handler with secret token validation.
    // Requests without the correct X-Telegram-Bot-Api-Secret-Token header
    // are automatically rejected (HTTP 401) by Grammy's webhookCallback.
    const handleUpdate = webhookCallback(bot, 'std/http', {
      secretToken: webhookSecretStr,
    });

    const startListening = async (): Promise<void> => {
      if (isListening) return;

      // Register webhook with Telegram
      await bot.api.setWebhook(webhookUrl, {
        secret_token: webhookSecretStr,
      });

      log.info({ webhookUrl, port }, 'Webhook registered');

      // Start HTTP server to handle incoming webhook requests
      const server = Bun.serve({
        port,
        async fetch(req: Request) {
          const url = new URL(req.url);
          if (url.pathname === '/telegram/webhook' && req.method === 'POST') {
            return handleUpdate(req);
          }
          if (url.pathname === '/health') {
            return new Response('{"status":"ok"}', {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response('Not Found', { status: 404 });
        },
      });

      log.info({ port }, 'Webhook HTTP server started');
      isListening = true;

      // Keep reference for shutdown
      (bot as unknown as Record<string, unknown>)['_webhookServer'] = server;
    };

    const stopListening = async (): Promise<void> => {
      if (!isListening) return;
      await bot.api.deleteWebhook();
      const server = (bot as unknown as Record<string, unknown>)['_webhookServer'];
      if (server && typeof (server as { stop(): void }).stop === 'function') {
        (server as { stop(): void }).stop();
      }
      isListening = false;
      log.info('Webhook stopped');
    };

    return { bot, startListening, stopListening };
  } else {
    // ── Long-polling mode ──────────────────────────────────────────────────
    const startListening = async (): Promise<void> => {
      if (isListening) return;
      bot.start({
        // Avoid replaying stale queued messages from downtime/restarts.
        drop_pending_updates: true,
        onStart: (botInfo) => {
          log.info({ username: botInfo.username }, 'Bot started polling');
          isListening = true;
        },
      }).catch((err: unknown) => {
        log.error({ err }, 'Polling error');
      });
    };

    const stopListening = async (): Promise<void> => {
      if (!isListening) return;
      await bot.stop();
      isListening = false;
      log.info('Bot polling stopped');
    };

    return { bot, startListening, stopListening };
  }
}

// Export SecretString for re-use
export type { SecretString };
