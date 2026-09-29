import { chmodSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
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
  type MediaCapabilities,
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
// ---------------------------------------------------------------------------
// Minimal valid media files (real container signatures, so the MediaInspector
// verifies them exactly as it verifies provider output)
// ---------------------------------------------------------------------------

export function pngBytes(width = 8, height = 8): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

export function wavBytes(seconds: number, sampleRate = 8000): Buffer {
  const dataSize = Math.round(seconds * sampleRate) * 2;
  const b = Buffer.alloc(44 + dataSize);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + dataSize, 4);
  b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28); // byte rate
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(dataSize, 40);
  return b;
}

export function mp4Bytes(seconds: number): Buffer {
  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0);
  ftyp.write('ftypisom', 4, 'latin1');
  const mvhd = Buffer.alloc(32);
  mvhd.writeUInt32BE(32, 0);
  mvhd.write('mvhd', 4, 'latin1');
  mvhd.writeUInt32BE(1000, 20); // timescale
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 24); // duration
  const moov = Buffer.alloc(8);
  moov.writeUInt32BE(8 + mvhd.length, 0);
  moov.write('moov', 4, 'latin1');
  return Buffer.concat([ftyp, moov, mvhd]);
}

const COST = { estimatedApiCost: 0, executionCostType: 'LOCAL_COMPUTE' as const, currency: 'USD' as const, basis: 'test double' };

abstract class FileWritingProvider {
  abstract readonly kind: 'LOCAL' | 'CLOUD';
  abstract readonly id: string;
  abstract readonly mediaKind: MediaKind;
  readonly calls: unknown[] = [];

  constructor(
    protected readonly store: MediaStore,
    /** Mutable on purpose: tests flip `available` to model an operator configuring a provider. */
    readonly behaviour: { available?: boolean; failFirst?: number; retryable?: boolean; lie?: boolean; garbage?: boolean; kind?: 'LOCAL' | 'CLOUD'; caps?: Partial<MediaCapabilities> } = {},
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
  capabilities(): MediaCapabilities {
    return {
      aspectRatios: ['9:16', '4:5', '1:1', '16:9'] as AspectRatio[],
      maxDurationSeconds: null,
      imageToVideo: false,
      referenceImages: false,
      languages: null,
      outputFormats: [],
      ...this.behaviour.caps,
    };
  }
  estimateCost() {
    return COST;
  }

  protected produce(request: { productionId: string; assetId: string }, ext: string, mimeType: string, extra: Partial<MediaGenerationResult> = {}, bytes?: Buffer): MediaGenerationResult {
    this.calls.push(request);
    if ((this.behaviour.failFirst ?? 0) > 0) {
      this.behaviour.failFirst! -= 1;
      throw new ProviderError(this.id, 'transient test failure', { retryable: this.behaviour.retryable ?? true });
    }
    // A "lying" provider claims success without producing any file.
    const location = this.behaviour.lie
      ? this.store.pathFor(request.productionId, request.assetId, ext)
      : this.store.write(request.productionId, request.assetId, ext, this.behaviour.garbage ? Buffer.from('<html>502 Bad Gateway</html>') : (bytes ?? Buffer.from(`${this.id}:${request.assetId}`)));
    return { provider: this.id, model: 'test-double', status: 'COMPLETED', location, mimeType, cost: COST, metadata: { testDouble: true }, ...extra };
  }
}

export class TestImageProvider extends FileWritingProvider implements ImageGenerationProvider {
  readonly id: string;
  readonly kind: 'LOCAL' | 'CLOUD';
  readonly mediaKind = 'IMAGE' as const;
  constructor(store: MediaStore, behaviour: FileWritingProvider['behaviour'] = {}, id = 'test-image') {
    super(store, behaviour);
    this.id = id;
    this.kind = behaviour.kind ?? 'LOCAL';
  }
  async generateImage(r: ImageGenerationRequest) {
    const size = ASPECT_RATIO_SIZES[r.aspectRatio];
    return this.produce(r, '.png', 'image/png', size, pngBytes(size.width, size.height));
  }
}

export class TestVideoProvider extends FileWritingProvider implements VideoGenerationProvider {
  readonly id: string;
  readonly kind = 'LOCAL' as const;
  readonly mediaKind = 'VIDEO' as const;
  readonly requests: VideoGenerationRequest[] = [];
  constructor(store: MediaStore, behaviour: FileWritingProvider['behaviour'] & { imageToVideo?: boolean } = {}, id = 'test-video') {
    super(store, { ...behaviour, caps: { imageToVideo: behaviour.imageToVideo ?? false, ...behaviour.caps } });
    this.id = id;
  }
  async generateVideo(r: VideoGenerationRequest) {
    this.requests.push(r);
    return this.produce(r, '.mp4', 'video/mp4', { ...ASPECT_RATIO_SIZES[r.aspectRatio], durationSeconds: r.durationSeconds }, mp4Bytes(r.durationSeconds));
  }
}

/** Returns a duration per script section so A/V sync can be checked. */
/** Writes WAV files whose real (header) duration is taken from `durations` per script section. */
export class TestVoiceProvider extends FileWritingProvider implements VoiceGenerationProvider {
  readonly id: string;
  readonly kind: 'LOCAL' | 'CLOUD';
  readonly mediaKind = 'VOICE' as const;
  constructor(
    store: MediaStore,
    private readonly durations: Record<string, number>,
    behaviour: FileWritingProvider['behaviour'] = {},
    id = 'test-voice',
  ) {
    super(store, behaviour);
    this.id = id;
    this.kind = behaviour.kind ?? 'LOCAL';
  }
  async synthesizeSpeech(r: VoiceGenerationRequest) {
    const seconds = this.durations[r.sceneId] ?? 1;
    // Deliberately claims a wrong duration: the measured WAV duration must win.
    return this.produce(r, '.wav', 'audio/wav', { durationSeconds: 999 }, wavBytes(seconds));
  }
}

export class TestRenderProvider extends FileWritingProvider implements EditingRenderProvider {
  readonly id = 'test-render';
  readonly kind = 'LOCAL' as const;
  readonly mediaKind = 'RENDER' as const;
  async renderEdit(r: RenderRequest) {
    const seconds = (r.editPlan as { totalDurationSeconds?: number }).totalDurationSeconds ?? 1;
    return this.produce(r, '.mp4', 'video/mp4', {}, mp4Bytes(seconds));
  }
}

// ---------------------------------------------------------------------------
// Fake ComfyUI HTTP server (implements the four endpoints the adapter uses)
// ---------------------------------------------------------------------------

export interface FakeComfyUI {
  url: string;
  prompts: Array<{ prompt: Record<string, unknown>; client_id: string }>;
  uploads: string[];
  close(): Promise<void>;
}

export async function startFakeComfyUI(options: { mode?: 'ok' | 'node_error' | 'execution_error' | 'no_output' } = {}): Promise<FakeComfyUI> {
  const mode = options.mode ?? 'ok';
  const prompts: FakeComfyUI['prompts'] = [];
  const uploads: string[] = [];
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
    if (req.method === 'POST' && url.pathname === '/upload/image') {
      const raw = await body(req);
      const name = /filename="([^"]+)"/.exec(raw)?.[1] ?? 'upload.png';
      uploads.push(name);
      return json(200, { name, subfolder: 'jovi', type: 'input' });
    }
    if (req.method === 'GET' && url.pathname === '/view') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(pngBytes(768, 1344));
    }
    json(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    prompts,
    uploads,
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

// ---------------------------------------------------------------------------
// Fake ElevenLabs HTTP server (the two endpoints the adapter uses)
// ---------------------------------------------------------------------------

export interface FakeElevenLabs {
  url: string;
  requests: Array<{ path: string; apiKey: string | undefined; body: Record<string, unknown> | null }>;
  close(): Promise<void>;
}

/** 128 kbps MPEG-1 Layer III frames: `seconds` of (silent) CBR audio. */
export function mp3Bytes(seconds: number): Buffer {
  const b = Buffer.alloc(Math.round(seconds * 16000));
  b.set([0xff, 0xfb, 0x90, 0x64]);
  return b;
}

export async function startFakeElevenLabs(options: { key?: string; voiceId?: string; mode?: 'ok' | 'rate_limited' | 'bad_request' } = {}): Promise<FakeElevenLabs> {
  const key = options.key ?? 'test-key';
  const voiceId = options.voiceId ?? 'voice-jovi';
  const requests: FakeElevenLabs['requests'] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const apiKey = req.headers['xi-api-key'] as string | undefined;
      requests.push({ path: `${req.method} ${url.pathname}${url.search}`, apiKey, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null });
      const json = (code: number, value: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (apiKey !== key) return json(401, { detail: { status: 'invalid_api_key' } });
      const voice = /^\/v1\/voices\/(.+)$/.exec(url.pathname);
      if (req.method === 'GET' && voice) return voice[1] === voiceId ? json(200, { voice_id: voiceId, name: 'Jovi (approved)' }) : json(404, { detail: 'voice_not_found' });
      const tts = /^\/v1\/text-to-speech\/(.+)$/.exec(url.pathname);
      if (req.method === 'POST' && tts) {
        if (options.mode === 'rate_limited') return json(429, { detail: 'too_many_requests' });
        if (options.mode === 'bad_request') return json(400, { detail: 'invalid text' });
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        return res.end(mp3Bytes(2));
      }
      json(404, { detail: 'not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

// ---------------------------------------------------------------------------
// Fake binaries (node scripts) standing in for macOS `say` and ffmpeg
// ---------------------------------------------------------------------------

/**
 * Writes an executable stand-in for macOS `say`: lists two voices for
 * `-v ?`, otherwise reads text from stdin, logs the call and writes a real
 * 16-bit WAV (3 words per second) to the `-o` path.
 */
export function writeFakeSay(dir: string): { path: string; log: string } {
  const path = join(dir, 'fake-say');
  const log = join(dir, 'fake-say.log');
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '-v' && args[1] === '?') {
  process.stdout.write('Daniel              en_GB    # Hello, my name is Daniel.\\nSerena              en_GB    # Hello, my name is Serena.\\n');
  process.exit(0);
}
let text = '';
process.stdin.on('data', (d) => (text += d));
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, text }) + '\\n');
  const words = text.split(/\\s+/).filter(Boolean).length;
  const rate = 8000;
  const dataSize = Math.round((words / 3) * rate) * 2;
  const b = Buffer.alloc(44 + dataSize);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + dataSize, 4); b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1'); b.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(args[args.indexOf('-o') + 1], b);
});
`,
  );
  chmodSync(path, 0o755);
  return { path, log };
}

/** An "ffmpeg" that runs but lacks the required encoders (→ MISCONFIGURED). */
export function writeFakeFfmpegWithoutEncoders(dir: string): string {
  const path = join(dir, 'fake-ffmpeg');
  writeFileSync(path, `#!${process.execPath}\nprocess.stdout.write(process.argv.includes('-encoders') ? ' V..... mpeg4  MPEG-4 part 2\\n' : 'ffmpeg version fake-0.1\\n');\n`);
  chmodSync(path, 0o755);
  return path;
}
