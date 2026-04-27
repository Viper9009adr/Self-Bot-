/**
 * tests/unit/media/capabilities.test.ts
 * Unit tests for media capability routing and contracts.
 */
import { describe, expect, it } from 'bun:test';
import type { Config } from '../../../src/config/index.js';
import {
  MEDIA_CAPABILITY_UNAVAILABLE_CODE,
  appendCapabilityNotice,
  createMediaCapabilityUnavailableError,
  isMediaCapabilityUnavailableError,
  mediaCapabilityUnavailableMessage,
  prependCapabilityNotice,
  resolveMediaCapabilityRoutes,
} from '../../../src/media/capabilities.js';

function makeConfig(partial: Partial<Config> = {}): Config {
  return {
    llm: {
      provider: 'openai',
      model: 'gpt-4o',
      ...partial.llm,
    },
    media: {
      imageModel: 'gpt-image-1',
      sttModel: 'whisper-1',
      ttsModel: 'tts-1',
      ttsVoice: 'alloy',
      ttsEnabled: true,
      imageSize: '1024x1024',
      imageQuality: 'standard',
      ...partial.media,
    },
  } as unknown as Config;
}

describe('media capabilities routing', () => {
  it('routes local_base_only to unavailable for all media capabilities', () => {
    const config = makeConfig({
      llm: {
        provider: 'local',
        model: 'llama3',
        localBaseUrl: 'http://localhost:11434/v1',
      } as Config['llm'],
    });
    const routes = resolveMediaCapabilityRoutes(config);
    expect(routes).toEqual({ image: 'unavailable', stt: 'unavailable', tts: 'unavailable' });
  });

  it('routes per-capability local endpoints to local', () => {
    const config = makeConfig({
      llm: {
        provider: 'local',
        model: 'llama3',
        localBaseUrl: 'http://localhost:11434/v1',
        localImageUrl: 'http://localhost:8003/v1',
        localSttUrl: 'http://localhost:8001/v1',
        localTtsUrl: 'http://localhost:8002/v1',
      } as Config['llm'],
    });
    const routes = resolveMediaCapabilityRoutes(config);
    expect(routes).toEqual({ image: 'local', stt: 'local', tts: 'local' });
  });

  it('routes openai_only with MEDIA_TTS_ENABLED=true to openai for all', () => {
    const config = makeConfig({
      llm: {
        provider: 'openai',
        model: 'gpt-4o',
        openaiApiKey: 'sk-test' as Config['llm']['openaiApiKey'],
      } as Config['llm'],
      media: {
        ttsEnabled: true,
      } as Config['media'],
    });
    const routes = resolveMediaCapabilityRoutes(config);
    expect(routes).toEqual({ image: 'openai', stt: 'openai', tts: 'openai' });
  });

  it('routes openai_only with MEDIA_TTS_ENABLED=false to tts unavailable', () => {
    const config = makeConfig({
      llm: {
        provider: 'openai',
        model: 'gpt-4o',
        openaiApiKey: 'sk-test' as Config['llm']['openaiApiKey'],
      } as Config['llm'],
      media: {
        ttsEnabled: false,
      } as Config['media'],
    });
    const routes = resolveMediaCapabilityRoutes(config);
    expect(routes).toEqual({ image: 'openai', stt: 'openai', tts: 'unavailable' });
  });

  it('routes mixed anthropic + local subset correctly', () => {
    const config = makeConfig({
      llm: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        openaiApiKey: 'sk-test' as Config['llm']['openaiApiKey'],
        localImageUrl: 'http://localhost:8003/v1',
        localTtsUrl: 'http://localhost:8002/v1',
      } as Config['llm'],
      media: {
        ttsEnabled: false,
      } as Config['media'],
    });
    const routes = resolveMediaCapabilityRoutes(config);
    expect(routes).toEqual({ image: 'local', stt: 'openai', tts: 'local' });
  });
});

describe('media capability unavailable contract helpers', () => {
  it('exposes stable unavailable error code and messages', () => {
    const imageErr = createMediaCapabilityUnavailableError('image');
    expect(imageErr.code).toBe(MEDIA_CAPABILITY_UNAVAILABLE_CODE);
    expect(imageErr.message).toBe('Image capability not configured. Set LOCAL_COMFYUI_URL, LOCAL_IMAGE_URL, or OPENAI_API_KEY.');
    expect(mediaCapabilityUnavailableMessage('stt')).toBe('STT capability not configured. Set LOCAL_STT_URL or OPENAI_API_KEY.');
    expect(mediaCapabilityUnavailableMessage('tts')).toBe('TTS capability not configured. Set LOCAL_TTS_URL or OPENAI_API_KEY and MEDIA_TTS_ENABLED=true.');
    expect(isMediaCapabilityUnavailableError(imageErr)).toBe(true);
  });

  it('prepends and appends notices without duplication', () => {
    const prepended = prependCapabilityNotice('hello', 'stt');
    expect(prepended.startsWith('⚠️ STT capability not configured.')).toBe(true);

    const prependedAgain = prependCapabilityNotice(prepended, 'stt');
    expect(prependedAgain).toBe(prepended);

    const appended = appendCapabilityNotice('hello', 'tts');
    expect(appended.endsWith('⚠️ TTS capability not configured. Set LOCAL_TTS_URL or OPENAI_API_KEY and MEDIA_TTS_ENABLED=true.')).toBe(true);

    const appendedAgain = appendCapabilityNotice(appended, 'tts');
    expect(appendedAgain).toBe(appended);
  });
});
