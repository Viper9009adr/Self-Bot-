/**
 * src/mcp/tools/edit-image.ts
 * Tool to edit or create a variation of an existing image via IMediaService.
 */
import { z } from 'zod';
import { BaseTool } from './base.js';
import type { IMediaService } from '../../media/index.js';
import type { ToolResult, ToolContext } from '../../types/tool.js';
import type { JsonObject } from '../../types/tool.js';

const inputSchema = z.object({
  prompt: z.string().min(1).describe('Description of the edit or variation to apply'),
  imageBase64: z.string().min(1).describe('Base64-encoded source image (PNG or JPEG)'),
  imageMimeType: z.string().default('image/png').describe('MIME type of the source image'),
  createVariation: z.boolean().default(false).describe('If true, create a variation instead of editing'),
});

type Input = z.infer<typeof inputSchema>;

export class EditImageTool extends BaseTool<Input & JsonObject> {
  readonly name = 'edit_image';
  readonly description = 'Edit or create a variation of an existing image using AI.';
  readonly inputSchema = inputSchema as unknown as z.ZodType<Input & JsonObject, z.ZodTypeDef, Input & JsonObject>;

  constructor(private readonly mediaService: IMediaService | null) { super(); }

  protected async run(input: Input & JsonObject, context: ToolContext): Promise<ToolResult> {
    if (!this.mediaService) {
      return { success: false, data: null, error: 'Image editing not configured (no OpenAI API key)', durationMs: 0 };
    }
    const imageBuffer = Buffer.from(input.imageBase64 as string, 'base64');
    let image;
    if (input.createVariation) {
      image = await this.mediaService.variateImage(imageBuffer);
    } else {
      image = await this.mediaService.editImage(imageBuffer, null, input.prompt as string, {
        imageMimeType: input.imageMimeType as string,
      });
    }
    if (image.data && context.onImageGenerated) {
      context.onImageGenerated(image.data.toString('base64'), image.mimeType ?? 'image/png');
    }
    return { success: true, data: { imageEdited: true, prompt: input.prompt as string }, durationMs: 0 };
  }
}
