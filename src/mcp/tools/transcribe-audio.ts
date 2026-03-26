/**
 * src/mcp/tools/transcribe-audio.ts
 * MCP tool: transcribe audio to text using Whisper.
 */
import { z } from 'zod';
import { BaseTool } from './base.js';
import type { IMediaService } from '../../media/index.js';
import type { ToolResult, ToolContext } from '../../types/tool.js';
import { ToolErrorCode } from '../../types/tool.js';

const inputSchema = z.object({
  audioBase64: z.string().min(1).describe('Base64-encoded audio data'),
  mimeType: z.string().default('audio/ogg').describe('MIME type of the audio (e.g. audio/ogg, audio/mp4)'),
  language: z.string().optional().describe('BCP-47 language code for transcription (e.g. en, es). Auto-detected if omitted.'),
});

type Input = z.infer<typeof inputSchema>;

export class TranscribeAudioTool extends BaseTool<Input> {
  readonly name = 'transcribe_audio';
  readonly description = 'Transcribe audio to text using Whisper. Note: audio is auto-transcribed when received from Telegram — use this tool for explicit re-transcription with a specific language, or when processing base64 audio from other sources.';
  readonly inputSchema = inputSchema;

  constructor(private readonly mediaService: IMediaService | null) { super(); }

  protected async run(input: Input, _context: ToolContext): Promise<ToolResult> {
    if (!this.mediaService) {
      return { success: false, data: null, error: 'Audio transcription not configured (no OpenAI API key)', errorCode: ToolErrorCode.WORKER_UNAVAILABLE, durationMs: 0 };
    }
    const audioBuffer = Buffer.from(input.audioBase64, 'base64');
    const result = await this.mediaService.transcribeAudio(audioBuffer, input.mimeType, {
      ...(input.language ? { language: input.language } : {}),
    });
    return {
      success: true,
      data: { text: result.text, ...(result.language ? { language: result.language } : {}), ...(result.duration ? { duration: result.duration } : {}) },
      durationMs: 0,
    };
  }
}
