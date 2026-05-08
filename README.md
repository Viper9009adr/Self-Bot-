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
| Google | `google` | Yes (Gemini) | `GOOGLE_API_KEY` |
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
| **Image Generation** | Generate images from text prompts (OpenAI DALL-E / Google Imagen 3 / NVIDIA NIM) |
| **Text-to-Speech** | Convert text responses to voice messages |
| **Speech-to-Text** | Transcribe voice messages and audio files |
| **PDF Reader** | Extract text from PDF attachments with base64 normalization (data URI + whitespace), decoded-byte validation (1KB-100MB), PK/ZIP non-PDF classification, BOM/preamble-tolerant `%PDF` detection (first 1KB), and prompt injection protection |
| **Terminal Sessions** | Run CLI tools (OpenCode, git, etc.) with skill definitions, security gates, and output capture |

### OpenCode background outcome reporting (Telegram)

- `opencode` runs are started in background mode and acknowledged immediately.
- A polling loop then posts exactly one follow-up outcome message:
  - **Success (`exitCode=0`)**: completed with stdout (or “No output.”).
  - **Failure (`exitCode!=0`)**: failed with exit code plus stderr/stdout fallback text.
  - **Polling failure (`poll_err`)**: user sees `⚠️ OpenCode result polling failed: ...`.
- Poll callback errors are caught and logged so callback rejections do not crash the poll loop.

Tests covering this behavior:
- `tests/integration/opencode-tool-outcome.test.ts` validates timeout→`poll_err`, completed output→`tool_outcome`, and swallowed callback rejection.
- `tests/unit/opencode-poll-err.test.ts` validates user-facing `poll_err` formatting.

### Interactive terminal authorization flow (Telegram/OpenCode)

When OpenCode requests confirmation during a running terminal session, Telegram messages can control that session using `terminal_session[...]` syntax.

- **Send approve/deny responses**:
  - `terminal_session[approve] <sessionId>`
  - `terminal_session[deny] <sessionId>`
- **Send free-form input**:
  - `terminal_session[input] <sessionId> <text>`

To retrieve captured output for a known session ID, call the `terminal_session` tool with `action: "output"` and that `sessionId`.

Safety constraints implemented by IMP:
- **Session binding gate**: approve/deny/input messages are accepted only from the same Telegram user that started the session. Otherwise the bot replies: `⚠️ Session not found or not owned by you.`
- **Start-time gates**: OpenCode start requests are validated before launch (skill prefix parsing, command allowlist checks, executable presence checks, and CWD validation). CWD failures are surfaced as `INVALID_CWD: ...`.
- **Duplicate-message guard**: bridge dispatch deduplicates by Telegram message ID to avoid accidental double execution.

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
LLM_PROVIDER=openai          # Choose your provider (openai, anthropic, groq, github-models, openrouter, nvidia-nim, google, local)
OPENAI_API_KEY=sk-...        # Set the matching credential
GOOGLE_API_KEY=AIza...       # Required for google provider
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

## Running with Docker

```bash
docker-compose up -d
```

The docker-compose configuration includes healthchecks for all services (Redis, browser-worker, and bot) that respect runtime environment variables.

### Healthcheck Port Configuration

The bot service healthcheck uses `$${HEALTHCHECK_PORT:-8080}` for runtime environment variable expansion:

```yaml
healthcheck:
  test: ["CMD", "sh", "-c", "curl -f http://localhost:$${HEALTHCHECK_PORT:-8080}/health || curl -f http://localhost:8080/health"]
```

**Why double dollar sign (`$$`)?** Docker Compose performs variable substitution at compose-time (when `docker-compose up` runs). Using `$$` escapes to a literal `$`, which allows `${HEALTHCHECK_PORT:-8080}` to be passed through to the container where it is evaluated at runtime.

- If `HEALTHCHECK_PORT` is set in the environment, the healthcheck uses that port
- Otherwise, it defaults to 8080
- The `|| curl -f http://localhost:8080/health` provides a fallback in case the first URL fails

### Port Split: API vs Health

| Port Mapping | Purpose |
|---|---|
| `8081:8080` | External:Internal — API serves on 8080 inside container, exposed as 8081 |
| `HEALTHCHECK_PORT` | Controls the health endpoint port (independent of API port) |

This allows splitting the healthcheck port from the main API port, enabling separate firewall rules or load balancer health probes.

### Local Development

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
A: Yes. GitHub Models (`LLM_PROVIDER=github-models`) gives free GPT-4o access with a GitHub token. Google Gemini (`LLM_PROVIDER=google`) also offers a generous free tier. OpenRouter and NVIDIA NIM offer free models too.

**Q: How do I add new tools or skills?**
A: Two options:
- **Terminal Skills**: Create a `.md` file in `./terminal-skills/` with YAML frontmatter defining the command, args, and security constraints.
- **MCP Tools**: Connect remote MCP servers via `MCP_REMOTE_SERVERS` env var — tools are auto-discovered at startup.

### Declarative Skill Transformations

Terminal skills support declarative transformations that replace hardcoded command-specific logic. This allows skill authors to define how arguments should be transformed without writing custom code.

#### Available Fields

| Field | Type | Description |
|-------|------|-------------|
| `subcommand` | string | Subcommand to inject at the beginning of args (e.g., `"run"`) |
| `approveFlag` | string | Maps `--approve` user argument to a custom flag (e.g., `"--dangerously-skip-permissions"`) |
| `transformations` | array | Declarative transformation rules for arguments |

#### Transformation Types

| Type | Description |
|------|-------------|
| `prepend` | Prepend a value to args when a flag is found and optionally matches a value |
| `append` | Append a value to args after a flag is found |
| `remove-flag` | Remove a flag and optionally its value from args |
| `convert-flag` | Convert one flag to another (requires `targetFlag`) |
| `positional` | Convert a flag to a positional argument (moves value to end) |

#### Example: OpenCode Skill

```yaml
---
name: opencode
description: AI coding assistant
command: opencode
args: []
subcommand: run
approveFlag: --dangerously-skip-permissions
transformations:
  - type: positional
    flag: --prompt
arguments:
  - name: prompt
    type: string
    required: true
    description: Task prompt
  - name: approve
    type: boolean
    required: false
    default: true
    description: Auto-approve file permission changes
cwd: /home
timeout: 30000
---
```

This configuration:
1. Injects `run` subcommand at the beginning
2. Maps `--approve=true` to `--dangerously-skip-permissions`
3. Converts `--prompt <value>` to a positional argument

#### Backward Compatibility

Existing skills without `subcommand`, `approveFlag`, or `transformations` fields continue to work unchanged. The transformation logic only applies when at least one of these fields is defined.

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
