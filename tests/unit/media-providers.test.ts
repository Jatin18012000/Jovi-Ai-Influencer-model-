import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { loadConfig } from '../../src/core/config/config.js';
import { ProviderError, ProviderUnavailableError } from '../../src/core/errors.js';
import { newId } from '../../src/core/ids.js';
import { fillWorkflow } from '../../src/integrations/comfyui/comfyui-client.js';
import { MediaProviderRegistry } from '../../src/media/media-provider-registry.js';
import { MediaStore } from '../../src/media/media-store.js';
import { ComfyUIImageProvider, ComfyUIVideoProvider } from '../../src/media/providers/comfyui-providers.js';
import { createMediaProvidersFromConfig } from '../../src/media/providers/index.js';
import { SimulatedImageProvider, SimulatedVoiceProvider } from '../../src/media/providers/simulated-providers.js';
import { GoogleFlowVideoProvider } from '../../src/media/providers/unintegrated-providers.js';
import { startFakeComfyUI, TEST_WORKFLOW, TestImageProvider, TestVideoProvider, type FakeComfyUI } from '../fakes/fake-media.js';
import { clearForMedia, createTestCore } from '../helpers.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jovi-media-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ids = () => ({ productionId: newId('production'), assetId: newId('asset') });
const imageRequest = () => ({ ...ids(), sceneId: 'sc1', prompt: 'Jovi in a London café', negativePrompt: 'blurry', aspectRatio: '9:16' as const, referenceImages: [] });

function writeWorkflow(content: unknown = TEST_WORKFLOW): string {
  const path = join(dir, 'workflow.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

describe('MediaStore', () => {
  it('confines paths to the media root and validates ids/extensions', () => {
    const store = new MediaStore(dir);
    const { productionId, assetId } = ids();
    const path = store.write(productionId, assetId, '.png', Buffer.from('x'));
    expect(path.startsWith(store.root)).toBe(true);
    expect(store.holdsFile(path)).toBe(true);
    expect(() => store.pathFor('../../etc', assetId, '.png')).toThrow();
    expect(() => store.pathFor(productionId, 'ast_../../x', '.png')).toThrow();
    expect(() => store.pathFor(productionId, assetId, '.sh')).toThrow();
    // Outside the root, missing, or empty files are not "held".
    const outside = join(tmpdir(), 'outside.png');
    writeFileSync(outside, 'x');
    expect(store.holdsFile(outside)).toBe(false);
    expect(store.holdsFile(store.pathFor(productionId, newId('asset'), '.png'))).toBe(false);
    const empty = store.write(productionId, newId('asset'), '.png', Buffer.alloc(0));
    expect(store.holdsFile(empty)).toBe(false);
    rmSync(outside, { force: true });
  });
});

describe('fillWorkflow', () => {
  it('substitutes placeholders and keeps exact numeric placeholders numeric', () => {
    const filled = fillWorkflow(TEST_WORKFLOW, { POSITIVE_PROMPT: 'hello', NEGATIVE_PROMPT: 'no', WIDTH: 768, HEIGHT: 1344, SEED: 7, FILENAME_PREFIX: 'jovi_x' }) as typeof TEST_WORKFLOW;
    expect(filled['5'].inputs.width).toBe(768);
    expect(filled['3'].inputs.seed).toBe(7);
    expect(filled['6'].inputs.text).toBe('hello');
    expect(filled['9'].inputs.filename_prefix).toBe('jovi_x');
    expect(fillWorkflow('a {{UNKNOWN}} b', {})).toBe('a {{UNKNOWN}} b');
  });
});

describe('ComfyUI adapter (against a fake ComfyUI HTTP server — not a real ComfyUI)', () => {
  let comfy: FakeComfyUI | null = null;
  afterEach(async () => {
    await comfy?.close();
    comfy = null;
  });

  it('reports NOT_CONFIGURED without COMFYUI_URL and refuses to generate', async () => {
    const provider = new ComfyUIImageProvider({ url: undefined, workflowPath: undefined, timeoutMs: 1000 }, new MediaStore(dir));
    const status = await provider.inspectAvailability();
    expect(status).toMatchObject({ available: false, state: 'NOT_CONFIGURED' });
    await expect(provider.generateImage(imageRequest())).rejects.toBeInstanceOf(ProviderError);
  });

  it('reports MISCONFIGURED for a missing, invalid or placeholder-less workflow', async () => {
    const store = new MediaStore(dir);
    const url = 'http://127.0.0.1:9';
    expect((await new ComfyUIImageProvider({ url, workflowPath: undefined, timeoutMs: 1000 }, store).inspectAvailability()).state).toBe('MISCONFIGURED');
    expect((await new ComfyUIImageProvider({ url, workflowPath: join(dir, 'nope.json'), timeoutMs: 1000 }, store).inspectAvailability()).state).toBe('MISCONFIGURED');
    expect((await new ComfyUIImageProvider({ url, workflowPath: writeWorkflow({ a: 1 }), timeoutMs: 1000 }, store).inspectAvailability()).reason).toMatch(/POSITIVE_PROMPT/);
    expect((await new ComfyUIImageProvider({ url, workflowPath: writeWorkflow('{"x": "{{POSITIVE_PROMPT}}"'), timeoutMs: 1000 }, store).inspectAvailability()).reason).toMatch(/not valid JSON/);
  });

  it('reports UNREACHABLE when nothing listens at the URL', async () => {
    const provider = new ComfyUIImageProvider({ url: 'http://127.0.0.1:9', workflowPath: writeWorkflow(), timeoutMs: 1000 }, new MediaStore(dir));
    expect(await provider.inspectAvailability()).toMatchObject({ available: false, state: 'UNREACHABLE' });
  });

  it('queues the filled workflow, polls history and downloads the output into the media store', async () => {
    comfy = await startFakeComfyUI();
    const store = new MediaStore(dir);
    const provider = new ComfyUIImageProvider({ url: comfy.url, workflowPath: writeWorkflow(), timeoutMs: 5000, pollMs: 5 }, store);
    expect(await provider.inspectAvailability()).toMatchObject({ available: true, state: 'AVAILABLE', details: { devices: ['fake-gpu'] } });

    const request = imageRequest();
    const result = await provider.generateImage(request);
    expect(result).toMatchObject({ provider: 'comfyui-image', status: 'COMPLETED', mimeType: 'image/png', width: 768, height: 1344, providerJobId: 'prompt-1' });
    expect(store.holdsFile(result.location)).toBe(true);
    expect(result.location).toBe(store.pathFor(request.productionId, request.assetId, '.png'));

    const sent = comfy.prompts[0]!.prompt as typeof TEST_WORKFLOW;
    expect(sent['6'].inputs.text).toBe('Jovi in a London café');
    expect(sent['7'].inputs.text).toBe('blurry');
    expect(sent['5'].inputs).toMatchObject({ width: 768, height: 1344 });
    expect(sent['9'].inputs.filename_prefix).toBe(`jovi_${request.assetId}`);
  });

  it('surfaces workflow rejections, execution errors and empty outputs as non-retryable errors', async () => {
    for (const mode of ['node_error', 'execution_error', 'no_output'] as const) {
      comfy = await startFakeComfyUI({ mode });
      const provider = new ComfyUIImageProvider({ url: comfy.url, workflowPath: writeWorkflow(), timeoutMs: 5000, pollMs: 5 }, new MediaStore(dir));
      const error = await provider.generateImage(imageRequest()).catch((e: unknown) => e);
      expect(error, mode).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).retryable, mode).toBe(false);
      await comfy.close();
      comfy = null;
    }
  });

  it('the video adapter fills duration/frames and is text-to-video only', async () => {
    comfy = await startFakeComfyUI();
    const provider = new ComfyUIVideoProvider(
      { url: comfy.url, workflowPath: writeWorkflow({ ...TEST_WORKFLOW, '10': { inputs: { frames: '{{FRAMES}}', seconds: '{{DURATION_SECONDS}}' } } }), timeoutMs: 5000, pollMs: 5 },
      new MediaStore(dir),
    );
    expect(provider.capabilities().imageToVideo).toBe(false);
    const result = await provider.generateVideo({ ...ids(), sceneId: 'sc1', prompt: 'p', negativePrompt: 'n', aspectRatio: '9:16', durationSeconds: 3, sourceImages: [] });
    expect(result.durationSeconds).toBe(3);
    expect((comfy.prompts[0]!.prompt['10'] as { inputs: Record<string, number> }).inputs).toEqual({ frames: 48, seconds: 3 });
  });
});

describe('Google Flow adapter', () => {
  it('is always NOT_INTEGRATED and never generates', async () => {
    const flow = new GoogleFlowVideoProvider();
    expect(await flow.inspectAvailability()).toMatchObject({ available: false, state: 'NOT_INTEGRATED' });
    await expect(flow.generateVideo()).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe('MediaProviderRegistry', () => {
  it('never mixes simulated and real media providers', () => {
    const store = new MediaStore(dir);
    const real = new MediaProviderRegistry();
    real.register(new TestImageProvider(store));
    expect(() => real.register(new SimulatedVoiceProvider())).toThrow(/simulated/);
    const sim = new MediaProviderRegistry();
    sim.register(new SimulatedImageProvider());
    expect(() => sim.register(new TestImageProvider(store))).toThrow(/simulated/);
    expect(sim.isSimulation()).toBe(true);
    expect(real.isSimulation()).toBe(false);
  });

  it('selects the first available provider and explains when none is usable', async () => {
    const store = new MediaStore(dir);
    const registry = new MediaProviderRegistry();
    expect((await registry.select('VOICE')).reason).toMatch(/^PROVIDER_NOT_CONFIGURED/);

    registry.register(new GoogleFlowVideoProvider());
    registry.register(new TestVideoProvider(store, { available: false }, 'test-video-offline'));
    const none = await registry.select('VIDEO', '9:16');
    expect(none.provider).toBeNull();
    expect(none.reason).toMatch(/^NO_AVAILABLE_VIDEO_PROVIDER/);
    expect(none.reason).toMatch(/google-flow: NOT_INTEGRATED/);
    expect(none.reason).toMatch(/test-video-offline: UNREACHABLE/);

    registry.register(new TestVideoProvider(store));
    expect((await registry.select('VIDEO', '9:16')).provider?.id).toBe('test-video');
  });

  it('configured providers: every media kind has real adapters in production, simulated only in simulation mode', () => {
    const store = new MediaStore(dir);
    const prod = createMediaProvidersFromConfig(loadConfig({ LM_STUDIO_ENABLED: 'false' }), store);
    expect(prod.map((p) => `${p.id}:${p.mediaKind}:${p.kind}`)).toEqual([
      'comfyui-image:IMAGE:LOCAL',
      'comfyui-video:VIDEO:LOCAL',
      'google-flow:VIDEO:CLOUD',
      'macos-say:VOICE:LOCAL',
      'elevenlabs:VOICE:CLOUD',
      'ffmpeg-render:RENDER:LOCAL',
    ]);
    const sim = createMediaProvidersFromConfig(loadConfig({ JOVI_SIMULATION_MODE: 'true' }), store);
    expect(sim.every((p) => p.kind === 'MOCK')).toBe(true);
    expect(sim.map((p) => p.mediaKind).sort()).toEqual(['IMAGE', 'RENDER', 'VIDEO', 'VOICE']);
  });
});

describe('MediaService: no fake success', () => {
  let core: JoviCore;
  afterEach(async () => {
    await core?.close();
  });

  function production() {
    const scope = core.events.scope(newId('correlation'));
    const task = core.tasks.create({ type: 'CREATIVE_PRODUCTION', goal: 'media test', createdBy: 'test' }, scope);
    const p = core.productions.create(
      { taskId: task.id, sourceType: 'DIRECT', sourcePlanningTaskId: null, ideaId: 'idea-1', idea: {}, productionContext: {}, identityVersion: 1, visualIdentityVersion: 1, simulated: false },
      scope,
    );
    clearForMedia(core, p.id);
    return { productionId: p.id, scope };
  }
  const job = (productionId: string) => ({
    productionId,
    sceneId: 'sc1',
    aspectRatio: '9:16' as const,
    request: { sceneId: 'sc1', prompt: 'p', negativePrompt: 'n', aspectRatio: '9:16' as const, referenceImages: [] },
  });

  it('a missing provider produces a BLOCKED asset with no location, never a fake asset', async () => {
    core = await createTestCore({ env: { JOVI_MEDIA_DIR: dir }, mediaProviders: [new GoogleFlowVideoProvider()] });
    const { productionId, scope } = production();
    const image = await core.media.generateImage(job(productionId), scope);
    expect(image).toMatchObject({ status: 'BLOCKED', location: null, provider: null, simulated: false });
    expect(image.statusReason).toMatch(/PROVIDER_NOT_CONFIGURED/);
    const events = core.events.list({ correlationId: scope.correlationId, limit: 100 }).map((e) => e.eventType);
    expect(events).toContain('ASSET_BLOCKED');
    expect(events).not.toContain('IMAGE_GENERATED');
  });

  it('a provider that reports success without an output file is marked FAILED', async () => {
    const store = new MediaStore(dir);
    core = await createTestCore({ env: { JOVI_MEDIA_DIR: dir }, mediaProviders: [new TestImageProvider(store, { lie: true })] });
    const { productionId, scope } = production();
    const image = await core.media.generateImage(job(productionId), scope);
    expect(image.status).toBe('FAILED');
    expect(image.statusReason).toMatch(/no verifiable output/);
  });

  it('retries retryable provider errors, then completes with a verified file', async () => {
    const store = new MediaStore(dir);
    const provider = new TestImageProvider(store, { failFirst: 1 });
    core = await createTestCore({ env: { JOVI_MEDIA_DIR: dir, JOVI_MEDIA_MAX_ATTEMPTS: '2' }, mediaProviders: [provider] });
    const { productionId, scope } = production();
    const image = await core.media.generateImage(job(productionId), scope);
    expect(image).toMatchObject({ status: 'COMPLETED', provider: 'test-image', providerKind: 'LOCAL', attempts: 2, simulated: false });
    expect(store.holdsFile(image.location!)).toBe(true);
    expect(provider.calls).toHaveLength(2);
    const types = core.events.list({ correlationId: scope.correlationId, limit: 100 }).map((e) => e.eventType);
    expect(types).toEqual(expect.arrayContaining(['IMAGE_GENERATION_REQUESTED', 'IMAGE_GENERATED']));
  });

  it('does not retry permanent errors', async () => {
    const provider = new TestImageProvider(new MediaStore(dir), { failFirst: 5, retryable: false });
    core = await createTestCore({ env: { JOVI_MEDIA_DIR: dir, JOVI_MEDIA_MAX_ATTEMPTS: '3' }, mediaProviders: [provider] });
    const { productionId, scope } = production();
    const image = await core.media.generateImage(job(productionId), scope);
    expect(image.status).toBe('FAILED');
    expect(provider.calls).toHaveLength(1);
  });

  it('simulated providers yield SIMULATED assets, never COMPLETED', async () => {
    core = await createTestCore({ env: { JOVI_MEDIA_DIR: dir }, mediaProviders: [new SimulatedImageProvider()] });
    const { productionId, scope } = production();
    const image = await core.media.generateImage(job(productionId), scope);
    expect(image).toMatchObject({ status: 'SIMULATED', simulated: true });
    expect(image.location).toMatch(/^simulation:\/\//);
  });

  it('the asset state machine refuses COMPLETED without a real provider and location', async () => {
    core = await createTestCore({ env: { JOVI_MEDIA_DIR: dir }, mediaProviders: [] });
    const { productionId, scope } = production();
    const asset = core.assets.create({ productionId, kind: 'IMAGE', sceneId: 'sc1', request: {} }, scope);
    expect(() => core.assets.transition(asset.id, 'COMPLETED', { provider: 'x', location: '/tmp/x' }, scope)).toThrow(/Invalid asset transition/);
    core.assets.transition(asset.id, 'QUEUED', {}, scope);
    core.assets.transition(asset.id, 'GENERATING', {}, scope);
    expect(() => core.assets.transition(asset.id, 'COMPLETED', { provider: 'x' }, scope)).toThrow(/real provider/);
    expect(() => core.assets.transition(asset.id, 'COMPLETED', { provider: 'x', location: 'simulation://x', simulated: true }, scope)).toThrow(/real provider/);
    const failed = core.assets.transition(asset.id, 'FAILED', { statusReason: 'test' }, scope);
    expect(() => core.assets.transition(failed.id, 'COMPLETED', { provider: 'x', location: '/x' }, scope)).toThrow(/Invalid asset transition/);
  });
});
