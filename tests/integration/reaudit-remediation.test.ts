import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApiServer } from '../../apps/api/server.js';
import { CODE_NEGATIVE_PROMPT } from '../../src/agents/production/creative-agents.js';
import { findAppearanceViolations, findIdentityViolations } from '../../src/agents/production/identity-guard.js';
import type { VisualPrompts } from '../../src/agents/production/production-schemas.js';
import { nonCodeNegatives } from '../../src/agents/production/safety-review-agent.js';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { ValidationError } from '../../src/core/errors.js';
import { newId } from '../../src/core/ids.js';
import { MediaStore } from '../../src/media/media-store.js';
import { mockPlanning, mockProduction } from '../../src/models/providers/mock-creative.js';
import { MockProvider } from '../../src/models/providers/mock-provider.js';
import type { GenerateRequest } from '../../src/models/types.js';
import { pngBytes, TestImageProvider, TestRenderProvider, TestVideoProvider, TestVoiceProvider } from '../fakes/fake-media.js';
import { DIRECT_IDEA, LOCKED_PROFILE, VOICE_DURATIONS } from '../fakes/production-fixtures.js';
import { bearer, createTestCore } from '../helpers.js';

/**
 * Regression tests for the re-audit remediations (docs/audit/v2/05):
 * R2-01 (N-01), R2-02 (N-02), R2-03 (N-03), R2-04 (N-04), R2-05 (N-05),
 * R2-06 (N-06), R2-09 (N-08, N-11, N-12). R2-07 (N-07) is checked by the CI
 * container job (token file 0600, no token in logs).
 */

let dir: string;
let core: JoviCore | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jovi-r2-'));
});
afterEach(async () => {
  await core?.close();
  core = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function model(override: (r: GenerateRequest) => unknown = () => undefined) {
  return new MockProvider({
    id: 'local-x',
    kind: 'LOCAL',
    model: 'local-x',
    responder: (r) => {
      const custom = override(r);
      if (custom instanceof Error) throw custom;
      if (custom !== undefined) return JSON.stringify(custom);
      return JSON.stringify(r.task.type.startsWith('planning.') ? mockPlanning(r.task.type, r.context.prompt) : mockProduction(r.task.type, r.context.prompt));
    },
  });
}
function media() {
  const store = new MediaStore(join(dir, 'media'), join(dir, 'references'));
  const image = new TestImageProvider(store);
  return { store, image, all: [image, new TestVideoProvider(store), new TestVoiceProvider(store, VOICE_DURATIONS), new TestRenderProvider(store)] };
}
const env = () => ({ JOVI_MEDIA_DIR: join(dir, 'media'), JOVI_REFERENCE_DIR: join(dir, 'references') });
const ALL_PASS = ['adult_only', 'ai_transparency', 'identity_consistent', 'no_real_person_likeness', 'platform_safe'].map((id) => ({ id, pass: true, note: '' }));

describe('R2-01 negative prompts are code-authored only (N-01, RA-01)', () => {
  it('a model-written negative never reaches a provider', async () => {
    const m = media();
    const steering = model((r) => {
      if (r.task.type !== 'production.visual_prompts') return undefined;
      const canned = mockProduction(r.task.type, r.context.prompt) as { prompts: Array<{ negativePrompt: string }> };
      for (const p of canned.prompts) p.negativePrompt = 'adult, mature woman, grown-up proportions';
      return canned;
    });
    core = await createTestCore({ providers: [steering], mediaProviders: m.all, env: env() });
    core.visualIdentity.createVersion(LOCKED_PROFILE, 'human:art-director', 'lock');
    const r = await core.production.start({ idea: DIRECT_IDEA });
    expect(m.image.calls.length).toBeGreaterThan(0);
    for (const call of m.image.calls as Array<{ negativePrompt: string }>) {
      expect(call.negativePrompt).toBe(CODE_NEGATIVE_PROMPT);
      expect(call.negativePrompt).not.toContain('mature woman');
    }
    expect(r.productionStatus).toBe('AWAITING_HUMAN_APPROVAL');
  });

  it('the safety review blocks prompts whose negative is not the code constant', async () => {
    const m = media();
    core = await createTestCore({ providers: [model()], mediaProviders: m.all, env: env() });
    core.visualIdentity.createVersion(LOCKED_PROFILE, 'human:art-director', 'lock');
    const r = await core.production.start({ idea: DIRECT_IDEA });
    const id = r.productionId!;
    const prompts = core.productions.latestArtifact<VisualPrompts>(id, 'VISUAL_PROMPTS')!;
    expect(nonCodeNegatives(prompts)).toEqual([]);
    const tampered = { ...prompts, prompts: prompts.prompts.map((p) => ({ ...p, negativePrompt: 'adult features' })) };
    core.productions.saveArtifact(id, 'VISUAL_PROMPTS', tampered, null, core.events.scope(r.correlationId));
    const calls = m.image.calls.length;
    const regen = await core.production.regenerateMedia(id, { requestedBy: 'jatin', kinds: ['IMAGE'], includeCompleted: true });
    expect(regen.productionStatus).toBe('BLOCKED');
    expect(core.productions.latestArtifact<{ reasons: string[] }>(id, 'SAFETY_REVIEW')!.reasons.join(' ')).toMatch(/NEGATIVE_PROMPT_NOT_CODE_AUTHORED/);
    expect(m.image.calls.length).toBe(calls);
  });
});

describe('R2-02 visual identity: named persons and an independent model review (N-02, RA-02)', () => {
  it('heuristics catch a real person named next to a facial feature; Jovi’s own name is allowed', () => {
    for (const face of ['Taylor Swift face and smile', "Zendaya's jawline and eyes", 'face of the singer Dua Lipa']) {
      expect(findAppearanceViolations([face], ['Jovi']).map((v) => v.rule), face).toContain('REAL_PERSON_LIKENESS');
    }
    expect(findAppearanceViolations(["Jovi's face: oval, hazel eyes", 'oval face, not resembling any real person'], ['Jovi'])).toEqual([]);
  });

  it('human-entered versions need the model review: BLOCK and unavailable are refused, ALLOW is recorded', async () => {
    let answer: unknown = { checks: ALL_PASS, verdict: 'ALLOW', reasons: [] };
    core = await createTestCore({ providers: [model((r) => (r.task.type === 'production.safety_review' ? answer : undefined))] });
    const subtle = { ...LOCKED_PROFILE, face: 'the face from the famous 2019 music video' };
    answer = { checks: ALL_PASS.map((c) => (c.id === 'no_real_person_likeness' ? { ...c, pass: false, note: 'identifies a real performer' } : c)), verdict: 'BLOCK', reasons: ['real person'] };
    await expect(core.visualIdentity.createReviewedVersion(subtle, 'api:jatin', 'probe')).rejects.toThrow(/independent review: .*no_real_person_likeness/);
    answer = new Error('model offline');
    await expect(core.visualIdentity.createReviewedVersion(LOCKED_PROFILE, 'api:jatin', 'probe')).rejects.toThrow(/APPEARANCE_REVIEW_UNAVAILABLE/);
    answer = { checks: ALL_PASS, verdict: 'ALLOW', reasons: [] };
    expect((await core.visualIdentity.createReviewedVersion(LOCKED_PROFILE, 'api:jatin', 'lock')).status).toBe('LOCKED');
    await expect(core.visualIdentity.createReviewedVersion({ ...LOCKED_PROFILE, face: 'Taylor Swift face' }, 'api:jatin', 'probe')).rejects.toThrow(ValidationError);
  });
});

describe('R2-03 retention checkpoints must be vouched for by a chained event (N-03, RA-03)', () => {
  it('a forged checkpoint hiding a deleted prefix fails verification', async () => {
    core = await createTestCore({ env: { JOVI_SIMULATION_MODE: 'true' } });
    await core.orchestrator.executeGoal({ goal: 'Create an Instagram Reel concept for Jovi.' });
    const victim = core.database.sqlite.prepare('SELECT sequence, hash FROM events ORDER BY sequence LIMIT 1 OFFSET 9').get() as { sequence: number; hash: string };
    core.database.sqlite
      .prepare("INSERT INTO audit_checkpoints (id, sequence, hash, pruned_events, pruned_before, created_at) VALUES ('ckp_forged', ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')")
      .run(victim.sequence, victim.hash, victim.sequence);
    core.database.sqlite.prepare('DELETE FROM events WHERE sequence <= ?').run(victim.sequence);
    expect(core.events.verifyChain()).toMatchObject({ ok: false, firstBreak: { reason: 'retention checkpoint has no matching chained RETENTION_APPLIED event' } });
  });
});

describe('R2-04 heuristic terms (N-04, RA-04)', () => {
  it('catches the re-audit paraphrases without flagging creator language', async () => {
    core = await createTestCore();
    const identity = core.identity.getActive().profile;
    const missed = [
      'my sweet sixteen party vlog',
      'just got my learner permit',
      'year 10 student life in London',
      'revising for my GCSEs',
      "I'm a mere seventeen",
      'still in sixth form',
      'my first day of freshman year',
      'too young to drink, obviously',
      'flesh and bone, no algorithms here',
      "there's no code behind this face",
      'a petite, flat-chested, prepubescent look',
    ].filter((t) => findIdentityViolations([t], identity, { likeness: true }).length === 0);
    expect(missed).toEqual([]);
    const flagged = [
      "I'm almost ten minutes late to my own coffee review",
      "I'm only two reels into the series",
      'Never claim to be flesh and blood',
      'No filter here, just good light',
      "Jovi's face lit by window light",
      'Golden hour light on her face',
    ].filter((t) => findIdentityViolations([t], identity, { likeness: true }).length > 0);
    expect(flagged).toEqual([]);
  });
});

describe('R2-05 unpriced cloud calls count against the budget (N-05, RA-08)', () => {
  it('counts each unpriced call at the configured worst case', async () => {
    core = await createTestCore({ env: { JOVI_DAILY_CLOUD_BUDGET_USD: '1', JOVI_UNPRICED_CALL_USD: '0.05' } });
    const insert = core.database.sqlite.prepare(
      "INSERT INTO model_runs (id, provider, model, purpose, correlation_id, routing_category, routing_reason, attempt, is_fallback, status, latency_ms, estimated_api_cost, execution_cost_type) VALUES (?, 'anthropic', 'claude-unlisted', 'probe', 'cor_x', 'NORMAL', 'r', 1, 0, 'SUCCEEDED', 1, NULL, 'API')",
    );
    for (let i = 0; i < 19; i += 1) insert.run(newId('modelRun'));
    expect(core.budget.spentTodayUsd()).toMatchObject({ unpricedCalls: 19 });
    expect(core.budget.exhaustedReason()).toBeNull();
    insert.run(newId('modelRun'));
    expect(core.budget.spentTodayUsd().total).toBeCloseTo(1);
    expect(core.budget.exhaustedReason()).toMatch(/daily cloud budget reached/);
  });
});

describe('R2-06 verified opens and staged process inputs (N-06)', () => {
  it('stages media inputs into a private directory through verified descriptors, refusing symlinks', () => {
    const store = new MediaStore(join(dir, 'media'), join(dir, 'references'));
    const pid = newId('production');
    const real = store.write(pid, newId('asset'), '.png', pngBytes(4, 4));
    const staged = store.stageInputs(new Map([['a', real]]));
    const copy = staged.paths.get('a')!;
    expect(statSync(dirname(copy)).mode & 0o777).toBe(0o700);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(statSync(copy).size).toBe(statSync(real).size);
    staged.cleanup();
    expect(existsSync(dirname(copy))).toBe(false);

    mkdirSync(join(dir, 'outside'));
    writeFileSync(join(dir, 'outside', 'secret.png'), pngBytes(4, 4));
    const link = join(dir, 'media', pid, `${newId('asset')}.png`);
    symlinkSync(join(dir, 'outside', 'secret.png'), link);
    expect(() => store.stageInputs(new Map([['b', link]]))).toThrow(ValidationError);
  });
});

describe('R2-09 information items (N-08, N-11, N-12)', () => {
  it('asset responses carry relative paths; staleness follows insertion order; the rollover token expires', async () => {
    const m = media();
    core = await createTestCore({ providers: [model()], mediaProviders: m.all, env: env() });
    core.visualIdentity.createVersion(LOCKED_PROFILE, 'human:art-director', 'lock');
    const r = await core.production.start({ idea: DIRECT_IDEA });
    const app = buildApiServer(core);
    const res = await app.inject({ method: 'GET', url: `/api/productions/${r.productionId}/assets`, headers: bearer(core, ['read']) });
    expect(res.body).not.toContain(dir);
    expect((res.json() as { assets: Array<{ location: string | null }> }).assets.find((a) => a.location)?.location).toMatch(/^media\/prd_/);
    await app.close();

    // Same-millisecond writes cannot hide a newer prompt artifact (rowid order).
    const scope = core.events.scope(r.correlationId);
    const prompts = core.productions.latestArtifact(r.productionId!, 'VISUAL_PROMPTS');
    core.productions.saveArtifact(r.productionId!, 'SAFETY_REVIEW', { verdict: 'ALLOW', reasons: [] }, null, scope);
    core.productions.saveArtifact(r.productionId!, 'VISUAL_PROMPTS', prompts, null, scope);
    expect(core.productions.safetyClearance(r.productionId!)).toMatch(/SAFETY_REVIEW_STALE/);
  });

  it('an expired rollover token is refused', async () => {
    const current = 'Cur-rent-token-0123456789-abcdefghijKLMN';
    const previous = 'Prev-ious-token-0123456789-abcdefghijKLMN';
    core = await createTestCore({ env: { JOVI_API_TOKEN: current, JOVI_API_TOKEN_PREVIOUS: previous, JOVI_API_TOKEN_PREVIOUS_EXPIRES_AT: new Date(Date.now() - 1000).toISOString() } });
    expect(core.credentials.verify(previous)).toBeNull();
    expect(core.credentials.verify(current)?.id).toBe('env:JOVI_API_TOKEN');
  });
});
