/**
 * src/utils/errors.ts
 * Custom error hierarchy for Self-BOT.
 */
import type { ToolErrorCode } from '../types/tool.js';

// ─── Base ─────────────────────────────────────────────────────────────────────
export class BotError extends Error {
  public readonly code: string;
  public readonly isRetryable: boolean;
  public readonly context: Record<string, unknown>;

  constructor(
    message: string,
    options: {
      code?: string;
      isRetryable?: boolean;
      context?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'BotError';
    this.code = options.code ?? 'BOT_ERROR';
    this.isRetryable = options.isRetryable ?? false;
    this.context = options.context ?? {};
    // Ensure proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      isRetryable: this.isRetryable,
      context: this.context,
    };
  }
}

// ─── Config Error ─────────────────────────────────────────────────────────────
export class ConfigError extends BotError {
  constructor(message: string, field?: string) {
    super(message, {
      code: 'CONFIG_ERROR',
      isRetryable: false,
      context: field ? { field } : {},
    });
    this.name = 'ConfigError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Adapter Error ────────────────────────────────────────────────────────────
export class AdapterError extends BotError {
  public readonly platform: string;

  constructor(
    message: string,
    platform: string,
    options: {
      code?: string;
      isRetryable?: boolean;
      context?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, {
      code: options.code ?? 'ADAPTER_ERROR',
      isRetryable: options.isRetryable ?? true,
      context: { platform, ...options.context },
      cause: options.cause,
    });
    this.name = 'AdapterError';
    this.platform = platform;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Tool Error ───────────────────────────────────────────────────────────────
export class ToolError extends BotError {
  public readonly toolName: string;
  public readonly toolErrorCode: ToolErrorCode;

  constructor(
    message: string,
    toolName: string,
    errorCode: ToolErrorCode,
    options: {
      isRetryable?: boolean;
      context?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, {
      code: `TOOL_${errorCode}`,
      isRetryable: options.isRetryable ?? false,
      context: { toolName, errorCode, ...options.context },
      cause: options.cause,
    });
    this.name = 'ToolError';
    this.toolName = toolName;
    this.toolErrorCode = errorCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Agent Error ──────────────────────────────────────────────────────────────
export class AgentError extends BotError {
  constructor(
    message: string,
    options: {
      code?: string;
      isRetryable?: boolean;
      context?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, {
      code: options.code ?? 'AGENT_ERROR',
      isRetryable: options.isRetryable ?? false,
      ...options,
    });
    this.name = 'AgentError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Session Error ────────────────────────────────────────────────────────────
export class SessionError extends BotError {
  constructor(message: string, userId?: string) {
    super(message, {
      code: 'SESSION_ERROR',
      isRetryable: true,
      context: userId ? { userId } : {},
    });
    this.name = 'SessionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Rate Limit Error ─────────────────────────────────────────────────────────
export class RateLimitError extends BotError {
  public readonly retryAfterMs: number;

  constructor(userId: string, retryAfterMs = 1000) {
    super(`User ${userId} is rate limited`, {
      code: 'RATE_LIMITED',
      isRetryable: true,
      context: { userId, retryAfterMs },
    });
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Validation Error ─────────────────────────────────────────────────────────
export class ValidationError extends BotError {
  public readonly field?: string;

  constructor(message: string, field?: string) {
    super(message, {
      code: 'VALIDATION_ERROR',
      isRetryable: false,
      context: field ? { field } : {},
    });
    this.name = 'ValidationError';
    if (field !== undefined) this.field = field;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────
/** Convert any thrown value to a BotError-compatible shape for logging. */
export function normalizeError(err: unknown): BotError {
  if (err instanceof BotError) return err;
  if (err instanceof Error) {
    return new BotError(err.message, {
      code: 'UNEXPECTED_ERROR',
      cause: err,
      context: { originalName: err.name },
    });
  }
  return new BotError(String(err), { code: 'UNEXPECTED_ERROR' });
}
