/**
 * src/media/types.ts
 * Platform-agnostic media service interfaces and types.
 * No platform-specific imports allowed here.
 */

export interface GeneratedImage {
  data?: Buffer;
  mimeType: string;
  revisedPrompt?: string;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
}

export interface SynthesizedAudio {
  data: Buffer;
  mimeType: string;
  format: 'opus' | 'mp3' | 'wav';
}

export interface ImageGenOptions {
  model?: string;
  size?: string;
  quality?: string;
  style?: string;
  n?: number;
  /** @nim-only NVIDIA NIM: Guidance scale (1-20, default 5) */
  cfg_scale?: number;
  /** @nim-only NVIDIA NIM: Aspect ratio (e.g. "16:9", "1:1", "9:16") */
  aspect_ratio?: string;
  /** @nim-only NVIDIA NIM: Random seed (0 = random) */
  seed?: number;
  /** @nim-only NVIDIA NIM: Number of denoising steps (default 50) */
  steps?: number;
  /** @nim-only NVIDIA NIM: Negative prompt to avoid */
  negative_prompt?: string;
  /** Callback for progress updates during generation (e.g. ComfyUI step progress). */
  onProgress?: (status: string) => Promise<void>;
}

export interface ImageEditOptions {
  model?: string;
  size?: string;
  n?: number;
  imageMimeType?: string; // used for Buffer→File conversion; default 'image/png'
  maskMimeType?: string;
}

export interface ImageVariationOptions {
  n?: number;
  size?: string;
}

export interface TranscribeOptions {
  model?: string;
  language?: string;
  prompt?: string;
}

export interface TTSOptions {
  model?: string;
  voice?: string;
  speed?: number;
  format?: 'opus' | 'mp3' | 'wav';
}

export interface MediaConfig {
  imageModel: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  ttsEnabled: boolean;
  imageSize: string;
  imageQuality: 'standard' | 'hd' | 'low' | 'medium' | 'high' | 'auto';
}

export const DEFAULT_MEDIA_CONFIG: MediaConfig = {
  imageModel: 'gpt-image-1',
  sttModel: 'whisper-1',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
  ttsEnabled: true,
  imageSize: '1024x1024',
  imageQuality: 'standard',
};

export interface IMediaService {
  generateImage(prompt: string, options?: ImageGenOptions): Promise<GeneratedImage>;
  editImage(imageData: Buffer, maskData: Buffer | null, prompt: string, options?: ImageEditOptions): Promise<GeneratedImage>;
  variateImage(imageData: Buffer, options?: ImageVariationOptions): Promise<GeneratedImage>;
  transcribeAudio(audioData: Buffer, mimeType: string, options?: TranscribeOptions): Promise<TranscriptionResult>;
  synthesizeSpeech(text: string, options?: TTSOptions): Promise<SynthesizedAudio>;
  /** Returns raw buffer + mimeType for inline LLM vision injection. No API call. */
  analyzeImageInline(imageData: Buffer, mimeType: string): Promise<{ data: Buffer; mimeType: string }>;
}
