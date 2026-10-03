import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLANNED_AGENTS } from '../../src/agents/planned-agents.js';
import { IdeationOutput } from '../../src/agents/planning/planning-agents.js';
import { SCRIPT_AGENT_DEFINITION, STORYBOARD_AGENT_DEFINITION, VISUAL_PROMPT_AGENT_DEFINITION } from '../../src/agents/production/creative-agents.js';
import { assertIdentityPreserved, findIdentityViolations } from '../../src/agents/production/identity-guard.js';
import { EDITING_AGENT_DEFINITION, IMAGE_AGENT_DEFINITION, VIDEO_AGENT_DEFINITION, VOICE_AGENT_DEFINITION } from '../../src/agents/production/media-agents.js';
import { ProductionRequestSchema } from '../../src/agents/production/production-pipeline.js';
import {
  EditPlanSchema,
  QAModelReviewSchema,
  QA_MODEL_CHECKS,
  ScriptSchema,
  StoryboardSchema,
  VisualPromptsSchema,
  type EditPlan,
  type QAModelReview,
  type Script,
  type Storyboard,
  type VisualPrompts,
} from '../../src/agents/production/production-schemas.js';
import { QA_AGENT_DEFINITION } from '../../src/agents/production/qa-agent.js';
import { runCreativeQA, type QAInput } from '../../src/agents/production/qa-engine.js';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { ConflictError, InvalidModelOutputError } from '../../src/core/errors.js';
import type { JoviIdentity } from '../../src/core/identity/identity-schema.js';
import { INITIAL_VISUAL_IDENTITY, renderCharacterLock, type ActiveVisualIdentity } from '../../src/core/identity/visual-identity.js';
import { newId } from '../../src/core/ids.js';
import { permissionRank } from '../../src/core/permissions/permissions.js';
import type { MediaAsset } from '../../src/core/production/asset-service.js';
import { PRODUCTION_TRANSITIONS } from '../../src/core/production/production-service.js';
import { evaluatePublishingGate } from '../../src/core/production/publishing-gate.js';
import { mockProduction } from '../../src/models/providers/mock-creative.js';
import { ProductionStatus } from '../../src/types/enums.js';
import { createTestCore } from '../helpers.js';

// ---------------------------------------------------------------------------
// Fixtures (built from the schema-valid simulated outputs, then varied per test)
// ---------------------------------------------------------------------------

const IDEA = {
  id: 'idea-1',
  title: 'Two Truths and a Glitch',
  format: 'REEL',
  pillar: 'Entertainment & Personality',
  hook: 'Three facts about me. One of them is a glitch. Go.',
  concept: 'Jovi rapid-fires three facts; the glitch reveals she is AI.',
  whyNow: '',
  personalityTraits: ['witty'],
  audienceValue: 'a game',
  productionNotes: [],
};

const LOCKED: ActiveVisualIdentity = {
  version: 2,
  status: 'LOCKED',
  profile: {
    ...INITIAL_VISUAL_IDENTITY,
    face: 'oval face, soft jaw',
    hair: 'long dark-brown waves',
    eyes: 'hazel',
    skin: 'warm olive',
    beautyMark: 'small mark above left lip',
    body: 'slim, 170cm',
    signatureStyle: 'camel trench, gold hoops',
  },
  unlockedFields: [],
};
const UNLOCKED: ActiveVisualIdentity = { version: 1, status: 'NOT_LOCKED', profile: INITIAL_VISUAL_IDENTITY, unlockedFields: ['face', 'hair', 'eyes', 'skin', 'beautyMark', 'body', 'signatureStyle'] };

function buildScript(): Script {
  return ScriptSchema.parse(mockProduction('production.script', `<idea_json>${JSON.stringify(IDEA)}</idea_json>`));
}
function buildStoryboard(script: Script): Storyboard {
  return StoryboardSchema.parse(mockProduction('production.storyboard', `Aspect ratio: 9:16.\n<script_json>${JSON.stringify(script)}</script_json>`));
}
function buildPrompts(storyboard: Storyboard, visual: ActiveVisualIdentity): VisualPrompts {
  const lock = renderCharacterLock(visual, 'Jovi');
  return VisualPromptsSchema.parse({
    globalStyle: 'cinematic',
    visualIdentityVersion: visual.version,
    prompts: storyboard.scenes.map((s) => ({
      sceneId: s.sceneId,
      imagePrompt: `${lock} ${s.action} in ${s.location}`,
      videoPrompt: `${lock} ${s.action}, gentle motion`,
      negativePrompt: 'blurry',
      characterConsistency: lock,
      environmentConsistency: 'London palette',
      wardrobeConsistency: s.wardrobe,
      cameraSpecification: s.camera,
      lightingSpecification: s.lighting,
      aspectRatio: storyboard.aspectRatio,
      targetDurationSeconds: s.durationSeconds,
      featuresJovi: s.featuresJovi,
    })),
  });
}

let seq = 0;
function asset(kind: MediaAsset['kind'], status: MediaAsset['status'], sceneId: string | null, extra: Partial<MediaAsset> = {}): MediaAsset {
  seq += 1;
  return {
    id: `ast_${String(seq).padStart(8, '0')}`,
    productionId: 'prd_00000000',
    kind,
    sceneId,
    status,
    statusReason: status === 'BLOCKED' ? 'PROVIDER_NOT_CONFIGURED: none' : null,
    provider: status === 'COMPLETED' ? 'test' : null,
    providerKind: status === 'COMPLETED' ? 'LOCAL' : null,
    model: null,
    request: {},
    sourceAssetIds: [],
    location: status === 'COMPLETED' ? `/media/${seq}` : null,
    mimeType: null,
    durationSeconds: null,
    width: null,
    height: null,
    aspectRatio: null,
    providerJobId: null,
    attempts: 1,
    cost: null,
    simulated: status === 'SIMULATED',
    metadata: null,
    createdAt: '',
    updatedAt: '',
    ...extra,
  } as MediaAsset;
}

/** Complete assets for every scene, voice section and the render, with voice durations matching their slots. */
function completedAssets(script: Script, storyboard: Storyboard, status: MediaAsset['status'] = 'COMPLETED'): MediaAsset[] {
  return [
    ...storyboard.scenes.flatMap((s) => [asset('IMAGE', status, s.sceneId), asset('VIDEO', status, s.sceneId)]),
    ...script.sections.map((s) => asset('VOICE', status, s.sectionId, { durationSeconds: s.durationSeconds })),
    asset('RENDER', status, null),
  ];
}

function buildEditPlan(script: Script, storyboard: Storyboard, assets: MediaAsset[]): EditPlan {
  let t = 0;
  const timeline = storyboard.scenes.map((s) => {
    const span = { sceneId: s.sceneId, start: t, end: t + s.durationSeconds };
    t += s.durationSeconds;
    return span;
  });
  let c = 0;
  const voice = script.sections.map((s) => {
    const span = { sectionId: s.sectionId, start: c, end: c + s.durationSeconds };
    c += s.durationSeconds;
    const a = assets.find((x) => x.kind === 'VOICE' && x.sceneId === s.sectionId);
    return { ...span, assetId: a?.id ?? null, assetStatus: a?.status ?? null };
  });
  return EditPlanSchema.parse({
    aspectRatio: storyboard.aspectRatio,
    totalDurationSeconds: t,
    timeline,
    clips: timeline.map((span, i) => {
      const v = assets.find((a) => a.kind === 'VIDEO' && a.sceneId === span.sceneId && ['COMPLETED', 'SIMULATED'].includes(a.status));
      return { clipId: `clip-${i + 1}`, sceneId: span.sceneId, source: v ? 'VIDEO' : 'MISSING', assetId: v?.id ?? null, assetStatus: v?.status ?? null, start: span.start, end: span.end, motion: null };
    }),
    transitions: [],
    audio: { voice, music: { status: 'NOT_SELECTED', note: '' } },
    captions: [],
    textOverlays: [],
    effects: [],
    exportSettings: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', width: 1080, height: 1920, fps: 30, bitrateMbps: 12 },
    render: { assetId: null, status: 'COMPLETED', reason: null },
  });
}

const goodReview = (score = 4): { review: QAModelReview; provider: string; model: string } => ({
  review: QAModelReviewSchema.parse({ reviews: QA_MODEL_CHECKS.map(([checkId]) => ({ checkId, score, note: 'ok' })), summary: 'fine' }),
  provider: 'test',
  model: 'test-model',
});

let core: JoviCore;
let identity: JoviIdentity;
beforeAll(async () => {
  core = await createTestCore();
  identity = core.identity.getActive().profile;
});
afterAll(async () => {
  await core.close();
});

function qaInput(overrides: Partial<QAInput> & { mutateScript?: (s: Script) => void } = {}): QAInput {
  const script = buildScript();
  overrides.mutateScript?.(script);
  const storyboard = buildStoryboard(script);
  const visual = overrides.visual ?? LOCKED;
  const prompts = buildPrompts(storyboard, visual);
  const assets = overrides.assets ?? completedAssets(script, storyboard);
  return {
    identity,
    identityVersion: 1,
    visual,
    idea: IDEA,
    script,
    storyboard,
    prompts,
    editPlan: buildEditPlan(script, storyboard, assets),
    assets,
    modelReview: goodReview(),
    ...overrides,
  };
}
const ids = (checks: Array<{ id: string }>) => checks.map((c) => c.id);

// ---------------------------------------------------------------------------

describe('Phase 7 → Phase 8 idea contract', () => {
  const ideas = [1, 2, 3, 4, 5].map((n) => ({ title: `Idea ${n}`, format: 'REEL', pillar: 'Travel', hook: 'h', concept: 'c', whyNow: 'w', productionNotes: [] }));

  it('assigns ids and accepts recommendedIdeaIds', () => {
    const out = IdeationOutput.parse({ ideas, recommendedIdeaIds: ['idea-2', 'idea-4'], selectionRationale: 'r' });
    expect(out.ideas.map((i) => i.id)).toEqual(['idea-1', 'idea-2', 'idea-3', 'idea-4', 'idea-5']);
    expect(out.recommendedIdeaIds).toEqual(['idea-2', 'idea-4']);
    expect(out.recommendedIdeaId).toBe('idea-2');
  });

  it('normalises the legacy recommendedIdeaId (id or title)', () => {
    expect(IdeationOutput.parse({ ideas, recommendedIdeaId: 'Idea 3', selectionRationale: 'r' }).recommendedIdeaIds).toEqual(['idea-3']);
    expect(IdeationOutput.parse({ ideas, recommendedIdeaId: 'idea-5', selectionRationale: 'r' }).recommendedIdeaIds).toEqual(['idea-5']);
  });

  it('rejects unknown or missing recommendations', () => {
    expect(() => IdeationOutput.parse({ ideas, recommendedIdeaIds: ['idea-9'], selectionRationale: 'r' })).toThrow();
    expect(() => IdeationOutput.parse({ ideas, selectionRationale: 'r' })).toThrow();
  });

  it('a production request names exactly one source', () => {
    expect(ProductionRequestSchema.safeParse({ goal: 'Make a reel' }).success).toBe(true);
    expect(ProductionRequestSchema.safeParse({ planningTaskId: 'tsk_1', ideaId: 'idea-2' }).success).toBe(true);
    expect(ProductionRequestSchema.safeParse({}).success).toBe(false);
    expect(ProductionRequestSchema.safeParse({ goal: 'Make a reel', planningTaskId: 'tsk_1' }).success).toBe(false);
    expect(ProductionRequestSchema.safeParse({ goal: 'Make a reel', aspectRatio: '3:2' }).success).toBe(false);
  });
});

describe('creative schemas', () => {
  it('validate script, storyboard, prompts and edit plan; reject malformed output', () => {
    const script = buildScript();
    expect(script.sections.map((s) => s.sectionId)).toEqual(['s1', 's2', 's3']);
    const storyboard = buildStoryboard(script);
    expect(storyboard.scenes).toHaveLength(3);
    expect(buildPrompts(storyboard, LOCKED).prompts[0]!.characterConsistency).toMatch(/Locked appearance/);

    expect(() => ScriptSchema.parse({ ...script, sections: [...script.sections, script.sections[0]] })).toThrow(/unique/);
    expect(() => ScriptSchema.parse({ ...script, sections: [] })).toThrow();
    expect(() => StoryboardSchema.parse({ ...storyboard, aspectRatio: '21:9' })).toThrow();
    expect(() => StoryboardSchema.parse({ ...storyboard, scenes: storyboard.scenes.map((s) => ({ ...s, continuityRequirements: [] })) })).toThrow();
    // Speaker and pacing are normalised from sloppy model casing.
    const line = ScriptSchema.parse({ ...script, sections: [{ ...script.sections[0]!, dialogue: [{ speaker: 'jovi', line: 'hi', emotion: 'warm', pacing: 'FAST' }] }] });
    expect(line.sections[0]!.dialogue[0]).toMatchObject({ speaker: 'JOVI', pacing: 'fast' });
  });

  it('the character lock is canonical and says when appearance is not locked', () => {
    expect(renderCharacterLock(UNLOCKED, 'Jovi')).toMatch(/not yet locked/);
    expect(renderCharacterLock(LOCKED, 'Jovi')).toMatch(/hazel/);
    expect(renderCharacterLock(LOCKED, 'Jovi')).toMatch(/not resembling any real person/);
  });
});

describe('identity guard (structural, applied at parse time)', () => {
  it('accepts output consistent with Jovi', () => {
    expect(findIdentityViolations(["I'm 25 and I'm from London.", 'I am an AI creator.'], identity)).toEqual([]);
  });

  it('detects age, minor depiction, origin, AI-transparency, explicit and likeness violations', () => {
    const rules = (text: string, likeness = false) => findIdentityViolations([text], identity, { likeness }).map((v) => v.rule);
    expect(rules("I'm 31 and loving it")).toContain('AGE');
    // Ages under 21 are treated as minor depiction (stricter than a plain age mismatch).
    expect(rules("I'm 19 and loving it")).toContain('MINOR_DEPICTION');
    expect(rules('a teenage schoolgirl look')).toContain('MINOR_DEPICTION');
    expect(rules("I'm from Paris")).toContain('ORIGIN');
    expect(rules("Honestly I'm a real person")).toContain('AI_TRANSPARENCY');
    expect(rules('nsfw shoot')).toContain('EXPLICIT');
    expect(rules('she looks like a famous singer', true)).toContain('REAL_PERSON_LIKENESS');
    expect(rules('she looks like a famous singer', false)).not.toContain('REAL_PERSON_LIKENESS');
  });

  it('throws InvalidModelOutputError so the router repairs or falls back', () => {
    expect(() => assertIdentityPreserved(["I'm 31 now"], identity)).toThrow(InvalidModelOutputError);
  });
});

describe('creative QA engine', () => {
  it('locked identity + completed assets + good model review → PASS_WITH_WARNINGS (visuals still need human eyes)', () => {
    const report = runCreativeQA(qaInput());
    expect(report.status).toBe('PASS_WITH_WARNINGS');
    expect(report.recommendedAction).toBe('HUMAN_REVIEW');
    expect(report.failedChecks).toEqual([]);
    expect(ids(report.warnings)).toEqual(expect.arrayContaining(['identity.face', 'identity.hair', 'identity.beauty_mark', 'visual.quality']));
    expect(ids(report.passedChecks)).toEqual(expect.arrayContaining(['identity.visual_identity_locked', 'identity.age', 'identity.origin', 'identity.character_lock', 'technical.av_sync', 'technical.final_render', 'personality.tone']));
    // Scores are fractions of evaluated checks, not invented percentages.
    for (const value of Object.values(report.scores)) expect(value === null || (value >= 0 && value <= 1)).toBe(true);
    expect(report.scoreLabel).toMatch(/Not a quality percentage/);
  });

  it('an unlocked visual identity BLOCKS approval', () => {
    const report = runCreativeQA(qaInput({ visual: UNLOCKED }));
    expect(report.status).toBe('BLOCKED');
    expect(report.recommendedAction).toBe('RESOLVE_BLOCKERS');
    expect(report.requiredFixes.join('\n')).toMatch(/Visual identity locked/);
  });

  it('simulated or blocked assets BLOCK approval — they are never counted as generated', () => {
    const script = buildScript();
    const storyboard = buildStoryboard(script);
    const simulated = runCreativeQA(qaInput({ assets: completedAssets(script, storyboard, 'SIMULATED') }));
    expect(simulated.status).toBe('BLOCKED');
    expect(simulated.requiredFixes.join('\n')).toMatch(/simulated asset/);
    const blocked = runCreativeQA(qaInput({ assets: completedAssets(script, storyboard, 'BLOCKED') }));
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.requiredFixes.join('\n')).toMatch(/PROVIDER_NOT_CONFIGURED/);
    expect(ids(blocked.passedChecks)).not.toContain('technical.visual_assets');
  });

  it('identity contradictions FAIL', () => {
    const age = runCreativeQA(qaInput({ mutateScript: (s) => void (s.sections[1]!.dialogue[0]!.line = "I'm 19 and I rate cities by coffee.") }));
    expect(age.status).toBe('FAIL');
    expect(ids(age.failedChecks)).toContain('identity.age');
    const human = runCreativeQA(qaInput({ mutateScript: (s) => void (s.cta = "Trust me, I'm a real person. Comment below!") }));
    expect(human.status).toBe('FAIL');
    expect(ids(human.failedChecks)).toContain('brand.transparency');
  });

  it('safety failures FAIL (real-person likeness, unauthorized claims)', () => {
    const base = qaInput();
    const likeness = runCreativeQA({ ...base, prompts: { ...base.prompts!, prompts: base.prompts!.prompts.map((p) => ({ ...p, imagePrompt: `${p.imagePrompt}, looks like a famous actress` })) } });
    expect(ids(likeness.failedChecks)).toContain('safety.real_person_likeness');
    expect(likeness.status).toBe('FAIL');
    const claims = runCreativeQA(qaInput({ mutateScript: (s) => void (s.cta = 'Guaranteed glow-up, sponsored by nobody') }));
    expect(ids(claims.failedChecks)).toContain('safety.unauthorized_claims');
  });

  it('missing character lock and A/V drift FAIL', () => {
    const base = qaInput();
    const noLock = runCreativeQA({ ...base, prompts: { ...base.prompts!, prompts: base.prompts!.prompts.map((p) => ({ ...p, imagePrompt: 'a woman in a café' })) } });
    expect(ids(noLock.failedChecks)).toContain('identity.character_lock');
    const drift = runCreativeQA({ ...base, assets: base.assets.map((a) => (a.kind === 'VOICE' ? { ...a, durationSeconds: 20 } : a)) });
    expect(ids(drift.failedChecks)).toContain('technical.av_sync');
    expect(drift.status).toBe('FAIL');
  });

  it('model-judged checks: low scores FAIL, a missing model is NOT_VERIFIABLE (never PASSED)', () => {
    expect(runCreativeQA(qaInput({ modelReview: goodReview(2) })).status).toBe('FAIL');
    expect(runCreativeQA(qaInput({ modelReview: goodReview(3) })).status).toBe('PASS_WITH_WARNINGS');
    const none = runCreativeQA(qaInput({ modelReview: null, modelReviewError: 'no model' }));
    const tone = [...none.warnings, ...none.passedChecks].find((c) => c.id === 'personality.tone');
    expect(tone).toMatchObject({ result: 'NOT_VERIFIABLE', method: 'HUMAN_REVIEW' });
    expect(none.modelReview.available).toBe(false);
  });

  it('missing artifacts FAIL', () => {
    expect(runCreativeQA({ ...qaInput(), editPlan: null }).status).toBe('FAIL');
  });
});

describe('governance contracts', () => {
  const productionAgents = [
    SCRIPT_AGENT_DEFINITION,
    STORYBOARD_AGENT_DEFINITION,
    VISUAL_PROMPT_AGENT_DEFINITION,
    IMAGE_AGENT_DEFINITION,
    VIDEO_AGENT_DEFINITION,
    VOICE_AGENT_DEFINITION,
    EDITING_AGENT_DEFINITION,
    QA_AGENT_DEFINITION,
  ];

  it('no production agent can publish, trigger automation or touch infrastructure', () => {
    expect(productionAgents.map((a) => a.name)).toEqual(['script', 'storyboard', 'visual-prompt', 'image-generation', 'video-generation', 'voice', 'editing', 'qa']);
    for (const agent of productionAgents) {
      expect(agent.allowedTools, agent.name).not.toContain('social.publish');
      expect(agent.allowedTools, agent.name).not.toContain('n8n.trigger');
      expect(agent.allowedTools, agent.name).not.toContain('infrastructure.modify');
      expect(permissionRank(agent.permissionLevel), agent.name).toBeLessThanOrEqual(permissionRank('LEVEL_3_EXECUTE'));
    }
    // Only media agents may call media tools, each exactly its own kind.
    expect(IMAGE_AGENT_DEFINITION.allowedTools).toEqual(['identity.read', 'production.read', 'media.image.generate']);
    expect(VOICE_AGENT_DEFINITION.allowedTools).toEqual(['identity.read', 'production.read', 'media.voice.generate']);
    for (const agent of [SCRIPT_AGENT_DEFINITION, STORYBOARD_AGENT_DEFINITION, VISUAL_PROMPT_AGENT_DEFINITION, QA_AGENT_DEFINITION]) {
      expect(agent.allowedTools.some((t) => t.startsWith('media.')), agent.name).toBe(false);
    }
    // Publishing remains a PLANNED, LEVEL_4 agent.
    expect(PLANNED_AGENTS.find((a) => a.name === 'publishing')?.permissionLevel).toBe('LEVEL_4_EXTERNAL_ACTION');
  });

  it('the production state machine has no publish state and human-only approval', () => {
    expect(ProductionStatus.options.some((s) => /PUBLISH/.test(s))).toBe(false);
    for (const [from, targets] of Object.entries(PRODUCTION_TRANSITIONS)) {
      if (from !== 'AWAITING_HUMAN_APPROVAL') expect(targets, from).not.toContain('APPROVED');
    }
    // BLOCKED can only be rejected or sent back to media regeneration — both human-only actions.
    expect(PRODUCTION_TRANSITIONS.BLOCKED).toEqual(['REJECTED', 'SAFETY_REVIEW']);
    // R-02: media generation is only reachable through the safety review.
    for (const [from, targets] of Object.entries(PRODUCTION_TRANSITIONS)) {
      if (from !== 'SAFETY_REVIEW') expect(targets, from).not.toContain('GENERATING_ASSETS');
    }
  });

  it('pipeline code cannot set APPROVED/REJECTED; approval needs a passing QA verdict', () => {
    const scope = core.events.scope(newId('correlation'));
    const task = core.tasks.create({ type: 'CREATIVE_PRODUCTION', goal: 'contract test', createdBy: 'test' }, scope);
    const p = core.productions.create(
      { taskId: task.id, sourceType: 'DIRECT', sourcePlanningTaskId: null, ideaId: 'idea-1', idea: IDEA, productionContext: {}, identityVersion: 1, visualIdentityVersion: 1, simulated: false },
      scope,
    );
    expect(() => core.productions.advance(p.id, 'APPROVED', scope)).toThrow(/human decision/);
    for (const s of ['SCRIPTING', 'STORYBOARDING', 'PROMPTING', 'SAFETY_REVIEW', 'GENERATING_ASSETS', 'EDITING', 'QA'] as const) core.productions.advance(p.id, s, scope);
    // QA not yet reported: cannot reach approval; an explicit FAIL report blocks approval.
    core.productions.saveArtifact(p.id, 'QA_REPORT', { status: 'FAIL' }, null, scope);
    core.productions.advance(p.id, 'BLOCKED', scope);
    expect(() => core.productions.recordHumanDecision(p.id, { decision: 'APPROVE', reviewer: 'human' }, scope)).toThrow(ConflictError);
    const rejected = core.productions.recordHumanDecision(p.id, { decision: 'REJECT', reviewer: 'human', note: 'identity drift' }, scope);
    expect(rejected).toMatchObject({ status: 'REJECTED', approvalDecision: 'REJECT', approvedBy: 'human' });
    expect(() => core.productions.recordHumanDecision(p.id, { decision: 'REJECT', reviewer: 'human' }, scope)).toThrow(ConflictError);
  });

  it('the publishing gate never allows autonomous publishing', () => {
    const scope = core.events.scope(newId('correlation'));
    const task = core.tasks.create({ type: 'CREATIVE_PRODUCTION', goal: 'gate test', createdBy: 'test' }, scope);
    const p = core.productions.create(
      { taskId: task.id, sourceType: 'DIRECT', sourcePlanningTaskId: null, ideaId: 'idea-1', idea: IDEA, productionContext: {}, identityVersion: 1, visualIdentityVersion: 1, simulated: false },
      scope,
    );
    const approved = { ...p, status: 'APPROVED', qaStatus: 'PASS' } as typeof p;
    const eligible = evaluatePublishingGate(approved, [asset('RENDER', 'COMPLETED', null)]);
    expect(eligible).toEqual({ eligibleForHumanPublishing: true, autonomousPublishingAllowed: false, blockers: [] });
    const notApproved = evaluatePublishingGate({ ...approved, status: 'AWAITING_HUMAN_APPROVAL' } as typeof p, [asset('RENDER', 'COMPLETED', null)]);
    expect(notApproved.eligibleForHumanPublishing).toBe(false);
    expect(notApproved.blockers.join()).toMatch(/human approval/);
    const simulated = evaluatePublishingGate({ ...approved, simulated: true } as typeof p, [asset('RENDER', 'SIMULATED', null)]);
    expect(simulated.blockers).toEqual(expect.arrayContaining(['production contains simulated assets', 'no completed final render exists']));
    expect(simulated.autonomousPublishingAllowed).toBe(false);
  });
});
