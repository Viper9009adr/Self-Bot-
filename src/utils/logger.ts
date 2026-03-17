/**
 * src/utils/logger.ts
 * Pino logger configured for Bun (sync stdout via pino.destination(1)).
 * Redacts sensitive fields so secrets never appear in logs.
 */
import pino, { type Logger, type LoggerOptions } from 'pino';

// Fields to redact from log output (dot-notation paths)
const REDACT_PATHS = [
  'config.telegram.botToken',
  'config.llm.openaiApiKey',
  'config.llm.anthropicApiKey',
  'config.llm.groqApiKey',
  'botToken',
  'token',
  'apiKey',
  'api_key',
  'password',
  'passwd',
  'secret',
  'webhookSecret',
  'authorization',
  'cookie',
  'credentials.password',
  'credentials.username',
  'payload.password',
  'input.password',
  'input.credentials',
  '*.password',
  '*.apiKey',
  '*.token',
  '*.secret',
];

let _logger: Logger | null = null;

export function createLogger(level = 'info', name?: string): Logger {
  const options: LoggerOptions = {
    level,
    ...(name !== undefined ? { name } : {}),
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    base: {
      pid: process.pid,
      env: process.env['NODE_ENV'] ?? 'development',
    },
  };

  // Use pino.destination(1) for sync stdout — required for Bun compatibility.
  // pino transport workers (pino-pretty etc.) are NOT used.
  return pino(options, pino.destination(1));
}

/** Get or create the global logger singleton. */
export function getLogger(level?: string): Logger {
  if (_logger === null) {
    _logger = createLogger(level ?? process.env['LOG_LEVEL'] ?? 'info', 'self-bot');
  }
  return _logger;
}

/** Create a child logger with additional bound fields. */
export function childLogger(
  bindings: Record<string, unknown>,
  level?: string,
): Logger {
  return getLogger(level).child(bindings);
}

export type { Logger };
