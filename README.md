# Self-BOT

> Self-hosted personal AI assistant for Telegram, WhatsApp, and the web.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)

## What is Self-BOT?

Self-BOT is a self-hosted personal AI assistant that runs on **Telegram**, **WhatsApp**, and a **web dashboard** — all from a single process. It connects to your choice of LLM provider (OpenAI, Anthropic, Groq, GitHub Models, OpenRouter, NVIDIA NIM, Claude OAuth, or local) and comes with built-in tools for web scraping, browser automation, image generation, text-to-speech, speech-to-text, PDF extraction, and terminal command orchestration.

Only you (and users you explicitly allow) can interact with it. Sessions persist across restarts via in-memory, Redis, or Meridian storage.

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/Viper9009adr/Self-BOT.git
cd Self-BOT
bun install

# 2. Configure
cp .env.example .env
# Edit .env — at minimum set TELEGRAM_BOT_TOKEN and BOT_OWNER_ID

# 3. Run
bun run dev       # development (hot reload)
bun run start     # production
```

That's it. The bot connects to Telegram in polling mode by default — no server setup needed.

---

## What You Need Before Running

| Requirement | Where to Get It |
|---|---|
| **Bun 1.x** | [bun.sh](https://bun.sh) |
| **Telegram Bot Token** | [@BotFather](https://t.me/BotFather) |
| **Your Telegram User ID** | [@userinfobot](https://t.me/userinfobot) — prefix with `tg:` (e.g. `tg:123456789`) |
| **LLM API Key** | At least one of: OpenAI, Anthropic, Groq, GitHub token, OpenRouter, or NVIDIA NIM |

---

## Platforms

| Platform | Setup | Notes |
|---|---|---|
| **Telegram** | Set `TELEGRAM_BOT_TOKEN` + `BOT_OWNER_ID=tg:...` | Default mode: polling (no server needed) |
| **WhatsApp** | Set `WA_ENABLED=true` + `WA_OWNER_NUMBER` | Scan QR code on first run. Text only — audio/voice outbound not yet supported. |
| **Web Dashboard** | Set `WEB_ENABLED=true` + owner username/password | Access at `http://localhost:3000` |

### Finding Your User IDs

- **Telegram**: Message [@userinfobot](https://t.me/userinfobot) → it replies with your numeric ID. Prefix with `tg:` → `tg:123456789`
- **WhatsApp**: Your number in international format, digits only, no `+`. Prefix with `wa:` → `wa:15551234567`
- **Web**: Your username from `WEB_OWNER_USERNAME`. Prefix with `web:` → `web:admin`

---

## LLM Providers

Set `LLM_PROVIDER` to your chosen provider. Each provider has its own env vars — see `.env.example` for the full list.

| Provider | `LLM_PROVIDER` Value | Free Tier | Credential |
|---|---|---|---|
| OpenAI | `openai` | No | `OPENAI_API_KEY` |
| Anthropic | `anthropic` | No | `ANTHROPIC_API_KEY` |
| Groq | `groq` | Yes (rate limited) | `GROQ_API_KEY` |
| GitHub Models | `github-models` | Yes | `GITHUB_TOKEN` (PAT with no scopes) |
| OpenRouter | `openrouter` | Yes (some models) | `OPENROUTER_API_KEY` |
| NVIDIA NIM | `nvidia-nim` | Yes | `NVIDIA_NIM_API_KEY` |
| Claude OAuth | `claude-oauth` | Claude Pro/Max subscription | Browser OAuth on first run |
| Local (Ollama, LM Studio, etc.) | `local` | Depends on your runtime | `LOCAL_BASE_URL` |

---

## Built-in Tools

The AI assistant can use these tools out of the box:

| Tool | What It Does |
|---|---|
| **Web Scraping** | Fetch and extract content from any URL |
| **Form Filling** | Automate filling and submission of web forms |
| **Browser Automation** | Full headless browser control (Playwright) |
| **Image Generation** | Generate images from text prompts (OpenAI DALL-E / gpt-image-1 / NVIDIA NIM) |
| **Text-to-Speech** | Convert text responses to voice messages |
| **Speech-to-Text** | Transcribe voice messages and audio files |
| **PDF Reader** | Extract text from PDF attachments with base64 normalization (data URI + whitespace), decoded-byte validation (1KB-100MB), PK/ZIP non-PDF classification, BOM/preamble-tolerant `%PDF` detection (first 1KB), and prompt injection protection |
| **Terminal Sessions** | Run CLI tools (OpenCode, git, etc.) with skill definitions, security gates, and output capture |

---

## Access Control

By default, **only the bot owner** (`BOT_OWNER_ID`) can use the bot.

To grant or revoke access, send these commands to the bot:

```
/grant tg:123456789      # Grant access to a Telegram user
/grant wa:15551234567    # Grant access to a WhatsApp user
/revoke tg:123456789     # Revoke access
```

Access decisions are stored in `.allowlist.json` by default. See the configuration section below for Meridian-backed allowlist storage.

---

## Configuration

All configuration is done via `.env`. Copy `.env.example` to get started.

### Required Variables

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
BOT_OWNER_ID=tg:123456789
```

### LLM Provider

```env
LLM_PROVIDER=openai          # Choose your provider
OPENAI_API_KEY=sk-...        # Set the matching credential
```

### Web Dashboard

```env
WEB_ENABLED=true
WEB_OWNER_USERNAME=admin
WEB_OWNER_PASSWORD=your_secure_password_here
GATEWAY_JWT_SECRET=<generate with: openssl rand -base64 32>
```

### WhatsApp

```env
WA_ENABLED=true
WA_OWNER_NUMBER=15551234567   # International format, no +
```

### Session Storage

| Store | `SESSION_STORE` | Description |
|---|---|---|
| In-memory | `memory` (default) | Fast, ephemeral — lost on restart |
| Redis | `redis` | Persistent, requires `REDIS_URL` |
| Meridian | `meridian` | Persistent via MCP server, requires `MERIDIAN_SESSION_URL` |

For Redis, sessions use TTL expiration by default (`SESSION_TTL_SECONDS`). Set `REDIS_DISABLE_TTL=true` to keep Redis sessions without expiration.

---

## Running

```bash
bun run dev       # Development mode with hot reload
bun run start     # Production mode
bun test          # Run test suite
bun run typecheck # TypeScript type check
```

---

## FAQ

**Q: Do I need a server to run the Telegram bot?**
A: No. By default it uses polling mode — the bot actively fetches updates from Telegram's servers. Just run `bun run dev` and it works.

**Q: Can I use this with a free LLM?**
A: Yes. GitHub Models (`LLM_PROVIDER=github-models`) gives free GPT-4o access with a GitHub token. OpenRouter also has free-tier models. NVIDIA NIM offers free models too.

**Q: How do I add new tools or skills?**
A: Two options:
- **Terminal Skills**: Create a `.md` file in `./terminal-skills/` with YAML frontmatter defining the command, args, and security constraints.
- **MCP Tools**: Connect remote MCP servers via `MCP_REMOTE_SERVERS` env var — tools are auto-discovered at startup.

**Q: Is my data private?**
A: Yes. Everything runs on your machine. No data is sent to any service except the LLM provider you configure and the platform APIs (Telegram/WhatsApp). The allowlist ensures only authorized users can interact with the bot.

**Q: What happens when the bot restarts?**
A: With `SESSION_STORE=memory`, conversations reset. With `redis` or `meridian`, sessions persist across restarts.

**Q: Can I run this on a VPS?**
A: Yes. For production, use webhook mode for Telegram (`TELEGRAM_MODE=webhook`) with a reverse proxy (nginx/Caddy). Set `NODE_ENV=production`.

**Q: WhatsApp audio not working?**
A: Outbound audio/voice delivery is not yet implemented in the WhatsApp adapter. Text and inbound voice work fine.

**Q: What if I send the bot a message while it's offline?**
A: Telegram queues messages while the bot is offline and delivers them when it reconnects. No need to resend.

---

## Project Structure

```
Self-BOT/
├── src/                          # Core application source
│   ├── adapters/                 # Platform adapters (Telegram, WhatsApp, Web)
│   ├── agent/                    # AI agent core (Vercel AI SDK)
│   ├── config/                   # Zod-validated environment configuration
│   ├── mcp/                      # MCP client, tools, and bridge logic
│   ├── media/                    # Image generation, TTS, STT services
│   ├── session/                  # Session store (memory/Redis/Meridian)
│   ├── terminal/                 # Terminal skills engine (loader, executor, manager)
│   ├── types/                    # Shared TypeScript type definitions
│   └── index.ts                  # Application entry point
├── web/                          # React web dashboard (Vite)
├── browser-worker/               # Headless browser worker server
├── terminal-skills/              # Skill definition files (.md with YAML frontmatter)
├── tests/                        # Test suite (Bun native test runner)
├── docs/                         # Project documentation
├── backend/                      # Backend runtime scaffold (migration track)
├── .docker/                      # Docker compose and model configurations
├── .opencode/                    # OpenCode CLI tool configuration (user-local)
├── .implementations/             # Archived development session logs
├── .env.example                  # Environment variable template
├── package.json                  # Dependencies and scripts
├── tsconfig.json                 # TypeScript configuration
└── .gitignore                    # Git ignore rules
```

---

## WhatsApp Disclaimer

This project uses [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js), which connects to WhatsApp Web via an unofficial API. This may violate WhatsApp's Terms of Service. Use at your own risk. The authors assume no liability for account bans or service interruptions.

---

## License

MIT License © 2026 Viper9009adr

See [LICENSE](./LICENSE) for full terms.
