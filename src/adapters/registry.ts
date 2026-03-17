/**
 * src/adapters/registry.ts
 * AdapterRegistry: manages all registered platform adapters.
 */
import type { IAdapter, MessageHandler, MessageHandlerDisposer } from './base.js';
import { childLogger } from '../utils/logger.js';
import type { UnifiedResponse } from '../types/message.js';

const log = childLogger({ module: 'adapters:registry' });

export class AdapterRegistry {
  private readonly adapters = new Map<string, IAdapter>();

  /**
   * Register an adapter. Throws if an adapter with the same name already exists.
   */
  register(adapter: IAdapter): void {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Adapter '${adapter.name}' is already registered`);
    }
    this.adapters.set(adapter.name, adapter);
    log.debug({ adapter: adapter.name }, 'Adapter registered');
  }

  /**
   * Get an adapter by name.
   */
  get(name: string): IAdapter | undefined {
    return this.adapters.get(name);
  }

  /**
   * Initialize all registered adapters.
   */
  async initializeAll(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.adapters.values()).map((adapter) =>
        adapter.initialize().then(() => {
          log.info({ adapter: adapter.name }, 'Adapter initialized');
        }),
      ),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        log.error({ err: result.reason }, 'Adapter initialization failed');
        throw result.reason;
      }
    }
  }

  /**
   * Register a message handler on ALL adapters.
   * Returns an array of disposers.
   */
  onMessage(handler: MessageHandler): MessageHandlerDisposer[] {
    const disposers: MessageHandlerDisposer[] = [];
    for (const adapter of this.adapters.values()) {
      disposers.push(adapter.onMessage(handler));
    }
    return disposers;
  }

  /**
   * Send a response through the correct adapter based on platform.
   */
  async sendResponse(response: UnifiedResponse): Promise<void> {
    const platform = response.platform.platform;
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      log.warn({ platform }, 'No adapter found for platform');
      return;
    }
    await adapter.sendResponse(response);
  }

  /**
   * Shut down all adapters.
   */
  async shutdownAll(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.adapters.values()).map((adapter) =>
        adapter.shutdown().then(() => {
          log.info({ adapter: adapter.name }, 'Adapter shut down');
        }),
      ),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        log.error({ err: result.reason }, 'Adapter shutdown error');
      }
    }
  }

  /**
   * List all registered adapter names.
   */
  list(): string[] {
    return Array.from(this.adapters.keys());
  }
}
