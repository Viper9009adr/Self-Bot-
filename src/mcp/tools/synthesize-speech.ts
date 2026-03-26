/**
 * src/mcp/tools/synthesize-speech.ts
 * MCP tool: convert text to speech and deliver as a voice message.
 */
import { z } from 'zod';
import { BaseTool } from './base.js';
import type { IMediaService } from '../../media/index.js';
import type { ToolResult, ToolContext } from '../../types/tool.js';
import { ToolErrorCode } from '../../types/tool.js';

const inputSchema = z.object({
  text: z.string().min(1).describe('Text to synthesize into speech'),
  voice: z.enum(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']).optional().describe('Voice to use'),
  speed: z.number().min(0.25).max(4.0).optional().describe('Speech speed (0.25–4.0, default 1.0)'),
});

type Input = z.infer<typeof inputSchema>;

export class SynthesizeSpeechTool extends BaseTool<Input> {
  readonly name = 'synthesize_speech';
  readonly description = 'Convert text to speech and deliver it as a voice message to the user.';
  readonly inputSchema = inputSchema;

  constructor(private readonly mediaService: IMediaService | null) { super(); }

  protected async run(input: Input, context: ToolContext): Promise<ToolResult> {
    if (!this.mediaService) {
      return { success: false, data: null, error: 'Speech synthesis not configured (no OpenAI API key)', errorCode: ToolErrorCode.WORKER_UNAVAILABLE, durationMs: 0 };
    }
    const audio = await this.mediaService.synthesizeSpeech(input.text, {
      ...(input.voice ? { voice: input.voice } : {}),
      ...(input.speed ? { speed: input.speed } : {}),
    });
    if (context.onAudioGenerated) {
      context.onAudioGenerated(audio.data.toString('base64'), audio.mimeType);
    }
    return { success: true, data: { synthesized: true, mimeType: audio.mimeType }, durationMs: 0 };
  }
}
