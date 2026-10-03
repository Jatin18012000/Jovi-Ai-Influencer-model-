import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApiServer } from '../../apps/api/server.js';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { ConflictError, ValidationError } from '../../src/core/errors.js';
import { MediaStore } from '../../src/media/media-store.js';
import { pngBytes, TestImageProvider, TestRenderProvider, TestVideoProvider, TestVoiceProvider } from '../fakes/fake-media.js';
import { countingLocalModel, DIRECT_IDEA, LOCKED_PROFILE, VOICE_DURATIONS } from '../fakes/production-fixtures.js';
import { approvalCode, authedInject, bearer, createTestCore } from '../helpers.js';
import { ALL_SCOPES } from '../../src/core/auth/api-credentials.js';

/**
 * Phase 9 end-to-end with a LOCAL canned text model and LOCAL/CLOUD test-double
 * media providers that write real-signature files (NOT external integrations):
 * human-requested media regeneration, provider fallback inside the pipeline,
 * privacy routing, visual identity locking and the new API routes.
 */

let dir: string;
let core: JoviCore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jovi-regen-'));
});
afterEach(async () => {
  await core?.close();
  rmSync(dir, { recursive: true, force: true });
});

function media(options: { voiceAvailable?: boolean; renderAvailable?: boolean } = {}) {
  const store = new MediaStore(join(dir, 'media'), join(dir, 'references'));
  const image = new TestImageProvider(store);
  const video = new TestVideoProvider(store);
  const voice = new TestVoiceProvider(store, VOICE_DURATIONS, { available: options.voiceAvailable ?? true });
  const render = new TestRenderProvider(store, { available: options.renderAvailable ?? true });
  return { store, image, video, voice, render, all: [image, video, voice, render] };
}

async function start(providers = media().all, env: Record<string, string> = {}) {
  const text = countingLocalModel();
  core = await createTestCore({ providers: [text.model], mediaProviders: providers, env: { JOVI_MEDIA_DIR: join(dir, 'media'), JOVI_REFERENCE_DIR: join(dir, 'references'), ...env } });
  core.visualIdentity.createVersion(LOCKED_PROFILE, 'human:art-director', 'lock for tests');
  return text.calls;
}

const active = (id: string) => core.assets.listActive(id);
const eventTypes = (correlationId: string) => core.events.list({ correlationId, limit: 2000 }).map((e) => e.eventType);

describe('human-requested media regeneration', () => {
  it('BLOCKED for missing voice/render → operator configures providers → regeneration reaches the approval boundary without re-running text agents', async () => {
    const m = media({ voiceAvailable: false, renderAvailable: false });
    const calls = await start(m.all);

    const first = await core.production.start({ idea: DIRECT_IDEA });
    expect(first.productionStatus).toBe('BLOCKED');
    const id = first.productionId!;
    expect(core.assets.list(id, 'VOICE').every((a) => a.status === 'BLOCKED')).toBe(true);
    expect(core.assets.list(id, 'IMAGE').every((a) => a.status === 'COMPLETED')).toBe(true);
    const completedImageIds = core.assets.list(id, 'IMAGE').map((a) => a.id);
    const textCallsBefore = { ...calls };

    // Pipeline code cannot leave BLOCKED on its own.
    expect(() => core.productions.advance(id, 'GENERATING_ASSETS', core.events.scope(first.correlationId))).toThrow(ValidationError);

    // The operator configures a voice engine and a renderer, then asks for regeneration.
    m.voice.behaviour.available = true;
    m.render.behaviour.available = true;
    const second = await core.production.regenerateMedia(id, { requestedBy: 'jatin', reason: 'voice + render configured' });

    expect(second.status).toBe('COMPLETED');
    expect(second.productionStatus).toBe('AWAITING_HUMAN_APPROVAL');
    expect(second.qaStatus).toBe('PASS_WITH_WARNINGS');
    expect(second.regenerations).toBe(1);
    expect(second.taskId).not.toBe(second.originTaskId);
    // Text stages were reused, not re-generated.
    expect(calls['production.script']).toBe(textCallsBefore['production.script']);
    expect(calls['production.storyboard']).toBe(textCallsBefore['production.storyboard']);
    expect(calls['production.visual_prompts']).toBe(textCallsBefore['production.visual_prompts']);
    expect(calls['production.qa_review']).toBe((textCallsBefore['production.qa_review'] ?? 0) + 1);

    // Blocked voice/render were superseded (kept for audit); completed images were kept as-is.
    const all = core.assets.list(id);
    expect(all.filter((a) => a.status === 'SUPERSEDED').map((a) => a.kind).sort()).toEqual(['RENDER', 'VOICE', 'VOICE', 'VOICE']);
    expect(active(id).every((a) => a.status === 'COMPLETED')).toBe(true);
    expect(core.assets.listActive(id, 'IMAGE').map((a) => a.id)).toEqual(completedImageIds);
    expect(core.productions.latestArtifact<{ render: { status: string } }>(id, 'EDIT_PLAN')!.render.status).toBe('COMPLETED');
    expect(eventTypes(first.correlationId)).toEqual(expect.arrayContaining(['MEDIA_REGENERATION_REQUESTED', 'ASSET_SUPERSEDED', 'VOICE_GENERATED', 'RENDER_GENERATED']));

    // Superseded history does not block the publishing gate once a human approves.
    core.productions.recordHumanDecision(id, { decision: 'APPROVE', reviewer: 'jatin', acknowledgeWarnings: true }, core.events.scope(first.correlationId));
    expect(core.productions.publishingGate(id)).toEqual({ eligibleForHumanPublishing: true, autonomousPublishingAllowed: false, blockers: [] });
  });

  it('includeCompleted replaces only the chosen kinds (plus the render) from AWAITING_HUMAN_APPROVAL', async () => {
    await start();
    const first = await core.production.start({ idea: DIRECT_IDEA });
    expect(first.productionStatus).toBe('AWAITING_HUMAN_APPROVAL');
    const id = first.productionId!;
    const voiceIds = core.assets.listActive(id, 'VOICE').map((a) => a.id);
    const imageIds = core.assets.listActive(id, 'IMAGE').map((a) => a.id);

    const second = await core.production.regenerateMedia(id, { requestedBy: 'jatin', kinds: ['IMAGE'], includeCompleted: true, reason: 'wrong café' });
    expect(second.productionStatus).toBe('AWAITING_HUMAN_APPROVAL');
    expect(core.assets.listActive(id, 'VOICE').map((a) => a.id)).toEqual(voiceIds);
    const newImages = core.assets.listActive(id, 'IMAGE').map((a) => a.id);
    expect(newImages).toHaveLength(3);
    expect(newImages.some((i) => imageIds.includes(i))).toBe(false);
    expect(core.assets.listActive(id, 'RENDER')).toHaveLength(1);
    // The edit plan was rebuilt against the new images.
    const plan = core.productions.latestArtifact<{ clips: Array<{ assetId: string }> }>(id, 'EDIT_PLAN')!;
    expect(core.assets.listActive(id, 'VIDEO').map((a) => a.id)).toEqual(plan.clips.map((c) => c.assetId));
  });

  it('is refused for approved/rejected productions and requires a named requester', async () => {
    await start();
    const done = await core.production.start({ idea: DIRECT_IDEA });
    const scope = core.events.scope(done.correlationId);
    await expect(core.production.regenerateMedia(done.productionId!, { requestedBy: '' })).rejects.toThrow();
    core.productions.recordHumanDecision(done.productionId!, { decision: 'APPROVE', reviewer: 'jatin', acknowledgeWarnings: true }, scope);
    await expect(core.production.regenerateMedia(done.productionId!, { requestedBy: 'jatin' })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('provider routing inside the pipeline', () => {
  it('falls back to a second image provider when the first returns unverifiable output', async () => {
    const m = media();
    const broken = new TestImageProvider(m.store, { garbage: true }, 'broken-image');
    await start([broken, m.image, m.video, m.voice, m.render]);
    const result = await core.production.start({ idea: DIRECT_IDEA });
    expect(result.productionStatus).toBe('AWAITING_HUMAN_APPROVAL');
    expect(core.assets.list(result.productionId!, 'IMAGE').every((a) => a.provider === 'test-image' && a.status === 'COMPLETED')).toBe(true);
    expect(eventTypes(result.correlationId).filter((t) => t === 'MEDIA_PROVIDER_FALLBACK')).toHaveLength(3);
  });

  it('LOCAL_ONLY productions never send media work to cloud providers', async () => {
    const m = media();
    const cloudVoice = new TestVoiceProvider(m.store, VOICE_DURATIONS, { kind: 'CLOUD' }, 'cloud-voice');
    await start([m.image, m.video, cloudVoice, m.render]);
    const result = await core.production.start({ idea: DIRECT_IDEA, privacy: 'LOCAL_ONLY' });
    const voices = core.assets.list(result.productionId!, 'VOICE');
    expect(voices.every((a) => a.status === 'BLOCKED' && /privacy LOCAL_ONLY excludes cloud providers/.test(a.statusReason ?? ''))).toBe(true);
    expect(cloudVoice.calls).toHaveLength(0);
    expect(result.productionStatus).toBe('BLOCKED');
  });
});

describe('visual identity locking and Phase 9 API', () => {
  it('locks the visual identity (human), regenerates via API and lists provider capabilities', async () => {
    const m = media({ voiceAvailable: false });
    const text = countingLocalModel();
    core = await createTestCore({ providers: [text.model], mediaProviders: m.all, env: { JOVI_MEDIA_DIR: join(dir, 'media'), JOVI_REFERENCE_DIR: join(dir, 'references'), JOVI_MEDIA_PROVIDER_PREFERENCE: 'test-image' } });
    const app = buildApiServer(core);
    await app.ready();
    const inject = authedInject(app, bearer(core, ALL_SCOPES, 'jatin'));
    try {
      const before = await inject({ method: 'GET', url: '/api/visual-identity' });
      expect(before.json().active).toMatchObject({ version: 1, status: 'NOT_LOCKED' });

      // Reference images must be real files inside the reference directory.
      const outside = await inject({ method: 'POST', url: '/api/visual-identity', payload: { profile: { ...LOCKED_PROFILE, referenceImages: ['/etc/hosts'] }, changeSummary: 'lock' } });
      expect(outside.statusCode).toBe(400);
      mkdirSync(join(dir, 'references'), { recursive: true });
      const sheet = join(dir, 'references', 'jovi-sheet.png');
      writeFileSync(sheet, pngBytes(512, 512));
      // The approver comes from the credential; a body-supplied approvedBy is rejected.
      expect((await inject({ method: 'POST', url: '/api/visual-identity', payload: { profile: LOCKED_PROFILE, approvedBy: 'someone-else', changeSummary: 'lock' } })).statusCode).toBe(400);
      const locked = await inject({ method: 'POST', url: '/api/visual-identity', payload: { profile: { ...LOCKED_PROFILE, referenceImages: [sheet] }, changeSummary: 'Lock appearance anchors and reference sheet' } });
      expect(locked.statusCode).toBe(201);
      expect(locked.json().active).toMatchObject({ version: 2, status: 'LOCKED', unlockedFields: [] });
      expect(locked.json().versions[0]).toMatchObject({ version: 2, approvedBy: 'api:jatin' });
      expect(locked.json().versions.map((v: { version: number; isActive: boolean }) => [v.version, v.isActive])).toEqual([
        [2, true],
        [1, false],
      ]);
      expect(core.events.list({ eventType: 'VISUAL_IDENTITY_VERSION_CREATED', limit: 5 })).toHaveLength(1);

      const providers = await inject({ method: 'GET', url: '/api/media/providers' });
      expect(providers.json().preference).toEqual(['test-image']);
      expect(providers.json().providers.find((p: { provider: string }) => p.provider === 'test-image').capabilities).toMatchObject({ aspectRatios: ['9:16', '4:5', '1:1', '16:9'] });

      const produced = await inject({ method: 'POST', url: '/api/productions', payload: { idea: DIRECT_IDEA } });
      const { productionId } = produced.json();
      expect(produced.json().productionStatus).toBe('BLOCKED');
      // Images were requested with the approved reference sheet.
      expect((core.assets.list(productionId, 'IMAGE')[0]!.request as { referenceImages: string[] }).referenceImages).toEqual([sheet]);

      expect((await inject({ method: 'POST', url: `/api/productions/${productionId}/regenerate-media`, payload: { requestedBy: 'someone-else' } })).statusCode).toBe(400);
      m.voice.behaviour.available = true;
      const regen = await inject({ method: 'POST', url: `/api/productions/${productionId}/regenerate-media`, payload: { kinds: ['VOICE'] } });
      expect(regen.statusCode).toBe(200);
      expect(regen.json()).toMatchObject({ productionStatus: 'AWAITING_HUMAN_APPROVAL', regenerations: 1 });
      expect((await inject({ method: 'POST', url: '/api/productions/prd_missing/regenerate-media', payload: {} })).statusCode).toBe(404);

      const approve = await inject({ method: 'POST', url: `/api/productions/${productionId}/decision`, headers: approvalCode(), payload: { decision: 'APPROVE', acknowledgeWarnings: true } });
      expect(approve.json().publishingGate).toMatchObject({ eligibleForHumanPublishing: true, autonomousPublishingAllowed: false });
      const again = await inject({ method: 'POST', url: `/api/productions/${productionId}/regenerate-media`, payload: {} });
      expect(again.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});
