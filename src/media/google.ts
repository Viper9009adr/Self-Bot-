/**
 * src/media/google.ts
 * Google Media Service implementing Imagen 3 image generation.
 * 
 * Architecture designed by ARC.
 * Implementation by IMP.
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
import { createMediaCapabilityUnavailableError } from './capabilities.js';

export class GoogleMediaService implements IMediaService {

  /**
   * Initializes the Google Media Service.
   * 
   * @param apiKey - The Google API key for authentication.
   * @param config - General media configuration.
   */
  constructor(
    private readonly apiKey: string,
    private readonly config: MediaConfig,
  ) {}

  /**
   * Generates an image using Imagen 3 via the Google Generative Language REST API.
   * 
   * @param prompt - The text description of the image to generate.
   * @param options - Optional generation settings (model, n, aspect_ratio).
   * @returns A GeneratedImage object containing the image buffer and metadata.
   * @throws MediaCapabilityUnavailableError if the API call fails or no data is returned.
   */
  async generateImage(prompt: string, options?: ImageGenOptions): Promise<GeneratedImage> {
    try {
      const model = options?.model || this.config.imageModel || 'imagen-3';
      const isGemini = model.startsWith('gemini-');
      const url = isGemini 
        ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`
        : `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${this.apiKey}`;
      

      const body = isGemini 
        ? {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              response_modalities: ['IMAGE'],
            },
          }
        : {
            instances: [{ prompt }],
            parameters: {
              sampleCount: options?.n || 1,
              aspectRatio: options?.aspect_ratio || '1:1',
            },
          };
      

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();

        throw new Error(`Google API error: ${response.status} ${errorText}`);
      }

      const result = (await response.json()) as any;
      
      if (isGemini) {
        const inlineData = result.candidates?.[0]?.content?.parts?.[0]?.inlineData;
        if (!inlineData?.data) {

          throw new Error('No image data returned from Google Gemini API');
        }


        return {
          data: Buffer.from(inlineData.data, 'base64'),
          mimeType: inlineData.mimeType || 'image/png',
        };
      }

      const prediction = result.predictions?.[0];
      if (!prediction || !prediction.bytesBase64Encoded) {

        throw new Error('No image data returned from Google Imagen API');
      }


      return {
        data: Buffer.from(prediction.bytesBase64Encoded, 'base64'),
        mimeType: 'image/png',
        revisedPrompt: result.revisedPrompt,
      };
    } catch (err) {

      throw createMediaCapabilityUnavailableError('image');
    }
  }

  /**
   * Edits an existing image. Currently not supported by GoogleMediaService.
   * @throws MediaCapabilityUnavailableError
   */
  async editImage(
    _imageData: Buffer,
    _maskData: Buffer | null,
    _prompt: string,
    _options?: ImageEditOptions,
  ): Promise<GeneratedImage> {
    throw createMediaCapabilityUnavailableError('image');
  }

  /**
   * Creates variations of an existing image. Currently not supported by GoogleMediaService.
   * @throws MediaCapabilityUnavailableError
   */
  async variateImage(
    _imageData: Buffer,
    _options?: ImageVariationOptions,
  ): Promise<GeneratedImage> {
    throw createMediaCapabilityUnavailableError('image');
  }

  /**
   * Transcribes audio to text. Currently not supported by GoogleMediaService.
   * @throws MediaCapabilityUnavailableError
   */
  async transcribeAudio(
    _audioData: Buffer,
    _mimeType: string,
    _options?: TranscribeOptions,
  ): Promise<TranscriptionResult> {
    throw createMediaCapabilityUnavailableError('stt');
  }

  /**
   * Synthesizes text to speech. Currently not supported by GoogleMediaService.
   * @throws MediaCapabilityUnavailableError
   */
  async synthesizeSpeech(
    _text: string,
    _options?: TTSOptions,
  ): Promise<SynthesizedAudio> {
    throw createMediaCapabilityUnavailableError('tts');
  }

  /**
   * Analyzes an image for inline processing.
   * @param imageData - The image buffer.
   * @param mimeType - The MIME type of the image.
   * @returns The original image data and mimeType.
   */
  async analyzeImageInline(imageData: Buffer, mimeType: string): Promise<{ data: Buffer; mimeType: string }> {
    return { data: imageData, mimeType };
  }
}
