import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { loadConfig } from '../../src/core/config/config.js';
import { loadEnvFile } from '../../src/core/config/load-env.js';
import { newId } from '../../src/core/ids.js';
import { MediaInspector } from '../../src/media/media-inspector.js';
import { MediaStore } from '../../src/media/media-store.js';
import { runProcess } from '../../src/media/process-runner.js';
import { ComfyUIImageProvider } from '../../src/media/providers/comfyui-providers.js';
import { FFmpegRenderProvider } from '../../src/media/providers/ffmpeg-render-provider.js';
import { ElevenLabsVoiceProvider, MacOSSayVoiceProvider } from '../../src/media/providers/voice-providers.js';
import {
  ASPECT_RATIO_SIZES,
  type AspectRatio,
  type ImageGenerationProvider,
  type ImageGenerationRequest,
  type MediaCapabilities,
  type MediaProviderStatus,
  type VideoGenerationProvider,
  type VideoGenerationRequest,
  type VoiceGenerationProvider,
  type VoiceGenerationRequest,
} from '../../src/media/types.js';
import { countingLocalModel, DIRECT_IDEA, LOCKED_PROFILE } from '../fakes/production-fixtures.js';
import { createTestCore } from '../helpers.js';

/**
 * REAL media-provider end-to-end tests. Skipped unless explicitly enabled:
 *
 *   JOVI_MEDIA_REAL=1 npx vitest run tests/integration/media.real.test.ts
 *
 * Each provider block runs only when that provider is configured (env or
 * .env) and otherwise is reported as skipped — never as passed:
 *   ffmpeg render    JOVI_FFMPEG_PATH (+ JOVI_FFPROBE_PATH for measurement)
 *   ComfyUI image    COMFYUI_URL + COMFYUI_IMAGE_WORKFLOW (server running)
 *   macOS say        MACOS_SAY_VOICE (macOS only)
 *   ElevenLabs       ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID (spends credits)
 */
const enabled = process.env.JOVI_MEDIA_REAL === '1';
if (enabled) loadEnvFile();
const env = loadConfig(process.env).media;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'jovi-real-media-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ids = () => ({ productionId: newId('production'), assetId: newId('asset') });
const ALL: AspectRatio[] = ['9:16', '4:5', '1:1', '16:9'];
const available = (id: string, kind: MediaProviderStatus['mediaKind']): MediaProviderStatus => ({
  provider: id,
  kind: 'LOCAL',
  mediaKind: kind,
  available: true,
  state: 'AVAILABLE',
  reason: 'ffmpeg test pattern',
  models: ['lavfi'],
  checkedAt: new Date().toISOString(),
});
const caps = (extra: Partial<MediaCapabilities> = {}): MediaCapabilities => ({ aspectRatios: ALL, maxDurationSeconds: null, imageToVideo: false, referenceImages: false, languages: null, outputFormats: [], ...extra });
const COST = { estimatedApiCost: 0, executionCostType: 'LOCAL_COMPUTE' as const, currency: 'USD' as const, basis: 'ffmpeg test pattern' };

/**
 * Real, decodable INPUT media synthesised by ffmpeg (lavfi test patterns and
 * tones). They stand in for ComfyUI/voice engines so the REAL ffmpeg render
 * engine can be exercised through the full pipeline. They validate nothing
 * about image, video or voice generation quality.
 */
function patternProviders(ffmpeg: string, store: MediaStore) {
  const run = async (args: string[]) => {
    const r = await runProcess('pattern', ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(r.stderr);
  };
  const image: ImageGenerationProvider = {
    id: 'pattern-image', kind: 'LOCAL', mediaKind: 'IMAGE',
    inspectAvailability: async () => available('pattern-image', 'IMAGE'), supportedModels: () => ['lavfi'], capabilities: () => caps(), estimateCost: () => COST,
    async generateImage(r: ImageGenerationRequest) {
      const { width, height } = ASPECT_RATIO_SIZES[r.aspectRatio];
      const out = store.prepare(r.productionId, r.assetId, '.png');
      await run(['-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}`, '-frames:v', '1', out]);
      return { provider: 'pattern-image', model: 'lavfi', status: 'COMPLETED', location: out, mimeType: 'image/png', cost: COST, metadata: {} };
    },
  };
  const video: VideoGenerationProvider = {
    id: 'pattern-video', kind: 'LOCAL', mediaKind: 'VIDEO',
    inspectAvailability: async () => available('pattern-video', 'VIDEO'), supportedModels: () => ['lavfi'], capabilities: () => caps(), estimateCost: () => COST,
    async generateVideo(r: VideoGenerationRequest) {
      const { width, height } = ASPECT_RATIO_SIZES[r.aspectRatio];
      const out = store.prepare(r.productionId, r.assetId, '.mp4');
      await run(['-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=24`, '-t', String(r.durationSeconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
      return { provider: 'pattern-video', model: 'lavfi', status: 'COMPLETED', location: out, mimeType: 'video/mp4', cost: COST, metadata: {} };
    },
  };
  const durations: Record<string, number> = { s1: 3, s2: 8, s3: 4 };
  const voice: VoiceGenerationProvider = {
    id: 'pattern-voice', kind: 'LOCAL', mediaKind: 'VOICE',
    inspectAvailability: async () => available('pattern-voice', 'VOICE'), supportedModels: () => ['lavfi'], capabilities: () => caps(), estimateCost: () => COST,
    async synthesizeSpeech(r: VoiceGenerationRequest) {
      const out = store.prepare(r.productionId, r.assetId, '.wav');
      await run(['-f', 'lavfi', '-i', `sine=frequency=220:duration=${durations[r.sceneId] ?? 2}`, '-ar', '22050', '-ac', '1', out]);
      return { provider: 'pattern-voice', model: 'lavfi', status: 'COMPLETED', location: out, mimeType: 'audio/wav', cost: COST, metadata: {} };
    },
  };
  return [image, video, voice];
}

describe.skipIf(!enabled || !env.ffmpegPath)('REAL ffmpeg render engine', () => {
  let core: JoviCore;
  afterAll(async () => core?.close());

  it('discovers ffmpeg with the required encoders', async () => {
    const provider = new FFmpegRenderProvider({ ffmpegPath: env.ffmpegPath, timeoutMs: env.ffmpegTimeoutMs }, new MediaStore(join(dir, 'probe')));
    const status = await provider.inspectAvailability();
    console.log('ffmpeg discovery:', JSON.stringify(status));
    expect(status.available, status.reason).toBe(true);
  });

  it('renders a full production (pattern inputs) to a verified 1080x1920 MP4 through the pipeline', { timeout: 600_000 }, async () => {
    const mediaDir = join(dir, 'media');
    const store = new MediaStore(mediaDir);
    const renderer = new FFmpegRenderProvider({ ffmpegPath: env.ffmpegPath, timeoutMs: env.ffmpegTimeoutMs }, store);
    const text = countingLocalModel();
    core = await createTestCore({
      providers: [text.model],
      mediaProviders: [...patternProviders(env.ffmpegPath!, store), renderer],
      env: { JOVI_MEDIA_DIR: mediaDir, ...(env.ffprobePath ? { JOVI_FFPROBE_PATH: env.ffprobePath } : {}) },
    });
    core.visualIdentity.createVersion(LOCKED_PROFILE, 'test', 'lock for render test');
    const result = await core.production.start({ idea: DIRECT_IDEA });
    const render = core.assets.list(result.productionId!, 'RENDER')[0]!;
    console.log(JSON.stringify({ productionStatus: result.productionStatus, qa: result.qaStatus, render: { status: render.status, reason: render.statusReason, location: render.location, duration: render.durationSeconds, width: render.width, height: render.height, inspection: (render.metadata as { inspection?: unknown }).inspection } }, null, 2));

    expect(render.status, render.statusReason ?? '').toBe('COMPLETED');
    expect(render.provider).toBe('ffmpeg-render');
    expect(render.width).toBe(1080);
    expect(render.height).toBe(1920);
    expect(Math.abs((render.durationSeconds ?? 0) - 15)).toBeLessThan(0.25);
    expect((render.metadata as { placeholderScenes: string[] }).placeholderScenes).toEqual([]);
    const inspection = await new MediaInspector({ ffprobePath: env.ffprobePath }).inspect(render.location!, 'RENDER');
    expect(inspection.ok).toBe(true);
    if (env.ffprobePath) {
      const streams = await runProcess('ffprobe', env.ffprobePath, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', render.location!], { timeoutMs: 30_000 });
      const types = (JSON.parse(streams.stdout) as { streams: Array<{ codec_type: string; codec_name: string }> }).streams.map((s) => `${s.codec_type}:${s.codec_name}`);
      console.log('render streams:', types);
      expect(types).toEqual(expect.arrayContaining(['video:h264', 'audio:aac', 'subtitle:mov_text']));
    }
    expect(result.productionStatus).toBe('AWAITING_HUMAN_APPROVAL');
    expect(result.publishingGate?.autonomousPublishingAllowed).toBe(false);
  });
});

describe.skipIf(!enabled || !env.comfyuiUrl || !env.comfyuiImageWorkflow)('REAL ComfyUI image generation', () => {
  it('generates one verified image', { timeout: 1_800_000 }, async () => {
    const store = new MediaStore(join(dir, 'comfy'));
    const provider = new ComfyUIImageProvider({ url: env.comfyuiUrl, workflowPath: env.comfyuiImageWorkflow, timeoutMs: env.comfyuiTimeoutMs }, store);
    const status = await provider.inspectAvailability();
    console.log('ComfyUI discovery:', JSON.stringify(status));
    expect(status.available, status.reason).toBe(true);
    const result = await provider.generateImage({ ...ids(), sceneId: 'sc1', prompt: 'an original fictional young woman in a London café, soft window light, 35mm photo', negativePrompt: 'blurry, text, watermark', aspectRatio: '9:16', referenceImages: [] });
    const inspection = await new MediaInspector({ ffprobePath: env.ffprobePath }).inspect(result.location, 'IMAGE');
    console.log('ComfyUI output:', result.location, JSON.stringify(inspection));
    expect(inspection.ok).toBe(true);
  });
});

describe.skipIf(!enabled || !env.sayVoice || process.platform !== 'darwin')('REAL macOS say voice', () => {
  it('synthesizes verified WAV speech with the approved voice', { timeout: 120_000 }, async () => {
    const provider = new MacOSSayVoiceProvider({ sayPath: env.sayPath, voice: env.sayVoice, timeoutMs: env.voiceTimeoutMs }, new MediaStore(join(dir, 'say')));
    const status = await provider.inspectAvailability();
    console.log('say discovery:', JSON.stringify(status));
    expect(status.available, status.reason).toBe(true);
    const result = await provider.synthesizeSpeech({ ...ids(), sceneId: 's1', text: 'Three facts about me. One of them is a glitch. Go.', voiceProfile: { name: 'Jovi', description: '', providerVoiceId: null }, language: 'en-GB', emotion: 'playful', pacing: 'natural' });
    const inspection = await new MediaInspector({ ffprobePath: env.ffprobePath }).inspect(result.location, 'VOICE');
    console.log('say output:', result.location, JSON.stringify(inspection));
    expect(inspection).toMatchObject({ ok: true, format: 'wav' });
    expect(inspection.durationSeconds ?? 0).toBeGreaterThan(1);
  });
});

describe.skipIf(!enabled || !env.elevenlabs.apiKey || !env.elevenlabs.voiceId)('REAL ElevenLabs voice (uses API credits)', () => {
  it('synthesizes verified MP3 speech with the approved voice', { timeout: 120_000 }, async () => {
    const provider = new ElevenLabsVoiceProvider({ ...env.elevenlabs, timeoutMs: env.voiceTimeoutMs }, new MediaStore(join(dir, 'elevenlabs')));
    const status = await provider.inspectAvailability();
    console.log('ElevenLabs discovery:', JSON.stringify({ state: status.state, reason: status.reason }));
    expect(status.available, status.reason).toBe(true);
    const result = await provider.synthesizeSpeech({ ...ids(), sceneId: 's1', text: 'Three facts about me. One of them is a glitch.', voiceProfile: { name: 'Jovi', description: '', providerVoiceId: null }, language: 'en-GB', emotion: 'playful', pacing: 'natural' });
    const inspection = await new MediaInspector({ ffprobePath: env.ffprobePath }).inspect(result.location, 'VOICE');
    console.log('ElevenLabs output:', result.location, JSON.stringify(inspection));
    expect(inspection).toMatchObject({ ok: true, format: 'mp3' });
  });
});
