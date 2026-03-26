# Self-BOT

> Self-hosted personal AI assistant for Telegram, WhatsApp, and the web.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)

## What is Self-BOT

Self-BOT is a self-hosted personal AI assistant that runs on Telegram, WhatsApp, and a browser-based web dashboard — all from a single process. It is designed for personal use: only you (and users you explicitly allow) can interact with it. The bot connects to your choice of LLM provider and exposes a set of built-in tools for web scraping, browser automation, image generation, text-to-speech, and speech-to-text. Sessions persist across restarts via in-memory, Redis, or Meridian storage. The MCP protocol is supported for both local and remote tool servers, making the assistant fully extensible.

## Features

- Telegram bot (polling or webhook)
- WhatsApp bot (via whatsapp-web.js)
- Web dashboard (React SPA + REST API)
- 6 LLM providers: OpenAI, Anthropic, Groq, GitHub Models, OpenRouter, Claude OAuth
- Built-in tools: web scraping, form filling, browser automation, image generation, text-to-speech, speech-to-text
- Per-user access control with allowlist
- Session persistence: in-memory, Redis, or Meridian
- MCP protocol support (local and remote servers)

## Prerequisites

- **Bun 1.x** — https://bun.sh
- **Node.js 18+** (required for Playwright browser automation)
- A **Telegram bot token** — create one with [@BotFather](https://t.me/BotFather)
- Your **Telegram user ID** (numeric) — use [@userinfobot](https://t.me/userinfobot)
- An **API key** for at least one LLM provider (or a free GitHub account for GitHub Models)

## Quick Start

```bash
git clone https://github.com/Viper9009adr/Self-Bot-
cd Self-Bot-
bun install
cp .env.example .env
# Edit .env with your credentials
bun run dev
```

## Configuration

Copy `.env.example` to `.env` and fill in the values. All variables are documented below.

### Required

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `BOT_OWNER_ID` | Your Telegram user ID with platform prefix (e.g. `tg:123456789`) |

### LLM Provider

Set `LLM_PROVIDER` to your chosen provider and supply the matching API key.

| Variable | Description | Default |
|---|---|---|
| `LLM_PROVIDER` | `openai` \| `anthropic` \| `groq` \| `github` \| `openrouter` \| `claude-oauth` | `openai` |
| `LLM_MODEL` | Override model name | provider default |
| `OPENAI_API_KEY` | OpenAI API key | — |
| `ANTHROPIC_API_KEY` | Anthropic API key | — |
| `GROQ_API_KEY` | Groq API key | — |
| `GITHUB_TOKEN` | GitHub personal access token (free GitHub Models access) | — |
| `OPENROUTER_API_KEY` | OpenRouter API key | — |
| `OPENROUTER_REFERER` | Your site URL (sent in OpenRouter request headers) | — |
| `ANTHROPIC_OAUTH_TOKENS_PATH` | Path to Claude OAuth token cache file | `.oauth-tokens.json` |

### Web Dashboard

Enable with `WEB_ENABLED=true`. Use a strong password.

| Variable | Description | Default |
|---|---|---|
| `WEB_ENABLED` | Enable the web dashboard | `false` |
| `WEB_OWNER_USERNAME` | Dashboard login username | — |
| `WEB_OWNER_PASSWORD` | Dashboard login password | — |
| `WEB_PORT` | HTTP port | `3000` |
| `WEB_HOST` | Bind address | `0.0.0.0` |
| `GATEWAY_JWT_SECRET` | JWT signing secret — generate with `openssl rand -base64 32` | — |

### WhatsApp

Enable with `WA_ENABLED=true`. Requires a phone with WhatsApp.

| Variable | Description | Default |
|---|---|---|
| `WA_ENABLED` | Enable the WhatsApp adapter | `false` |
| `WA_OWNER_NUMBER` | Your WhatsApp number with country code, digits only (e.g. `15551234567`) | — |
| `WA_SESSION_PATH` | Directory for WhatsApp browser session | `.whatsapp-session` |
| `WA_DOCUMENT_MAX_BYTES` | Max document upload size in bytes | `10485760` (10 MB) |

### Session Persistence

| Variable | Description | Default |
|---|---|---|
| `SESSION_STORE` | `memory` \| `redis` \| `meridian` | `memory` |
| `SESSION_TTL_SECONDS` | Session idle timeout | `3600` |
| `REDIS_URL` | Redis connection URL (when `SESSION_STORE=redis`) | `redis://localhost:6379` |
| `MERIDIAN_SESSION_URL` | Meridian MCP server URL (when `SESSION_STORE=meridian`) | — |
| `MERIDIAN_MCP_URL` | Meridian semantic context MCP URL | — |

### Tuning and Optional

| Variable | Description | Default |
|---|---|---|
| `NODE_ENV` | `development` \| `production` | `development` |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` | `info` |
| `TELEGRAM_MODE` | `polling` \| `webhook` | `polling` |
| `TELEGRAM_WEBHOOK_URL` | Public HTTPS URL for webhook mode | — |
| `TELEGRAM_WEBHOOK_SECRET` | Secret token for webhook verification | — |
| `TELEGRAM_WEBHOOK_PORT` | Webhook server port | `8080` |
| `AGENT_MAX_STEPS` | Max AI reasoning steps per message | `10` |
| `AGENT_MAX_HISTORY_TOKENS` | Conversation history token limit | `8000` |
| `AGENT_SYSTEM_PROMPT_EXTRA` | Extra instructions appended to the system prompt | — |
| `PROGRESS_REPORTER_PERSIST_HISTORY` | Include progress messages in conversation history | `false` |
| `QUEUE_CONCURRENCY` | Global concurrent message processing limit | `4` |
| `QUEUE_PER_USER_CONCURRENCY` | Per-user concurrent processing limit | `2` |
| `ACCESS_SILENT_REJECT` | Silently ignore messages from non-allowlisted users | `true` |
| `ACCESS_REJECTION_MESSAGE` | Custom rejection message (if silent reject is off) | — |
| `ALLOWLIST_PATH` | Path to the allowlist JSON file | `.allowlist.json` |
| `ALLOWLIST_STORE` | `file` \| `memory` | `file` |
| `MCP_SERVER_PORT` | Built-in MCP server port | `3001` |
| `MCP_SERVER_HOST` | Built-in MCP server bind address | `127.0.0.1` |
| `MCP_REMOTE_SERVERS` | JSON array of remote MCP server configurations | — |
| `BROWSER_WORKER_URL` | Browser automation worker URL | `http://localhost:3002` |
| `BROWSER_WORKER_TIMEOUT_MS` | Browser worker request timeout | `30000` |
| `MEDIA_TTS_ENABLED` | Enable text-to-speech responses | `true` |
| `MEDIA_TTS_MODEL` | TTS model | `tts-1` |
| `MEDIA_TTS_VOICE` | TTS voice | `alloy` |
| `MEDIA_STT_MODEL` | Speech-to-text model | `whisper-1` |
| `MEDIA_IMAGE_MODEL` | Image generation model | `gpt-image-1` |
| `MEDIA_IMAGE_SIZE` | Image output size | `1024x1024` |
| `MEDIA_IMAGE_QUALITY` | Image quality | `standard` |

## LLM Providers

| Provider | Set `LLM_PROVIDER` | Free Tier | Notes |
|---|---|---|---|
| OpenAI | `openai` | No | GPT-4o, o1, gpt-image-1 |
| Anthropic | `anthropic` | No | Claude 3.5 Sonnet/Haiku |
| Groq | `groq` | Yes (rate limited) | Llama 3, Gemma |
| GitHub Models | `github` | Yes (requires GitHub account) | GPT-4o, Phi |
| OpenRouter | `openrouter` | Yes (some models) | Multi-model gateway |
| Claude OAuth | `claude-oauth` | Requires Claude Pro subscription | Runs via browser OAuth |

## Running

```bash
bun run dev      # development mode with hot reload
bun run start    # production mode
bun test         # run tests (uses Bun's native test runner directly)
```

> **Note:** `bun test` invokes Bun's built-in test runner directly — it does **not** use `bun run test` (the `test` script in `package.json` is a Node/tsx fallback for non-Bun environments). Always use `bun test` to run the test suite.

> **Note:** `bun.lock` is intentionally excluded from version control. Run `bun install` to regenerate it after cloning.

## Platform Setup

### Telegram

By default the bot runs in **polling** mode — no server setup required.

For **webhook** mode:
1. Set `TELEGRAM_MODE=webhook`
2. Set `TELEGRAM_WEBHOOK_URL=https://your-domain.com/telegram/webhook`
3. Optionally set `TELEGRAM_WEBHOOK_SECRET` for request verification

### WhatsApp

1. Set `WA_ENABLED=true` and `WA_OWNER_NUMBER=15551234567`
2. Run `bun run dev` — a QR code will appear in the terminal
3. Scan it with WhatsApp on your phone

> **⚠️ WhatsApp Disclaimer:** This project uses [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js), which connects to WhatsApp Web via an unofficial API. This may violate WhatsApp's Terms of Service. Use at your own risk. The authors assume no liability for account bans or service interruptions.

### Web Dashboard

1. Set `WEB_ENABLED=true`
2. Set `WEB_OWNER_USERNAME`, `WEB_OWNER_PASSWORD`, and `GATEWAY_JWT_SECRET`
3. Run `bun run dev`
4. Open `http://localhost:3000` and log in

## Access Control

The bot owner (set via `BOT_OWNER_ID`) has full access automatically.

To grant or revoke access for other users, send these commands to the bot:

```
/allow @username    # grant access
/deny @username     # revoke access
```

Access decisions are stored in `.allowlist.json` (configurable via `ALLOWLIST_PATH`).

Set `ACCESS_SILENT_REJECT=false` to send a rejection message to unauthorized users instead of silently ignoring them.

`BOT_OWNER_ID` accepts any platform-prefixed user ID:

| Prefix | Platform | Example |
|---|---|---|
| `tg:` | Telegram | `tg:123456789` |
| `wa:` | WhatsApp | `wa:15551234567` |
| `web:` | Web dashboard | `web:admin` |

## Project Structure

```
Self-Bot-/
├── src/
│   ├── adapters/          # Telegram, WhatsApp, Web adapters
│   ├── agent/             # AI agent core (Vercel AI SDK)
│   ├── config/            # Zod-validated configuration
│   ├── context/           # Context injection and retrieval
│   ├── mcp/               # MCP client and built-in tools
│   ├── media/             # Image generation, TTS, STT
│   ├── memory/            # Retrieval router
│   ├── meridian/          # Semantic context adapter (Meridian)
│   ├── session/           # Session store (memory/Redis/Meridian)
│   └── types/             # Shared TypeScript types
├── web/                   # React web dashboard (Vite + React)
├── browser-worker/        # Headless browser worker server
├── tests/                 # Test suite
├── .env.example           # Environment variable template
└── Meridian/              # Optional: Python semantic memory server
```

## License

MIT License © 2026 Viper9009adr

See [LICENSE](./LICENSE) for full terms.
