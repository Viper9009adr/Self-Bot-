/**
 * src/utils/retry.ts
 * p-retry wrapper with exponential backoff and jitter.
 */
import pRetry, { AbortError, type Options as PRetryOptions } from 'p-retry';
import { BotError } from './errors.js';

export interface RetryOptions {
  /** Maximum number of attempts (default 3) */
  maxAttempts?: number;
  /** Initial delay in ms (default 500) */
  initialDelayMs?: number;
  /** Maximum delay in ms (default 10_000) */
  maxDelayMs?: number;
  /** Exponential factor (default 2) */
  factor?: number;
  /** Add random jitter to delays (default true) */
  jitter?: boolean;
  /** Called before each retry with the error and attempt number */
  onRetry?: (error: Error, attempt: number) => void;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  factor: 2,
  jitter: true,
  onRetry: () => undefined,
};

/**
 * Retry an async operation with exponential backoff.
 * Non-retryable BotErrors immediately abort the retry loop.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };

  const pRetryOptions: PRetryOptions = {
    retries: opts.maxAttempts - 1,
    minTimeout: opts.initialDelayMs,
    maxTimeout: opts.maxDelayMs,
    factor: opts.factor,
    randomize: opts.jitter,
    onFailedAttempt: (error) => {
      opts.onRetry(error, error.attemptNumber);
    },
  };

  return pRetry((attempt) => {
    return fn(attempt).catch((err: unknown) => {
      // Non-retryable errors abort immediately
      if (err instanceof BotError && !err.isRetryable) {
        throw new AbortError(err);
      }
      throw err;
    });
  }, pRetryOptions);
}

/**
 * Wraps a function and aborts the retry loop on specific error codes.
 */
export function abortRetryOnCodes(
  codes: string[],
): (error: Error) => void {
  return (error: Error) => {
    if (error instanceof BotError && codes.includes(error.code)) {
      throw new AbortError(error);
    }
  };
}

export { AbortError };
