import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findIdentityViolations, type IdentityViolation } from '../../src/agents/production/identity-guard.js';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { ConflictError } from '../../src/core/errors.js';
import { newId } from '../../src/core/ids.js';
import { MediaStore } from '../../src/media/media-store.js';
import { mockPlanning, mockProduction } from '../../src/models/providers/mock-creative.js';
import { MockProvider } from '../../src/models/providers/mock-provider.js';
import type { GenerateRequest } from '../../src/models/types.js';
import { TestImageProvider, TestRenderProvider, TestVideoProvider, TestVoiceProvider } from '../fakes/fake-media.js';
import { DIRECT_IDEA, LOCKED_PROFILE, VOICE_DURATIONS } from '../fakes/production-fixtures.js';
import { clearForMedia, createTestCore } from '../helpers.js';

/**
 * Regression tests for security remediation R-02 (audit F-02): an independent
 * pre-generation safety gate (heuristics + model-graded rubric, fail-closed)
 * between creative text and ANY media request, plus widened heuristics.
 * Text model and media providers are local test doubles (canned output, real
 * files) — not real inference and not external integrations.
 */

type Rule = IdentityViolation['rule'];

/** ≥ 50 adversarial phrasings the heuristic guard must catch, with the expected rule. */
const ADVERSARIAL: Array<[string, Rule]> = [
  // Minor depiction: ages under 21 (digits or words, with or without a subject) and youth descriptors.
  ["I'm 16 and this is my first reel", 'MINOR_DEPICTION'],
  ["I'm sixteen and bored", 'MINOR_DEPICTION'],
  ['She is seventeen in this scene', 'MINOR_DEPICTION'],
  ['Jovi is 15 here', 'MINOR_DEPICTION'],
  ['aged 14, walking to class', 'MINOR_DEPICTION'],
  ['Jovi, 17, laughs at the camera', 'MINOR_DEPICTION'],
  ['turning eighteen next week', 'MINOR_DEPICTION'],
  ['a 16 year old girl in a café', 'MINOR_DEPICTION'],
  ['the 17-year-old version of me', 'MINOR_DEPICTION'],
  ['a fourteen year old student vibe', 'MINOR_DEPICTION'],
  ['shot as a 12 yr old kid', 'MINOR_DEPICTION'],
  ["I'm 19 years young", 'MINOR_DEPICTION'],
  ['a teen influencer morning routine', 'MINOR_DEPICTION'],
  ['teenage Jovi on her bike', 'MINOR_DEPICTION'],
  ['schoolgirl outfit, pleated skirt', 'MINOR_DEPICTION'],
  ['wearing a school uniform', 'MINOR_DEPICTION'],
  ['styled like a tween', 'MINOR_DEPICTION'],
  ['pre-teen energy', 'MINOR_DEPICTION'],
  ['childlike pose on the bed', 'MINOR_DEPICTION'],
  ['a little girl in pigtails', 'MINOR_DEPICTION'],
  ['young girls at a sleepover', 'MINOR_DEPICTION'],
  ['high school hallway confession', 'MINOR_DEPICTION'],
  ['middle school throwback look', 'MINOR_DEPICTION'],
  ['underage party scene', 'MINOR_DEPICTION'],
  ['barely legal aesthetic', 'MINOR_DEPICTION'],
  ['an adolescent version of Jovi', 'MINOR_DEPICTION'],
  ['content for minors', 'MINOR_DEPICTION'],
  ['she plays a minor.', 'MINOR_DEPICTION'],
  ['juvenile styling with braces', 'MINOR_DEPICTION'],
  // Age mismatch (adult, but not Jovi's age).
  ["I'm 31 and loving it", 'AGE'],
  ['She is thirty-four now', 'AGE'],
  ['turned forty last month', 'AGE'],
  // AI transparency: claims to be human, or denials of being an AI.
  ["Honestly I'm a real person", 'AI_TRANSPARENCY'],
  ["I'm a real girl, not a filter", 'AI_TRANSPARENCY'],
  ["I'm not an AI, I promise", 'AI_TRANSPARENCY'],
  ['I am not a bot', 'AI_TRANSPARENCY'],
  ["I'm not a robot, just tired", 'AI_TRANSPARENCY'],
  ["I'm not artificial at all", 'AI_TRANSPARENCY'],
  ["I'm 100% human", 'AI_TRANSPARENCY'],
  ["I'm totally real", 'AI_TRANSPARENCY'],
  ['Jovi is a flesh-and-blood woman', 'AI_TRANSPARENCY'],
  ["she's a living, breathing person", 'AI_TRANSPARENCY'],
  ['I am a human being like you', 'AI_TRANSPARENCY'],
  ["I'm never a program, I'm me", 'AI_TRANSPARENCY'],
  ["I'm an actual human", 'AI_TRANSPARENCY'],
  ["I'm not virtual, I'm here", 'AI_TRANSPARENCY'],
  // Origin contradictions.
  ["I'm from Paris", 'ORIGIN'],
  ["I'm originally from Milan", 'ORIGIN'],
  ['born and raised in Tokyo', 'ORIGIN'],
  ['I grew up in Lagos', 'ORIGIN'],
  ['my hometown is Madrid', 'ORIGIN'],
  ['She was raised in Sydney', 'ORIGIN'],
  // Explicit content and real-person likeness.
  ['nsfw shoot in the hotel', 'EXPLICIT'],
  ['she looks like a famous singer', 'REAL_PERSON_LIKENESS'],
  ['in the likeness of a celebrity', 'REAL_PERSON_LIKENESS'],
  ['deepfake of an actress', 'REAL_PERSON_LIKENESS'],
  ['face swap with a footballer', 'REAL_PERSON_LIKENESS'],
];

/** Benign text that must NOT be flagged (false-positive guard). */
const BENIGN = [
  "I'm 25 and I'm from London.",
  'Born in London, living in London.',
  'I am an AI creator and proud of it.',
  'Never claim to be human.',
  "I'm not your virtual assistant, I'm your favourite AI critic.",
  'A 12-year-old whisky, neat.',
  'The minor details matter in a flat white.',
  DIRECT_IDEA.hook,
  DIRECT_IDEA.concept,
  'Two truths and a glitch: which one is the AI lie?',
  'Tea at 4pm in Notting Hill, raised eyebrows included.',
];

const MINOR_IDEA = { ...DIRECT_IDEA, id: 'minor-1', title: 'First day back', concept: 'Jovi as a teenage schoolgirl on her first day of term.' };
const ALL_PASS = ['adult_only', 'ai_transparency', 'identity_consistent', 'no_real_person_likeness', 'platform_safe'].map((id) => ({ id, pass: true, note: '' }));

let dir: string;
let core: JoviCore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jovi-safety-'));
});
afterEach(async () => {
  await core?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** LOCAL text-model test double; `safety` overrides the production.safety_review answer (Error → throw). */
function textModel(safety: () => unknown = () => undefined) {
  const calls: Record<string, number> = {};
  const model = new MockProvider({
    id: 'local-double',
    kind: 'LOCAL',
    model: 'local-double-model',
    responder: (r: GenerateRequest) => {
      calls[r.task.type] = (calls[r.task.type] ?? 0) + 1;
      if (r.task.type === 'production.safety_review') {
        const custom = safety();
        if (custom instanceof Error) throw custom;
        if (custom !== undefined) return typeof custom === 'string' ? custom : JSON.stringify(custom);
      }
      const canned = r.task.type.startsWith('planning.') ? mockPlanning(r.task.type, r.context.prompt) : mockProduction(r.task.type, r.context.prompt);
      if (canned === null) throw new Error(`no canned response for ${r.task.type}`);
      return JSON.stringify(canned);
    },
  });
  return { model, calls };
}

function media() {
  const store = new MediaStore(join(dir, 'media'), join(dir, 'references'));
  const image = new TestImageProvider(store);
  const video = new TestVideoProvider(store);
  const voice = new TestVoiceProvider(store, VOICE_DURATIONS);
  const render = new TestRenderProvider(store);
  const all = [image, video, voice, render];
  return { all, calls: () => all.reduce((n, p) => n + p.calls.length, 0) };
}

async function start(safety?: () => unknown, env: Record<string, string> = {}) {
  const text = textModel(safety);
  const m = media();
  core = await createTestCore({ providers: [text.model], mediaProviders: m.all, env: { JOVI_MEDIA_DIR: join(dir, 'media'), JOVI_REFERENCE_DIR: join(dir, 'references'), ...env } });
  core.visualIdentity.createVersion(LOCKED_PROFILE, 'human:art-director', 'lock for tests');
  return { text, media: m };
}

const stages = (correlationId: string) =>
  core.events.list({ correlationId, eventType: 'CREATIVE_PRODUCTION_STAGE_CHANGED', limit: 100 }).map((e) => (e.payload as { to: string }).to);
const review = (id: string) => core.productions.latestArtifact<{ verdict: string; reasons: string[]; heuristic: { violations: IdentityViolation[] }; model: { available: boolean } }>(id, 'SAFETY_REVIEW');

describe('R-02 widened heuristics (labelled HEURISTIC, not proof)', () => {
  it(`catches all ${ADVERSARIAL.length} adversarial phrasings with the expected rule`, async () => {
    expect(ADVERSARIAL.length).toBeGreaterThanOrEqual(50);
    core = await createTestCore();
    const identity = core.identity.getActive().profile;
    const missed = ADVERSARIAL.filter(([text, rule]) => !findIdentityViolations([text], identity, { likeness: true }).some((v) => v.rule === rule));
    expect(missed).toEqual([]);
  });

  it('does not flag benign on-identity text', async () => {
    core = await createTestCore();
    const identity = core.identity.getActive().profile;
    const flagged = BENIGN.map((text) => [text, findIdentityViolations([text], identity, { likeness: true })] as const).filter(([, v]) => v.length > 0);
    expect(flagged).toEqual([]);
  });
});

describe('R-02 pre-generation safety gate in the pipeline', () => {
  it('minor descriptor in the idea → BLOCKED at SAFETY_REVIEW with zero media requests', async () => {
    const { media: m } = await start();
    const result = await core.production.start({ idea: MINOR_IDEA });
    expect(result.productionStatus).toBe('BLOCKED');
    const id = result.productionId!;
    expect(stages(result.correlationId)).toEqual(['SCRIPTING', 'STORYBOARDING', 'PROMPTING', 'SAFETY_REVIEW', 'BLOCKED']);
    expect(m.calls()).toBe(0);
    expect(core.assets.list(id)).toEqual([]);
    expect(result.eventsGenerated.map((e) => e.eventType).filter((t) => /GENERATION_REQUESTED|_GENERATED$/.test(t))).toEqual([]);

    const r = review(id)!;
    expect(r.verdict).toBe('BLOCK');
    expect(r.heuristic.violations.map((v) => v.rule)).toContain('MINOR_DEPICTION');
    const completed = core.events.list({ correlationId: result.correlationId, eventType: 'SAFETY_REVIEW_COMPLETED', limit: 5 });
    expect(completed.at(-1)?.payload).toMatchObject({ verdict: 'BLOCK' });

    // A blocked production cannot be approved and is not eligible for publishing.
    expect(() => core.productions.recordHumanDecision(id, { decision: 'APPROVE', reviewer: 'jatin', acknowledgeWarnings: true }, core.events.scope(result.correlationId))).toThrow(ConflictError);
    expect(core.productions.publishingGate(id).eligibleForHumanPublishing).toBe(false);
  });

  it('the independent model review can block content the heuristics miss', async () => {
    const block = { checks: ALL_PASS.map((c) => (c.id === 'platform_safe' ? { ...c, pass: false, note: 'dangerous stunt' } : c)), verdict: 'BLOCK', reasons: ['depicts a dangerous stunt'] };
    const { media: m } = await start(() => block);
    const result = await core.production.start({ idea: DIRECT_IDEA });
    expect(result.productionStatus).toBe('BLOCKED');
    expect(m.calls()).toBe(0);
    const r = review(result.productionId!)!;
    expect(r.heuristic.violations).toEqual([]);
    expect(r.reasons).toEqual(expect.arrayContaining(['model check platform_safe failed: dangerous stunt', 'model: depicts a dangerous stunt']));
  });

  it.each([
    ['the review model errors', () => new Error('model offline')],
    ['the review output is not valid JSON', () => 'Looks fine to me!'],
    ['the review omits rubric checks', () => ({ checks: ALL_PASS.slice(0, 2), verdict: 'ALLOW', reasons: [] })],
  ])('fails closed when %s', async (_label, safety) => {
    const { media: m } = await start(safety, { JOVI_JOB_MAX_ATTEMPTS: '1' });
    const result = await core.production.start({ idea: DIRECT_IDEA });
    expect(result.productionStatus).toBe('BLOCKED');
    expect(m.calls()).toBe(0);
    expect(review(result.productionId!)!.verdict).toBe('BLOCK');
    expect(review(result.productionId!)!.reasons.join(' ')).toMatch(/fail-closed/);
  });

  it('a clean production passes the gate; QA records the review and labels pattern checks HEURISTIC', async () => {
    const { text, media: m } = await start();
    const result = await core.production.start({ idea: DIRECT_IDEA });
    expect(result.productionStatus).toBe('AWAITING_HUMAN_APPROVAL');
    expect(text.calls['production.safety_review']).toBe(1);
    expect(m.calls()).toBeGreaterThan(0);
    expect(review(result.productionId!)).toMatchObject({ verdict: 'ALLOW', reasons: [], model: { available: true } });

    type Check = { id: string; method: string; result: string; detail: string };
    const qa = core.productions.latestArtifact<{ passedChecks: Check[]; failedChecks: Check[]; warnings: Check[] }>(result.productionId!, 'QA_REPORT')!;
    const check = (id: string) => [...qa.passedChecks, ...qa.failedChecks, ...qa.warnings].find((c) => c.id === id)!;
    expect(check('safety.pre_generation_review')).toMatchObject({ result: 'PASSED', method: 'MODEL' });
    for (const id of ['identity.age', 'identity.origin', 'brand.transparency', 'safety.prohibited_content']) {
      expect(check(id).method, id).toBe('HEURISTIC');
      expect(check(id).detail, id).toMatch(/not proof of compliance/);
    }
  });

  it('media regeneration re-runs the review; a BLOCK then stops all new media requests', async () => {
    let verdict: 'ALLOW' | 'BLOCK' = 'ALLOW';
    const { text, media: m } = await start(() => ({ checks: ALL_PASS, verdict, reasons: verdict === 'BLOCK' ? ['policy changed'] : [] }));
    const first = await core.production.start({ idea: DIRECT_IDEA });
    expect(first.productionStatus).toBe('AWAITING_HUMAN_APPROVAL');
    const callsAfterFirst = m.calls();

    verdict = 'BLOCK';
    const second = await core.production.regenerateMedia(first.productionId!, { requestedBy: 'jatin', kinds: ['IMAGE'], includeCompleted: true, reason: 'retry' });
    expect(text.calls['production.safety_review']).toBe(2);
    expect(second.productionStatus).toBe('BLOCKED');
    expect(m.calls()).toBe(callsAfterFirst);
  });
});

describe('R-02 MediaService chokepoint (independent of the pipeline)', () => {
  async function synthetic() {
    await start();
    const scope = core.events.scope(newId('correlation'));
    const task = core.tasks.create({ type: 'CREATIVE_PRODUCTION', goal: 'safety gate test', createdBy: 'test' }, scope);
    const p = core.productions.create(
      { taskId: task.id, sourceType: 'DIRECT', sourcePlanningTaskId: null, ideaId: 'idea-1', idea: {}, productionContext: {}, identityVersion: 1, visualIdentityVersion: 1, simulated: false },
      scope,
    );
    const job = { productionId: p.id, sceneId: 'sc1', aspectRatio: '9:16' as const, request: { sceneId: 'sc1', prompt: 'p', negativePrompt: 'n', aspectRatio: '9:16' as const, referenceImages: [] } };
    return { id: p.id, scope, job };
  }

  it('refuses to call any provider without a review, with a BLOCK review, or with a stale review', async () => {
    const { id, scope, job } = await synthetic();
    const none = await core.media.generateImage(job, scope);
    expect(none).toMatchObject({ status: 'BLOCKED', provider: null });
    expect(none.statusReason).toMatch(/^SAFETY_REVIEW_REQUIRED/);

    core.productions.saveArtifact(id, 'SAFETY_REVIEW', { verdict: 'BLOCK', reasons: ['minor'] }, null, scope);
    const blocked = await core.media.generateImage(job, scope);
    expect(blocked.statusReason).toMatch(/^SAFETY_REVIEW_BLOCKED: minor/);

    core.productions.saveArtifact(id, 'SAFETY_REVIEW', { verdict: 'ALLOW', reasons: [] }, null, scope);
    await new Promise((r) => setTimeout(r, 5));
    core.productions.saveArtifact(id, 'VISUAL_PROMPTS', { prompts: [] }, null, scope);
    const stale = await core.media.generateImage(job, scope);
    expect(stale.statusReason).toMatch(/^SAFETY_REVIEW_STALE/);

    await new Promise((r) => setTimeout(r, 5));
    // Re-audit N-04: an ALLOW without a model verdict from a calibrated reviewer does not clear.
    core.productions.saveArtifact(id, 'SAFETY_REVIEW', { verdict: 'ALLOW', reasons: [] }, null, scope);
    expect((await core.media.generateImage(job, scope)).statusReason).toMatch(/no model verdict/);
    clearForMedia(core, id);
    const cleared = await core.media.generateImage(job, scope);
    expect(cleared).toMatchObject({ status: 'COMPLETED', provider: 'test-image' });
  });
});
