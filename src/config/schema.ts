/**
 * src/config/schema.ts
 * Zod v3 configuration schema with SecretString branded type.
 */
import { z } from 'zod';

// ─── Branded SecretString ─────────────────────────────────────────────────────
declare const __brand: unique symbol;
export type Brand<T, B> = T & { readonly [__brand]: B };
export type SecretString = Brand<string, 'Secret'>;

/** Wrap a plain string as a SecretString (only use at config parse time). */
export function secret(value: string): SecretString {
  return value as SecretString;
}

/** Redact a SecretString for logging purposes. */
export function redactSecret(_value: SecretString): string {
  return '[REDACTED]';
}

// ─── Zod transform helper ──────────────────────────────────────────────────
const secretString = z
  .string()
  .min(1)
  .transform((v) => secret(v));

// ─── Schema ───────────────────────────────────────────────────────────────────

/** Default model per provider — used when LLM_MODEL is not set. */
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
  'claude-oauth': 'claude-sonnet-4-20250514',
  groq: 'llama-3.3-70b-versatile',
  'github-models': 'gpt-4o',
  openrouter: 'meta-llama/llama-3.1-8b-instruct:free',
  'nvidia-nim': 'meta/llama-3.1-8b-instruct',
  local: 'llama3',
};

export const ConfigSchema = z.object({
  // Node environment
  nodeEnv: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  // Logging
  logLevel: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  // ── Telegram ──────────────────────────────────────────────────────────────
  telegram: z.object({
    botToken: secretString,
    webhookSecret: secretString.optional(),
    mode: z.enum(['webhook', 'polling']).default('polling'),
    webhookUrl: z.string().url().optional(),
    webhookPort: z.coerce.number().int().min(1).max(65535).default(8080),
  }),

  // ── LLM ───────────────────────────────────────────────────────────────────
  llm: z.object({
    provider: z
      .enum(['openai', 'anthropic', 'groq', 'github-models', 'openrouter', 'claude-oauth', 'nvidia-nim', 'local'])
      .default('openai'),
    model: z.string().min(1).optional(),
    openaiApiKey: secretString.optional(),
    anthropicApiKey: secretString.optional(),
    groqApiKey: secretString.optional(),
    // ── OAuth / Token-based providers (free alternatives) ─────────────────
    githubToken: secretString.optional(),
    openrouterApiKey: secretString.optional(),
    openrouterReferer: z.string().url().optional(),
    nvidiaNimApiKey: secretString.optional(),
    // ── Anthropic PKCE OAuth ──────────────────────────────────────────────
    /** Path to token cache file (default: .oauth-tokens.json) */
    oauthTokensPath: z.string().default('.oauth-tokens.json'),
    // ── Local OpenAI-compatible server endpoints ───────────────────────────
    // LOCAL_BASE_URL is primary (e.g. http://localhost:11434/v1)
    // Optional per-capability overrides can point to different local services.
    localBaseUrl: z.string().url().optional(),
    localApiKey: secretString.optional(),
    localSttUrl: z.string().url().optional(),
    localTtsUrl: z.string().url().optional(),
    localImageUrl: z.string().url().optional(),
  }).transform((llm) => ({
    ...llm,
    // If model is not explicitly set, pick a sensible default for the provider.
    // This prevents the dangerous situation where LLM_MODEL defaults to "gpt-4o"
    // but the provider is "claude-oauth" or "anthropic".
    model: llm.model ?? PROVIDER_DEFAULT_MODELS[llm.provider] ?? 'gpt-4o',
  })),

  // ── Agent ─────────────────────────────────────────────────────────────────
  agent: z.object({
    maxSteps: z.coerce.number().int().min(1).max(50).default(10),
    maxHistoryTokens: z.coerce.number().int().min(100).default(8000),
    systemPromptExtra: z.string().default(''),
    progressReporterPersistHistory: z
      .enum(['true', 'false'])
      .optional()
      .default('false')
      .transform((v) => v === 'true'),
  }),

  // ── Session ───────────────────────────────────────────────────────────────
  session: z.object({
    ttlSeconds: z.coerce.number().int().min(60).default(3600),
    store: z.enum(['memory', 'redis', 'meridian']).default('memory'),
    meridianUrl: z.string().url().optional(),
  }),

  // ── Redis ─────────────────────────────────────────────────────────────────
  redis: z.object({
    url: z.string().default('redis://localhost:6379'),
    disableTtl: z.coerce.boolean().default(false),
  }),

  // ── MCP ───────────────────────────────────────────────────────────────────
  mcp: z.object({
    serverPort: z.coerce.number().int().min(1).max(65535).default(3001),
    serverHost: z.string().default('127.0.0.1'),
    remoteServers: z.string().optional(),
  }),

  // ── Browser Worker ────────────────────────────────────────────────────────
  browserWorker: z.object({
    url: z.string().url().default('http://localhost:3002'),
    timeoutMs: z.coerce.number().int().min(1000).default(30000),
  }),

  // ── Queue ─────────────────────────────────────────────────────────────────
  queue: z.object({
    concurrency: z.coerce.number().int().min(1).default(4),
    perUserConcurrency: z.coerce.number().int().min(1).default(2),
  }),

  // ── Migration Compatibility Flags ─────────────────────────────────────────
  migration: z
    .object({
      adapterBoundary: z.coerce.boolean().default(false),
      mobileRuntime: z.coerce.boolean().default(false),
    })
    .default({}),

  // ── Access Control ────────────────────────────────────────────────────────
  access: z.object({
    ownerUserId: z
      .string()
      .min(1)
      .regex(/^[a-z]+:.+/, 'BOT_OWNER_ID must be platform-prefixed, e.g. tg:123456789'),
    allowlistPath: z.string().default('.allowlist.json'),
    silentReject: z.coerce.boolean().default(true),
    rejectionMessage: z.string().optional(),
    /** HS256 JWT signing secret. Must be ≥32 chars. Required when MERIDIAN_MCP_URL is set. */
    gatewayJwtSecret: z
      .string()
      .min(32, 'GATEWAY_JWT_SECRET must be at least 32 characters')
      .transform((v) => secret(v))
      .optional(),
    /** Base URL of the Meridian MCP server. When set, activates MeridianAllowlistStore. */
    meridianMcpUrl: z.string().url().optional(),
    /** Which allowlist store backend to use. Defaults to 'file'. Set to 'meridian' to use MeridianAllowlistStore (requires MERIDIAN_MCP_URL). */
    allowlistStore: z.enum(['file', 'meridian']).default('file'),
  }),

  // ── WhatsApp ──────────────────────────────────────────────────────────────
  whatsapp: z.object({
    ownerNumber: z.string().optional(),
    sessionPath: z.string().default('.whatsapp-session'),
    enabled: z.coerce.boolean().default(false),
    documentMaxBytes: z.coerce.number().int().min(1024).max(50 * 1024 * 1024).default(10 * 1024 * 1024),
  }).optional(),

  // ── Website ───────────────────────────────────────────────────────────────
  website: z.object({
    ownerUsername: z.string().min(1),
    ownerPassword: secretString,
    port: z.coerce.number().int().min(1).max(65535).default(3000),
    host: z.string().default('0.0.0.0'),
    enabled: z.coerce.boolean().default(false),
  }).optional(),

  // ── Media ──────────────────────────────────────────────────────────────────
  media: z.object({
    imageModel: z.string().default('gpt-image-1'),
    sttModel: z.string().default('whisper-1'),
    ttsModel: z.string().default('tts-1'),
    ttsVoice: z.enum(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']).default('alloy'),
    ttsEnabled: z.coerce.boolean().default(true),
    imageSize: z.string().default('1024x1024'),
    imageQuality: z.enum(['standard', 'hd', 'low', 'medium', 'high', 'auto']).default('standard'),
    nvidiaNimImageModel: z.string().default('stabilityai/stable-diffusion-3-medium'),
  }).optional(),

  // ── Terminal ────────────────────────────────────────────────────────────────
  terminal: z.object({
    skillsPath: z.string().default('./terminal-skills'),
    commandAllowlist: z.array(z.string()).default(['opencode', 'claude', 'codex', 'git']),
    cwdAllowlist: z.array(z.string()).default(['/home', '/tmp']),
    strictCwdValidation: z.coerce.boolean().default(true),
    envBlocklist: z.array(z.string()).default(['AWS_', 'SECRET_', 'TOKEN_', 'API_KEY']),
    defaultTimeout: z.coerce.number().int().min(1000).default(300000),
    maxConcurrentSessions: z.coerce.number().int().min(1).default(5),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type RawConfig = z.input<typeof ConfigSchema>;
