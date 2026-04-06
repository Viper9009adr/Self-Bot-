/**
 * src/media/capabilities.ts
 * Capability routing + explicit unavailable error contract for media.
 */
import type { Config } from '../config/index.js';

export type MediaCapability = 'image' | 'stt' | 'tts';
export type MediaRouteTarget = 'local' | 'openai' | 'nvidia-nim' | 'unavailable';

export const MEDIA_CAPABILITY_UNAVAILABLE_CODE = 'MEDIA_CAPABILITY_UNAVAILABLE' as const;

export const MEDIA_CAPABILITY_UNAVAILABLE_MESSAGES: Record<MediaCapability, string> = {
  image: 'Image capability not configured. Set LOCAL_IMAGE_URL or OPENAI_API_KEY.',
  stt: 'STT capability not configured. Set LOCAL_STT_URL or OPENAI_API_KEY.',
  tts: 'TTS capability not configured. Set LOCAL_TTS_URL or OPENAI_API_KEY and MEDIA_TTS_ENABLED=true.',
};

export interface MediaCapabilityRoutes {
  image: MediaRouteTarget;
  stt: MediaRouteTarget;
  tts: MediaRouteTarget;
}

export class MediaCapabilityUnavailableError extends Error {
  readonly code = MEDIA_CAPABILITY_UNAVAILABLE_CODE;
  readonly capability: MediaCapability;

  constructor(capability: MediaCapability) {
    super(MEDIA_CAPABILITY_UNAVAILABLE_MESSAGES[capability]);
    this.name = 'MediaCapabilityUnavailableError';
    this.capability = capability;
  }
}

export function mediaCapabilityUnavailableMessage(capability: MediaCapability): string {
  return MEDIA_CAPABILITY_UNAVAILABLE_MESSAGES[capability];
}

export function createMediaCapabilityUnavailableError(capability: MediaCapability): MediaCapabilityUnavailableError {
  return new MediaCapabilityUnavailableError(capability);
}

export function prependCapabilityNotice(text: string, capability: MediaCapability): string {
  const notice = `⚠️ ${mediaCapabilityUnavailableMessage(capability)}`;
  const trimmed = text.trim();
  if (!trimmed) return notice;
  if (trimmed.startsWith(notice)) return trimmed;
  return `${notice}\n${text}`;
}

export function appendCapabilityNotice(text: string, capability: MediaCapability): string {
  const notice = `⚠️ ${mediaCapabilityUnavailableMessage(capability)}`;
  const trimmed = text.trim();
  if (!trimmed) return notice;
  if (trimmed.includes(notice)) return text;
  return `${text}\n${notice}`;
}

export function isMediaCapabilityUnavailableError(err: unknown): err is MediaCapabilityUnavailableError {
  return err instanceof MediaCapabilityUnavailableError
    || (
      typeof err === 'object'
      && err !== null
      && 'code' in err
      && (err as { code?: unknown }).code === MEDIA_CAPABILITY_UNAVAILABLE_CODE
    );
}

/**
 * Capability router contract (chat remains bound to llm.provider).
 * Media routing is capability-scoped and never falls back to LOCAL_BASE_URL.
 */
export function resolveMediaCapabilityRoutes(config: Config): MediaCapabilityRoutes {
  const hasOpenAI = !!config.llm.openaiApiKey;
  const hasLocalImage = !!config.llm.localImageUrl;
  const hasLocalStt = !!config.llm.localSttUrl;
  const hasLocalTts = !!config.llm.localTtsUrl;
  const hasNvidiaNimImage = !!config.llm.nvidiaNimApiKey;

  return {
    image: hasLocalImage ? 'local' : (hasOpenAI ? 'openai' : (hasNvidiaNimImage ? 'nvidia-nim' : 'unavailable')),
    stt: hasLocalStt ? 'local' : (hasOpenAI ? 'openai' : 'unavailable'),
    tts: hasLocalTts
      ? 'local'
      : ((hasOpenAI && config.media?.ttsEnabled !== false) ? 'openai' : 'unavailable'),
  };
}
