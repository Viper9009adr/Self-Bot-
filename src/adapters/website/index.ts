/**
 * src/adapters/website/index.ts
 * WebAdapter: implements IAdapter for the website platform.
 * Hosts a Fastify HTTP server with JWT auth and REST + chat endpoints.
 */
import type { FastifyInstance } from 'fastify';
import type { IAdapter, MessageHandler, MessageHandlerDisposer } from '../base.js';
import type { UnifiedMessage, UnifiedResponse, WebMetadata } from '../../types/message.js';
import type { Config } from '../../config/index.js';
import type { SessionManager } from '../../session/manager.js';
import type { IAllowlistStore } from '../../access/index.js';
import { createWebServer, resolvePending } from './server.js';
import { AdapterError } from '../../utils/errors.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ module: 'website:adapter' });

// ─── PendingEntry ─────────────────────────────────────────────────────────────

interface PendingEntry {
  resolve: (r: UnifiedResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

// ─── WebAdapter ───────────────────────────────────────────────────────────────

export class WebAdapter implements IAdapter {
  public readonly name = 'web';

  private server!: FastifyInstance;
  private readonly handlers = new Set<MessageHandler>();
  private readonly pendingMap = new Map<string, PendingEntry>();
  private running = false;

  constructor(
    private readonly config: Config,
    private readonly sessions: SessionManager,
    private readonly allowlist: IAllowlistStore,
  ) {}

  // ── IAdapter ────────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (!this.config.website) {
      throw new AdapterError('Website adapter not configured — set WEB_OWNER_USERNAME', 'web', {
        code: 'CONFIG_MISSING',
        isRetryable: false,
      });
    }

    this.server = await createWebServer(
      this.config,
      this.sessions,
      this.allowlist,
      (msg) => this.dispatchMessage(msg),
      (res) => this.resolveResponse(res),
    );

    await this.server.listen({
      port: this.config.website.port,
      host: this.config.website.host,
    });

    this.running = true;
    log.info({ port: this.config.website.port }, 'WebAdapter initialized');
  }

  async sendResponse(response: UnifiedResponse): Promise<void> {
    if (response.platform.platform !== 'web') return;
    this.resolveResponse(response);
  }

  onMessage(handler: MessageHandler): MessageHandlerDisposer {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async shutdown(): Promise<void> {
    if (!this.running) return;

    // CRITICAL-1: Reject all pending requests on shutdown (settled guard)
    for (const [, entry] of this.pendingMap) {
      if (!entry.settled) {
        entry.settled = true;
        clearTimeout(entry.timer);
        entry.reject(new Error('Server shutting down'));
      }
    }
    this.pendingMap.clear();

    await this.server.close();
    this.handlers.clear();
    this.running = false;
    log.info('WebAdapter shut down');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private dispatchMessage(msg: UnifiedMessage): void {
    void Promise.allSettled(
      Array.from(this.handlers).map((h) =>
        h(msg).catch((err: unknown) => log.error({ err }, 'handler error')),
      ),
    );
  }

  /**
   * CRITICAL-1 sendResponse path:
   * 1. Check settled
   * 2. Set settled = true
   * 3. clearTimeout
   * 4. Delete from map
   * 5. resolve
   */
  private resolveResponse(response: UnifiedResponse): void {
    // Delegate to the module-level resolvePending which owns the pendingRef map
    resolvePending(response);

    // Also resolve against the adapter's own pendingMap (used during shutdown)
    const meta = response.platform as WebMetadata;
    const entry = this.pendingMap.get(meta.requestId);
    if (!entry || entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    this.pendingMap.delete(meta.requestId);
    entry.resolve(response);
  }
}
