/**
 * src/adapters/base.ts
 * IAdapter interface and MessageHandler type with disposer pattern.
 */
import type { UnifiedMessage, UnifiedResponse } from '../types/message.js';

/**
 * A handler for incoming messages.
 * Returns a disposer function that removes the handler when called.
 */
export type MessageHandler = (message: UnifiedMessage) => Promise<void>;

/** Disposer function returned by onMessage() */
export type MessageHandlerDisposer = () => void;

/**
 * Platform adapter interface.
 * Each platform (Telegram, CLI, API, etc.) must implement this.
 */
export interface IAdapter {
  /** Unique identifier for this adapter (e.g. 'telegram', 'whatsapp', 'web') */
  readonly name: string;

  /** Initialize the adapter (connect to platform, set up webhooks/polling) */
  initialize(): Promise<void>;

  /** Send a response back through this platform */
  sendResponse(response: UnifiedResponse): Promise<void>;

  /**
   * Register a handler for incoming messages.
   * Returns a disposer — call it to unregister the handler.
   */
  onMessage(handler: MessageHandler): MessageHandlerDisposer;

  /** Gracefully shut down the adapter */
  shutdown(): Promise<void>;

  /** Whether the adapter is currently running */
  isRunning(): boolean;
}
