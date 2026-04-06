/**
 * src/mcp/tools/read-pdf.ts
 * MCP tool: extract text from PDF and convert to speech.
 */
import { z } from 'zod';
import pdf from 'pdf-parse';
import { BaseTool } from './base.js';
import type { IMediaService } from '../../media/index.js';
import type { ToolResult, ToolContext } from '../../types/tool.js';
import { ToolErrorCode } from '../../types/tool.js';
import {
  MEDIA_CAPABILITY_UNAVAILABLE_CODE,
  createMediaCapabilityUnavailableError,
  isMediaCapabilityUnavailableError,
} from '../../media/index.js';

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
 * Calculate byte size from base64 string.
 */
function base64ToByteSize(base64: string): number {
  // Base64 encodes 3 bytes into 4 characters, accounting for padding
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length * 3) / 4 - padding;
}

// Size limits
const MIN_PDF_SIZE_BYTES = 1 * 1024; // 1kB
const MAX_PDF_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

// TTS chunk size
const TTS_CHUNK_SIZE = 3500;

export class ReadPDFTool extends BaseTool<Input> {
  readonly name = 'read_pdf';
  readonly description = 'Extract text from a PDF file and convert it to speech delivered as a voice message.';
  readonly inputSchema = inputSchema;

  constructor(private readonly mediaService: IMediaService | null) { super(); }

  /**
   * Execute the PDF reading and text-to-speech operation.
   *
   * Validates file size, extracts text from PDF, sanitizes against prompt injection,
   * and optionally synthesizes speech from the extracted text.
   *
   * @param input - Validated input containing base64-encoded PDF and optional maxPages
   * @param context - Tool execution context including callback for audio delivery
   * @returns ToolResult with extracted text metadata or audio delivery confirmation
   */
  protected async run(input: Input, context: ToolContext): Promise<ToolResult> {
    // Validate file size
    const byteSize = base64ToByteSize(input.pdfBase64);
    if (byteSize < MIN_PDF_SIZE_BYTES) {
      return {
        success: false,
        data: null,
        error: `PDF file too small. Minimum size is 1KB, got ${(byteSize / 1024).toFixed(2)}KB.`,
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

    // Decode base64 to buffer
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = Buffer.from(input.pdfBase64, 'base64');
    } catch (err) {
      return {
        success: false,
        data: null,
        error: 'Invalid base64 PDF data',
        errorCode: ToolErrorCode.PARSE_ERROR,
        durationMs: 0,
      };
    }

    // Extract text from PDF
    let pdfText: string;
    let numPages = 0;
    try {
      const pdfData = await pdf(pdfBuffer, {
        max: input.maxPages,
      });
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

    // If no media service, return the extracted text
    if (!this.mediaService) {
      const unavailable = createMediaCapabilityUnavailableError('tts');
      return {
        success: true,
        data: {
          text: sanitizedText.slice(0, 10000), // Limit text in response
          pageCount: numPages,
          textLength: sanitizedText.length,
          ttsUnavailable: true,
        },
        error: unavailable.message,
        errorCode: ToolErrorCode.MEDIA_CAPABILITY_UNAVAILABLE,
        durationMs: 0,
      };
    }

    // Split text into chunks for TTS
    const chunks: string[] = [];
    let currentChunk = '';

    // Split by paragraphs first, then by character limit
    const paragraphs = sanitizedText.split(/\n\n+/);
    for (const paragraph of paragraphs) {
      if (currentChunk.length + paragraph.length > TTS_CHUNK_SIZE) {
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
        }
        // If single paragraph exceeds chunk size, split by sentences
        if (paragraph.length > TTS_CHUNK_SIZE) {
          const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
          for (const sentence of sentences) {
            if (currentChunk.length + sentence.length > TTS_CHUNK_SIZE) {
              if (currentChunk.trim()) {
                chunks.push(currentChunk.trim());
              }
              currentChunk = sentence;
            } else {
              currentChunk += sentence;
            }
          }
        } else {
          currentChunk = paragraph;
        }
      } else {
        currentChunk += '\n\n' + paragraph;
      }
    }
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    // Synthesize speech for each chunk and collect audio
    const audioChunks: Buffer[] = [];
    try {
      for (const chunk of chunks) {
        const audio = await this.mediaService.synthesizeSpeech(chunk);
        audioChunks.push(audio.data);
      }
    } catch (err) {
      if (isMediaCapabilityUnavailableError(err) || (
        typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === MEDIA_CAPABILITY_UNAVAILABLE_CODE
      )) {
        const unavailable = createMediaCapabilityUnavailableError('tts');
        return {
          success: true,
          data: {
            text: sanitizedText.slice(0, 10000),
            pageCount: numPages,
            textLength: sanitizedText.length,
            ttsUnavailable: true,
          },
          error: unavailable.message,
          errorCode: ToolErrorCode.MEDIA_CAPABILITY_UNAVAILABLE,
          durationMs: 0,
        };
      }
      throw err;
    }

    // Combine all audio chunks
    const combinedAudio = Buffer.concat(audioChunks);

    // Deliver audio via callback
    if (context.onAudioGenerated) {
      context.onAudioGenerated(combinedAudio.toString('base64'), 'audio/mp3');
    }

    return {
      success: true,
      data: {
        pageCount: numPages,
        textLength: sanitizedText.length,
        chunkCount: chunks.length,
        mimeType: 'audio/mp3',
        audioDelivered: true,
      },
      durationMs: 0,
    };
  }
}
