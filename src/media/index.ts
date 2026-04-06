/**
 * src/media/index.ts
 * Factory for IMediaService.
 */
import type { Config } from '../config/index.js';
import type { IMediaService } from './types.js';
import { DEFAULT_MEDIA_CONFIG } from './types.js';
import { OpenAIMediaService } from './openai.js';
import { LocalMediaService } from './local.js';
import { NvidiaNIMMediaService } from './nvidia-nim.js';
import {
  createMediaCapabilityUnavailableError,
  resolveMediaCapabilityRoutes,
} from './capabilities.js';

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
export {
  appendCapabilityNotice,
  MEDIA_CAPABILITY_UNAVAILABLE_CODE,
  MediaCapabilityUnavailableError,
  createMediaCapabilityUnavailableError,
  mediaCapabilityUnavailableMessage,
  isMediaCapabilityUnavailableError,
  prependCapabilityNotice,
  resolveMediaCapabilityRoutes,
} from './capabilities.js';

class RoutedMediaService implements IMediaService {
  constructor(
    private readonly imageService: IMediaService | null,
    private readonly sttService: IMediaService | null,
    private readonly ttsService: IMediaService | null,
  ) {}

  async generateImage(prompt: string, options?: import('./types.js').ImageGenOptions): Promise<import('./types.js').GeneratedImage> {
    if (!this.imageService) throw createMediaCapabilityUnavailableError('image');
    return this.imageService.generateImage(prompt, options);
  }

  async editImage(
    imageData: Buffer,
    maskData: Buffer | null,
    prompt: string,
    options?: import('./types.js').ImageEditOptions,
  ): Promise<import('./types.js').GeneratedImage> {
    if (!this.imageService) throw createMediaCapabilityUnavailableError('image');
    return this.imageService.editImage(imageData, maskData, prompt, options);
  }

  async variateImage(imageData: Buffer, options?: import('./types.js').ImageVariationOptions): Promise<import('./types.js').GeneratedImage> {
    if (!this.imageService) throw createMediaCapabilityUnavailableError('image');
    return this.imageService.variateImage(imageData, options);
  }

  async transcribeAudio(
    audioData: Buffer,
    mimeType: string,
    options?: import('./types.js').TranscribeOptions,
  ): Promise<import('./types.js').TranscriptionResult> {
    if (!this.sttService) throw createMediaCapabilityUnavailableError('stt');
    return this.sttService.transcribeAudio(audioData, mimeType, options);
  }

  async synthesizeSpeech(text: string, options?: import('./types.js').TTSOptions): Promise<import('./types.js').SynthesizedAudio> {
    if (!this.ttsService) throw createMediaCapabilityUnavailableError('tts');
    return this.ttsService.synthesizeSpeech(text, options);
  }

  async analyzeImageInline(imageData: Buffer, mimeType: string): Promise<{ data: Buffer; mimeType: string }> {
    if (!this.imageService) throw createMediaCapabilityUnavailableError('image');
    return this.imageService.analyzeImageInline(imageData, mimeType);
  }
}

/**
 * Create a capability-routed IMediaService for the given config.
 * Returns null when no media capabilities route to a concrete provider (local or OpenAI);
 * callers must null-check before invoking media operations.
 */
export function createMediaService(config: Config): IMediaService | null {
  const mediaConfig = { ...DEFAULT_MEDIA_CONFIG, ...config.media };
  const routes = resolveMediaCapabilityRoutes(config);
  const localService = new LocalMediaService(mediaConfig, config.llm);
  const openaiService = config.llm.openaiApiKey
    ? new OpenAIMediaService(config.llm.openaiApiKey as unknown as string, mediaConfig)
    : null;
  const nimService = config.llm.nvidiaNimApiKey
    ? new NvidiaNIMMediaService(config.llm.nvidiaNimApiKey as unknown as string, mediaConfig, config.media?.nvidiaNimImageModel)
    : null;

  const imageService = routes.image === 'local' ? localService : routes.image === 'openai' ? openaiService : routes.image === 'nvidia-nim' ? nimService : null;
  const sttService = routes.stt === 'local' ? localService : (routes.stt === 'openai' ? openaiService : null);
  const ttsService = routes.tts === 'local' ? localService : (routes.tts === 'openai' ? openaiService : null);

  if (!imageService && !sttService && !ttsService) return null;

  return new RoutedMediaService(imageService, sttService, ttsService);
}
