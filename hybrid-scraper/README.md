# Hybrid Scraper Microservice

A standalone, high-performance scraping service that uses a "Fast Path" (Cheerio) and automatically escalates to a "Heavy Path" (Playwright) for JS-rendered content.

## Features
- **Automatic Escalation:** Tries static fetch first; if content is empty or selectors aren't found, it switches to Playwright.
- **Configurable Output:** Supports JSON and CSV response formats.
- **High Concurrency:** Built-in browser context pooling.
- **Standalone:** No dependencies on external bot logic.

## Quick Start (Docker)

```bash
docker-compose up --build
```

The service will be available at `http://localhost:3000`.

## API Usage

### `POST /scrape`

**Payload:**
```json
{
  "url": "https://example.com",
  "selectors": {
    "price": ".product-price",
    "title": "h1"
  },
  "format": "json",
  "autoEscalate": true
}
```

**Parameters:**
- `url` (Required): The target URL.
- `selectors` (Optional): A map of labels to CSS selectors. If omitted, returns page title and body text.
- `format`: `json` or `csv`.
- `autoEscalate`: If `true`, triggers Playwright if Cheerio fails to find data.
- `waitForJs`: If `true`, forces Playwright immediately.

### `GET /health`
Returns `{ "status": "ok" }`.

## Kubernetes
Designed for Batch Jobs or horizontal scaling. Includes health checks on port 3000.
