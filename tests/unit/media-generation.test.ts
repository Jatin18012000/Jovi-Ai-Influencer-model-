import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IMAGE_AGENT_DEFINITION, VOICE_AGENT_DEFINITION } from '../../src/agents/production/media-agents.js';
import { createToolKit } from '../../src/agents/toolkit.js';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { PermissionDeniedError, ProviderError } from '../../src/core/errors.js';
import { newId } from '../../src/core/ids.js';
import { PermissionGuard } from '../../src/core/permissions/permissions.js';
import { MediaInspector, sniffFormat } from '../../src/media/media-inspector.js';
import { MediaProviderRegistry } from '../../src/media/media-provider-registry.js';
import { MediaStore } from '../../src/media/media-store.js';
import { runProcess } from '../../src/media/process-runner.js';
import { buildRenderCommand, buildSrt, type RenderPlan } from '../../src/media/providers/ffmpeg-render-provider.js';
import { GoogleFlowVideoProvider } from '../../src/media/providers/unintegrated-providers.js';
import { parseSayVoices } from '../../src/media/providers/voice-providers.js';
import { capabilityMismatch, type MediaCapabilities } from '../../src/media/types.js';
import { mp4Bytes, pngBytes, TestImageProvider, TestVideoProvider, TestVoiceProvider, wavBytes } from '../fakes/fake-media.js';
import { clearForMedia, createTestCore } from '../helpers.js';

/** DETERMINISTIC unit tests for the Phase 9 media layer (no network, no binaries except `node`). */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jovi-p9-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CAPS: MediaCapabilities = { aspectRatios: ['9:16', '16:9'], maxDurationSeconds: 10, imageToVideo: false, referenceImages: false, languages: ['en'], outputFormats: ['.mp4'] };

describe('capability matching', () => {
  it('reports the first unmet hard requirement', () => {
    expect(capabilityMismatch('LOCAL', CAPS, { aspectRatio: '9:16', durationSeconds: 8, language: 'en-GB' })).toBeNull();
    expect(capabilityMismatch('LOCAL', CAPS, { aspectRatio: '1:1' })).toMatch(/aspect ratio 1:1/);
    expect(capabilityMismatch('LOCAL', CAPS, { durationSeconds: 12 })).toMatch(/exceeds provider maximum 10s/);
    expect(capabilityMismatch('LOCAL', CAPS, { language: 'fr-FR' })).toMatch(/language fr-FR/);
    expect(capabilityMismatch('CLOUD', CAPS, { privacy: 'LOCAL_ONLY' })).toMatch(/LOCAL_ONLY excludes cloud/);
    expect(capabilityMismatch('CLOUD', CAPS, { privacy: 'STANDARD' })).toBeNull();
    expect(capabilityMismatch('LOCAL', { ...CAPS, maxDurationSeconds: null, languages: null }, { durationSeconds: 600, language: 'ja-JP' })).toBeNull();
  });
});

describe('provider discovery and selection', () => {
  it('orders capable providers: operator preference, soft preferences, LOCAL before CLOUD, then registration', async () => {
    const store = new MediaStore(dir);
    const cloud = new TestImageProvider(store, { kind: 'CLOUD' }, 'cloud-image');
    const local = new TestImageProvider(store, {}, 'local-image');
    const refs = new TestImageProvider(store, { kind: 'CLOUD', caps: { referenceImages: true } }, 'ref-image');

    const plain = new MediaProviderRegistry();
    [cloud, local, refs].forEach((p) => plain.register(p));
    expect((await plain.candidates('IMAGE')).candidates.map((p) => p.id)).toEqual(['local-image', 'cloud-image', 'ref-image']);
    // A soft preference (reference images for identity) moves a capable provider ahead.
    expect((await plain.candidates('IMAGE', {}, { referenceImages: true })).candidates.map((p) => p.id)).toEqual(['ref-image', 'local-image', 'cloud-image']);
    // The operator's explicit preference wins over everything else.
    const preferred = new MediaProviderRegistry(['cloud-image']);
    [cloud, local, refs].forEach((p) => preferred.register(p));
    const selection = await preferred.candidates('IMAGE', {}, { referenceImages: true });
    expect(selection.candidates.map((p) => p.id)).toEqual(['cloud-image', 'ref-image', 'local-image']);
    expect(selection.reason).toBe('cloud-image selected (fallbacks: ref-image, local-image)');
  });

  it('excludes unavailable and incapable providers with reasons, and honours LOCAL_ONLY privacy', async () => {
    const store = new MediaStore(dir);
    const registry = new MediaProviderRegistry();
    registry.register(new GoogleFlowVideoProvider());
    registry.register(new TestVideoProvider(store, { caps: { maxDurationSeconds: 4 } }, 'short-video'));
    registry.register(new TestVoiceProvider(store, {}, { kind: 'CLOUD' }, 'cloud-voice'));

    const video = await registry.candidates('VIDEO', { aspectRatio: '9:16', durationSeconds: 6 });
    expect(video.candidates).toEqual([]);
    expect(video.excluded).toEqual([
      { provider: 'google-flow', reason: expect.stringMatching(/^NOT_INTEGRATED/) },
      { provider: 'short-video', reason: 'INCAPABLE — duration 6s exceeds provider maximum 4s' },
    ]);
    expect(video.reason).toMatch(/^NO_AVAILABLE_VIDEO_PROVIDER/);

    const voice = await registry.candidates('VOICE', { privacy: 'LOCAL_ONLY' });
    expect(voice.candidates).toEqual([]);
    expect(voice.reason).toMatch(/cloud-voice: INCAPABLE — privacy LOCAL_ONLY excludes cloud providers/);
    expect((await registry.candidates('VOICE', { privacy: 'STANDARD' })).candidates.map((p) => p.id)).toEqual(['cloud-voice']);
  });

  it('refuses duplicate provider ids', () => {
    const store = new MediaStore(dir);
    const registry = new MediaProviderRegistry();
    registry.register(new TestImageProvider(store));
    expect(() => registry.register(new TestImageProvider(store))).toThrow(/already registered/);
  });
});

describe('MediaInspector (output verification)', () => {
  const write = (name: string, bytes: Buffer) => {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  };
  const inspector = new MediaInspector();

  it('recognises containers by signature and measures what the header allows', async () => {
    const png = await inspector.inspect(write('a.png', pngBytes(768, 1344)), 'IMAGE');
    expect(png).toMatchObject({ ok: true, format: 'png', width: 768, height: 1344, method: 'SIGNATURE' });
    expect(png.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await inspector.inspect(write('a.wav', wavBytes(3.5)), 'VOICE')).durationSeconds).toBe(3.5);
    expect((await inspector.inspect(write('a.mp4', mp4Bytes(15)), 'RENDER')).durationSeconds).toBe(15);
    // 128 kbps MPEG-1 Layer III frame header, 16000 bytes ≈ 1 second.
    const mp3 = Buffer.alloc(16000);
    mp3.set([0xff, 0xfb, 0x90, 0x64]);
    expect((await inspector.inspect(write('a.mp3', mp3), 'VOICE')).durationSeconds).toBe(1);
  });

  it('rejects empty, missing, non-media and wrong-kind outputs', async () => {
    expect((await inspector.inspect(join(dir, 'missing.png'), 'IMAGE')).reason).toMatch(/does not exist/);
    expect((await inspector.inspect(write('empty.png', Buffer.alloc(0)), 'IMAGE')).reason).toMatch(/empty/);
    expect((await inspector.inspect(write('page.png', Buffer.from('<html>502</html>')), 'IMAGE')).reason).toMatch(/not a recognised media container/);
    expect((await inspector.inspect(write('img.wav', pngBytes()), 'VOICE')).reason).toMatch(/png output is not valid for a VOICE asset/);
    expect((await inspector.inspect(write('clip.mp4', mp4Bytes(2)), 'IMAGE')).ok).toBe(false);
  });

  it('sniffs the other supported formats', () => {
    expect(sniffFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffFormat(Buffer.from('OggS\0\0\0\0', 'latin1'))).toBe('ogg');
    expect(sniffFormat(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]))).toBe('webm');
    expect(sniffFormat(Buffer.from('FORM\0\0\0\0AIFF', 'latin1'))).toBe('aiff');
    expect(sniffFormat(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe('webp');
    expect(sniffFormat(Buffer.from('\0\0\0\x14ftypqt  ', 'latin1'))).toBe('mov');
    expect(sniffFormat(Buffer.from('hello world'))).toBeNull();
  });
});

describe('ffmpeg render command (pure builder)', () => {
  const plan: RenderPlan = {
    aspectRatio: '9:16',
    totalDurationSeconds: 15,
    clips: [
      { sceneId: 'sc1', source: 'VIDEO', assetId: 'ast_v1', start: 0, end: 3 },
      { sceneId: 'sc2', source: 'IMAGE', assetId: 'ast_i2', start: 3, end: 11 },
      { sceneId: 'sc3', source: 'MISSING', assetId: null, start: 11, end: 15 },
    ],
    audio: {
      voice: [
        { sectionId: 's1', assetId: 'ast_a1', start: 0, end: 3 },
        { sectionId: 's2', assetId: 'ast_a2', start: 3.25, end: 11 },
        { sectionId: 's3', assetId: 'ast_missing', start: 11, end: 15 },
      ],
    },
    captions: [
      { start: 0, end: 3, text: 'Three facts about me.' },
      { start: 3, end: 3, text: 'zero-length is dropped' },
    ],
    exportSettings: { width: 1080, height: 1920, fps: 30, bitrateMbps: 12 },
  };
  const inputs = new Map([
    ['ast_v1', '/m/v1.mp4'],
    ['ast_i2', '/m/i2.png'],
    ['ast_a1', '/m/a1.wav'],
    ['ast_a2', '/m/a2.wav'],
  ]);

  it('holds stills, fills missing scenes with black (reported), places voice at its timeline offset, muxes captions', () => {
    const cmd = buildRenderCommand(plan, inputs, '/m/out.mp4', '/m/out.srt');
    expect(cmd.placeholderScenes).toEqual(['sc3']);
    expect(cmd).toMatchObject({ durationSeconds: 15, width: 1080, height: 1920 });
    const a = cmd.args;
    expect(a.slice(0, 4)).toEqual(['-y', '-hide_banner', '-loglevel', 'error']);
    expect(a).toContain('/m/v1.mp4');
    expect(a.join(' ')).toContain('-loop 1 -t 8 -i /m/i2.png');
    expect(a.join(' ')).toContain('-f lavfi -t 4 -i color=c=black:s=1080x1920:r=30');
    const filter = a[a.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('concat=n=3:v=1:a=0[vout]');
    expect(filter).toContain('adelay=3250|3250');
    expect(filter).toContain('amix=inputs=2:duration=longest:normalize=0');
    expect(filter).toContain('atrim=duration=15[aout]');
    expect(a).not.toContain('ast_missing');
    expect(a.join(' ')).toContain('-map 5:s -c:s mov_text');
    expect(a.slice(-7)).toEqual(['-b:a', '192k', '-t', '15', '-movflags', '+faststart', '/m/out.mp4']);
    expect(a.join(' ')).toContain('-c:v libx264 -preset veryfast -pix_fmt yuv420p -r 30 -b:v 12M');
  });

  it('uses silence when no voice exists, and writes SubRip captions', () => {
    const silent = buildRenderCommand({ ...plan, audio: { voice: [] } }, inputs, '/m/out.mp4', null);
    expect(silent.args.join(' ')).toContain('anullsrc=r=48000:cl=stereo');
    expect(silent.args).not.toContain('mov_text');
    expect(buildSrt(plan.captions)).toBe('1\n00:00:00,000 --> 00:00:03,000\nThree facts about me.\n');
  });
});

describe('macOS say voice discovery parsing', () => {
  it('parses `say -v ?` output including multi-word names', () => {
    const voices = parseSayVoices('Daniel              en_GB    # Hello! My name is Daniel.\nEddy (English (UK)) en_GB    # Hello!\nAmélie              fr_CA    # Bonjour\n');
    expect(voices).toEqual([
      { name: 'Daniel', language: 'en-GB' },
      { name: 'Amélie', language: 'fr-CA' },
    ]);
  });
});

describe('process runner (operator-configured binaries only)', () => {
  it('passes stdin, never uses a shell, and classifies failures', async () => {
    const echo = await runProcess('test', process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { timeoutMs: 10_000, stdin: '$(rm -rf /) ; not executed' });
    expect(echo).toMatchObject({ code: 0, stdout: '$(rm -rf /) ; not executed' });

    const missing = await runProcess('test', join(dir, 'no-such-binary'), [], { timeoutMs: 1000 }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(ProviderError);
    expect(missing).toMatchObject({ retryable: false, code: 'BINARY_NOT_FOUND' });

    const slow = await runProcess('test', process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 }).catch((e: unknown) => e);
    expect(slow).toMatchObject({ retryable: true, code: 'PROCESS_TIMEOUT' });
  });
});

describe('permission enforcement for media tools', () => {
  it('each media agent can request only its own media kind', async () => {
    const calls: string[] = [];
    const services = {
      media: {
        generateImage: async () => calls.push('image'),
        generateVoice: async () => calls.push('voice'),
        generateVideo: async () => calls.push('video'),
        renderEdit: async () => calls.push('render'),
      },
    };
    const kitFor = (def: typeof IMAGE_AGENT_DEFINITION) =>
      createToolKit(services as never, new PermissionGuard(def.name, def.permissionLevel, def.allowedTools as never, 'LEVEL_3_EXECUTE'), {
        scope: { correlationId: 'cor_x', emit: () => undefined } as never,
        trace: () => ({}) as never,
      });
    const image = kitFor(IMAGE_AGENT_DEFINITION);
    await image.media.generateImage({} as never);
    expect(() => image.media.generateVoice({} as never)).toThrow(PermissionDeniedError);
    expect(() => image.media.renderEdit({} as never)).toThrow(PermissionDeniedError);
    const voice = kitFor(VOICE_AGENT_DEFINITION);
    await voice.media.generateVoice({} as never);
    expect(() => voice.media.generateImage({} as never)).toThrow(PermissionDeniedError);
    expect(calls).toEqual(['image', 'voice']);
    // A deployment ceiling below LEVEL_3 removes media generation entirely.
    const capped = createToolKit(services as never, new PermissionGuard('image-generation', 'LEVEL_3_EXECUTE', IMAGE_AGENT_DEFINITION.allowedTools as never, 'LEVEL_2_MODIFY'), {
      scope: {} as never,
      trace: () => ({}) as never,
    });
    expect(() => capped.media.generateImage({} as never)).toThrow(PermissionDeniedError);
  });
});

describe('MediaService: fallback, verification and measurement', () => {
  let core: JoviCore;
  afterEach(async () => {
    await core?.close();
  });

  function production() {
    const scope = core.events.scope(newId('correlation'));
    const task = core.tasks.create({ type: 'CREATIVE_PRODUCTION', goal: 'p9 media test', createdBy: 'test' }, scope);
    const p = core.productions.create(
      { taskId: task.id, sourceType: 'DIRECT', sourcePlanningTaskId: null, ideaId: 'idea-1', idea: {}, productionContext: {}, identityVersion: 1, visualIdentityVersion: 1, simulated: false },
      scope,
    );
    clearForMedia(core, p.id);
    return { productionId: p.id, scope };
  }
  const imageJob = (productionId: string) => ({
    productionId,
    sceneId: 'sc1',
    aspectRatio: '9:16' as const,
    request: { sceneId: 'sc1', prompt: 'p', negativePrompt: 'n', aspectRatio: '9:16' as const, referenceImages: [] },
  });
  const events = (correlationId: string) => core.events.list({ correlationId, limit: 200 });

  it('falls back to the next capable provider when the primary fails permanently', async () => {
    const store = new MediaStore(dir);
    const primary = new TestImageProvider(store, { failFirst: 9, retryable: false }, 'primary-image');
    const backup = new TestImageProvider(store, { kind: 'CLOUD' }, 'backup-image');
    core = await createTestCore({ env: { JOVI_MEDIA_DIR: dir }, mediaProviders: [primary, backup] });
    const { productionId, scope } = production();
    const asset = await core.media.generateImage(imageJob(productionId), scope);
    expect(asset).toMatchObject({ status: 'COMPLETED', provider: 'backup-image', providerKind: 'CLOUD', attempts: 2 });
    expect((asset.metadata as { providerAttempts: unknown[] }).providerAttempts).toEqual([{ provider: 'primary-image', attempts: 1, error: '[primary-image] transient test failure' }]);
    const fallback = events(scope.correlationId).find((e) => e.eventType === 'MEDIA_PROVIDER_FALLBACK');
    expect(fallback?.payload).toMatchObject({ from: 'primary-image', to: 'backup-image', kind: 'IMAGE' });
  });

  it('output that fails verification is not accepted; the next provider is tried', async () => {
    const store = new MediaStore(dir);
    core = await createTestCore({ env: { JOVI_MEDIA_DIR: dir }, mediaProviders: [new TestImageProvider(store, { garbage: true }, 'html-image'), new TestImageProvider(store, {}, 'good-image')] });
    const { productionId, scope } = production();
    const asset = await core.media.generateImage(imageJob(productionId), scope);
    expect(asset).toMatchObject({ status: 'COMPLETED', provider: 'good-image' });
    expect((asset.metadata as { inspection: { format: string } }).inspection.format).toBe('png');

    await core.close();
    core = await createTestCore({ env: { JOVI_MEDIA_DIR: dir }, mediaProviders: [new TestImageProvider(store, { garbage: true }, 'html-image')] });
    const only = production();
    const failed = await core.media.generateImage(imageJob(only.productionId), only.scope);
    expect(failed.status).toBe('FAILED');
    expect(failed.statusReason).toMatch(/failed verification: output is not a recognised media container/);
  });

  it('measured duration replaces the provider claim', async () => {
    const store = new MediaStore(dir);
    core = await createTestCore({ env: { JOVI_MEDIA_DIR: dir }, mediaProviders: [new TestVoiceProvider(store, { s1: 3 })] });
    const { productionId, scope } = production();
    const voice = await core.media.generateVoice(
      { productionId, sceneId: 's1', aspectRatio: null, request: { sceneId: 's1', text: 'hi', voiceProfile: { name: 'Jovi', description: '', providerVoiceId: null }, language: 'en-GB', emotion: 'warm', pacing: 'natural' } },
      scope,
    );
    expect(voice).toMatchObject({ status: 'COMPLETED', durationSeconds: 3 });
  });

  it('LOCAL_ONLY never falls back to a cloud provider; the asset is BLOCKED with the reason', async () => {
    const store = new MediaStore(dir);
    core = await createTestCore({ env: { JOVI_MEDIA_DIR: dir }, mediaProviders: [new TestImageProvider(store, { kind: 'CLOUD' }, 'cloud-image')] });
    const { productionId, scope } = production();
    const asset = await core.media.generateImage({ ...imageJob(productionId), requirements: { privacy: 'LOCAL_ONLY' } }, scope);
    expect(asset.status).toBe('BLOCKED');
    expect(asset.statusReason).toMatch(/cloud-image: INCAPABLE — privacy LOCAL_ONLY excludes cloud providers/);
  });
});
