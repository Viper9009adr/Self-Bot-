/**
 * src/agent/llm.ts
 * LLM client factory using Vercel AI SDK v4 with multi-provider support.
 *
 * Includes OAuth / token-based providers (GitHub Models, OpenRouter) that
 * reuse @ai-sdk/openai with custom baseURL for free LLM access — bypassing
 * paid API-key requirements.
 *
 * Also includes claude-oauth: Anthropic PKCE OAuth 2.0 flow using the real
 * Anthropic authorization server (same system used by Claude Code internally).
 */
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGroq } from '@ai-sdk/groq';
import type { LanguageModel } from 'ai';
import type { Config } from '../config/index.js';
import { ConfigError } from '../utils/errors.js';

/**
 * Derive LLMProvider from the Zod schema to prevent drift between
 * the config enum and this type alias.
 */
export type LLMProvider = Config['llm']['provider'];

/** GitHub Models OpenAI-compatible endpoint (free via GitHub PAT). */
const GITHUB_MODELS_BASE_URL = 'https://models.inference.ai.azure.com';

/** OpenRouter OpenAI-compatible endpoint (free tier available). */
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Create a Vercel AI SDK LanguageModel from the config.
 *
 * Supports six providers:
 * - `openai`        — Direct OpenAI API (requires paid API key)
 * - `anthropic`     — Direct Anthropic API (requires paid API key)
 * - `groq`          — Groq Cloud (free tier available)
 * - `github-models` — GitHub Models via Azure AI (free via GitHub PAT, no billing)
 * - `openrouter`    — OpenRouter proxy (free tier models available)
 * - `claude-oauth`  — Anthropic PKCE OAuth (uses Claude Pro/Max subscription)
 *
 * @param config         - validated app config
 * @param oauthAccessToken - required when provider='claude-oauth'; Bearer token from OAuthManager
 */
export function createLLMModel(config: Config, oauthAccessToken?: string): LanguageModel {
  const { provider, model } = config.llm;

  switch (provider) {
    // ── Paid API-Key Providers ──────────────────────────────────────────────

    case 'openai': {
      if (!config.llm.openaiApiKey) {
        throw new ConfigError(
          'OPENAI_API_KEY is required when LLM_PROVIDER=openai',
          'llm.openaiApiKey',
        );
      }
      const openai = createOpenAI({
        apiKey: config.llm.openaiApiKey as unknown as string,
      });
      return openai(model);
    }

    case 'anthropic': {
      if (!config.llm.anthropicApiKey) {
        throw new ConfigError(
          'ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic',
          'llm.anthropicApiKey',
        );
      }
      const anthropic = createAnthropic({
        apiKey: config.llm.anthropicApiKey as unknown as string,
      });
      return anthropic(model);
    }

    case 'groq': {
      if (!config.llm.groqApiKey) {
        throw new ConfigError(
          'GROQ_API_KEY is required when LLM_PROVIDER=groq',
          'llm.groqApiKey',
        );
      }
      const groq = createGroq({
        apiKey: config.llm.groqApiKey as unknown as string,
      });
      return groq(model);
    }

    // ── Free / OAuth Token Providers ────────────────────────────────────────

    case 'github-models': {
      if (!config.llm.githubToken) {
        throw new ConfigError(
          'GITHUB_TOKEN is required when LLM_PROVIDER=github-models. ' +
            'Create a free PAT at https://github.com/settings/tokens (no scopes needed)',
          'llm.githubToken',
        );
      }
      const ghModels = createOpenAI({
        name: 'github-models',
        baseURL: GITHUB_MODELS_BASE_URL,
        apiKey: config.llm.githubToken as unknown as string,
        compatibility: 'compatible',
      });
      return ghModels(model);
    }

    case 'openrouter': {
      if (!config.llm.openrouterApiKey) {
        throw new ConfigError(
          'OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter. ' +
            'Get a free key at https://openrouter.ai/keys',
          'llm.openrouterApiKey',
        );
      }

      const referer = config.llm.openrouterReferer as string | undefined;

      const openrouter = createOpenAI({
        name: 'openrouter',
        baseURL: OPENROUTER_BASE_URL,
        apiKey: config.llm.openrouterApiKey as unknown as string,
        compatibility: 'compatible',
        headers: {
          'HTTP-Referer': referer ?? 'https://github.com/self-bot',
          'X-Title': 'Self-BOT',
        },
      });
      return openrouter(model);
    }

    case 'claude-oauth': {
      if (!oauthAccessToken) {
        throw new ConfigError(
          "LLM provider 'claude-oauth' requires an OAuth access token. " +
            'Ensure OAuthManager.ensureAuthenticated() was called before createLLMModel().',
          'llm.provider',
        );
      }

      // IMPORTANT: @ai-sdk/anthropic sends x-api-key by default, but Anthropic OAuth
      // tokens require Authorization: Bearer. We use a fetch interceptor to swap the
      // auth header.
      //
      // Key fix: convert all incoming headers to a plain lowercase-keyed object before
      // passing to globalThis.fetch. Using a Headers instance caused Bun to serialize
      // headers differently, resulting in HTTP 400 from api.anthropic.com/v1. A plain
      // object with lowercase keys is the most portable representation across runtimes.
      const token = oauthAccessToken;
      const oauthFetch = (async (
        url: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ): Promise<Response> => {
        // Convert incoming headers to a plain lowercase-keyed object.
        // Avoids any Headers-instance serialization quirks in Bun.
        const plain: Record<string, string> = {};
        const incoming = init?.headers;
        if (incoming instanceof Headers) {
          incoming.forEach((value, key) => { plain[key.toLowerCase()] = value; });
        } else if (incoming != null && typeof incoming === 'object') {
          for (const [k, v] of Object.entries(incoming as Record<string, string>)) {
            if (v != null) plain[k.toLowerCase()] = v;
          }
        }

        // Remove API key header — OAuth uses Authorization: Bearer instead.
        delete plain['x-api-key'];

        // Set all required OAuth headers (lowercase keys for consistency).
        // claude-code-20250219 is mandatory — without it the API rejects OAuth tokens.
        // fine-grained-tool-streaming-2025-05-14 is required for tool streaming.
        plain['authorization'] = `Bearer ${token}`;
        plain['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14';
        plain['user-agent'] = 'claude-cli/2.1.77';
        plain['x-app'] = 'cli';

        // Strip fields rejected by the claude-code-20250219 beta.
        // The Vercel AI SDK adds temperature, tool_choice, and Zod-derived
        // $schema / additionalProperties that Anthropic's API does not accept.
        let body = init?.body;
        if (typeof body === 'string') {
          try {
            const parsed = JSON.parse(body) as Record<string, unknown>;

            // claude-code-20250219 beta rejects temperature (even 0)
            delete parsed['temperature'];

            // claude-code-20250219 beta rejects tool_choice
            delete parsed['tool_choice'];

            // The OAuth endpoint REQUIRES the Claude Code identity as a SEPARATE first block.
            // Any other format (combined, string) → 400.
            const IDENTITY = 'You are Claude Code, Anthropic\'s official CLI for Claude.';
            const systemVal = parsed['system'];
            if (Array.isArray(systemVal)) {
              // Check if identity is already the first standalone block
              const firstBlock = systemVal[0] as Record<string, unknown> | undefined;
              const alreadySplit = firstBlock?.['type'] === 'text' && firstBlock?.['text'] === IDENTITY;
              if (!alreadySplit) {
                // Strip identity prefix if it was concatenated into the first block
                const blocks = systemVal.map((b: unknown) => {
                  const block = b as Record<string, unknown>;
                  if (block['type'] === 'text' && typeof block['text'] === 'string') {
                    const t = block['text'] as string;
                    return { ...block, text: t.startsWith(IDENTITY) ? t.slice(IDENTITY.length).replace(/^\n+/, '') : t };
                  }
                  return block;
                });
                parsed['system'] = [{ type: 'text', text: IDENTITY }, ...blocks];
              }
            } else if (typeof systemVal === 'string') {
              const t = systemVal.startsWith(IDENTITY) ? systemVal.slice(IDENTITY.length).replace(/^\n+/, '') : systemVal;
              parsed['system'] = [{ type: 'text', text: IDENTITY }, { type: 'text', text: t }];
            }

            // Sanitize tool input_schema to only what Anthropic OAuth accepts.
            // The reference (badlogic/pi-mono) keeps only type, description, enum per property.
            // Fields like format, default, minimum, maximum, minLength, additionalProperties,
            // $schema are all rejected by the claude-code-20250219 beta endpoint.
            if (Array.isArray(parsed['tools'])) {
              parsed['tools'] = (parsed['tools'] as Array<Record<string, unknown>>).map((tool) => {
                const schema = tool['input_schema'] as Record<string, unknown> | undefined;
                if (schema && typeof schema === 'object') {
                  const props = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
                  const cleanedProps: Record<string, Record<string, unknown>> = {};
                  if (props) {
                    for (const [propName, propSchema] of Object.entries(props)) {
                      // Keep only type, description, enum — strip everything else
                      const clean: Record<string, unknown> = {};
                      if (propSchema['type'] !== undefined) clean['type'] = propSchema['type'];
                      if (propSchema['description'] !== undefined) clean['description'] = propSchema['description'];
                      if (propSchema['enum'] !== undefined) clean['enum'] = propSchema['enum'];
                      cleanedProps[propName] = clean;
                    }
                  }
                  return {
                    ...tool,
                    input_schema: {
                      type: 'object',
                      properties: cleanedProps,
                      required: schema['required'] ?? [],
                    },
                  };
                }
                return tool;
              });
            }

            body = JSON.stringify(parsed);
          } catch {
            // leave body unchanged if not valid JSON
          }
        }

        const response = await globalThis.fetch(url, { ...init, headers: plain, body });

        // Surface non-OK responses immediately instead of letting the SDK
        // silently produce an empty stream. Common case: 403 permission_error
        // when the OAuth token was obtained without the user:inference scope.
        if (!response.ok) {
          const errBody = await response.text().catch(() => '(unreadable body)');
          throw new Error(
            `Anthropic OAuth API error ${response.status}: ${errBody}. ` +
              'If you see a scope/permission error, delete .oauth-tokens.json and restart to re-authenticate.',
          );
        }
        return response;
      }) as typeof globalThis.fetch;
      const anthropicOAuth = createAnthropic({
        apiKey: 'oauth-placeholder', // satisfies non-empty check in the SDK
        fetch: oauthFetch,
        baseURL: 'https://api.anthropic.com/v1',
      });
      return anthropicOAuth(model);
    }

    default: {
      // TypeScript exhaustiveness check — ensures all providers are handled.
      // If a new provider is added to the Zod enum but not here, TS will error.
      const _exhaustive: never = provider;
      throw new ConfigError(`Unknown LLM provider: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Get a human-readable description of the current model.
 */
export function describeModel(config: Config): string {
  return `${config.llm.provider}/${config.llm.model}`;
}
