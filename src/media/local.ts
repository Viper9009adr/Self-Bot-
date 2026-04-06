/**
 * src/media/local.ts
 * OpenAI-compatible local media implementation (Ollama/LM Studio/etc).
 */
import type {
  IMediaService,
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
import type { Config } from '../config/index.js';
import { childLogger } from '../utils/logger.js';
import { createMediaCapabilityUnavailableError } from './capabilities.js';

const log = childLogger({ module: 'media:local' });

/**
 * Maps OpenAI TTS voice names to equivalent Kokoro-FastAPI voice names.
 *
 * When `LOCAL_TTS_URL` points to a Kokoro-FastAPI instance, the voice names
 * expected by the OpenAI API (e.g. `alloy`, `echo`) are not valid. This map
 * translates them to the closest Kokoro voices confirmed available at runtime.
 *
 * If a voice name is not found in this map, it is passed through unchanged
 * (useful for custom Kokoro voice names that don't have an OpenAI equivalent).
 */
const KOKORO_VOICE_MAP: Record<string, string> = {
  'alloy': 'af_alloy',
  'echo': 'am_echo',
  'fable': 'bm_fable',
  'onyx': 'am_onyx',
  'nova': 'af_nova',
  'shimmer': 'af_sky',
};

/**
 * Translates an OpenAI voice name to the corresponding Kokoro-FastAPI voice.
 *
 * Looks up the voice in `KOKORO_VOICE_MAP`. If a match is found, returns the
 * Kokoro voice name. Otherwise returns the input unchanged (pass-through),
 * allowing custom Kokoro voice names to be used directly.
 *
 * @param voice - OpenAI voice name (e.g. `alloy`, `echo`) or a custom Kokoro voice name.
 * @returns The mapped Kokoro voice name, or the original input if no mapping exists.
 */
function resolveVoice(voice: string | undefined): string | undefined {
  if (!voice) return voice;
  return KOKORO_VOICE_MAP[voice] ?? voice;
}

type ImageEndpoint = 'images.generate' | 'images.edit' | 'images.variation';

type APIError = {
  kind: 'api_error';
  status: number;
  endpoint: ImageEndpoint | 'audio.transcriptions' | 'audio.speech';
  message: string;
};

function isAPIError(err: unknown): err is APIError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'kind' in err &&
    (err as { kind?: unknown }).kind === 'api_error'
  );
}

function noOpImageEndpoint(err: unknown): boolean {
  return isAPIError(err) && (
    err.endpoint === 'images.generate' || err.endpoint === 'images.edit' || err.endpoint === 'images.variation'
  ) && (err.status === 404 || err.status === 501);
}

function trimSlash(v: string): string {
  return v.endsWith('/') ? v.slice(0, -1) : v;
}

function joinUrl(base: string, path: string): string {
  return `${trimSlash(base)}${path}`;
}

function asAPIError(status: number, endpoint: APIError['endpoint'], message: string): APIError {
  return { kind: 'api_error', status, endpoint, message };
}

async function safeErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '(unreadable body)';
  }
}

export class LocalMediaService implements IMediaService {
  private readonly config: MediaConfig;
  private readonly authHeaders: Record<string, string>;
  private readonly llm: Config['llm'];

  constructor(config: MediaConfig, llmConfig: Config['llm']) {
    this.config = config;
    this.llm = llmConfig;
    this.authHeaders = llmConfig.localApiKey
      ? { Authorization: `Bearer ${llmConfig.localApiKey as unknown as string}` }
      : {};
  }

  private imageBase(): string {
    if (!this.llm.localImageUrl) {
      throw createMediaCapabilityUnavailableError('image');
    }
    return this.llm.localImageUrl;
  }

  private sttBase(): string {
    if (!this.llm.localSttUrl) {
      throw createMediaCapabilityUnavailableError('stt');
    }
    return this.llm.localSttUrl;
  }

  private ttsBase(): string {
    if (!this.llm.localTtsUrl) {
      throw createMediaCapabilityUnavailableError('tts');
    }
    return this.llm.localTtsUrl;
  }

  /**
   * LocalAI diffusers backend compatibility: strips unsupported size/quality params,
   * handles b64_json and url responses.
   */
  async generateImage(prompt: string, options?: ImageGenOptions): Promise<GeneratedImage> {
    const endpoint: ImageEndpoint = 'images.generate';
    if (options?.size) {
      log.debug({ size: options.size }, 'LocalAI diffusers: size not supported, ignoring');
    }
    if (options?.quality) {
      log.debug({ quality: options.quality }, 'LocalAI diffusers: quality not supported, ignoring');
    }
    try {
      const response = await fetch(joinUrl(this.imageBase(), '/images/generations'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.authHeaders,
        },
        body: JSON.stringify({
          model: options?.model ?? this.config.imageModel,
          prompt,
          n: options?.n ?? 1,
        }),
      });
      if (!response.ok) {
        throw asAPIError(response.status, endpoint, await safeErrorBody(response));
      }
      const json = await response.json() as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> };
      const item = json.data?.[0];
      if (item?.b64_json) {
        return {
          data: Buffer.from(item.b64_json, 'base64'),
          mimeType: 'image/png',
          ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
        };
      }
      if (item?.url) {
        // Use the configured base URL instead of the URL returned by LocalAI
        // (the returned URL uses localhost which is only valid inside the LocalAI container)
        const baseUrl = this.imageBase().replace(/\/v1\/?$/, ''); // strip /v1 or /v1/ suffix
        const imageUrl = item.url.startsWith('http')
          ? `${baseUrl}${item.url.replace(/^http[s]?:\/\/[^/]+/, '')}`  // replace hostname with base
          : `${baseUrl}/${item.url.replace(/^\//, '')}`;

        log.debug({ imageUrl, originalUrl: item.url }, 'Fetching image from LocalAI');

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
          const imgResp = await fetch(imageUrl, { method: 'GET', signal: controller.signal });
          clearTimeout(timeout);
          if (!imgResp.ok) {
            log.warn({ url: item.url, status: imgResp.status }, 'LocalAI image URL fetch failed');
            return { mimeType: 'image/png' };
          }
          const ct = imgResp.headers.get('content-type');
          if (!ct?.startsWith('image/')) {
            log.warn({ url: item.url, contentType: ct }, 'LocalAI image URL returned non-image content-type');
            return { mimeType: 'image/png' };
          }
          const ab = await imgResp.arrayBuffer();
          log.debug({ status: imgResp.status, contentType: ct, hasData: ab.byteLength > 0 }, 'Image fetch response');
          log.info({ dataLength: ab.byteLength, mimeType: ct }, 'Image successfully fetched');
          return { data: Buffer.from(ab), mimeType: ct.split(';')[0]?.trim() ?? 'image/png' };
        } catch (fetchErr) {
          clearTimeout(timeout);
          log.warn({ url: item.url, err: fetchErr }, 'LocalAI image URL fetch error');
          return { mimeType: 'image/png' };
        }
      }
      throw new Error('generateImage: no b64_json or url in response');
    } catch (err) {
      if (noOpImageEndpoint(err)) {
        const apiErr = err as APIError;
        log.warn({ status: apiErr.status }, 'Local image generation endpoint unavailable; no-op');
        return { mimeType: 'image/png' };
      }
      throw err;
    }
  }

  async editImage(
    imageData: Buffer,
    maskData: Buffer | null,
    prompt: string,
    options?: ImageEditOptions,
  ): Promise<GeneratedImage> {
    const endpoint: ImageEndpoint = 'images.edit';
    try {
      const form = new FormData();
      form.set('model', options?.model ?? this.config.imageModel);
      form.set('prompt', prompt);
      form.set('n', String(options?.n ?? 1));
      form.set('size', options?.size ?? this.config.imageSize);
      const imageMime = options?.imageMimeType ?? 'image/png';
      form.set('image', new Blob([imageData], { type: imageMime }), `image.${imageMime.split('/')[1] ?? 'png'}`);
      if (maskData) {
        const maskMime = options?.maskMimeType ?? 'image/png';
        form.set('mask', new Blob([maskData], { type: maskMime }), 'mask.png');
      }

      const response = await fetch(joinUrl(this.imageBase(), '/images/edits'), {
        method: 'POST',
        headers: this.authHeaders,
        body: form,
      });
      if (!response.ok) {
        throw asAPIError(response.status, endpoint, await safeErrorBody(response));
      }
      const json = await response.json() as { data?: Array<{ b64_json?: string }> };
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) throw new Error('editImage: no b64_json in response');
      return {
        data: Buffer.from(b64, 'base64'),
        mimeType: 'image/png',
      };
    } catch (err) {
      if (noOpImageEndpoint(err)) {
        const apiErr = err as APIError;
        log.warn({ status: apiErr.status }, 'Local image edit endpoint unavailable; no-op');
        return { mimeType: 'image/png' };
      }
      throw err;
    }
  }

  async variateImage(imageData: Buffer, options?: ImageVariationOptions): Promise<GeneratedImage> {
    const endpoint: ImageEndpoint = 'images.variation';
    try {
      const form = new FormData();
      form.set('n', String(options?.n ?? 1));
      form.set('size', options?.size ?? this.config.imageSize);
      form.set('image', new Blob([imageData], { type: 'image/png' }), 'image.png');

      const response = await fetch(joinUrl(this.imageBase(), '/images/variations'), {
        method: 'POST',
        headers: this.authHeaders,
        body: form,
      });
      if (!response.ok) {
        throw asAPIError(response.status, endpoint, await safeErrorBody(response));
      }
      const json = await response.json() as { data?: Array<{ b64_json?: string }> };
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) throw new Error('variateImage: no b64_json in response');
      return {
        data: Buffer.from(b64, 'base64'),
        mimeType: 'image/png',
      };
    } catch (err) {
      if (noOpImageEndpoint(err)) {
        const apiErr = err as APIError;
        log.warn({ status: apiErr.status }, 'Local image variation endpoint unavailable; no-op');
        return { mimeType: 'image/png' };
      }
      throw err;
    }
  }

  async transcribeAudio(
    audioData: Buffer,
    mimeType: string,
    options?: TranscribeOptions,
  ): Promise<TranscriptionResult> {
    const form = new FormData();
    form.set('model', options?.model ?? this.config.sttModel);
    form.set('file', new Blob([audioData], { type: mimeType }), `audio.${mimeType.split('/')[1] ?? 'ogg'}`);
    if (options?.language) form.set('language', options.language);
    if (options?.prompt) form.set('prompt', options.prompt);

    const response = await fetch(joinUrl(this.sttBase(), '/audio/transcriptions'), {
      method: 'POST',
      headers: this.authHeaders,
      body: form,
    });
    if (!response.ok) {
      throw asAPIError(response.status, 'audio.transcriptions', await safeErrorBody(response));
    }

    const json = await response.json() as { text?: string; language?: string; duration?: number };
    return {
      text: json.text ?? '',
      ...(json.language ? { language: json.language } : {}),
      ...(json.duration !== undefined ? { duration: json.duration } : {}),
    };
  }

  async synthesizeSpeech(text: string, options?: TTSOptions): Promise<SynthesizedAudio> {
    const requestedFormat = options?.format ?? 'mp3';
    const response = await fetch(joinUrl(this.ttsBase(), '/audio/speech'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({
        model: options?.model ?? this.config.ttsModel,
        voice: resolveVoice(options?.voice ?? this.config.ttsVoice),
        input: text,
        ...(options?.speed ? { speed: options.speed } : {}),
        response_format: requestedFormat,
      }),
    });
    if (!response.ok) {
      throw asAPIError(response.status, 'audio.speech', await safeErrorBody(response));
    }

    const ab = await response.arrayBuffer();
    const data = Buffer.from(ab);
    const format = requestedFormat;
    const mimeType = format === 'mp3' ? 'audio/mpeg' : (format === 'wav' ? 'audio/wav' : 'audio/ogg');
    return { data, mimeType, format };
  }

  async analyzeImageInline(imageData: Buffer, mimeType: string): Promise<{ data: Buffer; mimeType: string }> {
    return { data: imageData, mimeType };
  }
}
