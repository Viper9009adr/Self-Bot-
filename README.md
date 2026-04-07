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
- 8 LLM providers: OpenAI, Anthropic, Groq, GitHub Models, OpenRouter, Local (OpenAI-compatible), Claude OAuth, NVIDIA NIM
- Built-in tools: web scraping, form filling, browser automation, image generation, text-to-speech, speech-to-text, PDF text extraction
- Per-user access control with allowlist
- Session persistence: in-memory, Redis, or Meridian
- MCP protocol support (local and remote servers)

## Prerequisites

- **Bun 1.x** — https://bun.sh
- **Node.js 18+** (required for Playwright browser automation)
- A **Telegram bot token** — create one with [@BotFather](https://t.me/BotFather)
- Your **Telegram user ID** (numeric) — use [@userinfobot](https://t.me/userinfobot)
- Either an **API key** for at least one hosted LLM provider, or a **local OpenAI-compatible endpoint**

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

Set `LLM_PROVIDER` to your chosen provider and supply the matching credentials (API key, token, OAuth, or local endpoint).

| Variable | Description | Default |
|---|---|---|
| `LLM_PROVIDER` | `openai` \| `anthropic` \| `groq` \| `github-models` \| `openrouter` \| `local` \| `claude-oauth` \| `nvidia-nim` | `openai` |
| `LLM_MODEL` | Override model name | provider default |
| `OPENAI_API_KEY` | OpenAI API key | — |
| `ANTHROPIC_API_KEY` | Anthropic API key | — |
| `GROQ_API_KEY` | Groq API key | — |
| `GITHUB_TOKEN` | GitHub personal access token (free GitHub Models access) | — |
| `OPENROUTER_API_KEY` | OpenRouter API key | — |
| `OPENROUTER_REFERER` | Your site URL (sent in OpenRouter request headers) | — |
| `NVIDIA_NIM_API_KEY` | NVIDIA NIM API key (starts with `nvapi-`) | — |
| `ANTHROPIC_OAUTH_TOKENS_PATH` | Path to Claude OAuth token cache file | `.oauth-tokens.json` |
| `LOCAL_BASE_URL` | Base URL for local OpenAI-compatible **chat** API (required when `LLM_PROVIDER=local`) | — |
| `LOCAL_API_KEY` | Optional bearer token for local provider auth | — |

#### Local provider (OpenAI-compatible)

Use this mode for Ollama, LM Studio, vLLM proxies, and other OpenAI-compatible servers.

`LOCAL_BASE_URL` is for **chat only**. Media routing is explicit per capability (`LOCAL_IMAGE_URL`, `LOCAL_STT_URL`, `LOCAL_TTS_URL`) and does not implicitly reuse `LOCAL_BASE_URL`.

1. Set `LLM_PROVIDER=local`
2. Set `LOCAL_BASE_URL` (for example: `http://localhost:11434/v1`)
3. Set `LLM_MODEL` to a model served by your local endpoint
4. Set `LOCAL_API_KEY` only if your local gateway requires authentication

> **`/v1` guidance:** startup validation warns if `LOCAL_BASE_URL` does not end with `/v1`. This is a warning (not a hard failure), because some proxy setups use non-standard base paths.

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

#### Meridian Session Store (Offline Mode)

When `SESSION_STORE=meridian`, sessions are persisted to a Meridian MCP server. If the Meridian server becomes unreachable during operation, the session store enters **offline mode**:

- **At startup**: If Meridian is unreachable, the bot starts with an ephemeral in-memory cache only and logs a warning
- **At runtime**: If a connection error occurs during `get()`, `set()`, or `delete()`, the store automatically switches to cache-only mode
- **Recovery**: When the MCP client is not connected, it attempts to reconnect once before falling back to cache-only mode

In offline mode:
- Sessions are still read/written to the local in-memory cache
- No remote persistence occurs until connection is restored
- The `isOnline()` method returns `false` when in offline mode

The bot continues operating normally in offline mode — sessions remain functional within a single process restart, but memory is not persisted to Meridian until connectivity is restored.

#### Session Outcome + Reset Semantics (Memory Fix)

As implemented by IMP in `MeridianSessionStore.get()` and validated by TST, session reset (`get()` returning `null`) only occurs on **canonical terminal outcomes**:

- `not_found`
- `ttl_expired`

All other failure paths are treated as **indeterminate** and throw `Session fetch indeterminate: ...` (transport errors, malformed payloads, unknown outcomes, parse failures). This prevents accidental resets during transient Meridian/MCP failures.

`SessionManager.getOrCreate()` follows this contract: it creates a new session only when the store returns `null`; it does **not** create a replacement session when `store.get()` throws.

#### Meridian fetch_context Compatibility (v1/v2)

The parser is intentionally backward compatible across payload versions:

- **v2 format (preferred):** `{ text, outcome }`
- **v1 format (legacy):** `{ content }` (no explicit `outcome`)

Compatibility rules implemented by IMP:

1. `_extractFirstItem()` supports both array and single-object MCP result shapes.
2. `text` is preferred over `content` when both fields exist.
3. Empty string `text` is treated as a valid v2 field (no falsy fallback to `content`).
4. Unknown/missing outcome on v2 payloads is normalized to non-terminal `malformed`.
5. v1 `content` remains supported as a legacy success path.

For full deterministic matrix details, see `docs/memory-fix-compat.md`.

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
| `ALLOWLIST_STORE` | `file` \| `meridian` | `file` |
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
| `MEDIA_NVIDIA_NIM_IMAGE_MODEL` | NVIDIA NIM image generation model | `stabilityai/stable-diffusion-3-medium` |
| `LOCAL_STT_URL` | Local STT endpoint (explicit media routing) | — |
| `LOCAL_TTS_URL` | Local TTS endpoint (explicit media routing) | — |
| `LOCAL_IMAGE_URL` | Local image endpoint (explicit media routing) | — |

## LLM Providers

| Provider | Set `LLM_PROVIDER` | Free Tier | Notes |
|---|---|---|---|
| OpenAI | `openai` | No | GPT-4o, o1, gpt-image-1 |
| Anthropic | `anthropic` | No | Claude 3.5 Sonnet/Haiku |
| Groq | `groq` | Yes (rate limited) | Llama 3, Gemma |
| GitHub Models | `github` | Yes (requires GitHub account) | GPT-4o, Phi |
| OpenRouter | `openrouter` | Yes (some models) | Multi-model gateway |
| Local (OpenAI-compatible) | `local` | Depends on your local runtime | `LOCAL_BASE_URL` is chat-only; media uses explicit `LOCAL_IMAGE_URL`/`LOCAL_STT_URL`/`LOCAL_TTS_URL` |
| Claude OAuth | `claude-oauth` | Requires Claude Pro subscription | Runs via browser OAuth |
| NVIDIA NIM | `nvidia-nim` | Yes (free-tier models) | `meta/llama-3.1-8b-instruct`, `deepseek-ai/deepseek-v3.2`, `google/gemma-2-9b-it` |

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

> **Current WhatsApp limitation:** outbound audio/voice attachments are not sent by the WhatsApp responder yet. When a response includes audio, the bot sends a text fallback message instead: `🎤 Voice reply is ready, but WhatsApp audio delivery is not yet supported in this build.`

## Media service modes

Media is now capability-based and explicit.

- `LOCAL_BASE_URL` is **chat-only**.
- Media does **not** fall back to `LOCAL_BASE_URL`.

Routing rules (simple):

- **Image**: `LOCAL_IMAGE_URL` → else `OPENAI_API_KEY` → else `NVIDIA_NIM_API_KEY` → else unavailable
- **STT**: `LOCAL_STT_URL` → else `OPENAI_API_KEY` → else unavailable
- **TTS**: `LOCAL_TTS_URL` → else (`OPENAI_API_KEY` + `MEDIA_TTS_ENABLED=true`) → else unavailable

#### Local TTS voice mapping

When `LOCAL_TTS_URL` points to a **Kokoro-FastAPI** instance, OpenAI voice names (set via `MEDIA_TTS_VOICE`) are automatically translated to the closest Kokoro equivalents:

| OpenAI Voice | Kokoro Voice |
|---|---|
| `alloy` | `af_alloy` |
| `echo` | `am_echo` |
| `fable` | `bm_fable` |
| `onyx` | `am_onyx` |
| `nova` | `af_nova` |
| `shimmer` | `af_sky` |

Voice names not in this table are passed through unchanged, so you can use any Kokoro voice name directly (e.g. `af_bella`, `am_michael`). If the mapped or custom voice is not available on your Kokoro-FastAPI instance, the request will fail with a 400 error from the TTS endpoint.

When a capability is missing, the user gets a clear message with exactly what to set:

- `Image capability not configured. Set LOCAL_IMAGE_URL or OPENAI_API_KEY.`
- `STT capability not configured. Set LOCAL_STT_URL or OPENAI_API_KEY.`
- `TTS capability not configured. Set LOCAL_TTS_URL or OPENAI_API_KEY and MEDIA_TTS_ENABLED=true.`

Practical example (Claude chat + local media subset):

```env
LLM_PROVIDER=claude-oauth
LLM_MODEL=claude-sonnet-4-20250514

# Chat stays on Claude OAuth (LOCAL_BASE_URL is not used here)

# Only STT is local in this setup
LOCAL_STT_URL=http://localhost:8001/v1

# Optional: leave these unset to use fallback behavior
# LOCAL_IMAGE_URL=
# LOCAL_TTS_URL=
```

What this does:

- Chat replies use Claude OAuth.
- Audio transcription uses your local STT endpoint.
- Image/TTS use OpenAI fallback only if `OPENAI_API_KEY` is set (and `MEDIA_TTS_ENABLED=true` for TTS).
- If not configured, the bot responds with the clear capability message above.

If local image endpoints return `404` or `501`, image operations degrade as no-ops instead of crashing the bot.

#### LocalAI diffusers (Stable Diffusion) compatibility

`generateImage()` automatically strips `size` and `quality` parameters that the LocalAI diffusers backend does not support. If LocalAI returns a URL instead of `b64_json`, the image is fetched automatically (with protocol validation, content-type check, and a 30-second timeout). Unsupported options are logged at `debug` level.

#### NVIDIA NIM image generation

Self-BOT can use NVIDIA NIM for image generation as a fallback when no local or OpenAI image endpoint is configured. This reuses the same `NVIDIA_NIM_API_KEY` already used for the LLM provider.

**Enable it:**

1. Set `NVIDIA_NIM_API_KEY=nvapi-...` (same key used for `LLM_PROVIDER=nvidia-nim` chat)
2. Optionally set `MEDIA_NVIDIA_NIM_IMAGE_MODEL` to choose a model

**Available models (free tier):**

| Model | Description |
|---|---|
| `stabilityai/stable-diffusion-3-medium` | Default — balanced quality and speed |
| `black-forest-labs/flux-1-schnell` | Fast generation |
| `black-forest-labs/flux-1-dev` | Higher quality, slower |

**NIM-specific image generation parameters:**

These can be passed via `ImageGenOptions` when calling the image generation API:

| Parameter | Type | Description |
|---|---|---|
| `cfg_scale` | number | Guidance scale (1–20, default 5) — higher values follow the prompt more strictly |
| `aspect_ratio` | string | Output aspect ratio (e.g. `"16:9"`, `"1:1"`, `"9:16"`) |
| `seed` | number | Random seed (0 = random) — use for reproducible results |
| `steps` | number | Number of denoising steps (default 50) — more steps = higher quality but slower |
| `negative_prompt` | string | Description of what to avoid in the generated image |

**Limitations:**

- **No image editing** — `editImage` throws an error; NIM does not support image-to-image editing
- **No image variations** — `variateImage` throws an error; NIM does not support generating variations from an existing image
- **STT and TTS not available** — the NIM media service only handles image generation; speech capabilities fall back to OpenAI or local endpoints

**Capability routing priority:**

Image generation routes in this order: `local` → `openai` → `nvidia-nim` → `unavailable`. NVIDIA NIM is used only when neither `LOCAL_IMAGE_URL` nor `OPENAI_API_KEY` is set.

## MCP Tools

Self-BOT exposes several built-in MCP tools for AI-assisted tasks.

### read_pdf

Extract text from a PDF file and convert it to speech delivered as a voice message.

**Tool Name:** `read_pdf`

**Description:** Reads a base64-encoded PDF, extracts its text content, and optionally synthesizes the text into audio via TTS. The extracted text is sanitized against prompt injection attacks before processing.

**Input Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pdfBase64` | string | Yes | Base64-encoded PDF file content |
| `maxPages` | number | No | Maximum number of pages to extract (default: all pages) |

**File Size Limits:**
- Minimum: 2MB
- Maximum: 100MB

**Security Features (Prompt Injection Guards):**

The tool sanitizes extracted text by removing the following patterns before processing:

1. `ignore previous instructions` / `ignore all prior instructions`
2. `system:` (any system prompt prefix)
3. `you are a` / `you are` (role assignment patterns)
4. `[SYSTEM]` (bracket-tagged system messages)
5. `<system>` (XML-tagged system messages)

This prevents malicious PDF content from instructing the AI to perform unauthorized actions.

**Error Cases:**

| Error | Cause |
|---|---|
| `PDF file too small` | File is below 2MB minimum |
| `PDF file too large` | File exceeds 100MB maximum |
| `Invalid base64 PDF data` | Malformed base64 encoding |
| `PDF is password-protected` | Encrypted/password-locked PDF |
| `PDF file is corrupt or invalid` | Malformed or damaged PDF |
| `No text could be extracted` | PDF contains no extractable text (scanned images, empty) |

**Response Format (Success with TTS):**

```json
{
  "success": true,
  "data": {
    "pageCount": 10,
    "textLength": 5000,
    "chunkCount": 2,
    "mimeType": "audio/mp3",
    "audioDelivered": true
  }
}
```

**Response Format (TTS Unavailable):**

```json
{
  "success": true,
  "data": {
    "text": "Extracted text content...",
    "pageCount": 10,
    "textLength": 5000,
    "ttsUnavailable": true
  },
  "error": "TTS capability not configured..."
}
```

**Usage Example:**

When the AI assistant receives a PDF attachment, it automatically uses the `read_pdf` tool to:
1. Validate the file size (2MB - 100MB)
2. Extract text from the PDF using pdf-parse
3. Sanitize the text against prompt injection
4. Split text into 3500-character chunks for TTS
5. Synthesize each chunk into audio
6. Deliver the combined audio as a voice message

If TTS is not configured, the tool returns the extracted text directly.

> **Type maintenance note (CRT):** `pdf-parse` does not ship complete typings for this project’s usage. We maintain a local shim at `src/types/pdf-parse.d.ts`. When upgrading `pdf-parse`, update that shim in the same PR if the runtime API shape changes.

## Validation status

Latest validated state for **Self-BOT-Providers**:

- Tests: **143/143 passing**
- TypeScript typecheck: **passing**
- Capability routing/error contract and matrix tests: **covered**

### Web Dashboard

1. Set `WEB_ENABLED=true`
2. Set `WEB_OWNER_USERNAME`, `WEB_OWNER_PASSWORD`, and `GATEWAY_JWT_SECRET`
3. Run `bun run dev`
4. Open `http://localhost:3000` and log in

## Access Control

The bot owner (set via `BOT_OWNER_ID`) has full access automatically.

> **Tip:** Commands sent while the bot is offline (e.g. during a restart) are queued by Telegram and processed automatically when the bot reconnects. You do not need to resend them.

To grant or revoke access for other users, send these commands to the bot:

```
/grant tg:123456789      # grant a Telegram user
/grant wa:15551234567    # grant a WhatsApp user
/revoke tg:123456789     # revoke a Telegram user
```

`userId` must match the schema `^[a-z]+:.+` — a lowercase platform prefix (`tg`, `wa`, `web`) followed by a colon and the user identifier.

Access decisions are stored in `.allowlist.json` (configurable via `ALLOWLIST_PATH`).

When `ALLOWLIST_STORE=meridian`, set `MERIDIAN_MCP_URL` to the full SSE endpoint of your Meridian server (e.g. `http://localhost:8080/sse`). The URL **must** end in `/sse` — the client uses this suffix to select the SSE transport. A URL without `/sse` will use Streamable HTTP and fail to connect to Meridian's FastMCP backend.

Set `ACCESS_SILENT_REJECT=false` to send a rejection message to unauthorized users instead of silently ignoring them.

`BOT_OWNER_ID` accepts any platform-prefixed user ID:

| Prefix | Platform | Example |
|---|---|---|
| `tg:` | Telegram | `tg:123456789` |
| `wa:` | WhatsApp | `wa:15551234567` |
| `web:` | Web dashboard | `web:admin` |

### Allowlist usage examples

**Finding your userId**

- **Telegram**: message [@userinfobot](https://t.me/userinfobot) — it replies with your numeric ID. Prefix it with `tg:` → `tg:123456789`.
- **WhatsApp**: your userId is logged at bot startup (search for `waOwner` in the log). It is your number in international format, digits only, no `+` → `wa:15551234567`.
- **Web dashboard**: the userId is `web:<username>` matching `WEB_OWNER_USERNAME`.

**File store (default) — `.allowlist.json` structure**

The file store writes and reads a JSON file at `ALLOWLIST_PATH` (default `.allowlist.json`):

```json
{
  "entries": [
    {
      "userId": "tg:123456789",
      "grantedAt": "2026-01-01T00:00:00.000Z",
      "grantedBy": "tg:111111111"
    }
  ]
}
```

**Meridian store — `.env` configuration**

```env
ALLOWLIST_STORE=meridian
MERIDIAN_MCP_URL=http://localhost:8080/sse
```

The URL **must** end in `/sse`. The `MeridianAllowlistStore` (implemented by IMP) persists the allowlist via `store_context`/`fetch_context` on the Meridian MCP server under task `self-bot-allowlist`, agent `AUTH`. If the Meridian server is unreachable at startup, the bot starts with an empty allowlist (owner still has full access) and logs a warning — it does not crash.

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
