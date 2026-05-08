import 'dotenv/config';
import Fastify from 'fastify';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { load } from 'cheerio';
import { z } from 'zod';
import pino from 'pino';
import { nanoid } from 'nanoid';
import { stringify } from 'csv-stringify/sync';

// ─── Logger ───────────────────────────────────────────────────────────────────
const log = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  name: 'hybrid-scraper',
});

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const HOST = process.env['HOST'] ?? '0.0.0.0';
const MAX_POOL_SIZE = parseInt(process.env['BROWSER_POOL_SIZE'] ?? '3', 10);
const DEFAULT_TIMEOUT = parseInt(process.env['TIMEOUT_MS'] ?? '30000', 10);

// ─── Schemas ──────────────────────────────────────────────────────────────────
const ScrapeRequestSchema = z.object({
  url: z.string().url(),
  selectors: z.record(z.string()).optional().describe('Map of field name to CSS selector'),
  format: z.enum(['json', 'csv']).default('json'),
  autoEscalate: z.boolean().default(true),
  waitForJs: z.boolean().default(false),
  timeout: z.number().int().min(1000).max(120000).optional(),
});

type ScrapeRequest = z.infer<typeof ScrapeRequestSchema>;

// ─── Browser Pool ─────────────────────────────────────────────────────────────
class BrowserPool {
  private browser: Browser | null = null;
  private contexts: Set<BrowserContext> = new Set();
  private initPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      log.info('Launching Chromium browser');
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      this.browser.on('disconnected', () => {
        log.error('Browser disconnected! Resetting pool.');
        this.browser = null;
        this.initPromise = null;
      });
    })();
    return this.initPromise;
  }

  async acquireContext(): Promise<BrowserContext> {
    if (!this.browser) await this.initialize();
    if (!this.browser) throw new Error('Browser failed to start');
    
    const context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });
    this.contexts.add(context);
    return context;
  }

  async releaseContext(context: BrowserContext): Promise<void> {
    await context.close().catch(() => {});
    this.contexts.delete(context);
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

const pool = new BrowserPool();

// ─── Scraper Engines ──────────────────────────────────────────────────────────

/**
 * Fast Path: Cheerio + Fetch
 */
async function scrapeStatic(url: string, selectors?: Record<string, string>) {
  log.debug({ url }, 'Attempting static scrape (Cheerio)');
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Hybrid-Scraper/1.0)' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  
  const html = await response.text();
  const $ = load(html);
  
  if (!selectors) {
    return { 
      _engine: 'cheerio',
      title: $('title').text().trim(),
      text: $('body').text().trim().slice(0, 5000) 
    };
  }

  const result: Record<string, string> = { _engine: 'cheerio' };
  for (const [key, selector] of Object.entries(selectors)) {
    result[key] = $(selector).first().text().trim();
  }
  return result;
}

/**
 * Heavy Path: Playwright
 */
async function scrapeDynamic(url: string, selectors?: Record<string, string>, timeout = DEFAULT_TIMEOUT) {
  log.debug({ url }, 'Attempting dynamic scrape (Playwright)');
  const context = await pool.acquireContext();
  const page = await context.newPage();
  
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout });
    
    if (!selectors) {
      return {
        _engine: 'playwright',
        title: await page.title(),
        text: (await page.innerText('body')).trim().slice(0, 5000),
      };
    }

    const result: Record<string, string> = { _engine: 'playwright' };
    for (const [key, selector] of Object.entries(selectors)) {
      try {
        result[key] = (await page.innerText(selector, { timeout: 5000 })).trim();
      } catch {
        result[key] = '';
      }
    }
    return result;
  } finally {
    await pool.releaseContext(context);
  }
}

// ─── Server ───────────────────────────────────────────────────────────────────
const app = Fastify({ logger: false });

app.get('/health', async () => ({ status: 'ok' }));

app.post('/scrape', async (request, reply) => {
  const body = ScrapeRequestSchema.parse(request.body);
  const requestId = nanoid(6);
  const reqLog = log.child({ requestId, url: body.url });

  let data: any = null;
  let error: string | null = null;

  try {
    if (body.waitForJs) {
      data = await scrapeDynamic(body.url, body.selectors, body.timeout);
    } else {
      try {
        data = await scrapeStatic(body.url, body.selectors);
        
        // Escalation Logic: If any requested selector returned empty, and autoEscalate is on
        if (body.autoEscalate && body.selectors) {
          const isEmpty = Object.values(data).some(v => v === '');
          if (isEmpty) {
            reqLog.info('Some fields empty, escalating to Playwright');
            data = await scrapeDynamic(body.url, body.selectors, body.timeout);
          }
        } else if (body.autoEscalate && !data.text) {
          reqLog.info('Content empty, escalating to Playwright');
          data = await scrapeDynamic(body.url, body.selectors, body.timeout);
        }
      } catch (e) {
        if (body.autoEscalate) {
          reqLog.warn({ err: (e as Error).message }, 'Static scrape failed, escalating');
          data = await scrapeDynamic(body.url, body.selectors, body.timeout);
        } else {
          throw e;
        }
      }
    }

    if (body.format === 'csv') {
      const csvData = Array.isArray(data) ? data : [data];
      const csv = stringify(csvData, { header: true });
      return reply.type('text/csv').send(csv);
    }

    return { success: true, requestId, data };
  } catch (err) {
    reqLog.error({ err: (err as Error).message }, 'Scrape failed');
    return reply.code(500).send({ success: false, error: (err as Error).message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await app.listen({ port: PORT, host: HOST });
    log.info(`Scraper listening on http://${HOST}:${PORT}`);
  } catch (err) {
    log.error(err);
    process.exit(1);
  }
};

start();
