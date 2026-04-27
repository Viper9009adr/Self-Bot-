/**
 * src/mcp/tools/read-pdf.ts
 * MCP tool: extract text from a base64 PDF.
 *
 * Input normalization strips data-URI prefixes and whitespace before
 * decoding so all accepted base64 forms are handled consistently.
 * Validation then classifies unsupported non-PDF payloads (including PK/ZIP
 * containers) before enforcing decoded-byte size limits.
 *
 * PDF header detection is tolerant of UTF-8 BOM/leading preamble content by
 * searching for `%PDF` within the first 1KB of decoded bytes.
 */
import { z } from 'zod';
import pdf from 'pdf-parse';
import { BaseTool } from './base.js';
import type { ToolResult, ToolContext } from '../../types/tool.js';
import { ToolErrorCode } from '../../types/tool.js';

const inputSchema = z.object({
  pdfBase64: z.string().min(1).describe('Base64-encoded PDF file'),
  maxPages: z.number().int().positive().optional().describe('Maximum number of pages to extract (default: all)'),
});

type Input = z.infer<typeof inputSchema>;

// Prompt injection patterns to sanitize
const PROMPT_INJECTION_PATTERNS = [
  /(?:ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions)/gi,
  /(?:system:)/gi,
  /(?:you\s+are\s+a?)/gi,
  /\[SYSTEM\]/gi,
  /<system>/gi,
];

/**
 * Sanitize text by removing prompt injection patterns.
 */
function sanitizeText(text: string): string {
  let sanitized = text;
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, '');
  }
  return sanitized.trim();
}

/**
 * Normalize PDF base64 by stripping optional data URI and whitespace.
 *
 * This ensures decoded-byte validation and signature detection run on the
 * same canonical payload regardless of transport formatting.
 */
function normalizePdfBase64(input: string): string {
  const compact = input.replace(/\s+/g, '');
  return compact.replace(/^data:[^;]+;base64,/i, '');
}

const PDF_SIGNATURE = Buffer.from('%PDF', 'ascii');
const ZIP_SIGNATURE = Buffer.from('PK', 'ascii');
const PDF_HEADER_SEARCH_LIMIT_BYTES = 1024;

/**
 * Find `%PDF` within first 1KB to allow BOM/preamble bytes.
 */
function findPdfSignatureOffset(buffer: Buffer): number {
  const maxStart = Math.min(buffer.length - PDF_SIGNATURE.length, PDF_HEADER_SEARCH_LIMIT_BYTES - PDF_SIGNATURE.length);
  for (let i = 0; i <= maxStart; i += 1) {
    if (
      buffer[i] === PDF_SIGNATURE[0]
      && buffer[i + 1] === PDF_SIGNATURE[1]
      && buffer[i + 2] === PDF_SIGNATURE[2]
      && buffer[i + 3] === PDF_SIGNATURE[3]
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Detect ZIP/container signatures (e.g., Office files) by PK marker.
 */
function hasPkContainerSignature(buffer: Buffer): boolean {
  return buffer.length >= ZIP_SIGNATURE.length
    && buffer[0] === ZIP_SIGNATURE[0]
    && buffer[1] === ZIP_SIGNATURE[1];
}

// Size limits
const MIN_PDF_SIZE_BYTES = 1 * 1024; // 1KB
const MAX_PDF_SIZE_BYTES = 100 * 1024 * 1024; // 100MB
const MIN_PDF_SIZE_KB = MIN_PDF_SIZE_BYTES / 1024;

export class ReadPDFTool extends BaseTool<Input> {
  readonly name = 'read_pdf';
  readonly description = 'Extract text from a PDF file. This does not synthesize speech; use synthesize_speech separately when audio is explicitly requested.';
  readonly inputSchema = inputSchema;

  constructor() { super(); }

  /**
   * Execute PDF text extraction.
   *
   * Normalizes the incoming base64 payload, validates PDF size boundaries
   * (minimum 1KB, maximum 100MB), classifies non-PDF inputs (including
   * PK/ZIP container payloads), extracts text, and sanitizes against prompt
   * injection patterns.
   *
   * @param input - Validated input containing base64-encoded PDF and optional maxPages
   * @returns ToolResult with extracted text and metadata
   */
  protected async run(input: Input, _context: ToolContext): Promise<ToolResult> {
    const normalizedPdfBase64 = normalizePdfBase64(input.pdfBase64);

    // Decode base64 to buffer
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = Buffer.from(normalizedPdfBase64, 'base64');
    } catch (err) {
      return {
        success: false,
        data: null,
        error: 'Invalid base64 PDF data',
        errorCode: ToolErrorCode.PARSE_ERROR,
        durationMs: 0,
      };
    }

    // Classify common ZIP/container uploads early (e.g., Office docs).
    if (hasPkContainerSignature(pdfBuffer)) {
      return {
        success: false,
        data: null,
        error: 'Unsupported file type: ZIP/container payload detected; expected PDF content',
        errorCode: ToolErrorCode.INVALID_INPUT,
        durationMs: 0,
      };
    }

    // Allow valid PDFs with BOM/whitespace/preamble before `%PDF` header.
    if (findPdfSignatureOffset(pdfBuffer) === -1) {
      return {
        success: false,
        data: null,
        error: 'Unsupported file type: payload does not contain a valid PDF signature',
        errorCode: ToolErrorCode.INVALID_INPUT,
        durationMs: 0,
      };
    }

    // Validate file size using decoded payload bytes
    const byteSize = pdfBuffer.length;
    if (byteSize < MIN_PDF_SIZE_BYTES) {
      return {
        success: false,
        data: null,
        error: `PDF file too small. Minimum size is ${MIN_PDF_SIZE_KB}KB, got ${(byteSize / 1024).toFixed(2)}KB.`,
        errorCode: ToolErrorCode.INVALID_INPUT,
        durationMs: 0,
      };
    }
    if (byteSize > MAX_PDF_SIZE_BYTES) {
      return {
        success: false,
        data: null,
        error: `PDF file too large. Maximum size is 100MB, got ${(byteSize / 1024 / 1024).toFixed(2)}MB.`,
        errorCode: ToolErrorCode.INVALID_INPUT,
        durationMs: 0,
      };
    }

    // Extract text from PDF
    let pdfText: string;
    let numPages = 0;
    try {
      const pdfOptions = input.maxPages === undefined ? undefined : { max: input.maxPages };
      const pdfData = await pdf(pdfBuffer, pdfOptions);
      pdfText = pdfData.text;
      numPages = pdfData.numpages;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Check for common PDF errors
      if (errorMessage.includes('password') || errorMessage.includes('encrypted')) {
        return {
          success: false,
          data: null,
          error: 'PDF is password-protected and cannot be read',
          errorCode: ToolErrorCode.PARSE_ERROR,
          durationMs: 0,
        };
      }
      // Check if PDF is corrupt or invalid
      if (errorMessage.includes('Invalid PDF') || errorMessage.includes('corrupt')) {
        return {
          success: false,
          data: null,
          error: 'PDF file is corrupt or invalid',
          errorCode: ToolErrorCode.PARSE_ERROR,
          durationMs: 0,
        };
      }
      // Re-throw unexpected errors
      throw err;
    }

    // Check if we got any text
    if (!pdfText || pdfText.trim().length === 0) {
      return {
        success: false,
        data: null,
        error: 'No text could be extracted from the PDF',
        errorCode: ToolErrorCode.PARSE_ERROR,
        durationMs: 0,
      };
    }

    // Sanitize text to remove prompt injection patterns
    const sanitizedText = sanitizeText(pdfText);

    return {
      success: true,
      data: {
        text: sanitizedText,
        pageCount: numPages,
        textLength: sanitizedText.length,
      },
      durationMs: 0,
    };
  }
}
