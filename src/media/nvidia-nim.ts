/**
 * src/media/nvidia-nim.ts
 * NVIDIA NIM image generation implementation.
 * Uses the genai-specific endpoint: https://ai.api.nvidia.com/v1/genai/{model}
 */
import type {
  IMediaService,
  MediaConfig,
  GeneratedImage,
  TranscriptionResult,
  SynthesizedAudio,
  ImageGenOptions,
  ImageEditOptions,
  ImageVariationOptions,
  TranscribeOptions,
  TTSOptions,
} from './types.js';
import { childLogger } from '../utils/logger.js';
import { createMediaCapabilityUnavailableError } from './capabilities.js';

const log = childLogger({ module: 'media:nvidia-nim' });

const NIM_BASE_URL = 'https://ai.api.nvidia.com/v1/genai';
const DEFAULT_TIMEOUT_MS = 60_000;

export class NvidiaNIMMediaService implements IMediaService {
  private readonly apiKey: string;
  private readonly config: MediaConfig;
  private readonly imageModel: string;

  constructor(apiKey: string, config: MediaConfig, imageModel?: string) {
    this.apiKey = apiKey;
    this.config = config;
    this.imageModel = imageModel ?? 'stabilityai/stable-diffusion-3-medium';
  }

  async generateImage(prompt: string, options?: ImageGenOptions): Promise<GeneratedImage> {
    const model = options?.model ?? this.imageModel;
    const url = `${NIM_BASE_URL}/${model}`;

    log.debug({ model, promptLength: prompt.length }, 'generateImage');

    const body: Record<string, unknown> = { prompt };

    if (options?.cfg_scale !== undefined) body['cfg_scale'] = options.cfg_scale;
    if (options?.aspect_ratio !== undefined) body['aspect_ratio'] = options.aspect_ratio;
    if (options?.seed !== undefined) body['seed'] = options.seed;
    if (options?.steps !== undefined) body['steps'] = options.steps;
    if (options?.negative_prompt !== undefined) body['negative_prompt'] = options.negative_prompt;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          const msg = retryAfter
            ? `NVIDIA NIM rate limit exceeded. Retry after ${retryAfter}s.`
            : 'NVIDIA NIM rate limit exceeded.';
          log.warn({ status: 429, retryAfter }, msg);
          throw new Error(msg);
        }
        const errorBody = await response.text().catch(() => '(unreadable)');
        throw new Error(`NVIDIA NIM image generation failed (${response.status}): ${errorBody}`);
      }

      const json = await response.json() as Record<string, unknown>;
      return this.parseResponse(json);
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`NVIDIA NIM image generation timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`);
      }
      throw err;
    }
  }

  /**
   * Parses NVIDIA NIM API response into a GeneratedImage.
   *
   * Supports three response formats:
   * 1. `{ images: [{ b64_json: "..." }] }` - Standard format with optional revised_prompt
   * 2. `{ artifacts: [{ b64_json: "..." | base64: "..." }] }` - Alternative format (base64 or b64_json)
   * 3. `{ image: "base64..." }` - Simple single-image format
   *
   * @param json - The parsed JSON response from NVIDIA NIM API
   * @returns GeneratedImage with decoded base64 data
   * @throws Error if the response format is unrecognized
   */
  private parseResponse(json: Record<string, unknown>): GeneratedImage {
    // Format 1: { images: [{ b64_json: "..." }] }
    if (json.images && Array.isArray(json.images) && json.images.length > 0) {
      const item = json.images[0] as Record<string, unknown>;
      if (item.b64_json && typeof item.b64_json === 'string') {
        return {
          data: Buffer.from(item.b64_json, 'base64'),
          mimeType: 'image/png',
          ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt as string } : {}),
        };
      }
      if (item.url && typeof item.url === 'string') {
        log.warn({ url: item.url }, 'NIM returned URL format — fetching not yet supported');
        throw new Error('NVIDIA NIM returned image URL — direct URL fetching not yet implemented');
      }
    }

    // Format 2: { artifacts: [{ b64_json: "..." | base64: "..." }] }
    if (json.artifacts && Array.isArray(json.artifacts) && json.artifacts.length > 0) {
      const artifact = json.artifacts[0] as Record<string, unknown>;
      const base64String = (artifact.b64_json as string) || (artifact.base64 as string);
      if (base64String && typeof base64String === 'string') {
        return {
          data: Buffer.from(base64String, 'base64'),
          mimeType: 'image/png',
        };
      }
    }

    // Format 3: { image: "base64..." }
    if (json.image && typeof json.image === 'string') {
      return {
        data: Buffer.from(json.image, 'base64'),
        mimeType: 'image/png',
      };
    }

    // Unrecognized format
    const keys = Object.keys(json);
    log.warn({ keys }, 'Unrecognized NIM response format');
    throw new Error(`Unrecognized NVIDIA NIM response format. Keys: ${keys.join(', ')}`);
  }

  async editImage(
    _imageData: Buffer,
    _maskData: Buffer | null,
    _prompt: string,
    _options?: ImageEditOptions,
  ): Promise<GeneratedImage> {
    throw new Error('NVIDIA NIM image generation does not support editing.');
  }

  async variateImage(_imageData: Buffer, _options?: ImageVariationOptions): Promise<GeneratedImage> {
    throw new Error('NVIDIA NIM image generation does not support variations.');
  }

  async transcribeAudio(
    _audioData: Buffer,
    _mimeType: string,
    _options?: TranscribeOptions,
  ): Promise<TranscriptionResult> {
    throw createMediaCapabilityUnavailableError('stt');
  }

  async synthesizeSpeech(_text: string, _options?: TTSOptions): Promise<SynthesizedAudio> {
    throw createMediaCapabilityUnavailableError('tts');
  }

  async analyzeImageInline(
    imageData: Buffer,
    mimeType: string,
  ): Promise<{ data: Buffer; mimeType: string }> {
    return { data: imageData, mimeType };
  }
}
