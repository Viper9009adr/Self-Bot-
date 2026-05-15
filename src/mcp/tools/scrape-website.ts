/**
 * src/mcp/tools/scrape-website.ts
 * scrape_website tool: delegate scraping to the hybrid-scraper service.
 */
import { z } from 'zod';
import { BaseTool } from './base.js';
import type { ToolResult, ToolContext } from '../../types/tool.js';
import { ToolErrorCode } from '../../types/tool.js';
import { getConfig } from '../../config/index.js';
import { parseStructured, parseToText, truncateText } from '../../utils/html-parser.js';

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
    .describe('Whether to render JavaScript via the hybrid scraper. Prefer true for job boards, search results, listings, filters, and SPA-like pages.'),
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

type HybridScraperResult = {
  success: boolean;
  requestId?: string;
  data?: {
    _engine?: string;
    html?: string;
    title?: string;
    text?: string;
    finalUrl?: string;
  } | null;
  error?: string;
};

export class ScrapeWebsiteTool extends BaseTool<ScrapeWebsiteInput> {
  readonly name = 'scrape_website';
  readonly description =
    'Fetch a webpage and extract its text content, structured data, or links. ' +
    'Uses the hybrid scraper service to auto-escalate from static fetch to browser rendering when needed.';
  readonly inputSchema = ScrapeWebsiteInput;

  private async fetchHybridScrape(
    input: ScrapeWebsiteInput,
    signal?: AbortSignal,
  ): Promise<{ html: string; title?: string; finalUrl: string }> {
    const config = getConfig();
    const response = await fetch(`${config.hybridScraper.url}/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: input.url,
        format: 'json',
        autoEscalate: true,
        waitForJs: input.waitForJs,
        includeHtml: true,
        timeout: input.timeoutMs,
      }),
      signal: signal ?? null,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Hybrid scraper returned HTTP ${response.status}: ${errText}`);
    }

    const result = (await response.json()) as HybridScraperResult;
    if (!result.success) {
      throw new Error(result.error ?? 'Hybrid scraper request failed');
    }

    if (!result.data?.html) {
      throw new Error('Hybrid scraper did not return HTML content');
    }

    return {
      html: result.data.html,
      ...(result.data.title !== undefined ? { title: result.data.title } : {}),
      finalUrl: result.data.finalUrl ?? input.url,
    };
  }

  protected async run(input: ScrapeWebsiteInput, context: ToolContext): Promise<ToolResult> {
    const { extractMode, maxChars } = input;

    let html: string;
    let finalUrl = input.url;
    let renderedTitle: string | undefined;

    try {
      const scraped = await this.fetchHybridScrape(input, context.signal);
      html = scraped.html;
      finalUrl = scraped.finalUrl;
      renderedTitle = scraped.title;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          success: false,
          data: null,
          error: `Request timed out after ${input.timeoutMs}ms`,
          errorCode: ToolErrorCode.TIMEOUT,
        };
      }

      const lowered = message.toLowerCase();
      let errorCode = ToolErrorCode.NETWORK_ERROR;
      if (lowered.includes('captcha')) errorCode = ToolErrorCode.CAPTCHA;
      else if (lowered.includes('403') || lowered.includes('forbidden') || lowered.includes('auth')) errorCode = ToolErrorCode.AUTH_FAILURE;
      else if (lowered.includes('429') || lowered.includes('rate')) errorCode = ToolErrorCode.RATE_LIMITED;
      else if (lowered.includes('unable to connect') || lowered.includes('econnrefused') || lowered.includes('hybrid scraper returned http 5')) errorCode = ToolErrorCode.WORKER_UNAVAILABLE;

      return {
        success: false,
        data: null,
        error: `Failed to fetch ${input.url}: ${message}`,
        errorCode,
      };
    }

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
        data: { url: finalUrl, text, extractMode: 'text' },
        summary: `Extracted ${text.length} characters of text from ${finalUrl}`,
      };
    }

    if (extractMode === 'links') {
      const structured = parseStructured(html, finalUrl);
      const links = structured.links.slice(0, 100);
      return {
        success: true,
        data: { url: finalUrl, links, linkCount: links.length, extractMode: 'links' },
        summary: `Found ${links.length} links on ${finalUrl}`,
      };
    }

    const structured = parseStructured(html, finalUrl);
    const textSummary = truncateText(structured.paragraphs.join('\n\n'), maxChars);

    return {
      success: true,
      data: {
        url: finalUrl,
        title: renderedTitle ?? structured.title,
        description: structured.description,
        headings: structured.headings.slice(0, 20),
        text: textSummary,
        links: structured.links.slice(0, 50),
        images: structured.images.slice(0, 20),
        extractMode: 'structured',
      },
      summary: `Scraped ${finalUrl}: "${renderedTitle ?? structured.title ?? 'No title'}" with ${structured.paragraphs.length} paragraphs`,
    };
  }
}
