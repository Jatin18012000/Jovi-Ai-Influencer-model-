import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProviderError } from '../../src/core/errors.js';
import { nowIso } from '../../src/core/ids.js';
import type { MediaStore } from '../../src/media/media-store.js';
import {
  ASPECT_RATIO_SIZES,
  type AspectRatio,
  type EditingRenderProvider,
  type ImageGenerationProvider,
  type ImageGenerationRequest,
  type MediaGenerationResult,
  type MediaProviderStatus,
  type RenderRequest,
  type VideoGenerationProvider,
  type VideoGenerationRequest,
  type VoiceGenerationProvider,
  type VoiceGenerationRequest,
} from '../../src/media/types.js';
import type { MediaKind } from '../../src/types/enums.js';

/**
 * TEST DOUBLES for media providers. They are LOCAL (not MOCK) so they exercise
 * the real-provider path of MediaService: they write real bytes through the
 * MediaStore, and MediaService verifies the file before marking COMPLETED.
 * They are not external integrations and prove nothing about ComfyUI, Flow,
 * a voice engine or an editor.
 */
const COST = { estimatedApiCost: 0, executionCostType: 'LOCAL_COMPUTE' as const, currency: 'USD' as const, basis: 'test double' };

abstract class FileWritingProvider {
  readonly kind = 'LOCAL' as const;
  abstract readonly id: string;
  abstract readonly mediaKind: MediaKind;
  readonly calls: unknown[] = [];

  constructor(
    protected readonly store: MediaStore,
    protected readonly behaviour: { available?: boolean; failFirst?: number; retryable?: boolean; lie?: boolean } = {},
  ) {}

  async inspectAvailability(): Promise<MediaProviderStatus> {
    const available = this.behaviour.available ?? true;
    return {
      provider: this.id,
      kind: this.kind,
      mediaKind: this.mediaKind,
      available,
      state: available ? 'AVAILABLE' : 'UNREACHABLE',
      reason: available ? 'test double' : 'test double offline',
      models: ['test-double'],
      checkedAt: nowIso(),
    };
  }
  supportedModels() {
    return ['test-double'];
  }
  supportedAspectRatios(): AspectRatio[] {
    return ['9:16', '4:5', '1:1', '16:9'];
  }
  estimateCost() {
    return COST;
  }

  protected produce(request: { productionId: string; assetId: string }, ext: string, mimeType: string, extra: Partial<MediaGenerationResult> = {}): MediaGenerationResult {
    this.calls.push(request);
    if ((this.behaviour.failFirst ?? 0) > 0) {
      this.behaviour.failFirst! -= 1;
      throw new ProviderError(this.id, 'transient test failure', { retryable: this.behaviour.retryable ?? true });
    }
    // A "lying" provider claims success without producing any file.
    const location = this.behaviour.lie
      ? this.store.pathFor(request.productionId, request.assetId, ext)
      : this.store.write(request.productionId, request.assetId, ext, Buffer.from(`${this.id}:${request.assetId}`));
    return { provider: this.id, model: 'test-double', status: 'COMPLETED', location, mimeType, cost: COST, metadata: { testDouble: true }, ...extra };
  }
}

export class TestImageProvider extends FileWritingProvider implements ImageGenerationProvider {
  readonly id = 'test-image';
  readonly mediaKind = 'IMAGE' as const;
  async generateImage(r: ImageGenerationRequest) {
    return this.produce(r, '.png', 'image/png', ASPECT_RATIO_SIZES[r.aspectRatio]);
  }
}

export class TestVideoProvider extends FileWritingProvider implements VideoGenerationProvider {
  readonly id = 'test-video';
  readonly mediaKind = 'VIDEO' as const;
  readonly supportsImageToVideo: boolean;
  constructor(store: MediaStore, behaviour: ConstructorParameters<typeof FileWritingProvider>[1] & { imageToVideo?: boolean } = {}) {
    super(store, behaviour);
    this.supportsImageToVideo = behaviour.imageToVideo ?? false;
  }
  async generateVideo(r: VideoGenerationRequest) {
    return this.produce(r, '.mp4', 'video/mp4', { ...ASPECT_RATIO_SIZES[r.aspectRatio], durationSeconds: r.durationSeconds });
  }
}

/** Returns a duration per script section so A/V sync can be checked. */
export class TestVoiceProvider extends FileWritingProvider implements VoiceGenerationProvider {
  readonly id = 'test-voice';
  readonly mediaKind = 'VOICE' as const;
  constructor(
    store: MediaStore,
    private readonly durations: Record<string, number>,
    behaviour: ConstructorParameters<typeof FileWritingProvider>[1] = {},
  ) {
    super(store, behaviour);
  }
  async synthesizeSpeech(r: VoiceGenerationRequest) {
    return this.produce(r, '.wav', 'audio/wav', { durationSeconds: this.durations[r.sceneId] ?? 1 });
  }
}

export class TestRenderProvider extends FileWritingProvider implements EditingRenderProvider {
  readonly id = 'test-render';
  readonly mediaKind = 'RENDER' as const;
  async renderEdit(r: RenderRequest) {
    return this.produce(r, '.mp4', 'video/mp4');
  }
}

// ---------------------------------------------------------------------------
// Fake ComfyUI HTTP server (implements the four endpoints the adapter uses)
// ---------------------------------------------------------------------------

export interface FakeComfyUI {
  url: string;
  prompts: Array<{ prompt: Record<string, unknown>; client_id: string }>;
  close(): Promise<void>;
}

export async function startFakeComfyUI(options: { mode?: 'ok' | 'node_error' | 'execution_error' | 'no_output' } = {}): Promise<FakeComfyUI> {
  const mode = options.mode ?? 'ok';
  const prompts: FakeComfyUI['prompts'] = [];
  const body = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data));
    });
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (code: number, value: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && url.pathname === '/system_stats') return json(200, { devices: [{ name: 'fake-gpu', type: 'cuda' }] });
    if (req.method === 'POST' && url.pathname === '/prompt') {
      const parsed = JSON.parse(await body(req)) as FakeComfyUI['prompts'][number];
      prompts.push(parsed);
      if (mode === 'node_error') return json(200, { prompt_id: 'p', node_errors: { '3': { errors: ['bad ckpt'] } } });
      return json(200, { prompt_id: `prompt-${prompts.length}`, number: prompts.length, node_errors: {} });
    }
    const history = /^\/history\/(.+)$/.exec(url.pathname);
    if (req.method === 'GET' && history) {
      const id = decodeURIComponent(history[1]!);
      if (mode === 'execution_error') return json(200, { [id]: { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', {}]] } } });
      if (mode === 'no_output') return json(200, { [id]: { outputs: {}, status: { status_str: 'success', completed: true } } });
      const prefix = String((prompts.at(-1)?.prompt['9'] as { inputs?: { filename_prefix?: string } })?.inputs?.filename_prefix ?? 'out');
      return json(200, { [id]: { outputs: { '9': { images: [{ filename: `${prefix}_00001_.png`, subfolder: '', type: 'output' }] } }, status: { status_str: 'success', completed: true } } });
    }
    if (req.method === 'GET' && url.pathname === '/view') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
    }
    json(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    prompts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A minimal API-format workflow with the adapter's placeholders. */
export const TEST_WORKFLOW = {
  '3': { class_type: 'KSampler', inputs: { seed: '{{SEED}}', steps: 20 } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: '{{WIDTH}}', height: '{{HEIGHT}}', batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{POSITIVE_PROMPT}}' } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '{{NEGATIVE_PROMPT}}' } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: '{{FILENAME_PREFIX}}' } },
};
