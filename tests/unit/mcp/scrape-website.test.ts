/**
 * tests/unit/mcp/scrape-website.test.ts
 * Unit tests for the scrape_website tool.
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { ScrapeWebsiteTool } from '../../../src/mcp/tools/scrape-website.js';
import type { ToolContext } from '../../../src/types/tool.js';
import { ToolErrorCode } from '../../../src/types/tool.js';
import * as configModule from '../../../src/config/index.js';

const SIMPLE_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Test Page</title>
  <meta name="description" content="A test page for scraping" />
</head>
<body>
  <h1>Main Heading</h1>
  <h2>Sub Heading</h2>
  <p>First paragraph with some content.</p>
  <p>Second paragraph.</p>
  <a href="https://example.com/link1">Link One</a>
  <a href="/relative-link">Relative Link</a>
</body>
</html>
`;

const RENDERED_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Rendered Page</title>
</head>
<body>
  <h1>Rendered Heading</h1>
  <p>Content from hybrid scraper.</p>
</body>
</html>
`;

const testContext: ToolContext = {
  userId: 'test-user',
  taskId: 'test-task',
  conversationId: 'test-conv',
};

const mockFetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

  if (url.includes('hybrid-scraper.test/scrape')) {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const targetUrl = String(body['url'] ?? '');

    if (targetUrl.includes('error-site.com')) {
      return new Response('Not Found', { status: 404, statusText: 'Not Found' });
    }

    if (targetUrl.includes('captcha-site.com')) {
      return new Response(JSON.stringify({
        success: false,
        error: 'CAPTCHA detected. Human intervention required.',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (targetUrl.includes('auth-site.com')) {
      return new Response(JSON.stringify({
        success: false,
        error: 'HTTP 403 Forbidden',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      success: true,
      data: {
        _engine: body['waitForJs'] ? 'playwright' : 'cheerio',
        html: body['waitForJs'] ? RENDERED_HTML : SIMPLE_HTML,
        title: body['waitForJs'] ? 'Rendered Page' : 'Test Page',
        finalUrl: body['waitForJs'] ? 'https://rendered.example.com/final' : targetUrl,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  throw new Error(`Unexpected URL in test fetch: ${url}`);
});

describe('ScrapeWebsiteTool', () => {
  let tool: ScrapeWebsiteTool;
  let originalFetch: typeof globalThis.fetch;
  let getConfigSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tool = new ScrapeWebsiteTool();
    originalFetch = globalThis.fetch;
    // @ts-expect-error - mock fetch
    globalThis.fetch = mockFetch;
    getConfigSpy = spyOn(configModule, 'getConfig').mockReturnValue({
      browserWorker: {
        url: 'http://browser-worker.test',
        timeoutMs: 30000,
      },
      hybridScraper: {
        url: 'http://hybrid-scraper.test',
        timeoutMs: 30000,
      },
    } as ReturnType<typeof configModule.getConfig>);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mockFetch.mockClear();
    getConfigSpy.mockRestore();
  });

  it('has correct metadata', () => {
    expect(tool.name).toBe('scrape_website');
    expect(tool.description).toContain('hybrid scraper');
    expect(tool.inputSchema).toBeDefined();
  });

  it('extracts structured content from hybrid scraper HTML', async () => {
    const result = await tool.execute(
      { url: 'https://test.example.com', extractMode: 'structured', maxChars: 10000, waitForJs: false, timeoutMs: 5000 },
      testContext,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['title']).toBe('Test Page');
    expect(data['extractMode']).toBe('structured');
    expect(data['url']).toBe('https://test.example.com');
    const headings = data['headings'] as Array<{ text: string }>;
    expect(headings.some((h) => h.text === 'Main Heading')).toBe(true);
  });

  it('returns rendered content when waitForJs is true', async () => {
    const result = await tool.execute(
      { url: 'https://dynamic.example.com', extractMode: 'structured', maxChars: 10000, waitForJs: true, timeoutMs: 5000 },
      testContext,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['title']).toBe('Rendered Page');
    expect(data['url']).toBe('https://rendered.example.com/final');
    expect(data['text']).toContain('Content from hybrid scraper');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://hybrid-scraper.test/scrape',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('returns plain text', async () => {
    const result = await tool.execute(
      { url: 'https://test.example.com', extractMode: 'text', maxChars: 200, waitForJs: false, timeoutMs: 5000 },
      testContext,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['text']).toContain('First paragraph');
    expect((data['text'] as string).length).toBeLessThanOrEqual(200);
  });

  it('returns links list', async () => {
    const result = await tool.execute(
      { url: 'https://test.example.com', extractMode: 'links', maxChars: 10000, waitForJs: false, timeoutMs: 5000 },
      testContext,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['extractMode']).toBe('links');
    expect(typeof data['linkCount']).toBe('number');
  });

  it('maps hybrid scraper HTTP failures to NETWORK_ERROR', async () => {
    const result = await tool.execute(
      { url: 'https://error-site.com/page', extractMode: 'text', maxChars: 5000, waitForJs: false, timeoutMs: 5000 },
      testContext,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(ToolErrorCode.NETWORK_ERROR);
  });

  it('maps captcha failures', async () => {
    const result = await tool.execute(
      { url: 'https://captcha-site.com/page', extractMode: 'text', maxChars: 5000, waitForJs: true, timeoutMs: 5000 },
      testContext,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(ToolErrorCode.CAPTCHA);
  });

  it('maps auth failures', async () => {
    const result = await tool.execute(
      { url: 'https://auth-site.com/page', extractMode: 'structured', maxChars: 5000, waitForJs: true, timeoutMs: 5000 },
      testContext,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(ToolErrorCode.AUTH_FAILURE);
  });

  it('validates URL input', async () => {
    const result = await tool.execute(
      { url: 'not-a-url', extractMode: 'text', maxChars: 5000, waitForJs: false, timeoutMs: 5000 },
      testContext,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(ToolErrorCode.INVALID_INPUT);
  });

  it('includes durationMs in result', async () => {
    const result = await tool.execute(
      { url: 'https://test.example.com', extractMode: 'text', maxChars: 5000, waitForJs: false, timeoutMs: 5000 },
      testContext,
    );

    expect(result.durationMs).toBeDefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
