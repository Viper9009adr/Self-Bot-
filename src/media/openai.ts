/**
 * src/media/openai.ts
 * OpenAI implementation of IMediaService.
 * Uses openai npm package directly (NOT Vercel AI SDK).
 */
import OpenAI, { toFile } from 'openai';
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

const log = childLogger({ module: 'media:openai' });

// mimeType → file extension for audio formats supported by Whisper
const MIME_TO_EXT: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
};

// mimeType → file extension for image formats
const IMG_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
};

export class OpenAIMediaService implements IMediaService {
  private readonly openai: OpenAI;
  private readonly config: MediaConfig;

  constructor(apiKey: string, config: MediaConfig) {
    this.openai = new OpenAI({ apiKey });
    this.config = config;
  }

  async generateImage(prompt: string, options?: ImageGenOptions): Promise<GeneratedImage> {
    const model = options?.model ?? this.config.imageModel;
    const isGptImage = model.startsWith('gpt-image');

    const params: Record<string, unknown> = {
      model,
      prompt,
      n: options?.n ?? 1,
      size: (options?.size ?? this.config.imageSize) as never,
      quality: (options?.quality ?? this.config.imageQuality) as never,
    };
    // Only pass response_format for dall-e-2/dall-e-3; gpt-image-1 always returns b64_json
    if (!isGptImage) {
      params['response_format'] = 'b64_json';
    }

    log.debug({ model, isGptImage }, 'generateImage');
    const result = await this.openai.images.generate(params as never);
    const item = result.data?.[0];
    const b64 = item?.b64_json;
    if (!b64) throw new Error('generateImage: no b64_json in response');
    const revisedPrompt = item?.revised_prompt;

    return {
      data: Buffer.from(b64, 'base64'),
      mimeType: 'image/png',
      ...(revisedPrompt !== undefined ? { revisedPrompt } : {}),
    };
  }

  async editImage(
    imageData: Buffer,
    maskData: Buffer | null,
    prompt: string,
    options?: ImageEditOptions,
  ): Promise<GeneratedImage> {
    const model = options?.model ?? this.config.imageModel;
    const isGptImage = model.startsWith('gpt-image');
    const imgMime = options?.imageMimeType ?? 'image/png';
    const imgExt = IMG_TO_EXT[imgMime] ?? 'png';
    const imageFile = await toFile(imageData, `image.${imgExt}`, { type: imgMime });
    const maskFile = maskData
      ? await toFile(maskData, 'mask.png', { type: options?.maskMimeType ?? 'image/png' })
      : undefined;

    const params: Record<string, unknown> = {
      model,
      image: imageFile,
      prompt,
      n: options?.n ?? 1,
      size: (options?.size ?? this.config.imageSize) as never,
    };
    if (maskFile) params['mask'] = maskFile;
    if (!isGptImage) params['response_format'] = 'b64_json';

    log.debug({ model, isGptImage, hasMask: !!maskFile }, 'editImage');
    const result = await this.openai.images.edit(params as never);
    const b64 = result.data?.[0]?.b64_json;
    if (!b64) throw new Error('editImage: no b64_json in response');

    return {
      data: Buffer.from(b64, 'base64'),
      mimeType: 'image/png',
    };
  }

  async variateImage(imageData: Buffer, options?: ImageVariationOptions): Promise<GeneratedImage> {
    // createVariation only supports dall-e-2
    const imageFile = await toFile(imageData, 'image.png', { type: 'image/png' });

    log.debug({ n: options?.n ?? 1 }, 'variateImage');
    const result = await this.openai.images.createVariation({
      model: 'dall-e-2',
      image: imageFile,
      n: options?.n ?? 1,
      size: (options?.size ?? '1024x1024') as never,
      response_format: 'b64_json',
    });
    const b64 = result.data?.[0]?.b64_json;
    if (!b64) throw new Error('variateImage: no b64_json in response');

    return {
      data: Buffer.from(b64, 'base64'),
      mimeType: 'image/png',
    };
  }

  async transcribeAudio(
    audioData: Buffer,
    mimeType: string,
    options?: TranscribeOptions,
  ): Promise<TranscriptionResult> {
    const ext = MIME_TO_EXT[mimeType] ?? 'ogg';
    const audioFile = await toFile(audioData, `audio.${ext}`, { type: mimeType });

    log.debug({ mimeType, ext, model: options?.model ?? this.config.sttModel }, 'transcribeAudio');
    const result = await this.openai.audio.transcriptions.create({
      file: audioFile,
      model: options?.model ?? this.config.sttModel,
      ...(options?.language ? { language: options.language } : {}),
      ...(options?.prompt ? { prompt: options.prompt } : {}),
      response_format: 'verbose_json',
    });

    const transcription = result as { text: string; language?: string; duration?: number };
    const transcriptionResult: TranscriptionResult = { text: transcription.text };
    if (transcription.language !== undefined) transcriptionResult.language = transcription.language;
    if (transcription.duration !== undefined) transcriptionResult.duration = transcription.duration;
    return transcriptionResult;
  }

  async synthesizeSpeech(text: string, options?: TTSOptions): Promise<SynthesizedAudio> {
    log.debug({ model: options?.model ?? this.config.ttsModel, voice: options?.voice ?? this.config.ttsVoice }, 'synthesizeSpeech');
    const response = await this.openai.audio.speech.create({
      model: options?.model ?? this.config.ttsModel,
      voice: (options?.voice ?? this.config.ttsVoice) as never,
      input: text,
      response_format: 'opus',
      ...(options?.speed ? { speed: options.speed } : {}),
    });

    // OpenAI SDK returns a web Response; extract bytes via arrayBuffer()
    const ab = await (response as unknown as Response).arrayBuffer();
    const data = Buffer.from(ab);

    return { data, mimeType: 'audio/ogg', format: 'opus' };
  }

  async analyzeImageInline(
    imageData: Buffer,
    mimeType: string,
  ): Promise<{ data: Buffer; mimeType: string }> {
    // No API call — just returns raw buffer + mimeType for LLM vision injection
    return { data: imageData, mimeType };
  }
}
