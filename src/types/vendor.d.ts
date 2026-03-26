/**
 * src/types/vendor.d.ts
 * Module declaration shims for packages that ship without TypeScript types.
 * These are replaced at runtime once packages are installed.
 */

// ─── whatsapp-web.js ──────────────────────────────────────────────────────────
declare module 'whatsapp-web.js' {
  import type { EventEmitter } from 'events';

  export interface ClientOptions {
    authStrategy?: AuthStrategy;
    puppeteer?: {
      headless?: boolean;
      args?: string[];
    };
  }

  export abstract class AuthStrategy {
    setup(client: Client): void;
    beforeBrowserInitialized(): Promise<void>;
    afterBrowserInitialized(): Promise<void>;
    onAuthenticationNeeded(): Promise<{ failed: boolean; restart: boolean; failureEventPayload?: unknown }>;
    afterAuthReady(): Promise<void>;
    disconnect(): Promise<void>;
    destroy(): Promise<void>;
    logout(): Promise<void>;
  }

  export class LocalAuth extends AuthStrategy {
    constructor(options?: { clientId?: string; dataPath?: string });
  }

  export interface Message {
    id: { id: string };
    from: string;
    to: string;
    author?: string;
    body: string;
    fromMe: boolean;
    isStatus?: boolean;
    timestamp: number;
    hasMedia: boolean;
    type: string;
  }

  export class Client extends EventEmitter {
    constructor(options?: ClientOptions);
    initialize(): Promise<void>;
    destroy(): Promise<void>;
    sendMessage(chatId: string, content: string): Promise<Message>;
    on(event: 'qr', listener: (qr: string) => void): this;
    on(event: 'ready', listener: () => void): this;
    on(event: 'auth_failure', listener: (msg: string) => void): this;
    on(event: 'disconnected', listener: (reason: string) => void): this;
    on(event: 'loading_screen', listener: (percent: number, message: string) => void): this;
    on(event: 'message', listener: (msg: Message) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
}

// ─── @fastify/cors ────────────────────────────────────────────────────────────
declare module '@fastify/cors' {
  import type { FastifyPluginAsync } from 'fastify';
  export interface FastifyCorsOptions {
    origin?: string | boolean | string[] | ((origin: string | undefined, callback: (err: Error | null, allow: boolean) => void) => void);
    credentials?: boolean;
    methods?: string | string[];
    allowedHeaders?: string | string[];
    exposedHeaders?: string | string[];
    maxAge?: number;
    preflightContinue?: boolean;
    optionsSuccessStatus?: number;
    preflight?: boolean;
    strictPreflight?: boolean;
    hideOptionsRoute?: boolean;
  }
  const cors: FastifyPluginAsync<FastifyCorsOptions>;
  export default cors;
}

// ─── @fastify/static ─────────────────────────────────────────────────────────
declare module '@fastify/static' {
  import type { FastifyPluginCallback } from 'fastify';
  export interface FastifyStaticOptions {
    root: string | string[];
    prefix?: string;
    prefixAvoidTrailingSlash?: boolean;
    serve?: boolean;
    decorateReply?: boolean;
    schemaHide?: boolean;
    setHeaders?: (res: unknown, path: string, stat: unknown) => void;
    allowedPath?: (pathName: string, root: string) => boolean;
    index?: string | string[] | false;
    wildcard?: boolean | string;
    list?: boolean | { format?: string; names?: string[]; extendedFolderInfo?: boolean; jsonFormat?: string };
    dotfiles?: 'allow' | 'deny' | 'ignore';
    etag?: boolean;
    extensions?: string[];
    immutable?: boolean;
    lastModified?: boolean;
    maxAge?: string | number;
  }
  const staticPlugin: FastifyPluginCallback<FastifyStaticOptions>;
  export default staticPlugin;
}

// ─── qrcode-terminal ─────────────────────────────────────────────────────────
declare module 'qrcode-terminal' {
  interface GenerateOptions {
    small?: boolean;
  }
  const qrcode: {
    generate(qr: string, opts?: GenerateOptions): void;
    generate(qr: string, opts: GenerateOptions, callback: () => void): void;
    setErrorLevel(level: 'L' | 'M' | 'Q' | 'H'): void;
  };
  export default qrcode;
}
