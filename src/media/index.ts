/**
 * src/media/index.ts
 * Factory for IMediaService.
 */
import type { Config } from '../config/index.js';
import type { IMediaService } from './types.js';
import { DEFAULT_MEDIA_CONFIG } from './types.js';
import { OpenAIMediaService } from './openai.js';

export type { IMediaService } from './types.js';
export type {
  GeneratedImage,
  TranscriptionResult,
  SynthesizedAudio,
  ImageGenOptions,
  ImageEditOptions,
  ImageVariationOptions,
  TranscribeOptions,
  TTSOptions,
  MediaConfig,
} from './types.js';
export { DEFAULT_MEDIA_CONFIG } from './types.js';

/**
 * Create the appropriate IMediaService for the given config.
 * Returns null when config.llm.openaiApiKey is absent — callers must null-check.
 */
export function createMediaService(config: Config): IMediaService | null {
  if (!config.llm.openaiApiKey) return null;
  const mediaConfig = { ...DEFAULT_MEDIA_CONFIG, ...config.media };
  return new OpenAIMediaService(config.llm.openaiApiKey as unknown as string, mediaConfig);
}
