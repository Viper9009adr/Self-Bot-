/**
 * src/config/index.ts
 * Load and validate environment variables into a typed Config object.
 */
import { config as loadDotenv } from 'dotenv';
import { ConfigSchema, type Config } from './schema.js';

// Load .env file (no-op if already set or file missing)
loadDotenv();

function buildRawConfig(): Record<string, unknown> {
  return {
    nodeEnv: process.env['NODE_ENV'],
    logLevel: process.env['LOG_LEVEL'],

    telegram: {
      botToken: process.env['TELEGRAM_BOT_TOKEN'],
      webhookSecret: process.env['TELEGRAM_WEBHOOK_SECRET'],
      mode: process.env['TELEGRAM_MODE'],
      webhookUrl: process.env['TELEGRAM_WEBHOOK_URL'],
      webhookPort: process.env['TELEGRAM_WEBHOOK_PORT'],
    },

    llm: {
      provider: process.env['LLM_PROVIDER'],
      model: process.env['LLM_MODEL'] || undefined,
      openaiApiKey: process.env['OPENAI_API_KEY'],
      anthropicApiKey: process.env['ANTHROPIC_API_KEY'],
      groqApiKey: process.env['GROQ_API_KEY'],
      // OAuth / token-based providers (free alternatives)
      githubToken: process.env['GITHUB_TOKEN'],
      openrouterApiKey: process.env['OPENROUTER_API_KEY'],
      openrouterReferer: process.env['OPENROUTER_REFERER'],
      oauthTokensPath: process.env['ANTHROPIC_OAUTH_TOKENS_PATH'],
    },

    agent: {
      maxSteps: process.env['AGENT_MAX_STEPS'],
      maxHistoryTokens: process.env['AGENT_MAX_HISTORY_TOKENS'],
      systemPromptExtra: process.env['AGENT_SYSTEM_PROMPT_EXTRA'] ?? '',
    },

    session: {
      ttlSeconds: process.env['SESSION_TTL_SECONDS'],
      store: process.env['SESSION_STORE'],
    },

    redis: {
      url: process.env['REDIS_URL'],
    },

    mcp: {
      serverPort: process.env['MCP_SERVER_PORT'],
      serverHost: process.env['MCP_SERVER_HOST'],
    },

    browserWorker: {
      url: process.env['BROWSER_WORKER_URL'],
      timeoutMs: process.env['BROWSER_WORKER_TIMEOUT_MS'],
    },

    queue: {
      concurrency: process.env['QUEUE_CONCURRENCY'],
      perUserConcurrency: process.env['QUEUE_PER_USER_CONCURRENCY'],
    },

    access: {
      ownerUserId: process.env['BOT_OWNER_ID'],
      allowlistPath: process.env['ALLOWLIST_PATH'],
      silentReject: process.env['ACCESS_SILENT_REJECT'],
      rejectionMessage: process.env['ACCESS_REJECTION_MESSAGE'],
    },
  };
}

let _config: Config | null = null;

/**
 * Known model prefixes for each provider. Used to detect obvious mismatches
 * (e.g. sending "gpt-4o" to the Anthropic API) at startup rather than at
 * first request time where the error is harder to diagnose.
 */
const PROVIDER_MODEL_PREFIXES: Record<string, string[]> = {
  openai: ['gpt-', 'o1-', 'o3-', 'chatgpt-', 'ft:gpt-'],
  anthropic: ['claude-'],
  'claude-oauth': ['claude-'],
  groq: ['llama', 'mixtral', 'gemma', 'whisper'],
  'github-models': ['gpt-', 'o1-', 'o3-', 'meta-llama', 'mistral', 'phi-'],
  // openrouter uses diverse model slugs — skip prefix validation
};

/**
 * Warn loudly (and throw) if the configured model clearly doesn't belong to the
 * selected provider. This catches the common case where LLM_MODEL is left at the
 * default "gpt-4o" but LLM_PROVIDER is set to "claude-oauth" or "anthropic".
 */
function validateProviderModel(config: Config): void {
  const { provider, model } = config.llm;
  const prefixes = PROVIDER_MODEL_PREFIXES[provider];
  if (!prefixes) return; // no prefix list → skip

  const modelLower = model.toLowerCase();
  const matches = prefixes.some((p) => modelLower.startsWith(p));
  if (!matches) {
    throw new Error(
      `Configuration error: LLM_MODEL="${model}" does not look like a valid model for LLM_PROVIDER="${provider}". ` +
        `Expected a model starting with one of: ${prefixes.join(', ')}. ` +
        `Set LLM_MODEL in your .env file to a model compatible with your provider.`,
    );
  }
}

/**
 * Parse and validate environment configuration.
 * Throws a descriptive error if validation fails.
 */
export function loadConfig(): Config {
  if (_config !== null) return _config;

  const raw = buildRawConfig();
  const result = ConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  [${i.path.join('.')}] ${i.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${issues}`);
  }

  const config = result.data;

  // ── Cross-field validation: provider ↔ model sanity check ──────────────
  validateProviderModel(config);

  _config = config;
  return _config;
}

/** Returns the validated config, loading it if not yet loaded. */
export function getConfig(): Config {
  return _config ?? loadConfig();
}

/** Reset cached config (useful in tests). */
export function resetConfig(): void {
  _config = null;
}

export type { Config } from './schema.js';
export { secret, redactSecret, type SecretString } from './schema.js';
