# Self-BOT

An AI-powered Telegram bot with browser automation, MCP tool integration, and extensible agent capabilities built on the Bun runtime.

## Features

- **Telegram Bot Integration** — Full support for both webhook and long-polling modes
- **AI Agent** — Powered by Vercel AI SDK with chain-of-thought reasoning and planning
- **Multiple LLM Providers** — OpenAI, Anthropic, Groq, GitHub Models, OpenRouter, and Claude OAuth (free with Claude Pro/Max)
- **MCP Tools** — Extensible tool system with built-in tools for web scraping, form filling, appointment booking, and account registration/login
- **Browser Automation** — Playwright-based headless browser with stealth mode
- **Session Management** — Per-user session isolation with optional Redis persistence
- **Access Control** — Owner + allowlist gate; only you and users you explicitly grant can interact with the bot
- **Rate Limiting** — Per-user concurrency controls to prevent abuse
- **Graceful Shutdown** — Proper drain logic for handling shutdown signals
- **CAPTCHA Detection** — Automatic detection and handling of CAPTCHA challenges
- **Structured Logging** — Pino-based logging with sensitive data redaction

## Tech Stack

| Component | Technology | Version |
|-----------|------------|---------|
| Runtime | Bun | 1.x |
| Telegram Bot Framework | Grammy | 1.30 |
| AI/LLM Framework | Vercel AI SDK | 4.x |
| MCP SDK | Model Context Protocol | 1.10 |
| Browser Automation | Playwright | latest |
| Web Scraping | Cheerio | latest |
| Queue Management | p-queue | 8.x |
| Logging | Pino | 9.x |
| Validation | Zod | 3.x |
| Database (optional) | Redis | - |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Telegram Users                           │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Telegram Adapter                            │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐   │
│  │   Webhook   │  │   Normalizer │  │     Responder       │   │
│  │   Handler   │──▶│   (Unified   │──▶│   (Send replies)    │   │
│  │             │  │   Message)   │  │                     │   │
│  └─────────────┘  └──────────────┘  └─────────────────────┘   │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Agent System                               │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐   │
│  │   LLM       │  │   Chain-of   │  │      Memory         │   │
│  │   Provider  │◀─▶│   Thought    │──▶│   (Conversation)   │   │
│  │             │  │              │  │                     │   │
│  └─────────────┘  └──────────────┘  └─────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              MCP Tool Registry & Executor               │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   External Services                             │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐   │
│  │    LLM      │  │   Browser    │  │    MCP Servers      │   │
│  │   Providers │  │   (Playwright│  │  (Custom tools)     │   │
│  │             │  │   Worker)    │  │                     │   │
│  └─────────────┘  └──────────────┘  └─────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Component Flow

1. **Message Reception** — Telegram updates arrive via webhook or long-polling
2. **Normalization** — Raw updates converted to `UnifiedMessage` format
3. **Access Control** — `AccessGuard` checks the sender against the owner ID and allowlist; unauthorized messages are dropped or rejected before any further processing
4. **Session Retrieval** — User session loaded from store (in-memory or Redis)
5. **Agent Processing** — Message passed to AI agent with memory context
6. **Tool Execution** — Agent decides which MCP tools to invoke
7. **Browser Automation** — If needed, Playwright handles web interactions
8. **Response Generation** — Agent produces structured response
9. **Response Delivery** — Responder sends message back to Telegram

## Prerequisites

- **Bun** 1.x installed
- **Node.js** 18+ (for Playwright browser binaries)
- **Telegram Bot Token** — Obtain from [@BotFather](https://t.me/BotFather)
- **LLM Provider credentials** — API key (OpenAI/Anthropic/Groq/OpenRouter), GitHub PAT, or Claude Pro/Max subscription (see [LLM Providers](#llm-providers) below)
- **Redis** (optional) — For session persistence across restarts

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd Self-BOT

# Install dependencies
bun install

# Install Playwright browsers
npx playwright install chromium
```

## LLM Providers

Self-BOT supports six LLM providers. Set `LLM_PROVIDER` in your `.env` to select one.

| Provider | `LLM_PROVIDER` value | Cost | Required credential |
|---|---|---|---|
| OpenAI | `openai` | Paid | `OPENAI_API_KEY` |
| Anthropic | `anthropic` | Paid | `ANTHROPIC_API_KEY` |
| Groq | `groq` | Free tier available | `GROQ_API_KEY` |
| GitHub Models | `github-models` | Free (GitHub PAT) | `GITHUB_TOKEN` |
| OpenRouter | `openrouter` | Free tier available | `OPENROUTER_API_KEY` |
| Claude OAuth | `claude-oauth` | Free with Claude Pro/Max | *(browser auth, no key)* |

### openai

Direct API access to OpenAI models. Requires a paid API key.

```env
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o
OPENAI_API_KEY=sk-...
```

### anthropic

Direct API access to Anthropic models. Requires a paid API key.

```env
LLM_PROVIDER=anthropic
LLM_MODEL=claude-3-5-sonnet-20241022
ANTHROPIC_API_KEY=sk-ant-...
```

### groq

Access to Groq-hosted models with a free tier available. Sign up at [console.groq.com](https://console.groq.com).

```env
LLM_PROVIDER=groq
LLM_MODEL=llama-3.3-70b-versatile
GROQ_API_KEY=gsk_...
```

### github-models

Free access to GPT-4o and other models via GitHub's model inference endpoint. No billing required — only a GitHub Personal Access Token (classic or fine-grained, no scopes needed).

- Rate limits: ~10 RPM for `gpt-4o`, ~150 RPM for `gpt-4o-mini` on the free tier
- Create a PAT at: [github.com/settings/tokens/new](https://github.com/settings/tokens/new)

```env
LLM_PROVIDER=github-models
LLM_MODEL=gpt-4o
GITHUB_TOKEN=ghp_...
```

### openrouter

Access free-tier and paid models via the OpenRouter proxy. Sign up at [openrouter.ai](https://openrouter.ai/keys).

Free model examples: `meta-llama/llama-3.1-8b-instruct:free`, `google/gemma-2-9b-it:free`

```env
LLM_PROVIDER=openrouter
LLM_MODEL=meta-llama/llama-3.1-8b-instruct:free
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_REFERER=https://github.com/your-repo   # optional
```

### claude-oauth

Anthropic PKCE OAuth 2.0. 

- On first run the bot prints an authorization URL to the console
- Tokens are cached in `.oauth-tokens.json` (gitignored) and auto-refreshed silently
- Interactive re-authentication is only required if the refresh token is revoked

See [Claude OAuth Setup](#claude-oauth-setup) below for the step-by-step guide.

```env
LLM_PROVIDER=claude-oauth
LLM_MODEL=claude-sonnet-4-20250514
# ANTHROPIC_OAUTH_TOKENS_PATH=.oauth-tokens.json  # optional, this is the default
```

## Configuration

Copy `.env.example` to `.env` and fill in the values for your chosen provider.

```bash
cp .env.example .env
```

### Claude OAuth Setup

1. Set `LLM_PROVIDER=claude-oauth` (and optionally `LLM_MODEL`) in your `.env` file.
2. Start the bot:
   ```bash
   bun run src/index.ts
   ```
3. On first run, the bot will print an authorization URL to the console:
   ```
   Open this URL in your browser to authorize:
   https://claude.ai/oauth/authorize?...
   ```
4. Open the URL in your browser and sign in with the Claude account that has a Pro or Max subscription.
5. After authorizing, the browser will show a code. Paste it back into the terminal when prompted.
6. Tokens are saved to `.oauth-tokens.json` — **do not commit this file** (it is already in `.gitignore`).
7. On all subsequent starts, cached tokens are used and silently refreshed ~5 minutes before expiry. No further interaction is required unless the refresh token is revoked.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Telegram bot token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | No | — | Secret for webhook request verification |
| `TELEGRAM_MODE` | No | `polling` | Transport mode: `polling` or `webhook` |
| `TELEGRAM_WEBHOOK_URL` | When `MODE=webhook` | — | Public HTTPS URL for webhook delivery |
| `TELEGRAM_WEBHOOK_PORT` | No | `8080` | Port for the webhook HTTP listener |
| `LLM_PROVIDER` | Yes | — | `openai` \| `anthropic` \| `groq` \| `github-models` \| `openrouter` \| `claude-oauth` |
| `LLM_MODEL` | No | *(provider default)* | Model identifier (e.g. `gpt-4o`, `claude-3-5-sonnet-20241022`) |
| `OPENAI_API_KEY` | When `provider=openai` | — | OpenAI API key |
| `ANTHROPIC_API_KEY` | When `provider=anthropic` | — | Anthropic API key |
| `GROQ_API_KEY` | When `provider=groq` | — | Groq API key |
| `GITHUB_TOKEN` | When `provider=github-models` | — | GitHub Personal Access Token |
| `OPENROUTER_API_KEY` | When `provider=openrouter` | — | OpenRouter API key |
| `OPENROUTER_REFERER` | No | — | Referer header sent to OpenRouter (optional) |
| `ANTHROPIC_OAUTH_TOKENS_PATH` | No | `.oauth-tokens.json` | Path to the OAuth token cache file |
| `AGENT_MAX_STEPS` | No | `10` | Maximum tool-call steps per agent turn |
| `AGENT_MAX_HISTORY_TOKENS` | No | `8000` | Conversation history token budget |
| `SESSION_TTL_SECONDS` | No | `3600` | Session inactivity timeout in seconds |
| `SESSION_STORE` | No | `memory` | Session backend: `memory` or `redis` |
| `REDIS_URL` | When `SESSION_STORE=redis` | — | Redis connection string |
| `MCP_SERVER_PORT` | No | `3001` | Port for the internal MCP server |
| `LOG_LEVEL` | No | `info` | Log verbosity: `trace`, `debug`, `info`, `warn`, `error` |
| `BOT_OWNER_ID` | **Yes** | — | Your Telegram user ID, platform-prefixed: `tg:123456789` |
| `ALLOWLIST_PATH` | No | `.allowlist.json` | Path to the JSON file that stores granted users |
| `ACCESS_SILENT_REJECT` | No | `true` | `true` = silently drop unauthorized messages; `false` = send a rejection reply |
| `ACCESS_REJECTION_MESSAGE` | No | `Access denied.` | Custom text sent when `ACCESS_SILENT_REJECT=false` |

## Access Control

Self-BOT is a **personal bot**. By default every message from an unknown user is silently dropped. Only two categories of users can interact with the bot:

1. **The owner** — identified by `BOT_OWNER_ID`. Always permitted; cannot be revoked.
2. **Granted users** — any Telegram user the owner has explicitly added via `/grant`.

### How it works

Every incoming message passes through `AccessGuard` before reaching the AI agent:

- If the sender is the owner → permitted.
- If the sender is in the allowlist → permitted.
- Otherwise → dropped (or rejected with a message if `ACCESS_SILENT_REJECT=false`).

If the allowlist store throws an unexpected error, the guard **fails closed** — the message is dropped rather than accidentally permitted.

### Finding your Telegram user ID

Message [@userinfobot](https://t.me/userinfobot) on Telegram. It will reply with your numeric user ID (e.g. `123456789`).

### Configuration

Set `BOT_OWNER_ID` in your `.env` file using the `tg:` prefix:

```env
BOT_OWNER_ID=tg:123456789
```

The value must match the regex `^[a-z]+:.+` — the platform prefix (`tg:`) is required. Startup will fail with a validation error if the format is wrong.

Optional variables:

```env
# Path to the allowlist file (default: .allowlist.json in the working directory)
ALLOWLIST_PATH=.allowlist.json

# Set to "false" to send a rejection reply instead of silently dropping messages
ACCESS_SILENT_REJECT=true

# Custom rejection text (only used when ACCESS_SILENT_REJECT=false)
ACCESS_REJECTION_MESSAGE=Sorry, this bot is private.
```

### The allowlist file

Granted users are persisted in `.allowlist.json` (or the path set by `ALLOWLIST_PATH`). The file is created automatically on the first `/grant` command. Example:

```json
{
  "version": 1,
  "entries": [
    {
      "userId": "tg:987654321",
      "grantedAt": "2026-03-15T10:00:00.000Z",
      "grantedBy": "tg:123456789"
    }
  ]
}
```

Add `.allowlist.json` to your `.gitignore` if you do not want to commit it.

### Runtime management commands

These commands are only available to the owner (`BOT_OWNER_ID`). Send them as regular Telegram messages to the bot.

| Command | Description |
|---------|-------------|
| `/grant tg:<userId>` | Add a user to the allowlist. Idempotent — running it again refreshes the grant timestamp. |
| `/revoke tg:<userId>` | Remove a user from the allowlist. No-op if the user is not listed. |
| `/listusers` | Reply with a numbered list of all currently granted users. |

**Examples:**

```
/grant tg:987654321
→ ✅ Granted access to tg:987654321

/revoke tg:987654321
→ ✅ Revoked access from tg:987654321

/listusers
→ Granted users:
  1. tg:987654321
```

Unrecognised commands (e.g. `/help`) are not consumed by the guard and are forwarded to the AI agent as normal messages.

---

## Usage

### Running the Bot

```bash
# Development mode (watch for file changes)
bun run dev

# Run directly
bun run src/index.ts
```

### Starting the Browser Worker (Optional)

If using browser automation tools, start the browser worker microservice:

```bash
bun run start:browser-worker
```

### Webhook Setup

For production deployment with webhooks, set `TELEGRAM_MODE=webhook` and `TELEGRAM_WEBHOOK_URL` in your `.env`, then register the URL with Telegram:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://your-domain.com/telegram/webhook" \
  -d "secret_token=your_webhook_secret"
```

## Available MCP Tools

The bot includes several built-in MCP tools:

### scrape-website

Scrapes content from web pages using Cheerio.

```typescript
// Tool definition
{
  name: "scrape-website",
  description: "Scrapes content from a website URL",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to scrape" },
      selector: { type: "string", description: "CSS selector (optional)" }
    },
    required: ["url"]
  }
}
```

### fill-form

Fills and submits web forms using Playwright.

```typescript
// Tool definition
{
  name: "fill-form",
  description: "Fills a web form and optionally submits it",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Form page URL" },
      fields: { type: "object", description: "Key-value pairs for form fields" },
      submit: { type: "boolean", description: "Whether to submit the form" }
    },
    required: ["url", "fields"]
  }
}
```

### book-appointment

Books appointments on supported platforms.

```typescript
// Tool definition
{
  name: "book-appointment",
  description: "Books an appointment on a scheduling platform",
  inputSchema: {
    type: "object",
    properties: {
      platform: { type: "string", description: "Platform name" },
      date: { type: "string", description: "ISO date string" },
      time: { type: "string", description: "Time slot" },
      details: { type: "object", description: "Appointment details" }
    },
    required: ["platform", "date"]
  }
}
```

### register-account

Registers a new account on a platform.

```typescript
// Tool definition
{
  name: "register-account",
  description: "Registers a new account on a platform",
  inputSchema: {
    type: "object",
    properties: {
      platform: { type: "string", description: "Platform name" },
      email: { type: "string", description: "Email address" },
      username: { type: "string", description: "Desired username" },
      password: { type: "string", description: "Password" }
    },
    required: ["platform", "email", "password"]
  }
}
```

### login-account

Logs into an existing account.

```typescript
// Tool definition
{
  name: "login-account",
  description: "Logs into an existing account",
  inputSchema: {
    type: "object",
    properties: {
      platform: { type: "string", description: "Platform name" },
      identifier: { type: "string", description: "Email or username" },
      password: { type: "string", description: "Password" }
    },
    required: ["platform", "identifier", "password"]
  }
}
```

## Security Considerations

### Access Control

All messages are gated by `AccessGuard` before reaching the AI agent. Only the owner (`BOT_OWNER_ID`) and explicitly granted users can interact with the bot. The guard fails closed — a store error drops the message rather than granting access. See [Access Control](#access-control) for full details.

### Webhook Verification

When using webhook mode, always set `TELEGRAM_WEBHOOK_SECRET`. The bot validates this token on every incoming request to prevent spoofing attacks.

### Sensitive Data Redaction

All sensitive data is automatically redacted in logs using Pino's redaction feature:

- API keys
- Passwords
- Session tokens
- User PII

### Per-User Rate Limiting

The bot enforces rate limits per user to prevent abuse:

- Configurable concurrent request limit (`QUEUE_PER_USER_CONCURRENCY`)
- Global concurrency cap (`QUEUE_CONCURRENCY`)

### Session Isolation

Each user gets an isolated session context. Session data is:

- Stored separately per user ID
- Can be persisted in Redis with optional encryption
- Automatically cleaned up on user request

### Graceful Shutdown

The bot implements proper shutdown handling:

- In-flight requests are allowed to complete
- New requests are rejected during shutdown
- Session data is saved before exit

### OAuth Token Security

When using `claude-oauth`, the token cache file (`.oauth-tokens.json`) contains sensitive OAuth credentials. It is included in `.gitignore` by default — **never commit it to source control**.

### CAPTCHA Handling

Automatic detection of CAPTCHA challenges with user notification:

- Detects common CAPTCHA patterns
- Alerts user when intervention is needed
- Can pause automation until resolved

## Development Commands

```bash
# Install dependencies
bun install

# Run in development mode (with file watching)
bun run dev

# Run directly (no watch)
bun run src/index.ts

# Run tests (Jest)
npx jest

# Type check (no emit)
npx tsc --noEmit

# Build / type check for production
bun run build

# Start browser worker
bun run start:browser-worker

# Lint code
bun run lint
```

## Project Structure

```
Self-BOT/
├── src/
│   ├── index.ts                 # Entry point
│   ├── config/
│   │   ├── index.ts             # Configuration loader
│   │   └── schema.ts            # Zod validation schema
│   ├── types/
│   │   ├── message.ts           # UnifiedMessage types
│   │   ├── session.ts           # Session types
│   │   ├── tool.ts              # Tool definition types
│   │   └── index.ts             # Type exports
│   ├── access/
│   │   ├── index.ts             # Barrel export
│   │   ├── types.ts             # AllowlistEntry, AccessConfig, IAllowlistStore, makeGuardResponse
│   │   ├── store.ts             # FileAllowlistStore — JSON-file-backed allowlist
│   │   └── guard.ts             # AccessGuard — wraps MessageHandler with access control
│   ├── adapters/
│   │   ├── base.ts              # IAdapter interface
│   │   ├── registry.ts          # Adapter registry
│   │   └── telegram/
│   │       ├── index.ts         # Telegram adapter
│   │       ├── webhook.ts       # Webhook handler
│   │       ├── normalizer.ts    # Message normalization
│   │       └── responder.ts     # Response handler
│   ├── agent/
│   │   ├── index.ts             # Agent orchestrator
│   │   ├── llm.ts               # LLM provider interface
│   │   ├── cot.ts               # Chain-of-thought reasoning
│   │   ├── memory.ts            # Conversation memory
│   │   ├── planner.ts           # Task planning
│   │   └── prompts/
│   │       ├── system.ts        # System prompt
│   │       └── tool-use.ts      # Tool use prompt
│   ├── auth/                    # OAuth 2.0 / PKCE authentication
│   │   ├── index.ts             # Barrel export
│   │   ├── types.ts             # OAuthTokens, PKCEPair, OAuthLoginCallbacks
│   │   ├── pkce.ts              # PKCE S256 challenge generation
│   │   ├── store.ts             # Atomic JSON token persistence
│   │   ├── manager.ts           # OAuthManager lifecycle (load/refresh/login)
│   │   └── providers/
│   │       └── anthropic.ts     # anthropicLogin() + anthropicRefresh()
│   ├── mcp/
│   │   ├── server.ts            # MCP server
│   │   ├── registry.ts          # Tool registry
│   │   ├── client.ts            # MCP client
│   │   └── tools/
│   │       ├── base.ts          # BaseTool class
│   │       ├── scrape-website.ts
│   │       ├── fill-form.ts
│   │       ├── book-appointment.ts
│   │       ├── register-account.ts
│   │       └── login-account.ts
│   ├── browser/
│   │   ├── manager.ts           # Browser manager
│   │   ├── page-helper.ts       # Page utilities
│   │   └── stealth.ts           # Stealth mode config
│   ├── session/
│   │   ├── store.ts             # Session store
│   │   └── manager.ts           # Session manager
│   ├── queue/
│   │   ├── task-queue.ts        # Task queue
│   │   └── worker.ts            # Queue worker
│   └── utils/
│       ├── logger.ts            # Pino logger setup
│       ├── retry.ts             # Retry utilities
│       ├── errors.ts            # Error classes
│       └── html-parser.ts       # HTML parsing utilities
├── browser-worker/
│   └── server.ts                # Playwright HTTP microservice
├── tests/
│   ├── unit/                    # Unit tests
│   └── integration/             # Integration tests
├── .env.example                 # Example environment file
├── jest.config.js               # Jest configuration
├── tsconfig.json                # TypeScript configuration
└── package.json                 # Dependencies
```

## License

MIT License

---

Built with Bun, Grammy, Vercel AI SDK, and Playwright
