import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { ProviderError } from '../../src/core/errors.js';
import { newId } from '../../src/core/ids.js';
import { MediaInspector } from '../../src/media/media-inspector.js';
import { MediaStore } from '../../src/media/media-store.js';
import { ComfyUIImageProvider, ComfyUIVideoProvider } from '../../src/media/providers/comfyui-providers.js';
import { FFmpegRenderProvider } from '../../src/media/providers/ffmpeg-render-provider.js';
import { ElevenLabsVoiceProvider, MacOSSayVoiceProvider } from '../../src/media/providers/voice-providers.js';
import type { VoiceGenerationRequest } from '../../src/media/types.js';
import {
  pngBytes,
  startFakeComfyUI,
  startFakeElevenLabs,
  TEST_WORKFLOW,
  writeFakeFfmpegWithoutEncoders,
  writeFakeSay,
  type FakeComfyUI,
  type FakeElevenLabs,
} from '../fakes/fake-media.js';
import { createTestCore } from '../helpers.js';

/**
 * FAKE-SERVER / FAKE-BINARY integration tests. They exercise the real adapter
 * code against local stand-ins (HTTP servers and node scripts). They prove the
 * adapters speak the expected protocol; they do NOT prove that a real
 * ComfyUI, ElevenLabs account or macOS `say` works — see media.real.test.ts.
 */

let dir: string;
let refDir: string;
let store: MediaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jovi-fake-'));
  refDir = join(dir, 'references');
  mkdirSync(refDir);
  store = new MediaStore(join(dir, 'media'), refDir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ids = () => ({ productionId: newId('production'), assetId: newId('asset') });
const voiceRequest = (text = 'Three facts about me. One of them is a glitch.'): VoiceGenerationRequest => ({
  ...ids(),
  sceneId: 's1',
  text,
  voiceProfile: { name: 'Jovi', description: 'witty', providerVoiceId: null },
  language: 'en-GB',
  emotion: 'playful',
  pacing: 'fast',
});

describe('ComfyUI adapter — identity conditioning and image-to-video (fake ComfyUI server)', () => {
  let comfy: FakeComfyUI | null = null;
  afterEach(async () => {
    await comfy?.close();
    comfy = null;
  });
  const workflow = (extra: Record<string, unknown>) => {
    const path = join(dir, `wf-${Object.keys(extra).join('-')}.json`);
    writeFileSync(path, JSON.stringify({ ...TEST_WORKFLOW, ...extra }));
    return path;
  };

  it('derives capabilities from workflow placeholders', () => {
    const plain = new ComfyUIImageProvider({ url: 'http://127.0.0.1:9', workflowPath: workflow({}), timeoutMs: 1000 }, store);
    expect(plain.capabilities()).toMatchObject({ referenceImages: false, imageToVideo: false });
    const withRef = new ComfyUIImageProvider({ url: 'http://127.0.0.1:9', workflowPath: workflow({ '11': { inputs: { image: '{{REFERENCE_IMAGE}}' } } }), timeoutMs: 1000 }, store);
    expect(withRef.capabilities().referenceImages).toBe(true);
    const i2v = new ComfyUIVideoProvider({ url: 'http://127.0.0.1:9', workflowPath: workflow({ '12': { inputs: { image: '{{SOURCE_IMAGE}}' } } }), timeoutMs: 1000, maxVideoSeconds: 5 }, store);
    expect(i2v.capabilities()).toMatchObject({ imageToVideo: true, maxDurationSeconds: 5 });
  });

  it('uploads the approved reference image and fills {{REFERENCE_IMAGE}}; refuses paths outside the allowed directories', async () => {
    comfy = await startFakeComfyUI();
    const provider = new ComfyUIImageProvider({ url: comfy.url, workflowPath: workflow({ '11': { inputs: { image: '{{REFERENCE_IMAGE}}' } } }), timeoutMs: 5000, pollMs: 5 }, store);
    const reference = join(refDir, 'jovi-sheet.png');
    writeFileSync(reference, pngBytes(512, 512));
    const request = { ...ids(), sceneId: 'sc1', prompt: 'Jovi', negativePrompt: '', aspectRatio: '9:16' as const, referenceImages: [reference] };
    const result = await provider.generateImage(request);
    expect(comfy.uploads).toEqual(['jovi-sheet.png']);
    expect((comfy.prompts[0]!.prompt['11'] as { inputs: { image: string } }).inputs.image).toBe('jovi/jovi-sheet.png');
    expect((await new MediaInspector().inspect(result.location, 'IMAGE')).ok).toBe(true);

    await expect(provider.generateImage({ ...request, ...ids(), referenceImages: [] })).rejects.toThrow(/no approved reference image/);
    const outside = join(dir, 'elsewhere.png');
    writeFileSync(outside, pngBytes());
    const refused = await provider.generateImage({ ...request, ...ids(), referenceImages: [outside] }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ProviderError);
    expect((refused as ProviderError).message).toMatch(/not inside the media or reference directory/);
    expect(comfy.uploads).toHaveLength(1);
  });

  it('image-to-video uploads the scene image as {{SOURCE_IMAGE}} and requires one', async () => {
    comfy = await startFakeComfyUI();
    const provider = new ComfyUIVideoProvider({ url: comfy.url, workflowPath: workflow({ '12': { inputs: { image: '{{SOURCE_IMAGE}}', fps: '{{FPS}}' } } }), timeoutMs: 5000, pollMs: 5, fps: 24 }, store);
    const { productionId } = ids();
    const source = store.write(productionId, newId('asset'), '.png', pngBytes());
    await provider.generateVideo({ productionId, assetId: newId('asset'), sceneId: 'sc1', prompt: 'p', negativePrompt: '', aspectRatio: '9:16', durationSeconds: 2, sourceImages: [{ assetId: 'ast_x', location: source }] });
    expect(comfy.uploads).toHaveLength(1);
    expect((comfy.prompts[0]!.prompt['12'] as { inputs: Record<string, unknown> }).inputs).toEqual({ image: `jovi/${comfy.uploads[0]}`, fps: 24 });
    await expect(provider.generateVideo({ productionId, assetId: newId('asset'), sceneId: 'sc2', prompt: 'p', negativePrompt: '', aspectRatio: '9:16', durationSeconds: 2, sourceImages: [] })).rejects.toThrow(
      /needs a completed source image/,
    );
  });
});

describe('ComfyUI through MediaService (fake server) — verified COMPLETED asset', () => {
  let core: JoviCore;
  let comfy: FakeComfyUI;
  afterEach(async () => {
    await core?.close();
    await comfy?.close();
  });

  it('downloads, verifies and measures the output', async () => {
    comfy = await startFakeComfyUI();
    const wf = join(dir, 'wf.json');
    writeFileSync(wf, JSON.stringify(TEST_WORKFLOW));
    const media = join(dir, 'media');
    core = await createTestCore({ env: { JOVI_MEDIA_DIR: media, COMFYUI_URL: comfy.url, COMFYUI_IMAGE_WORKFLOW: wf } });
    const scope = core.events.scope(newId('correlation'));
    const task = core.tasks.create({ type: 'CREATIVE_PRODUCTION', goal: 'comfy', createdBy: 'test' }, scope);
    const p = core.productions.create(
      { taskId: task.id, sourceType: 'DIRECT', sourcePlanningTaskId: null, ideaId: 'i', idea: {}, productionContext: {}, identityVersion: 1, visualIdentityVersion: 1, simulated: false },
      scope,
    );
    const asset = await core.media.generateImage(
      { productionId: p.id, sceneId: 'sc1', aspectRatio: '9:16', request: { sceneId: 'sc1', prompt: 'Jovi in London', negativePrompt: '', aspectRatio: '9:16', referenceImages: [] } },
      scope,
    );
    expect(asset).toMatchObject({ status: 'COMPLETED', provider: 'comfyui-image', providerKind: 'LOCAL', width: 768, height: 1344, providerJobId: 'prompt-1' });
    expect((asset.metadata as { inspection: { ok: boolean; sha256: string } }).inspection).toMatchObject({ ok: true });
  });
});

describe('ElevenLabs adapter (fake ElevenLabs server)', () => {
  let server: FakeElevenLabs | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });
  const provider = (overrides: Partial<ConstructorParameters<typeof ElevenLabsVoiceProvider>[0]> = {}) =>
    new ElevenLabsVoiceProvider({ apiKey: 'test-key', voiceId: 'voice-jovi', model: 'eleven_multilingual_v2', baseUrl: server!.url, timeoutMs: 5000, statusTtlMs: 0, ...overrides }, store);

  it('discovery: NOT_CONFIGURED, MISCONFIGURED (no voice, bad key, unknown voice), AVAILABLE', async () => {
    server = await startFakeElevenLabs();
    expect((await provider({ apiKey: undefined }).inspectAvailability()).state).toBe('NOT_CONFIGURED');
    expect((await provider({ voiceId: undefined }).inspectAvailability()).reason).toMatch(/ELEVENLABS_VOICE_ID not set/);
    expect((await provider({ apiKey: 'wrong' }).inspectAvailability()).reason).toMatch(/API key rejected \(HTTP 401\)/);
    expect((await provider({ voiceId: 'someone-else' }).inspectAvailability()).reason).toMatch(/not found/);
    expect(await provider().inspectAvailability()).toMatchObject({ available: true, state: 'AVAILABLE', kind: 'CLOUD', reason: 'voice Jovi (approved)' });
    expect((await provider({ baseUrl: 'http://127.0.0.1:9' }).inspectAvailability()).state).toBe('UNREACHABLE');
  });

  it('synthesizes with the approved voice and model; the key only travels as a header', async () => {
    server = await startFakeElevenLabs();
    const request = voiceRequest();
    const result = await provider().synthesizeSpeech(request);
    const call = server.requests.at(-1)!;
    expect(call.path).toBe('POST /v1/text-to-speech/voice-jovi?output_format=mp3_44100_128');
    expect(call.apiKey).toBe('test-key');
    expect(call.body).toEqual({ text: request.text, model_id: 'eleven_multilingual_v2' });
    const inspection = await new MediaInspector().inspect(result.location, 'VOICE');
    expect(inspection).toMatchObject({ ok: true, format: 'mp3', durationSeconds: 2 });
    expect(JSON.stringify(result)).not.toContain('test-key');
  });

  it('classifies failures: 429 retryable, 400 permanent, and never leaks the key', async () => {
    server = await startFakeElevenLabs({ mode: 'rate_limited' });
    const limited = await provider().synthesizeSpeech(voiceRequest()).catch((e: unknown) => e);
    expect(limited).toMatchObject({ retryable: true });
    await server.close();
    server = await startFakeElevenLabs({ mode: 'bad_request' });
    const bad = (await provider().synthesizeSpeech(voiceRequest()).catch((e: unknown) => e)) as ProviderError;
    expect(bad.retryable).toBe(false);
    expect(bad.message).not.toContain('test-key');
  });
});

describe('macOS say adapter (fake `say` binary)', () => {
  it('discovers the approved voice and synthesizes WAV from stdin', async () => {
    const fake = writeFakeSay(dir);
    const say = (voice: string | undefined) => new MacOSSayVoiceProvider({ sayPath: fake.path, voice, timeoutMs: 10_000, requireDarwin: false, statusTtlMs: 0 }, store);
    expect((await say(undefined).inspectAvailability()).state).toBe('NOT_CONFIGURED');
    expect((await say('Karen').inspectAvailability()).reason).toMatch(/voice "Karen" is not installed \(2 voices found/);
    const serena = say('Serena');
    expect(await serena.inspectAvailability()).toMatchObject({ available: true, reason: 'voice Serena (en-GB)' });
    expect(serena.capabilities().languages).toEqual(['en']);

    const request = voiceRequest('One two three four five six');
    const result = await serena.synthesizeSpeech(request);
    const inspection = await new MediaInspector().inspect(result.location, 'VOICE');
    expect(inspection).toMatchObject({ ok: true, format: 'wav', durationSeconds: 2 });
    const [call] = readFileSync(fake.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; text: string });
    expect(call!.text).toBe('One two three four five six');
    expect(call!.args).toEqual(['-v', 'Serena', '-r', '210', '--file-format=WAVE', '--data-format=LEI16@22050', '-o', result.location, '-f', '-']);
    // The spoken text is never an argument (no flag injection).
    expect(call!.args).not.toContain(request.text);
  });

  it('is unavailable off macOS unless explicitly overridden', async () => {
    const say = new MacOSSayVoiceProvider({ sayPath: '/usr/bin/say', voice: 'Serena', timeoutMs: 1000, statusTtlMs: 0 }, store);
    const status = await say.inspectAvailability();
    if (process.platform === 'darwin') expect(status.state).not.toBe('NOT_CONFIGURED');
    else expect(status).toMatchObject({ available: false, state: 'UNREACHABLE', reason: `macOS say is not available on ${process.platform}` });
  });
});

describe('ffmpeg render adapter discovery (fake binaries)', () => {
  it('NOT_CONFIGURED without a path, UNREACHABLE for a missing binary, MISCONFIGURED without encoders', async () => {
    const make = (ffmpegPath: string | undefined) => new FFmpegRenderProvider({ ffmpegPath, timeoutMs: 10_000, statusTtlMs: 0 }, store);
    expect((await make(undefined).inspectAvailability()).state).toBe('NOT_CONFIGURED');
    expect((await make(join(dir, 'nope')).inspectAvailability()).state).toBe('UNREACHABLE');
    expect((await make(writeFakeFfmpegWithoutEncoders(dir)).inspectAvailability()).reason).toBe('ffmpeg lacks encoders: libx264, aac, mov_text');
    await expect(
      make(undefined).renderEdit({ ...ids(), editPlan: {}, inputs: [] }),
    ).rejects.toThrow(/JOVI_FFMPEG_PATH not set/);
  });

  it('refuses unrenderable plans and inputs outside the media store', async () => {
    const provider = new FFmpegRenderProvider({ ffmpegPath: writeFakeFfmpegWithoutEncoders(dir), timeoutMs: 10_000 }, store);
    await expect(provider.renderEdit({ ...ids(), editPlan: { clips: [] }, inputs: [] })).rejects.toThrow(/edit plan is not renderable/);
    const plan = { aspectRatio: '9:16', totalDurationSeconds: 1, clips: [{ sceneId: 'sc1', source: 'MISSING', assetId: null, start: 0, end: 1 }], audio: { voice: [] }, captions: [], exportSettings: { width: 64, height: 64, fps: 10, bitrateMbps: 1 } };
    await expect(provider.renderEdit({ ...ids(), editPlan: plan, inputs: [{ assetId: 'ast_x', kind: 'IMAGE', location: '/etc/passwd' }] })).rejects.toThrow(/not a file inside the media store/);
  });
});
