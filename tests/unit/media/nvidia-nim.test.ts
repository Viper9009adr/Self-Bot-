/**
 * tests/unit/media/nvidia-nim.test.ts
 * Unit tests for NvidiaNIMMediaService.
 */
import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { NvidiaNIMMediaService } from '../../../src/media/nvidia-nim.js';
import type { MediaConfig, ImageGenOptions } from '../../../src/media/types.js';
import { DEFAULT_MEDIA_CONFIG } from '../../../src/media/types.js';

const mockConfig: MediaConfig = { ...DEFAULT_MEDIA_CONFIG };

function createService(imageModel?: string): NvidiaNIMMediaService {
  return new NvidiaNIMMediaService('test-api-key', mockConfig, imageModel);
}

describe('NvidiaNIMMediaService', () => {
  beforeEach(() => {
    mock.restore();
  });

  describe('constructor', () => {
    it('uses default model when not provided', () => {
      const service = createService();
      expect(service).toBeDefined();
    });

    it('uses provided model', () => {
      const service = createService('black-forest-labs/flux-1-schnell');
      expect(service).toBeDefined();
    });
  });

  describe('generateImage', () => {
    it('sends prompt to correct endpoint with default model', async () => {
      const mockResponse = {
        images: [{ b64_json: Buffer.from('test-image-data').toString('base64') }],
      };

      const fetchMock = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockResponse),
          headers: new Headers(),
        }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const service = createService();
      const result = await service.generateImage('a test prompt');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(calls?.[0]?.[0]).toBe('https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-3-medium');

      expect(result.data).toBeDefined();
      expect(result.mimeType).toBe('image/png');
    });

    it('includes optional NIM parameters when provided', async () => {
      const mockResponse = {
        images: [{ b64_json: Buffer.from('test-image').toString('base64') }],
      };

      const fetchMock = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockResponse),
          headers: new Headers(),
        }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const service = createService();
      const options: ImageGenOptions = {
        cfg_scale: 7.5,
        aspect_ratio: '16:9',
        seed: 42,
        steps: 30,
        negative_prompt: 'blurry',
      };

      await service.generateImage('test', options);

      const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const body = JSON.parse((calls?.[0]?.[1] as { body: string }).body);

      expect(body.cfg_scale).toBe(7.5);
      expect(body.aspect_ratio).toBe('16:9');
      expect(body.seed).toBe(42);
      expect(body.steps).toBe(30);
      expect(body.negative_prompt).toBe('blurry');
    });

    it('parses { image: "base64..." } response format', async () => {
      const b64 = Buffer.from('single-image-format').toString('base64');
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ image: b64 }),
          headers: new Headers(),
        }),
      ) as unknown as typeof fetch;

      const service = createService();
      const result = await service.generateImage('test');

      expect(result.data).toBeDefined();
      expect(result.mimeType).toBe('image/png');
    });

    it('throws on unrecognized response format', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ unexpected: 'format' }),
          headers: new Headers(),
        }),
      ) as unknown as typeof fetch;

      const service = createService();

      await expect(service.generateImage('test')).rejects.toThrow(
        'Unrecognized NVIDIA NIM response format',
      );
    });

    it('throws on rate limit (429)', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 429,
          headers: new Headers({ 'Retry-After': '30' }),
          text: () => Promise.resolve('rate limited'),
        }),
      ) as unknown as typeof fetch;

      const service = createService();

      await expect(service.generateImage('test')).rejects.toThrow(
        'NVIDIA NIM rate limit exceeded. Retry after 30s.',
      );
    });

    it('throws on generic error response', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          headers: new Headers(),
          text: () => Promise.resolve('internal error'),
        }),
      ) as unknown as typeof fetch;

      const service = createService();

      await expect(service.generateImage('test')).rejects.toThrow(
        'NVIDIA NIM image generation failed (500)',
      );
    });
  });

  describe('unsupported operations', () => {
    it('editImage throws unsupported error', async () => {
      const service = createService();
      await expect(
        service.editImage(Buffer.from(''), null, 'edit prompt'),
      ).rejects.toThrow('does not support editing');
    });

    it('variateImage throws unsupported error', async () => {
      const service = createService();
      await expect(
        service.variateImage(Buffer.from('')),
      ).rejects.toThrow('does not support variations');
    });

    it('transcribeAudio throws capability unavailable error', async () => {
      const service = createService();
      await expect(
        service.transcribeAudio(Buffer.from(''), 'audio/wav'),
      ).rejects.toHaveProperty('code', 'MEDIA_CAPABILITY_UNAVAILABLE');
    });

    it('synthesizeSpeech throws capability unavailable error', async () => {
      const service = createService();
      await expect(
        service.synthesizeSpeech('hello'),
      ).rejects.toHaveProperty('code', 'MEDIA_CAPABILITY_UNAVAILABLE');
    });
  });

  describe('analyzeImageInline', () => {
    it('returns image data as-is', async () => {
      const service = createService();
      const imageData = Buffer.from('test-image');
      const result = await service.analyzeImageInline(imageData, 'image/png');

      expect(result.data).toBe(imageData);
      expect(result.mimeType).toBe('image/png');
    });
  });
});
