import { copyFileSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApiServer } from '../../apps/api/server.js';
import { routedSafetyReviewer } from '../../src/agents/production/model-safety-review.js';
import { totpCode, TotpVerifier } from '../../src/core/auth/totp.js';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { fromRoot } from '../../src/core/config/paths.js';
import { ConflictError, PermissionDeniedError } from '../../src/core/errors.js';
import { newId } from '../../src/core/ids.js';
import { MediaInspector } from '../../src/media/media-inspector.js';
import { MediaStore } from '../../src/media/media-store.js';
import { mockPlanning, mockProduction } from '../../src/models/providers/mock-creative.js';
import { MockProvider } from '../../src/models/providers/mock-provider.js';
import type { GenerateRequest } from '../../src/models/types.js';
import { pngBytes, TestImageProvider, TestRenderProvider, TestVideoProvider, TestVoiceProvider } from '../fakes/fake-media.js';
import { DIRECT_IDEA, LOCKED_PROFILE, VOICE_DURATIONS } from '../fakes/production-fixtures.js';
import { approvalCode, bearer, calibrateReviewer, createTestCore, TEST_TOTP_SECRET } from '../helpers.js';

/**
 * Regression tests for the final remediation round:
 *  - N-04: the safety reviewer must be calibrated (measured) before it can clear media;
 *  - F-22: the reviewer can be pinned to one model;
 *  - Gate C: a TOTP second factor for API approvals, and external audit anchors;
 *  - N-06 residual: hard links refused, ffprobe on a private copy;
 *  - N-10: the attestation capability is runtime-private.
 * The N-05 ElevenLabs per-character estimate is tested in media-providers-fake.test.ts.
 * Models and media providers are local test doubles (canned output, real files).
 */

let dir: string;
let core: JoviCore | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jovi-final-'));
});
afterEach(async () => {
  await core?.close();
  core = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const ALL_PASS = ['adult_only', 'ai_transparency', 'identity_consistent', 'no_real_person_likeness', 'platform_safe'].map((id) => ({ id, pass: true, note: '' }));
const CORPUS = JSON.parse(readFileSync(fromRoot('prompts', 'production', 'safety-eval-corpus.json'), 'utf8')) as { cases: Array<{ text: string; expect: 'ALLOW' | 'BLOCK' }> };
const LABELS = new Map(CORPUS.cases.map((c) => [c.text, c.expect]));

/** The texts inside <production_material> of a safety-review prompt. */
function materialOf(prompt: string): string[] {
  const inner = /<production_material>\n([\s\S]*?)\n<\/production_material>/.exec(prompt)?.[1] ?? '';
  return inner
    .split('\n')
    .map((l) => l.replace(/^- /, '').trim())
    .filter(Boolean);
}

/**
 * A LOCAL text-model double. Its safety reviewer is either `reviewer`
 * ('oracle' answers corpus cases by their label; 'allow-all' never blocks).
 */
function model(id: string, reviewer: 'oracle' | 'allow-all' = 'allow-all') {
  const calls: string[] = [];
  const provider = new MockProvider({
    id,
    kind: 'LOCAL',
    model: `${id}-model`,
    responder: (r: GenerateRequest) => {
      if (r.task.type === 'production.safety_review') {
        calls.push(r.task.type);
        const blocked = reviewer === 'oracle' && materialOf(r.context.prompt).some((t) => LABELS.get(t) === 'BLOCK');
        return JSON.stringify(
          blocked
            ? { checks: ALL_PASS.map((c) => (c.id === 'adult_only' ? { ...c, pass: false } : c)), verdict: 'BLOCK', reasons: ['labelled BLOCK'] }
            : { checks: ALL_PASS, verdict: 'ALLOW', reasons: [] },
        );
      }
      return JSON.stringify(r.task.type.startsWith('planning.') ? mockPlanning(r.task.type, r.context.prompt) : mockProduction(r.task.type, r.context.prompt));
    },
  });
  return { provider, calls };
}
function media() {
  const store = new MediaStore(join(dir, 'media'), join(dir, 'references'));
  const image = new TestImageProvider(store);
  return { store, image, all: [image, new TestVideoProvider(store), new TestVoiceProvider(store, VOICE_DURATIONS), new TestRenderProvider(store)] };
}
const env = (extra: Record<string, string> = {}) => ({ JOVI_MEDIA_DIR: join(dir, 'media'), JOVI_REFERENCE_DIR: join(dir, 'references'), ...extra });

describe('N-04 the safety reviewer must be calibrated before it can clear media', () => {
  it('an uncalibrated real reviewer blocks the production before any media request', async () => {
    const m = media();
    core = await createTestCore({ providers: [model('local-a').provider], mediaProviders: m.all, env: env(), calibrateReviewers: false });
    core.visualIdentity.createVersion(LOCKED_PROFILE, 'human:art-director', 'lock');
    const r = await core.production.start({ idea: DIRECT_IDEA });
    expect(r.productionStatus).toBe('BLOCKED');
    const review = core.productions.latestArtifact<{ verdict: string; reasons: string[] }>(r.productionId!, 'SAFETY_REVIEW')!;
    expect(review.verdict).toBe('BLOCK');
    expect(review.reasons.join(' ')).toMatch(/SAFETY_REVIEW_NOT_CALIBRATED: local-a:local-a-model has never been measured/);
    expect(m.image.calls).toHaveLength(0);
  });

  it('a reviewer that misses BLOCK cases fails calibration and stays refused; a measured one passes', async () => {
    const weak = model('local-a', 'allow-all');
    core = await createTestCore({ providers: [weak.provider], calibrateReviewers: false });
    const run = () => core!.safetyCalibration.calibrate(routedSafetyReviewer(core!.router, core!.prompts, () => core!.identity.getActive().profile, newId('correlation')), 'local:test');
    const failed = await run();
    expect(failed).toMatchObject({ passed: false, provider: 'local-a', model: 'local-a-model', recall: 0, falseBlockRate: 0 });
    expect(failed.failures.join(' ')).toMatch(/recall 0 below the minimum 0.95/);
    expect(failed.blockCases).toBeGreaterThanOrEqual(40);
    expect(core.safetyCalibration.status('local-a', 'local-a-model')).toMatch(/latest calibration of local-a:local-a-model failed/);
    await core.close();

    const strong = model('local-a', 'oracle');
    core = await createTestCore({ providers: [strong.provider], calibrateReviewers: false });
    const passed = await core.safetyCalibration.calibrate(routedSafetyReviewer(core.router, core.prompts, () => core!.identity.getActive().profile, newId('correlation')), 'local:test');
    expect(passed).toMatchObject({ passed: true, recall: 1, falseBlockRate: 0, errors: 0 });
    expect(strong.calls.length).toBe(CORPUS.cases.length);
    expect(core.safetyCalibration.status('local-a', 'local-a-model')).toBeNull();
    // The record is a protected, chain-verified event.
    const event = core.safetyCalibration.latest('local-a', 'local-a-model')!;
    expect(core.events.verifyEvent(event.eventId).ok).toBe(true);
    expect(() =>
      core!.events.emit({ eventType: 'SAFETY_CALIBRATION_RECORDED', source: 'safety.calibration', entityId: 'local-b:local-b-model', payload: { passed: true } }),
    ).toThrow(PermissionDeniedError);
  });

  it('cases answered by different models, a changed corpus or a changed prompt invalidate the calibration', async () => {
    const corpus = join(dir, 'corpus.json');
    copyFileSync(fromRoot('prompts', 'production', 'safety-eval-corpus.json'), corpus);
    core = await createTestCore({ providers: [model('local-a').provider], calibrateReviewers: false, env: { JOVI_SAFETY_EVAL_CORPUS: corpus } });
    let flip = false;
    const mixed = await core.safetyCalibration.calibrate(async ([text]) => {
      flip = !flip;
      return { provider: flip ? 'local-a' : 'local-b', model: 'm', blocked: LABELS.get(text ?? '') === 'BLOCK' };
    }, 'local:test');
    expect(mixed.passed).toBe(false);
    expect(mixed.failures.join(' ')).toMatch(/different models/);
    expect(core.safetyCalibration.status('local-a', 'm')).toMatch(/failed/);

    await calibrateReviewer(core, 'local-a', 'local-a-model');
    expect(core.safetyCalibration.status('local-a', 'local-a-model')).toBeNull();
    writeFileSync(corpus, readFileSync(corpus, 'utf8').replace('"version": 1', '"version": 2'));
    expect(core.safetyCalibration.status('local-a', 'local-a-model')).toMatch(/corpus changed/);
  });

  it('a too-small corpus cannot calibrate', async () => {
    const corpus = join(dir, 'tiny.json');
    writeFileSync(corpus, JSON.stringify({ version: 1, cases: [{ id: 'b1', text: 'I am 16', expect: 'BLOCK', category: 'minor' }, { id: 'a1', text: 'coffee', expect: 'ALLOW', category: 'benign' }] }));
    core = await createTestCore({ calibrateReviewers: false, env: { JOVI_SAFETY_EVAL_CORPUS: corpus } });
    const result = await core.safetyCalibration.calibrate(async ([t]) => ({ provider: 'local-a', model: 'm', blocked: t === 'I am 16' }), 'local:test');
    expect(result).toMatchObject({ passed: false, recall: 1 });
    expect(result.failures.join(' ')).toMatch(/BLOCK cases \(minimum 40\)/);
  });

  it('an uncalibrated reviewer cannot approve visual-identity anchors', async () => {
    core = await createTestCore({ providers: [model('local-a').provider], calibrateReviewers: false });
    await expect(core.visualIdentity.createReviewedVersion(LOCKED_PROFILE, 'api:jatin', 'lock')).rejects.toThrow(/SAFETY_REVIEW_NOT_CALIBRATED/);
  });

  it('the minimum recall cannot be configured below 0.9', async () => {
    await expect(createTestCore({ env: { JOVI_SAFETY_EVAL_MIN_RECALL: '0.5' } })).rejects.toThrow();
  });
});

describe('F-22 the safety reviewer can be pinned to one model', () => {
  it('only the pinned model reviews; a missing pinned model fails closed', async () => {
    const generator = model('local-gen');
    const reviewer = model('local-rev', 'oracle');
    const m = media();
    core = await createTestCore({ providers: [generator.provider, reviewer.provider], mediaProviders: m.all, env: env({ JOVI_SAFETY_REVIEW_MODEL: 'local-rev:local-rev-model' }) });
    core.visualIdentity.createVersion(LOCKED_PROFILE, 'human:art-director', 'lock');
    const r = await core.production.start({ idea: DIRECT_IDEA });
    const review = core.productions.latestArtifact<{ model: { provider: string } }>(r.productionId!, 'SAFETY_REVIEW')!;
    expect(review.model.provider).toBe('local-rev');
    expect(generator.calls).toHaveLength(0);
    await core.close();

    core = await createTestCore({ providers: [generator.provider], mediaProviders: media().all, env: env({ JOVI_SAFETY_REVIEW_MODEL: 'local-rev' }) });
    core.visualIdentity.createVersion(LOCKED_PROFILE, 'human:art-director', 'lock');
    const blocked = await core.production.start({ idea: DIRECT_IDEA });
    expect(blocked.productionStatus).toBe('BLOCKED');
    expect(core.productions.latestArtifact<{ reasons: string[] }>(blocked.productionId!, 'SAFETY_REVIEW')!.reasons.join(' ')).toMatch(/SAFETY_REVIEW_UNAVAILABLE/);
  });
});

describe('Gate C: second factor for API approvals', () => {
  it('implements RFC 6238 (SHA-1 test vector) and refuses replays per production', () => {
    // RFC 6238 Appendix B: secret "12345678901234567890", T = 59 s → 94287082 (8 digits); 6 digits → 287082.
    expect(totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1)).toBe('287082');
    let now = 59_000;
    const verifier = new TotpVerifier('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', () => now);
    expect(verifier.verify('287082', 'prd_a')).toBeNull();
    expect(verifier.verify('287082', 'prd_a')).toMatch(/already used/);
    expect(verifier.verify('287082', 'prd_b')).toBeNull();
    now = 10 * 60_000;
    expect(verifier.verify('287082', 'prd_c')).toMatch(/not valid/);
    for (let i = 0; i < 4; i++) verifier.verify('000000', 'prd_c');
    expect(verifier.verify(totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', Math.floor(now / 30_000)), 'prd_c')).toMatch(/locked/);
  });

  it('API approvals need a valid code; refusals are audited; without a secret API approvals are refused', async () => {
    core = await createTestCore({ env: { JOVI_SIMULATION_MODE: 'true' } });
    const r = await core.production.start({ idea: DIRECT_IDEA });
    const app = buildApiServer(core);
    const approver = bearer(core, ['read', 'approve']);
    const approve = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: `/api/productions/${r.productionId}/decision`, headers: { ...approver, ...headers }, payload: { decision: 'APPROVE', acknowledgeWarnings: true } });
    expect((await approve({})).statusCode).toBe(403);
    const wrong = await approve({ 'x-jovi-approval-code': '000000' });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().message).toMatch(/Second factor refused/);
    expect(core.events.list({ eventType: 'API_AUTH_FAILED' }).some((e) => e.payload.reason === 'APPROVAL_CODE_REFUSED')).toBe(true);
    // A valid code passes the factor; the simulated production is still not approvable (QA/SIMULATED), proving the order of checks.
    const valid = await approve(approvalCode(TEST_TOTP_SECRET));
    expect(valid.statusCode).not.toBe(403);
    // Rejection needs no second factor (it can only stop content).
    expect((await app.inject({ method: 'POST', url: `/api/productions/${r.productionId}/decision`, headers: approver, payload: { decision: 'REJECT' } })).statusCode).toBe(200);
    await app.close();
    await core.close();

    core = await createTestCore({ env: { JOVI_SIMULATION_MODE: 'true', JOVI_APPROVAL_TOTP_SECRET: '' } });
    const r2 = await core.production.start({ idea: DIRECT_IDEA });
    const app2 = buildApiServer(core);
    const res = await app2.inject({ method: 'POST', url: `/api/productions/${r2.productionId}/decision`, headers: bearer(core, ['approve']), payload: { decision: 'APPROVE' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/JOVI_APPROVAL_TOTP_SECRET/);
    await app2.close();
  });

  it('rejects a weak TOTP secret', async () => {
    await expect(createTestCore({ env: { JOVI_APPROVAL_TOTP_SECRET: 'ABCDEF' } })).rejects.toThrow(/at least 32 characters/);
  });
});

describe('Gate C: external audit anchors', () => {
  it('an anchored head must stay in the chain; approvals stop when it does not', async () => {
    const m = media();
    core = await createTestCore({ providers: [model('local-a', 'oracle').provider], mediaProviders: m.all, env: env() });
    core.visualIdentity.createVersion(LOCKED_PROFILE, 'human:art-director', 'lock');
    const r = await core.production.start({ idea: DIRECT_IDEA });
    expect(r.productionStatus).toBe('AWAITING_HUMAN_APPROVAL');
    const head = core.events.verifyChain().head!;
    expect(core.events.verifyAnchors([{ sequence: head.sequence, hash: head.hash }])).toEqual({ ok: true, results: [{ sequence: head.sequence, status: 'MATCH' }] });
    expect(core.events.verifyAnchors([{ sequence: head.sequence, hash: 'f'.repeat(64) }]).ok).toBe(false);
    expect(core.events.verifyAnchors([{ sequence: head.sequence + 10_000, hash: head.hash }]).results[0]!.status).toBe('MISSING');
    const mediaEnv = env();
    await core.close();

    // A database whose history no longer contains the recorded head refuses approvals.
    core = await createTestCore({ providers: [model('local-a', 'oracle').provider], mediaProviders: media().all, env: { ...mediaEnv, JOVI_AUDIT_ANCHORS: `1:${'a'.repeat(64)}` } });
    core.visualIdentity.createVersion(LOCKED_PROFILE, 'human:art-director', 'lock');
    const p = await core.production.start({ idea: DIRECT_IDEA });
    expect(p.productionStatus).toBe('AWAITING_HUMAN_APPROVAL');
    expect(() =>
      core!.productions.recordHumanDecision(p.productionId!, { decision: 'APPROVE', reviewer: 'local:jatin', acknowledgeWarnings: true }, core!.events.scope(p.correlationId)),
    ).toThrow(ConflictError);
    expect(() =>
      core!.productions.recordHumanDecision(p.productionId!, { decision: 'APPROVE', reviewer: 'local:jatin', acknowledgeWarnings: true }, core!.events.scope(p.correlationId)),
    ).toThrow(/no longer matches recorded anchors \(#1 MISMATCH\)/);
  });

  it('rejects malformed anchors', async () => {
    await expect(createTestCore({ env: { JOVI_AUDIT_ANCHORS: '12:nothex' } })).rejects.toThrow(/sequence:sha256-hash/);
  });
});

describe('N-06 residual: hard links and ffprobe inputs', () => {
  it('refuses hard-linked media inputs and outputs', async () => {
    const store = new MediaStore(join(dir, 'media'), join(dir, 'references'));
    const pid = newId('production');
    const real = store.write(pid, newId('asset'), '.png', pngBytes(4, 4));
    expect(store.readInput(real).length).toBeGreaterThan(0);
    const outside = join(dir, 'outside.png');
    writeFileSync(outside, pngBytes(4, 4));
    const linked = join(dir, 'media', pid, 'linked.png');
    linkSync(outside, linked);
    expect(() => store.readInput(linked)).toThrow(/hard-linked/);
    expect(() => store.stageInputs(new Map([['x', linked]]))).toThrow(/hard-linked/);
    const inspection = await new MediaInspector().inspect(linked, 'IMAGE');
    expect(inspection).toMatchObject({ ok: false });
    expect(inspection.reason).toMatch(/hard-linked/);
    expect((await new MediaInspector().inspect(real, 'IMAGE')).ok).toBe(true);
  });
});

describe('N-10 the attestation capability is runtime-private', () => {
  it('no service exposes it to in-process code', async () => {
    core = await createTestCore({ env: { JOVI_SIMULATION_MODE: 'true' } });
    const loose = (o: unknown) => o as Record<string, Record<string, unknown> | undefined>;
    const candidates = [
      loose(core.productions).audit?.attestation,
      loose(core.events).attestation,
      loose(core.credentials).attestation,
      loose(core.visualIdentity).audit?.attestation,
      loose(core.safetyCalibration).attestation,
    ];
    for (const stolen of candidates) {
      expect(stolen).toBeUndefined();
      expect(() => core!.events.emit({ eventType: 'PRODUCTION_APPROVED', source: 'production', entityId: 'prd_x', payload: {}, attestation: stolen as never })).toThrow(PermissionDeniedError);
    }
    expect(() => core!.events.issueAttestation()).toThrow(PermissionDeniedError);
  });
});
