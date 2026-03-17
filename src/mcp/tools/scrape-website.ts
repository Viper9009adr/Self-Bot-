/**
 * src/mcp/tools/scrape-website.ts
 * scrape_website tool: fetch a URL and extract structured content via Cheerio.
 */
import { z } from 'zod';
import { BaseTool } from './base.js';
import type { ToolResult, ToolContext } from '../../types/tool.js';
import { ToolErrorCode } from '../../types/tool.js';
import { parseStructured, parseToText, truncateText } from '../../utils/html-parser.js';
import { withRetry } from '../../utils/retry.js';

const ScrapeWebsiteInput = z.object({
  url: z.string().url().describe('The URL to scrape'),
  extractMode: z
    .enum(['text', 'structured', 'links'])
    .default('structured')
    .describe('Extraction mode: text (plain text), structured (headings/paragraphs/links), links (only links)'),
  maxChars: z
    .number()
    .int()
    .min(100)
    .max(50000)
    .default(10000)
    .describe('Maximum characters to return'),
  waitForJs: z
    .boolean()
    .default(false)
    .describe('Whether to render JavaScript (requires browser-worker)'),
  selector: z
    .string()
    .optional()
    .describe('CSS selector to scope extraction to a specific element'),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(60000)
    .default(15000)
    .describe('Request timeout in milliseconds'),
});

type ScrapeWebsiteInput = z.infer<typeof ScrapeWebsiteInput>;

export class ScrapeWebsiteTool extends BaseTool<ScrapeWebsiteInput> {
  readonly name = 'scrape_website';
  readonly description =
    'Fetch a webpage and extract its text content, structured data, or links. ' +
    'Use extractMode="structured" for rich data (headings, paragraphs, links). ' +
    'Use extractMode="text" for plain text. ' +
    'Use extractMode="links" to list all hyperlinks.';
  readonly inputSchema = ScrapeWebsiteInput;

  protected async run(input: ScrapeWebsiteInput, context: ToolContext): Promise<ToolResult> {
    const { url, extractMode, maxChars, timeoutMs } = input;

    let html: string;
    try {
      html = await withRetry(
        async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const response = await fetch(url, {
              signal: controller.signal,
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (compatible; Self-BOT/1.0; +https://github.com/self-bot)',
                'Accept': 'text/html,application/xhtml+xml,*/*',
                'Accept-Language': 'en-US,en;q=0.9',
              },
            });
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            return response.text();
          } finally {
            clearTimeout(timer);
          }
        },
        { maxAttempts: 2, initialDelayMs: 1000 },
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          success: false,
          data: null,
          error: `Request timed out after ${timeoutMs}ms`,
          errorCode: ToolErrorCode.TIMEOUT,
        };
      }
      return {
        success: false,
        data: null,
        error: `Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
        errorCode: ToolErrorCode.NETWORK_ERROR,
      };
    }

    // Apply CSS selector scope if provided
    if (input.selector) {
      const { load } = await import('cheerio');
      const $ = load(html);
      const scoped = $(input.selector).html();
      if (scoped) html = scoped;
    }

    if (extractMode === 'text') {
      const text = truncateText(parseToText(html), maxChars);
      return {
        success: true,
        data: { url, text, extractMode: 'text' },
        summary: `Extracted ${text.length} characters of text from ${url}`,
      };
    }

    if (extractMode === 'links') {
      const structured = parseStructured(html, url);
      const links = structured.links.slice(0, 100); // cap at 100 links
      return {
        success: true,
        data: { url, links, linkCount: links.length, extractMode: 'links' },
        summary: `Found ${links.length} links on ${url}`,
      };
    }

    // structured mode
    const structured = parseStructured(html, url);
    const textSummary = truncateText(
      structured.paragraphs.join('\n\n'),
      maxChars,
    );

    return {
      success: true,
      data: {
        url,
        title: structured.title,
        description: structured.description,
        headings: structured.headings.slice(0, 20),
        text: textSummary,
        links: structured.links.slice(0, 50),
        images: structured.images.slice(0, 20),
        extractMode: 'structured',
      },
      summary: `Scraped ${url}: "${structured.title ?? 'No title'}" with ${structured.paragraphs.length} paragraphs`,
    };
  }
}
