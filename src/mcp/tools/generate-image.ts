/**
 * src/mcp/tools/generate-image.ts
 * Tool to generate an image from a text prompt via IMediaService.
 */
import { z } from 'zod';
import { BaseTool } from './base.js';
import type { IMediaService } from '../../media/index.js';
import type { ToolResult, ToolContext } from '../../types/tool.js';
import type { JsonObject } from '../../types/tool.js';
import { ToolErrorCode } from '../../types/tool.js';
import {
  MEDIA_CAPABILITY_UNAVAILABLE_CODE,
  createMediaCapabilityUnavailableError,
  isMediaCapabilityUnavailableError,
} from '../../media/index.js';

const inputSchema = z.object({
  prompt: z.string().min(1).describe('Detailed description of the image to generate'),
  size: z.string().optional().describe('Image size, e.g. 1024x1024'),
  quality: z.string().optional().describe('Image quality: standard, hd, low, medium, high, auto'),
});

type Input = z.infer<typeof inputSchema>;

export class GenerateImageTool extends BaseTool<Input & JsonObject> {
  readonly name = 'generate_image';
  readonly description = 'Generate an image from a text prompt and deliver it to the user in the chat.';
  readonly inputSchema = inputSchema as unknown as z.ZodType<Input & JsonObject, z.ZodTypeDef, Input & JsonObject>;

  constructor(private readonly mediaService: IMediaService | null) { super(); }

  protected async run(input: Input & JsonObject, context: ToolContext): Promise<ToolResult> {
    if (!this.mediaService) {
      const err = createMediaCapabilityUnavailableError('image');
      return {
        success: false,
        data: null,
        error: err.message,
        errorCode: ToolErrorCode.MEDIA_CAPABILITY_UNAVAILABLE,
        durationMs: 0,
      };
    }
    try {
      const genOptions: import('../../media/index.js').ImageGenOptions = {};
      if (input.size) genOptions.size = input.size as string;
      if (input.quality) genOptions.quality = input.quality as string;
      const image = await this.mediaService.generateImage(input.prompt as string, genOptions);
      if (image.data && context.onImageGenerated) {
        context.onImageGenerated(image.data.toString('base64'), image.mimeType ?? 'image/png');
      }
      return {
        success: true,
        data: {
          imageGenerated: true,
          prompt: input.prompt as string,
          ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
        },
        durationMs: 0,
      };
    } catch (err) {
      if (isMediaCapabilityUnavailableError(err) || (
        typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === MEDIA_CAPABILITY_UNAVAILABLE_CODE
      )) {
        const unavailable = createMediaCapabilityUnavailableError('image');
        return {
          success: false,
          data: null,
          error: unavailable.message,
          errorCode: ToolErrorCode.MEDIA_CAPABILITY_UNAVAILABLE,
          durationMs: 0,
        };
      }
      throw err;
    }
  }
}
