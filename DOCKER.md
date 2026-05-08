# Self-BOT Docker Setup

> Self-hosted personal AI assistant running in containerized environments.

Self-BOT supports full Docker deployment with three services: the main bot, a dedicated browser worker for Playwright automation, and Redis for session persistence. This guide covers containerized deployment, configuration, and production considerations.

---

## Overview

The Docker setup provides:

- **Multi-stage builds** — Optimized image sizes with separate build and runtime stages
- **Service orchestration** — Three-container stack managed via Docker Compose
- **Health monitoring** — Built-in health checks for all services
- **Session persistence** — Redis-backed session storage with data persistence
- **Browser automation** — Dedicated container for headless Playwright workloads

---

## Services

| Service | Image | Port | Purpose |
|---|---|---|---|
| **bot** | Built from `Dockerfile` | 8080 | Main application (Telegram/WhatsApp/Web adapters, AI agent, tools) |
| **browser-worker** | Built from `browser-worker/Dockerfile` | 3002 | Headless browser automation server |
| **redis** | `redis:alpine` | 6379 | Session store backend |

### Service Dependencies

```
bot → redis (healthy) + browser-worker (healthy)
browser-worker → redis (healthy)
redis → (standalone)
```

The bot service waits for both Redis and browser-worker to become healthy before starting.

---

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (v20.10+)
- [Docker Compose](https://docs.docker.com/compose/install/) (v2.0+)

### Build and Run

```bash
# Clone and configure
git clone https://github.com/Viper9009adr/Self-BOT.git
cd Self-BOT

# Create environment file
cp .env.example .env
# Edit .env — set at minimum:
#   TELEGRAM_BOT_TOKEN=your_bot_token
#   BOT_OWNER_ID=tg:123456789

# Start all services
docker compose up -d --build
```

### Verify Status

```bash
docker compose ps
# NAME            IMAGE       COMMAND           SERVICE    CREATED   STATUS
# self-bot-bot-1  self-bot     "bun run dist/…"  bot        ...       Up (healthy)
# self-bot-browser-worker-1  …   "bun run dist/…"  browser-worker  ...  Up (healthy)
# self-bot-redis-1          "docker-entrypoint.sh"  redis  ...       Up (healthy)
```

### View Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f bot
docker compose logs -f browser-worker
```

### Stop

```bash
docker compose down
# Preserve Redis data
docker compose down -v  # removes volumes
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_HOST` | `redis` | Redis service hostname (Docker Compose internal) |
| `BROWSER_WORKER_URL` | `http://browser-worker:3002` | Browser worker API endpoint |
| `REDIS_URL` | — | Full Redis connection string (overrides `REDIS_HOST`) |
| `SESSION_STORE` | `memory` | Session backend (`memory`, `redis`, or `meridian`) |

### Redis Session Storage

To enable persistent sessions:

```env
SESSION_STORE=redis
REDIS_HOST=redis
```

---

## Healthchecks

Each service includes a health check that Docker uses to determine readiness.

| Service | Endpoint | Interval | Timeout | Retries |
|---|---|---|---|---|
| bot | `GET http://localhost:8080/health` | 10s | 5s | 3 |
| browser-worker | `GET http://localhost:3002/health` | 10s | 5s | 3 |
| redis | `redis-cli ping` | 5s | 3s | 5 |

The bot and browser-worker services wait for their dependencies to be healthy before starting. This ensures Redis is available before the bot attempts to connect.

---

## Ports

| Service | Host Port | Container Port | Description |
|---|---|---|---|
| bot | 8080 | 8080 | Main application API |
| browser-worker | 3002 | 3002 | Browser automation API |
| redis | — | 6379 | Redis internal (not exposed to host) |

### Exposing Redis

To expose Redis to the host for external connections, add to `docker-compose.yml` under the redis service:

```yaml
services:
  redis:
    ports:
      - "6379:6379"
```

---

## Image Details

| Service | Base Image | Size (approx.) | Architecture |
|---|---|---|---|
| bot | `oven/bun:1.1.20` | ~150MB | arm64/x64 |
| browser-worker | `mcr.microsoft.com/playwright:v1.50.0-jammy` | ~1.2GB | x64 only |
| redis | `redis:alpine` | ~40MB | arm64/x64 |

The browser-worker image is larger due to Playwright dependencies (Chromium browser).

---

## Deployment

### Local Development

```bash
# Rebuild on changes
docker compose up -d --build

# View real-time logs
docker compose logs -f
```

### Production VPS

For production deployment on a VPS:

1. **Use webhook mode** for Telegram:
   ```env
   TELEGRAM_MODE=webhook
   TELEGRAM_WEBHOOK_URL=https://your-domain.com
   ```

2. **Set a reverse proxy** (Caddy, nginx) to handle TLS termination and route traffic to the bot container on port 8080.

3. **Persist Redis data** — the `redis_data` volume persists session data across container restarts.

### Cloud Platforms

| Platform | Recommended Approach |
|---|---|
| **GCP Cloud Run** | Deploy bot and browser-worker as separate services, use Cloud Memorystore for Redis |
| **AWS ECS/Fargate** | Use ECS services with Amazon ElastiCache for Redis |
| **DigitalOcean App Platform** | App Platform containers with managed Redis |
| **Railway/Northflock** | One-click deploy with managed Redis add-on |

### GCP Example (Cloud Run)

```bash
# Build and push
docker build -t gcr.io/PROJECT/self-bot:latest .
docker push gcr.io/PROJECT/self-bot:latest

# Deploy
gcloud run deploy self-bot \
  --image gcr.io/PROJECT/self-bot:latest \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars REDIS_HOST=REDIS_IP,BROWSER_WORKER_URL=http://browser-worker:3002
```

---

## Troubleshooting

### Service Not Healthy

```bash
# Check logs
docker compose logs SERVICE_NAME

# Restart a service
docker compose restart SERVICE_NAME
```

### Redis Connection Refused

Ensure Redis is healthy before the bot starts:

```bash
docker compose ps
# If redis is restarting, check logs:
docker compose logs redis
```

### Port Already in Use

If port 8080 or 3002 is already in use, change the port mapping in `docker-compose.yml`:

```yaml
services:
  bot:
    ports:
      - "8888:8080"  # Host port 8888 → container 8080
```

### Browser Automation Fails

The browser-worker requires Chromium dependencies. If you encounter issues:

```bash
# Check worker logs
docker compose logs browser-worker

# Ensure proper platform image — x64 only
docker compose logs browser-worker | grep "playwright"
```

---

## Volume Mounts

| Volume | Service | Purpose |
|---|---|---|
| `redis_data` | redis | Persists Redis data across restarts |

To back up Redis data:

```bash
docker compose stop redis
docker run --rm -v self-bot_redis_data:/data -v $(pwd):/backup alpine tar czf /backup/redis-backup.tar.gz /data
```

---

## Security Considerations

- **Do not expose `.env` to the image** — Use Docker secrets or environment variables passed at runtime
- **Run as non-root user** — Both images create dedicated users (`bun`, `pwuser`)
- **Rate limiting** — Configure via your reverse proxy (nginx/Caddy) in production
- **Webhook TLS** — Use HTTPS for Telegram webhooks (required by Telegram API)

---

## License

MIT License © 2026 Viper9009adr

See [LICENSE](./LICENSE) for full terms.