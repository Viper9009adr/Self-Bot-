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
import { ComfyUIMediaService } from './comfyui.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { childLogger } from '../utils/logger.js';
import {
  createMediaCapabilityUnavailableError,
  isMediaCapabilityUnavailableError,
  resolveMediaCapabilityRoutes,
} from './capabilities.js';

const log = childLogger({ module: 'media:factory' });

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
    private readonly imageServices: IMediaService[],
    private readonly sttService: IMediaService | null,
    private readonly ttsService: IMediaService | null,
  ) {}

  async generateImage(prompt: string, options?: import('./types.js').ImageGenOptions): Promise<import('./types.js').GeneratedImage> {
    for (const svc of this.imageServices) {
      try {
        return await svc.generateImage(prompt, options);
      } catch (err) {
        if (isMediaCapabilityUnavailableError(err)) continue;
        log.warn({ err }, 'Image service failed, trying next in chain');
      }
    }
    throw createMediaCapabilityUnavailableError('image');
  }

  async editImage(
    imageData: Buffer,
    maskData: Buffer | null,
    prompt: string,
    options?: import('./types.js').ImageEditOptions,
  ): Promise<import('./types.js').GeneratedImage> {
    for (const svc of this.imageServices) {
      try {
        return await svc.editImage(imageData, maskData, prompt, options);
      } catch (err) {
        if (isMediaCapabilityUnavailableError(err)) continue;
        log.warn({ err }, 'Image service failed (edit), trying next in chain');
      }
    }
    throw createMediaCapabilityUnavailableError('image');
  }

  async variateImage(imageData: Buffer, options?: import('./types.js').ImageVariationOptions): Promise<import('./types.js').GeneratedImage> {
    for (const svc of this.imageServices) {
      try {
        return await svc.variateImage(imageData, options);
      } catch (err) {
        if (isMediaCapabilityUnavailableError(err)) continue;
        log.warn({ err }, 'Image service failed (variate), trying next in chain');
      }
    }
    throw createMediaCapabilityUnavailableError('image');
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
    const first = this.imageServices[0];
    if (!first) throw createMediaCapabilityUnavailableError('image');
    return first.analyzeImageInline(imageData, mimeType);
  }
}

/**
 * Create a capability-routed IMediaService for the given config.
 *
 * Image generation uses an ordered fallback chain: ComfyUI → NIM → local → OpenAI.
 * Each provider is included only when its required config keys are present. On failure,
 * RoutedMediaService skips providers that throw MediaCapabilityUnavailableError and
 * logs a warning for any other error before trying the next provider in the chain.
 *
 * Returns null when no media capabilities route to a concrete provider; callers must
 * null-check before invoking media operations.
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

  // Build ComfyUI service if configured
  let comfyuiService: ComfyUIMediaService | null = null;
  if (config.llm.localComfyuiUrl && config.media?.comfyuiWorkflowPath) {
    try {
      const raw = readFileSync(resolve(config.media.comfyuiWorkflowPath), 'utf-8');
      const workflow = JSON.parse(raw) as Record<string, unknown>;
      comfyuiService = new ComfyUIMediaService(config.llm.localComfyuiUrl as unknown as string, workflow);
    } catch (err) {
      log.warn({ err, path: config.media.comfyuiWorkflowPath }, 'ComfyUI workflow load failed — skipping ComfyUI service');
    }
  }

  // Ordered image services array: comfyui → nim → local → openai
  const imageServices: IMediaService[] = [];
  if (comfyuiService) imageServices.push(comfyuiService);
  if (nimService) imageServices.push(nimService);
  if (config.llm.localImageUrl) imageServices.push(localService);
  if (openaiService) imageServices.push(openaiService);

  const sttService = routes.stt === 'local' ? localService : (routes.stt === 'openai' ? openaiService : null);
  const ttsService = routes.tts === 'local' ? localService
    : ((routes.tts === 'openai' && openaiService) ? openaiService : null);

  if (!imageServices.length && !sttService && !ttsService) return null;
  return new RoutedMediaService(imageServices, sttService, ttsService);
}
