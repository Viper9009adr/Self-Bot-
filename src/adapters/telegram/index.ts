/**
 * src/adapters/telegram/index.ts
 * TelegramAdapter: implements IAdapter for Telegram via Grammy.
 * Includes Grammy middleware with per-user rate limiting.
 */
import type { Bot, Context } from 'grammy';
import type { IAdapter, MessageHandler, MessageHandlerDisposer } from '../base.js';
import type { UnifiedResponse } from '../../types/message.js';
import type { Config } from '../../config/index.js';
import { createTelegramBot } from './webhook.js';
import { normalizeGrammyContext } from './normalizer.js';
import { sendTelegramResponse } from './responder.js';
import { childLogger } from '../../utils/logger.js';
import { RateLimitError } from '../../utils/errors.js';

const log = childLogger({ module: 'telegram:adapter' });

export class TelegramAdapter implements IAdapter {
  public readonly name = 'telegram';

  private bot!: Bot;
  private startListening!: () => Promise<void>;
  private stopListening!: () => Promise<void>;
  private readonly handlers = new Set<MessageHandler>();
  private running = false;

  // Per-user concurrency tracking: userId → active task count
  private readonly userConcurrency = new Map<string, number>();
  private readonly maxPerUserConcurrency: number;

  constructor(private readonly config: Config) {
    this.maxPerUserConcurrency = config.queue.perUserConcurrency;
  }

  async initialize(): Promise<void> {
    const setup = createTelegramBot(this.config);
    this.bot = setup.bot;
    this.startListening = setup.startListening;
    this.stopListening = setup.stopListening;

    // Install per-user rate limiting middleware
    this.bot.use(async (ctx: Context, next: () => Promise<void>) => {
      const userId = ctx.from?.id ? `tg:${ctx.from.id}` : null;
      if (userId) {
        const current = this.userConcurrency.get(userId) ?? 0;
        if (current >= this.maxPerUserConcurrency) {
          log.warn({ userId, current }, 'Per-user concurrency limit reached');
          // Notify user and skip processing
          if (ctx.chat) {
            await ctx.reply(
              'I\'m currently processing your previous request. Please wait a moment before sending another message.',
            ).catch(() => undefined);
          }
          return; // Don't call next()
        }
        this.userConcurrency.set(userId, current + 1);
        try {
          await next();
        } finally {
          const after = this.userConcurrency.get(userId) ?? 1;
          if (after <= 1) {
            this.userConcurrency.delete(userId);
          } else {
            this.userConcurrency.set(userId, after - 1);
          }
        }
      } else {
        await next();
      }
    });

    // Main message handler middleware
    this.bot.on('message', async (ctx: Context) => {
      const message = normalizeGrammyContext(ctx);
      if (!message) return;

      log.debug({ userId: message.userId, text: message.text.slice(0, 50) }, 'Message received');

      // Dispatch to all registered handlers
      await Promise.allSettled(
        Array.from(this.handlers).map((handler) =>
          handler(message).catch((err: unknown) => {
            log.error({ err, userId: message.userId }, 'Message handler error');
          }),
        ),
      );
    });

    // Handle errors globally
    this.bot.catch((err) => {
      log.error({ err: err.error, ctx: err.ctx?.update }, 'Grammy error');
    });

    await this.startListening();
    this.running = true;
    log.info({ mode: this.config.telegram.mode }, 'TelegramAdapter initialized');
  }

  async sendResponse(response: UnifiedResponse): Promise<void> {
    if (!this.bot) {
      throw new Error('TelegramAdapter not initialized');
    }
    // Cast because Grammy types are complex but the API is compatible
    await sendTelegramResponse(this.bot, response);
  }

  onMessage(handler: MessageHandler): MessageHandlerDisposer {
    this.handlers.add(handler);
    log.debug({ handlerCount: this.handlers.size }, 'Message handler registered');

    // Return disposer
    return () => {
      this.handlers.delete(handler);
      log.debug({ handlerCount: this.handlers.size }, 'Message handler disposed');
    };
  }

  async shutdown(): Promise<void> {
    if (!this.running) return;
    await this.stopListening();
    this.handlers.clear();
    this.userConcurrency.clear();
    this.running = false;
    log.info('TelegramAdapter shut down');
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get current per-user concurrency count (for metrics).
   */
  getUserConcurrency(userId: string): number {
    return this.userConcurrency.get(userId) ?? 0;
  }

  /**
   * Returns the Grammy Bot API instance, or undefined if not yet initialized.
   * Used by ProgressReporter to send/edit progress messages without private field access.
   */
  public getApi(): import('grammy').Api | undefined {
    return this.bot?.api;
  }
}
