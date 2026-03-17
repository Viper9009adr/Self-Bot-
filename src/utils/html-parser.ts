/**
 * src/utils/html-parser.ts
 * Cheerio-based HTML parsing utilities.
 */
import { load, type CheerioAPI } from 'cheerio';

export interface ParsedLink {
  text: string;
  href: string;
  title?: string | undefined;
  [key: string]: string | undefined;
}

export interface ParsedStructured {
  title: string | null;
  description: string | null;
  headings: Array<{ level: number; text: string }>;
  paragraphs: string[];
  links: ParsedLink[];
  images: Array<{ src: string; alt: string }>;
  tables: Array<Array<string[]>>;
  lists: Array<string[]>;
}

/**
 * Load HTML and return the Cheerio API instance.
 */
export function loadHtml(html: string): CheerioAPI {
  return load(html);
}

/**
 * Extract plain text from HTML, collapsing whitespace.
 */
export function parseToText(html: string): string {
  const $ = loadHtml(html);

  // Remove script and style tags
  $('script, style, noscript, head').remove();

  const text = $('body').text() || $.root().text();
  return text
    .replace(/\s+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract all links from HTML.
 */
export function parseLinks(html: string, baseUrl?: string): ParsedLink[] {
  const $ = loadHtml(html);
  const links: ParsedLink[] = [];

  $('a[href]').each((_i, el) => {
    const $el = $(el);
    const href = $el.attr('href') ?? '';
    const text = $el.text().trim();
    const title = $el.attr('title');

    if (!href) return;

    let resolvedHref = href;
    if (baseUrl && !href.startsWith('http') && !href.startsWith('mailto:')) {
      try {
        resolvedHref = new URL(href, baseUrl).toString();
      } catch {
        // Keep original href if URL resolution fails
      }
    }

    links.push({
      text: text || resolvedHref,
      href: resolvedHref,
      ...(title !== undefined && title !== null ? { title } : {}),
    });
  });

  return links;
}

/**
 * Extract structured content from HTML.
 */
export function parseStructured(html: string, baseUrl?: string): ParsedStructured {
  const $ = loadHtml(html);

  // Remove noise
  $('script, style, noscript, nav, footer, header').remove();

  // Title
  const title =
    $('title').first().text().trim() ||
    $('h1').first().text().trim() ||
    null;

  // Meta description
  const description =
    $('meta[name="description"]').attr('content')?.trim() ?? null;

  // Headings
  const headings: Array<{ level: number; text: string }> = [];
  $('h1, h2, h3, h4, h5, h6').each((_i, el) => {
    const level = parseInt((el as { tagName: string }).tagName.slice(1), 10);
    const text = $(el).text().trim();
    if (text) headings.push({ level, text });
  });

  // Paragraphs
  const paragraphs: string[] = [];
  $('p').each((_i, el) => {
    const text = $(el).text().trim();
    if (text) paragraphs.push(text);
  });

  // Links
  const links = parseLinks(html, baseUrl);

  // Images
  const images: Array<{ src: string; alt: string }> = [];
  $('img[src]').each((_i, el) => {
    const src = $(el).attr('src') ?? '';
    const alt = $(el).attr('alt') ?? '';
    if (src) images.push({ src, alt });
  });

  // Tables
  const tables: Array<Array<string[]>> = [];
  $('table').each((_i, tableEl) => {
    const rows: Array<string[]> = [];
    $(tableEl)
      .find('tr')
      .each((_j, rowEl) => {
        const cells: string[] = [];
        $(rowEl)
          .find('th, td')
          .each((_k, cellEl) => {
            cells.push($(cellEl).text().trim());
          });
        if (cells.length > 0) rows.push(cells);
      });
    if (rows.length > 0) tables.push(rows);
  });

  // Lists
  const lists: Array<string[]> = [];
  $('ul, ol').each((_i, listEl) => {
    const items: string[] = [];
    $(listEl)
      .children('li')
      .each((_j, liEl) => {
        const text = $(liEl).text().trim();
        if (text) items.push(text);
      });
    if (items.length > 0) lists.push(items);
  });

  return {
    title,
    description,
    headings,
    paragraphs,
    links,
    images,
    tables,
    lists,
  };
}

/**
 * Truncate text to a maximum number of characters, preserving word boundaries.
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? truncated.slice(0, lastSpace) + '…' : truncated + '…';
}
