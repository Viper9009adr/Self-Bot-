/**
 * tests/unit/mcp/media-unavailable-errors.test.ts
 * Verifies explicit MEDIA_CAPABILITY_UNAVAILABLE tool contracts.
 */
import { describe, expect, it } from 'bun:test';
import { GenerateImageTool } from '../../../src/mcp/tools/generate-image.js';
import { EditImageTool } from '../../../src/mcp/tools/edit-image.js';
import { TranscribeAudioTool } from '../../../src/mcp/tools/transcribe-audio.js';
import { SynthesizeSpeechTool } from '../../../src/mcp/tools/synthesize-speech.js';
import type { ToolContext } from '../../../src/types/tool.js';
import { ToolErrorCode } from '../../../src/types/tool.js';

const context: ToolContext = {
  userId: 'u1',
  taskId: 't1',
  conversationId: 'c1',
};

describe('media tool unavailable error contract', () => {
  it('generate_image returns explicit image unavailable contract', async () => {
    const tool = new GenerateImageTool(null);
    const result = await tool.execute({ prompt: 'sunset' }, context);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(ToolErrorCode.MEDIA_CAPABILITY_UNAVAILABLE);
    expect(result.error).toBe('Image capability not configured. Set LOCAL_COMFYUI_URL, LOCAL_IMAGE_URL, or OPENAI_API_KEY.');
  });

  it('edit_image returns explicit image unavailable contract', async () => {
    const tool = new EditImageTool(null);
    const result = await tool.execute({
      prompt: 'make it cinematic',
      imageBase64: Buffer.from('x').toString('base64'),
      imageMimeType: 'image/png',
      createVariation: false,
    }, context);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(ToolErrorCode.MEDIA_CAPABILITY_UNAVAILABLE);
    expect(result.error).toBe('Image capability not configured. Set LOCAL_COMFYUI_URL, LOCAL_IMAGE_URL, or OPENAI_API_KEY.');
  });

  it('transcribe_audio returns explicit stt unavailable contract', async () => {
    const tool = new TranscribeAudioTool(null);
    const result = await tool.execute({
      audioBase64: Buffer.from('audio').toString('base64'),
      mimeType: 'audio/ogg',
    }, context);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(ToolErrorCode.MEDIA_CAPABILITY_UNAVAILABLE);
    expect(result.error).toBe('STT capability not configured. Set LOCAL_STT_URL or OPENAI_API_KEY.');
  });

  it('synthesize_speech returns explicit tts unavailable contract', async () => {
    const tool = new SynthesizeSpeechTool(null);
    const result = await tool.execute({ text: 'hello' }, context);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(ToolErrorCode.MEDIA_CAPABILITY_UNAVAILABLE);
    expect(result.error).toBe('TTS capability not configured. Set LOCAL_TTS_URL or OPENAI_API_KEY and MEDIA_TTS_ENABLED=true.');
  });
});
