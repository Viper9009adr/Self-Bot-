/**
 * src/media/comfyui.ts
 * ComfyUI local image generation implementation.
 *
 * API flow:
 *   1. Deep-clone the loaded workflow JSON and inject prompt/steps/seed/guidance/size
 *      into the fixed node IDs used by the default workflow (nodes 43, 17, 45, 42, 44, 46).
 *   2. POST the modified workflow to ComfyUI's /prompt endpoint with a random client_id.
 *   3. Poll GET /history/{prompt_id} every 5 s (initial 5 s delay) until outputs are
 *      populated or the 290 s timeout is reached. All output nodes are scanned dynamically
 *      for images arrays — no hardcoded node IDs required.
 *   4. Fetch the finished image binary from /view with the filename/subfolder/type params.
 *
 * Progress: onProgress is called at each poll interval with elapsed time.
 *
 * Fallback behaviour: editImage, variateImage, transcribeAudio, and synthesizeSpeech all
 * throw MediaCapabilityUnavailableError so RoutedMediaService can fall through to the next
 * provider in the chain. analyzeImageInline passes the buffer through unchanged.
 *
 * Timeout: 290 s (5 s initial delay + 57 polls × 5 s). Hard cap avoids hanging forever.
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
} from './types.js';
import { childLogger } from '../utils/logger.js';
import { createMediaCapabilityUnavailableError } from './capabilities.js';

const log = childLogger({ module: 'media:comfyui' });


export class ComfyUIMediaService implements IMediaService {
  private readonly baseUrl: string;
  private readonly workflow: Record<string, unknown>;

  constructor(baseUrl: string, workflow: Record<string, unknown>) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.workflow = workflow;
  }

  async generateImage(prompt: string, options?: ImageGenOptions): Promise<GeneratedImage> {
    log.debug({ promptLength: prompt.length }, 'ComfyUI generateImage');

    // Deep-clone workflow
    const wf = JSON.parse(JSON.stringify(this.workflow)) as Record<string, unknown>;

    type WfNode = { inputs: Record<string, unknown> };
    const getNode = (id: string): Record<string, unknown> =>
      ((wf[id] as WfNode).inputs);

    // Inject prompt
    getNode('43').text = prompt;

    // Inject steps
    const node17inputs = getNode('17');
    node17inputs.steps = options?.steps ?? node17inputs.steps;

    // Inject seed
    getNode('45').noise_seed = options?.seed ?? Math.floor(Math.random() * (2 ** 48));

    // Inject guidance/cfg_scale
    const node42inputs = getNode('42');
    node42inputs.guidance = options?.cfg_scale ?? node42inputs.guidance;

    // Inject size if provided
    if (options?.size) {
      const parts = options.size.split('x');
      if (parts.length === 2) {
        const widthStr = parts[0];
        const heightStr = parts[1];
        if (widthStr !== undefined && heightStr !== undefined) {
          const width = parseInt(widthStr, 10);
          const height = parseInt(heightStr, 10);
          if (!isNaN(width) && !isNaN(height)) {
            const node44inputs = getNode('44');
            node44inputs.width = width;
            node44inputs.height = height;
            const node46inputs = getNode('46');
            node46inputs.width = width;
            node46inputs.height = height;
          }
        }
      }
    }

    // POST to /prompt
    const response = await fetch(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: wf, client_id: crypto.randomUUID() }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '(unreadable)');
      throw new Error(`ComfyUI prompt submission failed (${response.status}): ${errorBody}`);
    }

    const json = await response.json() as { prompt_id: string };
    const promptId = json.prompt_id;

    log.debug({ promptId }, 'ComfyUI prompt submitted, polling for completion');

    const wsUrl = this.baseUrl
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://');

    let ws: InstanceType<typeof globalThis.WebSocket> | null = null;
    if (typeof globalThis.WebSocket !== 'undefined') {
      try {
        ws = new (globalThis.WebSocket as typeof WebSocket)(`${wsUrl}/ws?clientId=${crypto.randomUUID()}`);
        ws.onerror = () => { /* degraded — polling continues */ };
        ws.onclose = () => { /* degraded — polling continues */ };
        ws.onmessage = (event: MessageEvent) => {
          try {
            const msg = JSON.parse(event.data as string) as { type?: string; data?: { value?: number; max?: number } };
            if (msg.type === 'progress' && typeof msg.data?.value === 'number' && typeof msg.data?.max === 'number') {
              options?.onProgress?.(`Step ${msg.data.value}/${msg.data.max}`).catch(() => {});
            }
          } catch { /* ignore malformed frames */ }
        };
      } catch { /* WS unavailable — progress falls back to polling elapsed time */ }
    }

    let imageRef: { filename: string; subfolder: string; type: string };
    try {
      imageRef = await this.pollForCompletion(promptId, options?.onProgress);
    } finally {
      ws?.close();
    }
    const buffer = await this.fetchImage(imageRef.filename, imageRef.subfolder, imageRef.type);

    return { data: buffer, mimeType: 'image/png' };
  }

  /**
   * Poll GET /history/{promptId} every 5 s until the outputs object is non-empty or
   * the timeout is reached. An initial 5 s delay is applied before the first request.
   *
   * All node keys in the outputs object are scanned dynamically for images arrays.
   * Each image entry is validated for the required filename, subfolder, and type fields.
   * The first valid image entry is returned.
   *
   * onProgress is called at each poll interval with elapsed time in seconds.
   */
  private async pollForCompletion(
    promptId: string,
    onProgress?: (status: string) => Promise<void>,
  ): Promise<{ filename: string; subfolder: string; type: string }> {
    const POLL_INTERVAL_MS = 5_000;
    const MAX_POLLS = 57;

    // Initial delay — generation has not started yet at t=0
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));

    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      const elapsed = (attempt + 1) * (POLL_INTERVAL_MS / 1000);
      onProgress?.(`Generating... (${elapsed}s)`).catch(() => {});

      const historyRes = await fetch(`${this.baseUrl}/history/${promptId}`);
      if (!historyRes.ok) {
        throw new Error(`ComfyUI history fetch failed (${historyRes.status}) for prompt ${promptId}`);
      }

      const history = await historyRes.json() as Record<string, unknown>;
      const entry = history[promptId] as { outputs?: Record<string, unknown> } | undefined;

      if (entry?.outputs && Object.keys(entry.outputs).length > 0) {
        // Scan all node keys for an images array with valid entries
        for (const nodeId of Object.keys(entry.outputs)) {
          const nodeOutput = entry.outputs[nodeId] as Record<string, unknown> | undefined;
          if (!nodeOutput) continue;
          const images = nodeOutput.images as Array<Record<string, unknown>> | undefined;
          if (!Array.isArray(images)) continue;
          for (const img of images) {
            if (
              typeof img.filename === 'string' &&
              typeof img.subfolder === 'string' &&
              typeof img.type === 'string'
            ) {
              log.debug({ promptId, nodeId, filename: img.filename }, 'ComfyUI image found');
              return { filename: img.filename, subfolder: img.subfolder, type: img.type };
            }
          }
        }
      }

      if (attempt < MAX_POLLS - 1) {
        await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }

    throw new Error(`ComfyUI timed out after ${(5 + MAX_POLLS * 5)}s waiting for prompt ${promptId}`);
  }

  /**
   * Download a completed image from ComfyUI's /view endpoint.
   * Returns raw PNG bytes as a Node.js Buffer.
   */
  private async fetchImage(filename: string, subfolder: string, type: string): Promise<Buffer> {
    const params = new URLSearchParams({ filename, subfolder, type });
    const url = `${this.baseUrl}/view?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`ComfyUI image fetch failed (${response.status}): ${url}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async editImage(
    _imageData: Buffer,
    _maskData: Buffer | null,
    _prompt: string,
    _options?: ImageEditOptions,
  ): Promise<GeneratedImage> {
    throw createMediaCapabilityUnavailableError('image');
  }

  async variateImage(_imageData: Buffer, _options?: ImageVariationOptions): Promise<GeneratedImage> {
    throw createMediaCapabilityUnavailableError('image');
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
