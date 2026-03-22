/**
 * tests/unit/mcp/scrape-website.test.ts
 * Unit tests for the scrape_website tool.
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { ScrapeWebsiteTool } from '../../../src/mcp/tools/scrape-website.js';
import type { ToolContext } from '../../../src/types/tool.js';
import { ToolErrorCode } from '../../../src/types/tool.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────
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
  <ul>
    <li>Item 1</li>
    <li>Item 2</li>
  </ul>
</body>
</html>
`;

const CAPTCHA_HTML = `
<html>
<body>
  <div class="g-recaptcha" data-sitekey="abc123"></div>
  <h1>Please verify you are not a robot</h1>
</body>
</html>
`;

// ─── Mock fetch ───────────────────────────────────────────────────────────────
const mockFetch = mock(async (url: string): Promise<Response> => {
  if (url.includes('captcha-site.com')) {
    return new Response(CAPTCHA_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
  }
  if (url.includes('timeout-site.com')) {
    await new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })), 100),
    );
    throw new Error('Should not reach here');
  }
  if (url.includes('error-site.com')) {
    return new Response('Not Found', { status: 404 });
  }
  return new Response(SIMPLE_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
});

// ─── Test context ─────────────────────────────────────────────────────────────
const testContext: ToolContext = {
  userId: 'test-user',
  taskId: 'test-task',
  conversationId: 'test-conv',
};

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('ScrapeWebsiteTool', () => {
  let tool: ScrapeWebsiteTool;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tool = new ScrapeWebsiteTool();
    originalFetch = globalThis.fetch;
    // @ts-expect-error - mock fetch
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mockFetch.mockClear();
  });

  describe('tool metadata', () => {
    it('has correct name', () => {
      expect(tool.name).toBe('scrape_website');
    });

    it('has description', () => {
      expect(tool.description).toContain('webpage');
    });

    it('has inputSchema', () => {
      expect(tool.inputSchema).toBeDefined();
    });
  });

  describe('structured extraction', () => {
    it('extracts title and paragraphs', async () => {
      const result = await tool.execute(
        { url: 'https://test.example.com', extractMode: 'structured', maxChars: 10000, waitForJs: false, timeoutMs: 5000 },
        testContext,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      const data = result.data as Record<string, unknown>;
      expect(data['title']).toBe('Test Page');
      expect(data['extractMode']).toBe('structured');
      expect(data['url']).toBe('https://test.example.com');
    });

    it('extracts headings', async () => {
      const result = await tool.execute(
        { url: 'https://test.example.com', extractMode: 'structured', maxChars: 10000, waitForJs: false, timeoutMs: 5000 },
        testContext,
      );

      const data = result.data as Record<string, unknown>;
      const headings = data['headings'] as Array<{ level: number; text: string }>;
      expect(headings.length).toBeGreaterThanOrEqual(2);
      expect(headings.some((h) => h.text === 'Main Heading')).toBe(true);
    });

    it('extracts links', async () => {
      const result = await tool.execute(
        { url: 'https://test.example.com', extractMode: 'structured', maxChars: 10000, waitForJs: false, timeoutMs: 5000 },
        testContext,
      );

      const data = result.data as Record<string, unknown>;
      const links = data['links'] as Array<{ href: string }>;
      expect(links.length).toBeGreaterThanOrEqual(1);
      expect(links.some((l) => l.href.includes('example.com'))).toBe(true);
    });
  });

  describe('text extraction', () => {
    it('returns plain text', async () => {
      const result = await tool.execute(
        { url: 'https://test.example.com', extractMode: 'text', maxChars: 10000, waitForJs: false, timeoutMs: 5000 },
        testContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(typeof data['text']).toBe('string');
      expect(data['text'] as string).toContain('First paragraph');
    });

    it('respects maxChars limit', async () => {
      const result = await tool.execute(
        { url: 'https://test.example.com', extractMode: 'text', maxChars: 200, waitForJs: false, timeoutMs: 5000 },
        testContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect((data['text'] as string).length).toBeLessThanOrEqual(200); // includes ellipsis
    });
  });

  describe('links extraction', () => {
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
  });

  describe('error handling', () => {
    it('returns NETWORK_ERROR on HTTP 404', async () => {
      const result = await tool.execute(
        { url: 'https://error-site.com/page', extractMode: 'text', maxChars: 5000, waitForJs: false, timeoutMs: 5000 },
        testContext,
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(ToolErrorCode.NETWORK_ERROR);
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

  describe('summary', () => {
    it('includes URL in summary', async () => {
      const result = await tool.execute(
        { url: 'https://test.example.com', extractMode: 'structured', maxChars: 5000, waitForJs: false, timeoutMs: 5000 },
        testContext,
      );

      expect(result.summary).toContain('test.example.com');
    });
  });
});
