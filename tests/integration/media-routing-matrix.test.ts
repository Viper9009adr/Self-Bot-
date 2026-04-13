/**
 * tests/integration/media-routing-matrix.test.ts
 * Media routing matrix coverage for capability-scoped behavior.
 */
type BunTestModule = typeof import('bun:test');

const bunTest: BunTestModule | null =
  typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ? await import('bun:test') : null;

const describe = bunTest?.describe ?? (() => {}) as unknown as BunTestModule['describe'];
const it = bunTest?.it ?? (() => {}) as unknown as BunTestModule['it'];
const expect = bunTest?.expect ?? ((() => {
  throw new Error('expect() is unavailable outside Bun runtime');
}) as unknown as BunTestModule['expect']);
import type { Config } from '../../src/config/index.js';
import {
  createMediaCapabilityUnavailableError,
  appendCapabilityNotice,
  createMediaService,
  isMediaCapabilityUnavailableError,
  prependCapabilityNotice,
  resolveMediaCapabilityRoutes,
} from '../../src/media/index.js';

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

describe('media routing matrix', () => {
  it('local_base_only => all media unavailable (no LOCAL_BASE_URL fallback)', async () => {
    const config = makeConfig({
      llm: {
        provider: 'local',
        model: 'llama3',
        localBaseUrl: 'http://localhost:11434/v1',
      } as Config['llm'],
    });

    expect(resolveMediaCapabilityRoutes(config)).toEqual({
      image: 'unavailable',
      stt: 'unavailable',
      tts: 'unavailable',
    });

    const svc = createMediaService(config);
    expect(svc).toBeNull();

    const imageErr = createMediaCapabilityUnavailableError('image');
    const sttErr = createMediaCapabilityUnavailableError('stt');
    const ttsErr = createMediaCapabilityUnavailableError('tts');

    expect(isMediaCapabilityUnavailableError(imageErr)).toBe(true);
    expect(isMediaCapabilityUnavailableError(sttErr)).toBe(true);
    expect(isMediaCapabilityUnavailableError(ttsErr)).toBe(true);
  });

  it('per-capability_local_only => all media local', () => {
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

    expect(resolveMediaCapabilityRoutes(config)).toEqual({ image: 'local', stt: 'local', tts: 'local' });
    expect(createMediaService(config)).not.toBeNull();
  });

  it('openai_only with MEDIA_TTS_ENABLED=true => all openai', () => {
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

    expect(resolveMediaCapabilityRoutes(config)).toEqual({ image: 'openai', stt: 'openai', tts: 'openai' });
    expect(createMediaService(config)).not.toBeNull();
  });

  it('openai_only with MEDIA_TTS_ENABLED=false => tts unavailable', async () => {
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

    expect(resolveMediaCapabilityRoutes(config)).toEqual({ image: 'openai', stt: 'openai', tts: 'unavailable' });

    const svc = createMediaService(config);
    expect(svc).not.toBeNull();
    await expect(svc!.synthesizeSpeech('hello')).rejects.toMatchObject({
      name: 'MediaCapabilityUnavailableError',
      code: 'MEDIA_CAPABILITY_UNAVAILABLE',
      capability: 'tts',
    });
  });

  it('mixed anthropic + local subset => local image/tts, openai stt', () => {
    const config = makeConfig({
      llm: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        openaiApiKey: 'sk-test' as Config['llm']['openaiApiKey'],
        localImageUrl: 'http://localhost:8003/v1',
        localTtsUrl: 'http://localhost:8002/v1',
      } as Config['llm'],
      media: {
        ttsEnabled: true,
      } as Config['media'],
    });

    expect(resolveMediaCapabilityRoutes(config)).toEqual({ image: 'local', stt: 'openai', tts: 'local' });
    expect(createMediaService(config)).not.toBeNull();
  });
});

describe('runtime user-visible notice helpers', () => {
  it('prepends STT notice for auto-STT path', () => {
    const result = prependCapabilityNotice('Please help with this voice note', 'stt');
    expect(result).toContain('⚠️ STT capability not configured. Set LOCAL_STT_URL or OPENAI_API_KEY.');
  });

  it('appends TTS notice for auto-TTS path', () => {
    const result = appendCapabilityNotice('Here is your response', 'tts');
    expect(result).toContain('⚠️ TTS capability not configured. Set LOCAL_TTS_URL or OPENAI_API_KEY and MEDIA_TTS_ENABLED=true.');
  });
});
