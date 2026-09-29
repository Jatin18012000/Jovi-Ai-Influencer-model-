import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApiServer } from '../../apps/api/server.js';
import { createToolKit } from '../../src/agents/toolkit.js';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { ConflictError, ProviderError, ValidationError } from '../../src/core/errors.js';
import { INITIAL_VISUAL_IDENTITY } from '../../src/core/identity/visual-identity.js';
import { PermissionGuard } from '../../src/core/permissions/permissions.js';
import { MediaStore } from '../../src/media/media-store.js';
import type { AnyMediaProvider } from '../../src/media/types.js';
import { mockPlanning, mockProduction } from '../../src/models/providers/mock-creative.js';
import { MockProvider } from '../../src/models/providers/mock-provider.js';
import type { GenerateRequest, ModelProvider } from '../../src/models/types.js';
import { EventType } from '../../src/types/enums.js';
import { TestImageProvider, TestRenderProvider, TestVideoProvider, TestVoiceProvider } from '../fakes/fake-media.js';
import { createTestCore } from '../helpers.js';

/**
 * Phase 8 end-to-end. Two kinds of runs:
 *  - "real path": a LOCAL test-double text model (canned output, not inference)
 *    and LOCAL test-double media providers that write real files, so the
 *    COMPLETED / approval path is exercised structurally. This is NOT a real
 *    ComfyUI / Flow / voice / editing integration.
 *  - default and simulation configurations, where no real media exists.
 */

const GOAL = 'Create an Instagram Reel concept that introduces Jovi to a new audience.';
const IDEA = {
  id: 'direct-1',
  title: 'Coffee critic minute',
  format: 'REEL',
  pillar: 'Lifestyle & Everyday Life',
  hook: 'Rating this flat white like it owes me money.',
  concept: 'Jovi reviews one London flat white in fifteen seconds.',
};
/** Voice durations per script section of the canned script (s1 3s, s2 8s, s3 4s). */
const VOICE_DURATIONS = { s1: 3, s2: 8, s3: 4 };

const LOCKED_PROFILE = {
  ...INITIAL_VISUAL_IDENTITY,
  face: 'oval face, soft jaw',
  hair: 'long dark-brown waves',
  eyes: 'hazel',
  skin: 'warm olive',
  beautyMark: 'small mark above left lip',
  body: 'slim, 170cm',
  signatureStyle: 'camel trench, gold hoops',
};

type Override = (request: GenerateRequest) => unknown | undefined;
/** A LOCAL (non-simulation) text-model test double built on the canned creative responses. */
function localModel(override: Override = () => undefined): MockProvider {
  return new MockProvider({
    id: 'local-double',
    kind: 'LOCAL',
    model: 'local-double-model',
    responder: (r) => {
      const custom = override(r);
      if (custom instanceof Error) throw custom;
      if (custom !== undefined) return typeof custom === 'string' ? custom : JSON.stringify(custom);
      const canned = r.task.type.startsWith('planning.') ? mockPlanning(r.task.type, r.context.prompt) : mockProduction(r.task.type, r.context.prompt);
      if (canned === null) throw new Error(`no canned response for ${r.task.type}`);
      return JSON.stringify(canned);
    },
  });
}

let dir: string;
let core: JoviCore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jovi-prod-'));
});
afterEach(async () => {
  await core?.close();
  rmSync(dir, { recursive: true, force: true });
});

function testMedia(options: { imageToVideo?: boolean } = {}) {
  const store = new MediaStore(dir);
  const image = new TestImageProvider(store);
  const video = new TestVideoProvider(store, { imageToVideo: options.imageToVideo ?? false });
  const voice = new TestVoiceProvider(store, VOICE_DURATIONS);
  const render = new TestRenderProvider(store);
  return { store, image, video, voice, render, all: [image, video, voice, render] as AnyMediaProvider[] };
}

async function realPathCore(options: { model?: ModelProvider; media?: AnyMediaProvider[]; lock?: boolean; env?: Record<string, string> } = {}) {
  const media = options.media ?? testMedia().all;
  core = await createTestCore({ providers: [options.model ?? localModel()], mediaProviders: media, env: { JOVI_MEDIA_DIR: dir, ...options.env } });
  if (options.lock ?? true) core.visualIdentity.createVersion(LOCKED_PROFILE, 'human:art-director', 'Lock appearance anchors for tests');
  return core;
}

const eventTypes = (result: { eventsGenerated: Array<{ eventType: string }> }) => result.eventsGenerated.map((e) => e.eventType);

describe('creative production pipeline — real path with test doubles', () => {
  it('runs Phase 7 planning → the full Phase 8 pipeline and stops at the human approval boundary', async () => {
    const media = testMedia();
    await realPathCore({ media: media.all });
    const identityBefore = JSON.stringify(core.identity.getActive());
    const visualBefore = JSON.stringify(core.visualIdentity.getActive());

    const result = await core.production.start({ goal: GOAL });
    expect(result.status, JSON.stringify(result.error)).toBe('COMPLETED');
    expect(result.source).toMatchObject({ type: 'PLANNING', ideaId: 'idea-1', ideaTitle: 'Two Truths and a Glitch' });
    expect(result.productionStatus).toBe('AWAITING_HUMAN_APPROVAL');
    expect(result.qaStatus).toBe('PASS_WITH_WARNINGS');
    expect(result.simulated).toBe(false);
    expect(result.artifacts).toEqual({ script: true, storyboard: true, visualPrompts: true, editPlan: true, qaReport: true });

    // 3 images + 3 videos + 3 voice sections + 1 render, all real files verified by MediaService.
    expect(result.assets.map((a) => a.kind).sort()).toEqual(['IMAGE', 'IMAGE', 'IMAGE', 'RENDER', 'VIDEO', 'VIDEO', 'VIDEO', 'VOICE', 'VOICE', 'VOICE']);
    for (const a of core.assets.list(result.productionId!)) {
      expect(a.status, a.kind).toBe('COMPLETED');
      expect(media.store.holdsFile(a.location!)).toBe(true);
    }

    // Visual prompts carry the canonical character lock from the active visual identity.
    const prompts = core.productions.latestArtifact<{ visualIdentityVersion: number; prompts: Array<{ imagePrompt: string; aspectRatio: string }> }>(result.productionId!, 'VISUAL_PROMPTS')!;
    expect(prompts.visualIdentityVersion).toBe(2);
    for (const p of prompts.prompts) {
      expect(p.imagePrompt).toMatch(/hazel/);
      expect(p.aspectRatio).toBe('9:16');
    }

    // Stage order and events.
    const stages = core.events
      .list({ correlationId: result.correlationId, eventType: 'CREATIVE_PRODUCTION_STAGE_CHANGED', limit: 100 })
      .map((e) => (e.payload as { to: string }).to);
    expect(stages).toEqual(['SCRIPTING', 'STORYBOARDING', 'PROMPTING', 'GENERATING_ASSETS', 'EDITING', 'QA', 'AWAITING_HUMAN_APPROVAL']);
    expect(eventTypes(result)).toEqual(
      expect.arrayContaining([
        'CREATIVE_PRODUCTION_STARTED',
        'SCRIPT_CREATED',
        'STORYBOARD_CREATED',
        'VISUAL_PROMPT_CREATED',
        'IMAGE_GENERATION_REQUESTED',
        'IMAGE_GENERATED',
        'VIDEO_GENERATED',
        'VOICE_GENERATED',
        'RENDER_GENERATED',
        'EDITING_PLAN_CREATED',
        'QA_STARTED',
        'QA_COMPLETED',
        'CREATIVE_PRODUCTION_COMPLETED',
      ]),
    );
    expect(eventTypes(result).some((t) => /PUBLISH/.test(t))).toBe(false);

    // Image, video and voice generation overlap (parallel), not one kind after another.
    const types = eventTypes(result);
    expect(types.indexOf('VOICE_GENERATION_REQUESTED')).toBeLessThan(types.lastIndexOf('IMAGE_GENERATED'));
    expect(types.indexOf('VIDEO_GENERATION_REQUESTED')).toBeLessThan(types.lastIndexOf('IMAGE_GENERATED'));

    // Nothing was published; the gate still needs a human decision.
    expect(result.publishingGate).toMatchObject({ eligibleForHumanPublishing: false, autonomousPublishingAllowed: false });

    // Identity is immutable across production.
    expect(JSON.stringify(core.identity.getActive())).toBe(identityBefore);
    expect(JSON.stringify(core.visualIdentity.getActive())).toBe(visualBefore);
  });

  it('human approval: warnings must be acknowledged; approval does not publish', async () => {
    await realPathCore();
    const result = await core.production.start({ idea: IDEA });
    expect(result.productionStatus).toBe('AWAITING_HUMAN_APPROVAL');
    const scope = core.events.scope(result.correlationId);
    expect(() => core.productions.recordHumanDecision(result.productionId!, { decision: 'APPROVE', reviewer: 'jatin' }, scope)).toThrow(/acknowledgeWarnings/);
    const approved = core.productions.recordHumanDecision(result.productionId!, { decision: 'APPROVE', reviewer: 'jatin', acknowledgeWarnings: true, note: 'visuals checked' }, scope);
    expect(approved).toMatchObject({ status: 'APPROVED', approvedBy: 'jatin', approvalDecision: 'APPROVE' });
    const gate = core.productions.publishingGate(result.productionId!);
    expect(gate).toEqual({ eligibleForHumanPublishing: true, autonomousPublishingAllowed: false, blockers: [] });
    expect(core.events.list({ correlationId: result.correlationId, limit: 500 }).map((e) => e.eventType)).toContain('PRODUCTION_APPROVED');
    // Approved is terminal: it cannot be re-decided.
    expect(() => core.productions.recordHumanDecision(result.productionId!, { decision: 'REJECT', reviewer: 'jatin' }, scope)).toThrow(ConflictError);
  });

  it('when the video provider animates images, video waits for them and is conditioned on the completed images', async () => {
    const media = testMedia({ imageToVideo: true });
    await realPathCore({ media: media.all });
    const result = await core.production.start({ idea: IDEA });
    expect(result.productionStatus).toBe('AWAITING_HUMAN_APPROVAL');
    const assets = core.assets.list(result.productionId!);
    for (const video of assets.filter((a) => a.kind === 'VIDEO')) {
      const image = assets.find((a) => a.kind === 'IMAGE' && a.sceneId === video.sceneId)!;
      expect(video.sourceAssetIds).toEqual([image.id]);
    }
    const types = eventTypes(result);
    expect(types.indexOf('VIDEO_GENERATION_REQUESTED')).toBeGreaterThan(types.lastIndexOf('IMAGE_GENERATED'));
  });

  it('starts from an existing Phase 7 planning task and a chosen idea id', async () => {
    await realPathCore();
    const planning = await core.planning.execute({ goal: GOAL, createdBy: 'test' });
    expect(planning.status).toBe('COMPLETED');

    const byDefault = await core.production.start({ planningTaskId: planning.taskId! });
    expect(byDefault.source).toMatchObject({ type: 'PLANNING', planningTaskId: planning.taskId, ideaId: 'idea-1' });
    const chosen = await core.production.start({ planningTaskId: planning.taskId!, ideaId: 'idea-2' });
    expect(chosen.source?.ideaId).toBe('idea-2');

    await expect(core.production.start({ planningTaskId: planning.taskId!, ideaId: 'idea-99' })).rejects.toBeInstanceOf(ValidationError);
    await expect(core.production.start({ planningTaskId: byDefault.taskId! })).rejects.toThrow(/not a CREATOR_PLANNING task/);
  });

  it('QA FAIL blocks the production and approval is refused', async () => {
    const low = { reviews: ['personality.tone', 'content.hook'].map((checkId) => ({ checkId, score: 2, note: 'flat' })), summary: 'weak' };
    await realPathCore({ model: localModel((r) => (r.task.type === 'production.qa_review' ? low : undefined)) });
    const result = await core.production.start({ idea: IDEA });
    expect(result.status).toBe('COMPLETED');
    expect(result.qaStatus).toBe('FAIL');
    expect(result.productionStatus).toBe('BLOCKED');
    expect(result.qa?.failedChecks).toEqual(expect.arrayContaining(['personality.tone', 'content.hook']));
    expect(eventTypes(result)).toContain('CREATIVE_PRODUCTION_BLOCKED');
    const scope = core.events.scope(result.correlationId);
    expect(() => core.productions.recordHumanDecision(result.productionId!, { decision: 'APPROVE', reviewer: 'jatin', acknowledgeWarnings: true }, scope)).toThrow(ConflictError);
    expect(core.productions.publishingGate(result.productionId!).eligibleForHumanPublishing).toBe(false);
  });

  it('identity violations in model output are rejected structurally, then repaired', async () => {
    let scriptCalls = 0;
    const model = localModel((r) => {
      if (r.task.type !== 'production.script') return undefined;
      scriptCalls += 1;
      if (scriptCalls > 1) return undefined;
      const script = mockProduction('production.script', r.context.prompt) as { sections: Array<{ dialogue: Array<{ line: string }> }> };
      script.sections[1]!.dialogue[0]!.line = "I'm 19, I'm a real person and I'm from Paris.";
      return script;
    });
    await realPathCore({ model });
    const result = await core.production.start({ idea: IDEA });
    expect(result.status).toBe('COMPLETED');
    expect(scriptCalls).toBe(2);
    const script = JSON.stringify(core.productions.latestArtifact(result.productionId!, 'SCRIPT'));
    expect(script).not.toMatch(/19|real person|Paris/);
  });

  it('a model that keeps contradicting identity fails the production — nothing is persisted', async () => {
    const model = localModel((r) => {
      if (r.task.type !== 'production.script') return undefined;
      const script = mockProduction('production.script', r.context.prompt) as { cta: string };
      script.cta = "I'm 17, follow me!";
      return script;
    });
    await realPathCore({ model, env: { JOVI_JOB_MAX_ATTEMPTS: '1' } });
    const result = await core.production.start({ idea: IDEA });
    expect(result.status).toBe('FAILED');
    expect(result.productionStatus).toBe('FAILED');
    expect(result.artifacts.script).toBe(false);
    expect(eventTypes(result)).toContain('CREATIVE_PRODUCTION_FAILED');
  });

  it('a failed stage is retried by the job queue and resumes without redoing earlier stages', async () => {
    let scriptCalls = 0;
    let storyboardCalls = 0;
    const model = localModel((r) => {
      if (r.task.type === 'production.script') scriptCalls += 1;
      if (r.task.type === 'production.storyboard') {
        storyboardCalls += 1;
        if (storyboardCalls === 1) return new ProviderError('local-double', 'connection reset', { retryable: true });
      }
      return undefined;
    });
    await realPathCore({ model });
    const result = await core.production.start({ idea: IDEA });
    expect(result.status, JSON.stringify(result.error)).toBe('COMPLETED');
    expect(result.productionStatus).toBe('AWAITING_HUMAN_APPROVAL');
    expect(result.attempts).toBe(2);
    expect(scriptCalls).toBe(1);
    expect(storyboardCalls).toBe(2);
    expect(core.events.list({ correlationId: result.correlationId, eventType: 'SCRIPT_CREATED', limit: 10 })).toHaveLength(1);
  });

  it('a media provider that fails is recorded as FAILED and QA fails the production', async () => {
    const media = testMedia();
    const failingVoice = new TestVoiceProvider(media.store, VOICE_DURATIONS, { failFirst: 99, retryable: false });
    await realPathCore({ media: [media.image, media.video, failingVoice, media.render] });
    const result = await core.production.start({ idea: IDEA });
    expect(result.assets.filter((a) => a.kind === 'VOICE').every((a) => a.status === 'FAILED')).toBe(true);
    expect(result.qa?.failedChecks).toContain('technical.voice_assets');
    expect(result.productionStatus).toBe('BLOCKED');
  });
});

describe('creative production pipeline — missing providers and simulation', () => {
  it('with no configured media providers every asset is BLOCKED (not faked) and approval is refused', async () => {
    core = await createTestCore({ providers: [localModel()], env: { JOVI_MEDIA_DIR: dir } });
    const result = await core.production.start({ idea: IDEA });
    expect(result.status).toBe('COMPLETED');
    expect(result.assets.length).toBeGreaterThan(0);
    for (const a of core.assets.list(result.productionId!)) {
      expect(a.status, a.kind).toBe('BLOCKED');
      expect(a.location).toBeNull();
      expect(a.simulated).toBe(false);
    }
    const reasons = result.assets.map((a) => a.reason).join('\n');
    expect(reasons).toMatch(/comfyui-image: NOT_CONFIGURED/);
    expect(reasons).toMatch(/google-flow: NOT_INTEGRATED/);
    expect(reasons).toMatch(/PROVIDER_NOT_CONFIGURED: no voice provider/);
    expect(reasons).toMatch(/PROVIDER_NOT_CONFIGURED: no render provider/);
    expect(existsSync(join(dir, result.productionId!))).toBe(false);
    expect(eventTypes(result)).not.toContain('IMAGE_GENERATED');

    // The edit plan records the gaps instead of papering over them.
    const plan = core.productions.latestArtifact<{ clips: Array<{ source: string }>; render: { status: string } }>(result.productionId!, 'EDIT_PLAN')!;
    expect(plan.clips.every((c) => c.source === 'MISSING')).toBe(true);
    expect(plan.render.status).toBe('BLOCKED');

    expect(result.qaStatus).toBe('BLOCKED');
    expect(result.productionStatus).toBe('BLOCKED');
    const scope = core.events.scope(result.correlationId);
    expect(() => core.productions.recordHumanDecision(result.productionId!, { decision: 'APPROVE', reviewer: 'jatin', acknowledgeWarnings: true }, scope)).toThrow(ConflictError);
  });

  it('simulation mode is explicit and isolated: SIMULATED assets, flagged result, gate closed', async () => {
    core = await createTestCore({ env: { JOVI_SIMULATION_MODE: 'true', JOVI_MEDIA_DIR: dir } });
    expect(core.mediaProviders.isSimulation()).toBe(true);
    const result = await core.production.start({ goal: GOAL });
    expect(result.simulated).toBe(true);
    expect(result.assets.every((a) => a.status === 'SIMULATED')).toBe(true);
    expect(eventTypes(result)).toContain('ASSET_SIMULATED');
    expect(eventTypes(result)).not.toContain('IMAGE_GENERATED');
    expect(result.qaStatus).toBe('BLOCKED');
    expect(result.publishingGate?.blockers).toEqual(expect.arrayContaining(['production contains simulated assets']));
    expect(existsSync(join(dir, result.productionId!))).toBe(false);
  });
});

describe('Phase 8 cannot publish', () => {
  it('no tool, event, state or API route publishes content', async () => {
    await realPathCore();
    // The agent ToolKit has no publish/approve/external-action capability at all.
    const guard = new PermissionGuard('probe', 'LEVEL_3_EXECUTE', [], 'LEVEL_3_EXECUTE');
    const kit = createToolKit({} as never, guard, { scope: core.events.scope('cor_probe'), trace: () => ({}) as never });
    const paths: string[] = [];
    const walk = (obj: Record<string, unknown>, prefix: string) => {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'function') paths.push(`${prefix}${k}`);
        else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v as Record<string, unknown>, `${prefix}${k}.`);
      }
    };
    walk(kit as unknown as Record<string, unknown>, '');
    expect(paths).toContain('media.generateImage');
    expect(paths.filter((p) => /publish|approve|decision\b|social|n8n|shell|exec|infra|credential/i.test(p))).toEqual([]);

    // A production agent cannot use the (LEVEL_4) social.publish tool even if it asked.
    const imageAgent = core.agents.get('image-generation');
    expect(imageAgent?.definition.allowedTools).not.toContain('social.publish');

    expect(EventType.options.filter((t) => /PUBLISH/.test(t))).toEqual([]);

    const app = buildApiServer(core);
    await app.ready();
    const routes = app.printRoutes({ commonPrefix: false });
    expect(routes).not.toMatch(/\/publish(\W|$)/);
    await app.close();
  });
});

describe('Phase 8 API', () => {
  it('produces, reads artifacts/assets, enforces the approval boundary and lists media providers', async () => {
    core = await createTestCore({ providers: [localModel()], env: { JOVI_MEDIA_DIR: dir } });
    const app = buildApiServer(core);
    await app.ready();
    try {
      expect((await app.inject({ method: 'POST', url: '/api/productions', payload: {} })).statusCode).toBe(400);
      const res = await app.inject({ method: 'POST', url: '/api/productions', payload: { idea: IDEA } });
      expect(res.statusCode).toBe(200);
      const { productionId, productionStatus } = res.json();
      expect(productionStatus).toBe('BLOCKED');

      for (const path of ['script', 'storyboard', 'visual-prompts', 'edit-plan', 'qa']) {
        const r = await app.inject({ method: 'GET', url: `/api/productions/${productionId}/${path}` });
        expect(r.statusCode, path).toBe(200);
      }
      const assets = await app.inject({ method: 'GET', url: `/api/productions/${productionId}/assets` });
      expect(assets.json().assets.every((a: { status: string }) => a.status === 'BLOCKED')).toBe(true);
      const gate = await app.inject({ method: 'GET', url: `/api/productions/${productionId}/publishing-gate` });
      expect(gate.json()).toMatchObject({ eligibleForHumanPublishing: false, autonomousPublishingAllowed: false });

      const approve = await app.inject({ method: 'POST', url: `/api/productions/${productionId}/decision`, payload: { decision: 'APPROVE', reviewer: 'jatin', acknowledgeWarnings: true } });
      expect(approve.statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url: `/api/productions/${productionId}/decision`, payload: { decision: 'MAYBE' } })).statusCode).toBe(400);
      const reject = await app.inject({ method: 'POST', url: `/api/productions/${productionId}/decision`, payload: { decision: 'REJECT', reviewer: 'jatin', note: 'no media' } });
      expect(reject.statusCode).toBe(200);
      expect(reject.json().production.status).toBe('REJECTED');

      expect((await app.inject({ method: 'GET', url: '/api/productions/prd_missing' })).statusCode).toBe(404);

      const providers = await app.inject({ method: 'GET', url: '/api/media/providers' });
      expect(providers.json().simulationMode).toBe(false);
      expect(providers.json().providers.map((p: { provider: string; state: string }) => `${p.provider}:${p.state}`)).toEqual([
        'comfyui-image:NOT_CONFIGURED',
        'comfyui-video:NOT_CONFIGURED',
        'google-flow:NOT_INTEGRATED',
      ]);

      const async = await app.inject({ method: 'POST', url: '/api/productions', payload: { idea: IDEA, mode: 'async' } });
      expect(async.statusCode).toBe(202);
      expect(async.json().productionStatus).toBe('CREATED');
      await core.worker.drain();
      const polled = await app.inject({ method: 'GET', url: `/api/productions/${async.json().productionId}` });
      expect(polled.json().productionStatus).toBe('BLOCKED');
    } finally {
      await app.close();
    }
  });
});
