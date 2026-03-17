/**
 * browser-worker/server.ts
 * Fastify HTTP microservice exposing POST /execute for Playwright browser automation.
 * Runs as a separate Node.js process. Self-BOT calls it via fetch().
 *
 * Build: tsc browser-worker/server.ts --outDir browser-worker
 * Run:   node browser-worker/server.js
 */

import 'dotenv/config';
import Fastify from 'fastify';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { z } from 'zod';
import pino from 'pino';
import { nanoid } from 'nanoid';

// ─── Logger ───────────────────────────────────────────────────────────────────
const log = pino(
  {
    level: process.env['LOG_LEVEL'] ?? 'info',
    name: 'browser-worker',
    redact: {
      paths: ['*.password', '*.passwd', '*.secret', '*.apiKey', 'payload.*'],
      censor: '[REDACTED]',
    },
  },
  pino.destination(1),
);

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env['BROWSER_WORKER_PORT'] ?? '3002', 10);
const HOST = process.env['BROWSER_WORKER_HOST'] ?? '127.0.0.1';
const MAX_POOL_SIZE = parseInt(process.env['BROWSER_POOL_SIZE'] ?? '3', 10);
const DEFAULT_TIMEOUT = parseInt(process.env['BROWSER_TIMEOUT_MS'] ?? '30000', 10);
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ─── Schemas ──────────────────────────────────────────────────────────────────
const BrowserCommandSchema = z.object({
  action: z.enum(['fill_form', 'login', 'register', 'navigate', 'screenshot', 'extract_text']),
  url: z.string().url(),
  payload: z.record(z.string()).optional(),
  options: z
    .object({
      waitForSelector: z.string().optional(),
      submitSelector: z.string().optional(),
      timeout: z.number().int().min(1000).max(120000).optional(),
      screenshotOnError: z.boolean().optional(),
      captureScreenshot: z.boolean().optional(),
    })
    .optional(),
});

type BrowserCommand = z.infer<typeof BrowserCommandSchema>;

interface BrowserResult {
  success: boolean;
  data?: Record<string, unknown>;
  screenshot?: string; // base64
  error?: string;
  errorCode?: 'TIMEOUT' | 'CAPTCHA' | 'AUTH_FAILURE' | 'RATE_LIMITED' | 'PARSE_ERROR' | 'BROWSER_CRASH';
  humanHandoffRequired?: boolean;
}

// ─── Browser Pool ─────────────────────────────────────────────────────────────
class BrowserPool {
  private browser: Browser | null = null;
  private readonly contexts: Set<BrowserContext> = new Set();
  private initPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    log.info('Launching Chromium browser');
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    this.browser.on('disconnected', () => {
      log.error('Browser disconnected! Will reinitialize on next request.');
      this.browser = null;
      this.initPromise = null;
    });
    log.info('Browser ready');
  }

  async acquireContext(): Promise<BrowserContext> {
    if (!this.browser) {
      this.initPromise = null;
      await this.initialize();
    }
    if (!this.browser) throw new Error('Browser unavailable');

    if (this.contexts.size >= MAX_POOL_SIZE) {
      // Wait briefly for a context to free up
      await new Promise((r) => setTimeout(r, 500));
    }

    const context = await this.browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      javaScriptEnabled: true,
    });
    this.contexts.add(context);
    return context;
  }

  async releaseContext(context: BrowserContext): Promise<void> {
    try {
      await context.close();
    } catch {
      // Ignore close errors
    }
    this.contexts.delete(context);
  }

  async close(): Promise<void> {
    for (const ctx of this.contexts) {
      await ctx.close().catch(() => undefined);
    }
    this.contexts.clear();
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
    log.info('Browser pool closed');
  }
}

const pool = new BrowserPool();

// ─── CAPTCHA Detection ────────────────────────────────────────────────────────
function detectCaptcha(content: string): boolean {
  const captchaSignals = [
    'recaptcha',
    'hcaptcha',
    'cf-challenge',
    'challenge-form',
    'turnstile',
    'captcha',
    'I am not a robot',
    'verify you are human',
    'bot protection',
  ];
  const lower = content.toLowerCase();
  return captchaSignals.some((signal) => lower.includes(signal));
}

// ─── Core Executor ────────────────────────────────────────────────────────────
async function executeCommand(cmd: BrowserCommand): Promise<BrowserResult> {
  const timeout = cmd.options?.timeout ?? DEFAULT_TIMEOUT;
  const requestId = nanoid(8);
  const cmdLog = log.child({ requestId, action: cmd.action, url: cmd.url });

  cmdLog.info('Executing browser command');

  const context = await pool.acquireContext();
  let page: Page | null = null;

  try {
    page = await context.newPage();
    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(timeout);

    // Navigate to URL
    const response = await page.goto(cmd.url, {
      waitUntil: 'domcontentloaded',
      timeout,
    });

    if (!response || !response.ok()) {
      const status = response?.status() ?? 0;
      if (status === 429) {
        return { success: false, errorCode: 'RATE_LIMITED', error: 'HTTP 429 Too Many Requests' };
      }
      if (status === 403) {
        return { success: false, errorCode: 'AUTH_FAILURE', error: `HTTP ${status} Forbidden` };
      }
      return { success: false, error: `Navigation failed with status ${status}`, errorCode: 'PARSE_ERROR' };
    }

    // Check for CAPTCHA after navigation
    const bodyContent = await page.content();
    if (detectCaptcha(bodyContent)) {
      cmdLog.warn('CAPTCHA detected');
      const screenshot = await captureScreenshot(page);
      return {
        success: false,
        errorCode: 'CAPTCHA',
        error: 'CAPTCHA detected. Human intervention required.',
        humanHandoffRequired: true,
        screenshot,
      };
    }

    switch (cmd.action) {
      case 'screenshot': {
        const screenshot = await captureScreenshot(page);
        return { success: true, data: { url: cmd.url }, screenshot };
      }

      case 'extract_text': {
        const text = await page.innerText('body');
        return { success: true, data: { text: text.slice(0, 50000) } };
      }

      case 'navigate': {
        return { success: true, data: { url: page.url(), title: await page.title() } };
      }

      case 'fill_form':
      case 'login':
      case 'register': {
        return await fillAndSubmit(page, cmd, cmdLog);
      }

      default: {
        return { success: false, error: `Unknown action: ${cmd.action}`, errorCode: 'PARSE_ERROR' };
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    cmdLog.error({ err: errMsg }, 'Command execution error');

    // Determine error code
    let errorCode: BrowserResult['errorCode'] = 'BROWSER_CRASH';
    if (errMsg.includes('Timeout') || errMsg.includes('timeout')) {
      errorCode = 'TIMEOUT';
    } else if (errMsg.includes('net::') || errMsg.includes('navigation')) {
      errorCode = 'PARSE_ERROR';
    }

    // Screenshot on error if requested
    let screenshot: string | undefined;
    if (cmd.options?.screenshotOnError && page) {
      screenshot = await captureScreenshot(page).catch(() => undefined);
    }

    return {
      success: false,
      error: errMsg,
      errorCode,
      screenshot,
    };
  } finally {
    await pool.releaseContext(context);
  }
}

async function fillAndSubmit(
  page: Page,
  cmd: BrowserCommand,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cmdLog: any,
): Promise<BrowserResult> {
  const payload = cmd.payload ?? {};
  const timeout = cmd.options?.timeout ?? DEFAULT_TIMEOUT;

  // Fill each field
  for (const [selector, value] of Object.entries(payload)) {
    try {
      await page.waitForSelector(selector, { timeout: Math.min(5000, timeout) });
      await page.fill(selector, value);
      cmdLog.debug({ selector }, 'Field filled');
    } catch {
      // Try alternative: locate by label or placeholder
      try {
        const locator = page.locator(selector).first();
        await locator.fill(value);
      } catch (innerErr) {
        cmdLog.warn({ selector, err: innerErr instanceof Error ? innerErr.message : String(innerErr) }, 'Could not fill field');
      }
    }
  }

  // Check for CAPTCHA before submitting
  const bodyContent = await page.content();
  if (detectCaptcha(bodyContent)) {
    const screenshot = await captureScreenshot(page);
    return {
      success: false,
      errorCode: 'CAPTCHA',
      error: 'CAPTCHA appeared before form submission.',
      humanHandoffRequired: true,
      screenshot,
    };
  }

  // Submit the form
  const submitSel = cmd.options?.submitSelector ?? 'button[type="submit"]';
  try {
    await Promise.all([
      page.waitForNavigation({ timeout, waitUntil: 'domcontentloaded' }).catch(() => undefined),
      page.click(submitSel),
    ]);
  } catch {
    // Try pressing Enter as fallback
    await page.keyboard.press('Enter').catch(() => undefined);
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
  }

  // Check for CAPTCHA after submission
  const afterContent = await page.content();
  if (detectCaptcha(afterContent)) {
    const screenshot = await captureScreenshot(page);
    return {
      success: false,
      errorCode: 'CAPTCHA',
      error: 'CAPTCHA appeared after form submission.',
      humanHandoffRequired: true,
      screenshot,
    };
  }

  // Wait for success selector if provided
  if (cmd.options?.waitForSelector) {
    try {
      await page.waitForSelector(cmd.options.waitForSelector, { timeout: Math.min(10000, timeout) });
    } catch {
      // Selector not found — check for auth failure
      const failContent = await page.content().catch(() => '');
      const failSignals = ['invalid', 'incorrect', 'failed', 'wrong', 'error', 'denied'];
      if (failSignals.some((s) => failContent.toLowerCase().includes(s))) {
        return {
          success: false,
          errorCode: 'AUTH_FAILURE',
          error: 'Form submission appears to have failed (error message detected)',
        };
      }
    }
  }

  // Capture screenshot if requested
  let screenshot: string | undefined;
  if (cmd.options?.captureScreenshot) {
    screenshot = await captureScreenshot(page).catch(() => undefined);
  }

  const finalUrl = page.url();
  const title = await page.title().catch(() => '');

  return {
    success: true,
    data: {
      url: finalUrl,
      title,
      action: cmd.action,
    },
    screenshot,
  };
}

async function captureScreenshot(page: Page): Promise<string> {
  const buffer = await page.screenshot({ type: 'png', fullPage: false });
  return Buffer.from(buffer).toString('base64');
}

// ─── Fastify Server ───────────────────────────────────────────────────────────
const app = Fastify({
  logger: false, // We use pino directly
  trustProxy: true,
});

// Health endpoint
app.get('/health', async (_req, reply) => {
  return reply.code(200).send({ status: 'ok', pid: process.pid });
});

// Execute endpoint
app.post('/execute', async (request, reply) => {
  const parseResult = BrowserCommandSchema.safeParse(request.body);
  if (!parseResult.success) {
    return reply.code(400).send({
      success: false,
      error: 'Invalid request: ' + parseResult.error.issues.map((i) => i.message).join(', '),
    });
  }

  try {
    const result = await executeCommand(parseResult.data);
    return reply.code(200).send(result);
  } catch (err) {
    log.error({ err }, 'Execute endpoint error');
    return reply.code(500).send({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
      errorCode: 'BROWSER_CRASH',
    });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  // Initialize browser pool eagerly
  await pool.initialize().catch((err) => {
    log.error({ err }, 'Browser initialization failed — will retry on first request');
  });

  await app.listen({ port: PORT, host: HOST });
  log.info({ port: PORT, host: HOST }, 'Browser worker listening');
}

// Signal handlers for graceful shutdown
process.once('SIGINT', async () => {
  log.info('SIGINT received, shutting down');
  await app.close();
  await pool.close();
  process.exit(0);
});

process.once('SIGTERM', async () => {
  log.info('SIGTERM received, shutting down');
  await app.close();
  await pool.close();
  process.exit(0);
});

start().catch((err) => {
  log.error({ err }, 'Failed to start browser worker');
  process.exit(1);
});
