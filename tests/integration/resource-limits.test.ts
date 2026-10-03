import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApiServer } from '../../apps/api/server.js';
import { ExpensiveCallLimiter } from '../../apps/api/security.js';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { ConflictError, RateLimitedError } from '../../src/core/errors.js';
import { newId } from '../../src/core/ids.js';
import { MediaStore } from '../../src/media/media-store.js';
import { MockProvider } from '../../src/models/providers/mock-provider.js';
import { TestImageProvider, TestRenderProvider, TestVideoProvider, TestVoiceProvider } from '../fakes/fake-media.js';
import { countingLocalModel, DIRECT_IDEA, LOCKED_PROFILE, VOICE_DURATIONS } from '../fakes/production-fixtures.js';
import { bearer, clearForMedia, createTestCore, TEST_GOAL } from '../helpers.js';

/**
 * Regression tests for security remediation R-05 (audit F-05, red-team RT-14):
 * async jobs hold concurrency slots, the queue is capped, write routes are
 * rate limited, regenerations are capped, media has a disk quota and a GC for
 * superseded files, and cloud spend has a daily budget.
 */

let dir: string;
let core: JoviCore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jovi-limits-'));
});
afterEach(async () => {
  await core?.close();
  rmSync(dir, { recursive: true, force: true });
});

const mediaEnv = () => ({ JOVI_MEDIA_DIR: join(dir, 'media'), JOVI_REFERENCE_DIR: join(dir, 'references') });
function testMedia(kind: 'LOCAL' | 'CLOUD' = 'LOCAL') {
  const store = new MediaStore(join(dir, 'media'), join(dir, 'references'));
  const image = new TestImageProvider(store, { kind });
  return { store, image, all: [image, new TestVideoProvider(store), new TestVoiceProvider(store, VOICE_DURATIONS), new TestRenderProvider(store)] };
}
const pendingJobs = () => (core.database.sqlite.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('QUEUED','RETRYING','RUNNING')").get() as { n: number }).n;
const taskCount = () => (core.database.sqlite.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n;

describe('R-05 job admission (RT-14)', () => {
  it('async requests keep their concurrency slot until the job finishes', async () => {
    core = await createTestCore({ env: { JOVI_SIMULATION_MODE: 'true', JOVI_WORKER_ENABLED: 'false' } });
    const app = buildApiServer(core, { limiter: new ExpensiveCallLimiter(10, 2) });
    const headers = bearer(core, ['operate', 'read']);
    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1) codes.push((await app.inject({ method: 'POST', url: '/api/productions', headers, payload: { idea: DIRECT_IDEA, mode: 'async' } })).statusCode);
    expect(codes).toEqual([202, 202, 429, 429, 429, 429]);
    expect(core.jobs.countPendingAsync()).toBe(2);
    // Synchronous calls are refused too while two async jobs hold the slots.
    expect((await app.inject({ method: 'POST', url: '/api/jovi/goal', headers, payload: { goal: TEST_GOAL } })).statusCode).toBe(429);
    // Once the jobs finish, the slots are free again.
    await core.worker.drain();
    expect(core.jobs.countPendingAsync()).toBe(0);
    expect((await app.inject({ method: 'POST', url: '/api/jovi/goal', headers, payload: { goal: TEST_GOAL } })).statusCode).toBe(200);
    await app.close();
  });

  it('the queue is capped for every entry point and refusals create no orphan tasks', async () => {
    core = await createTestCore({ env: { JOVI_SIMULATION_MODE: 'true', JOVI_WORKER_ENABLED: 'false', JOVI_MAX_QUEUED_JOBS: '3' } });
    for (let i = 0; i < 3; i += 1) await core.orchestrator.executeGoal({ goal: TEST_GOAL, mode: 'async' });
    expect(pendingJobs()).toBe(3);
    const tasks = taskCount();
    await expect(core.orchestrator.executeGoal({ goal: TEST_GOAL, mode: 'async' })).rejects.toBeInstanceOf(RateLimitedError);
    await expect(core.production.start({ idea: DIRECT_IDEA, mode: 'async' })).rejects.toBeInstanceOf(RateLimitedError);
    expect(taskCount()).toBe(tasks);
    expect(pendingJobs()).toBe(3);
  });

  it('memory, decision and visual-identity writes are rate limited per principal; external memory is capped', async () => {
    core = await createTestCore({ env: { JOVI_WRITE_RATE_LIMIT_PER_MINUTE: '3', JOVI_MAX_EXTERNAL_MEMORY_ITEMS: '5' } });
    const app = buildApiServer(core);
    const headers = bearer(core, ['operate', 'approve', 'identity-admin']);
    const memory = (i: number) => app.inject({ method: 'POST', url: '/api/memory', headers, payload: { type: 'FACT', key: `fan.${i}`, value: 'x' } });
    expect([(await memory(1)).statusCode, (await memory(2)).statusCode, (await memory(3)).statusCode, (await memory(4)).statusCode]).toEqual([201, 201, 201, 429]);
    // Another principal has its own budget.
    const other = bearer(core, ['operate']);
    expect((await app.inject({ method: 'POST', url: '/api/memory', headers: other, payload: { type: 'FACT', key: 'fan.9', value: 'x' } })).statusCode).toBe(201);
    for (let i = 0; i < 3; i += 1) await app.inject({ method: 'POST', url: '/api/productions/prd_missing/decision', headers, payload: { decision: 'REJECT' } });
    expect((await app.inject({ method: 'POST', url: '/api/productions/prd_missing/decision', headers, payload: { decision: 'REJECT' } })).statusCode).toBe(429);
    await app.close();

    // Total external memory is capped regardless of rate.
    core.memory.writeExternal({ type: 'FACT', key: 'fan.10', value: 'x' });
    expect(() => core.memory.writeExternal({ type: 'FACT', key: 'fan.11', value: 'x' })).toThrow(RateLimitedError);
    expect(core.memory.writeExternal({ type: 'FACT', key: 'fan.10', value: 'updated' }).created).toBe(false);
  });

  it('sets a request-receive timeout (slow-client defence)', async () => {
    core = await createTestCore({ env: { JOVI_REQUEST_TIMEOUT_MS: '15000' } });
    const app = buildApiServer(core);
    await app.ready();
    // The effective Node HTTP server setting, not just the option passed to Fastify.
    expect(app.server.requestTimeout).toBe(15_000);
    await app.close();
  });
});

describe('R-05 media limits', () => {
  it('caps human-requested regenerations per production', async () => {
    const m = testMedia();
    core = await createTestCore({ providers: [countingLocalModel().model], mediaProviders: m.all, env: { ...mediaEnv(), JOVI_MAX_MEDIA_REGENERATIONS: '1' } });
    core.visualIdentity.createVersion(LOCKED_PROFILE, 'human:art-director', 'lock');
    const first = await core.production.start({ idea: DIRECT_IDEA });
    const again = await core.production.regenerateMedia(first.productionId!, { requestedBy: 'jatin', kinds: ['IMAGE'], includeCompleted: true });
    expect(again.productionStatus).toBe('AWAITING_HUMAN_APPROVAL');
    await expect(core.production.regenerateMedia(first.productionId!, { requestedBy: 'jatin', kinds: ['IMAGE'], includeCompleted: true })).rejects.toThrow(ConflictError);
    expect(core.productions.regenerationCount(first.productionId!)).toBe(1);
  });

  it('refuses generation when the media directory exceeds its quota (no provider call)', async () => {
    const m = testMedia();
    core = await createTestCore({ mediaProviders: m.all, env: { ...mediaEnv(), JOVI_MEDIA_QUOTA_MB: '1' } });
    mkdirSync(join(dir, 'media', 'filler'), { recursive: true });
    writeFileSync(join(dir, 'media', 'filler', 'big.bin'), Buffer.alloc(1024 * 1024 + 1));
    const scope = core.events.scope(newId('correlation'));
    const task = core.tasks.create({ type: 'CREATIVE_PRODUCTION', goal: 'quota', createdBy: 'test' }, scope);
    const p = core.productions.create({ taskId: task.id, sourceType: 'DIRECT', sourcePlanningTaskId: null, ideaId: 'i', idea: {}, productionContext: {}, identityVersion: 1, visualIdentityVersion: 1, simulated: false }, scope);
    clearForMedia(core, p.id);
    const asset = await core.media.generateImage({ productionId: p.id, sceneId: 's1', aspectRatio: '9:16', request: { sceneId: 's1', prompt: 'p', negativePrompt: 'n', aspectRatio: '9:16', referenceImages: [] } }, scope);
    expect(asset.status).toBe('BLOCKED');
    expect(asset.statusReason).toMatch(/^MEDIA_QUOTA_EXCEEDED/);
    expect(m.image.calls).toHaveLength(0);
  });

  it('garbage-collects files of superseded assets, keeping their records', async () => {
    const m = testMedia();
    core = await createTestCore({ providers: [countingLocalModel().model], mediaProviders: m.all, env: mediaEnv() });
    core.visualIdentity.createVersion(LOCKED_PROFILE, 'human:art-director', 'lock');
    const first = await core.production.start({ idea: DIRECT_IDEA });
    await core.production.regenerateMedia(first.productionId!, { requestedBy: 'jatin', kinds: ['IMAGE'], includeCompleted: true });
    const superseded = core.assets.list(first.productionId!).filter((a) => a.status === 'SUPERSEDED' && a.location);
    expect(superseded.length).toBeGreaterThan(0);
    const scope = core.events.scope(newId('correlation'));
    // Retention: nothing is old enough yet.
    expect(core.media.collectSuperseded({ olderThanDays: 7 }, scope).assets).toBe(0);
    await new Promise((r) => setTimeout(r, 5));
    const dry = core.media.collectSuperseded({ olderThanDays: 0, dryRun: true }, scope);
    expect(dry).toMatchObject({ assets: superseded.length, dryRun: true });
    expect(superseded.every((a) => m.store.holdsFile(a.location!))).toBe(true);
    const gc = core.media.collectSuperseded({ olderThanDays: 0 }, scope);
    expect(gc.assets).toBe(superseded.length);
    expect(gc.bytes).toBeGreaterThan(0);
    for (const a of superseded) {
      expect(m.store.holdsFile(a.location!)).toBe(false);
      expect(core.assets.get(a.id)).toMatchObject({ status: 'SUPERSEDED', metadata: expect.objectContaining({ purgedAt: expect.any(String) }) });
    }
    // Active assets are untouched; a second run finds nothing.
    expect(core.assets.listActive(first.productionId!).filter((a) => a.location).every((a) => m.store.holdsFile(a.location!))).toBe(true);
    expect(core.media.collectSuperseded({ olderThanDays: 0 }, scope).assets).toBe(0);
    // Only runs that deleted something are recorded.
    expect(core.events.list({ eventType: 'MEDIA_GC_COMPLETED', limit: 5 }).map((e) => e.payload.assets)).toEqual([superseded.length]);
  });
});

describe('R-05 daily cloud budget', () => {
  const routing = { taskType: 'probe', complexity: 'NORMAL', quality: 'NORMAL', privacy: 'STANDARD', costClass: 'LOW', latency: 'STANDARD' } as const;
  const spend = (usd: number) =>
    core.database.sqlite
      .prepare(
        "INSERT INTO model_runs (id, provider, model, purpose, correlation_id, routing_category, routing_reason, attempt, is_fallback, status, latency_ms, estimated_api_cost, execution_cost_type) VALUES (?, 'anthropic', 'm', 'probe', 'cor_x', 'NORMAL', 'r', 1, 0, 'SUCCEEDED', 1, ?, 'API')",
      )
      .run(newId('modelRun'), usd);

  it('stops routing to cloud models once the day\'s estimated spend reaches the budget; local still works', async () => {
    core = await createTestCore({
      providers: [new MockProvider({ id: 'anthropic', kind: 'CLOUD', model: 'cloud-model' }), new MockProvider({ id: 'lmstudio', kind: 'LOCAL', model: 'local-model' })],
      env: { JOVI_DAILY_CLOUD_BUDGET_USD: '5' },
    });
    expect((await core.router.plan(routing)).candidates[0]?.kind).toBe('CLOUD');
    spend(3);
    expect((await core.router.plan(routing)).candidates[0]?.kind).toBe('CLOUD');
    spend(2.5);
    const plan = await core.router.plan(routing);
    expect(plan.candidates.map((c) => c.kind)).toEqual(['LOCAL']);
    expect(plan.reason).toMatch(/CLOUD_BUDGET: daily cloud budget reached \(\$5\.50 of \$5\.00/);
    expect(core.budget.spentTodayUsd().models).toBeCloseTo(5.5);
  });

  it('a zero budget disables cloud providers for models and media', async () => {
    const m = testMedia('CLOUD');
    core = await createTestCore({ providers: [new MockProvider({ id: 'anthropic', kind: 'CLOUD' }), new MockProvider({ id: 'lmstudio', kind: 'LOCAL' })], mediaProviders: m.all, env: { ...mediaEnv(), JOVI_DAILY_CLOUD_BUDGET_USD: '0' } });
    expect((await core.router.plan(routing)).candidates.every((c) => c.kind === 'LOCAL')).toBe(true);
    const scope = core.events.scope(newId('correlation'));
    const task = core.tasks.create({ type: 'CREATIVE_PRODUCTION', goal: 'budget', createdBy: 'test' }, scope);
    const p = core.productions.create({ taskId: task.id, sourceType: 'DIRECT', sourcePlanningTaskId: null, ideaId: 'i', idea: {}, productionContext: {}, identityVersion: 1, visualIdentityVersion: 1, simulated: false }, scope);
    clearForMedia(core, p.id);
    const asset = await core.media.generateImage({ productionId: p.id, sceneId: 's1', aspectRatio: '9:16', request: { sceneId: 's1', prompt: 'p', negativePrompt: 'n', aspectRatio: '9:16', referenceImages: [] } }, scope);
    expect(asset.status).toBe('BLOCKED');
    expect(JSON.stringify(asset.metadata)).toMatch(/CLOUD_BUDGET: cloud providers disabled/);
    expect(m.image.calls).toHaveLength(0);
  });
});
