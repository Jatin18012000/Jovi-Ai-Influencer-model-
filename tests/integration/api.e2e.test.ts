import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApiServer } from '../../apps/api/server.js';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { mockExecutiveProposal } from '../../src/models/providers/mock-provider.js';
import { authedInject, bearer, createTestCore, TEST_GOAL } from '../helpers.js';

describe('Fastify API', () => {
  let core: JoviCore;
  let app: FastifyInstance;
  let inject: ReturnType<typeof authedInject>;

  async function start(env: Record<string, string> = {}) {
    core = await createTestCore({ env });
    app = buildApiServer(core);
    await app.ready();
    inject = authedInject(app, bearer(core));
  }

  afterEach(async () => {
    await app?.close();
    await core?.close();
  });

  it('GET /health is public but minimal; details live behind /api/status', async () => {
    await start();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'jovi-core', database: 'ok' });
    expect((await app.inject({ method: 'GET', url: '/api/status' })).statusCode).toBe(401);
    const status = await inject({ method: 'GET', url: '/api/status' });
    expect(status.json()).toMatchObject({ status: 'ok', database: 'ok', anyModelAvailable: true });
  });

  it('GET /api/jovi/identity', async () => {
    await start();
    const res = await inject({ method: 'GET', url: '/api/jovi/identity' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.identity.profile).toMatchObject({ name: 'Jovira', creatorName: 'Jovi', age: 25 });
    expect(body.versions).toHaveLength(1);
  });

  it('POST /api/jovi/goal executes the full flow and returns the contract fields', async () => {
    await start();
    const res = await inject({ method: 'POST', url: '/api/jovi/goal', payload: { goal: TEST_GOAL } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const field of ['taskId', 'jobId', 'decisionId', 'selectedAction', 'options', 'confidence', 'reasoningSummary', 'nextActions', 'modelsUsed', 'eventsGenerated']) {
      expect(body).toHaveProperty(field);
    }
    expect(body.status).toBe('COMPLETED');
    expect(body.selectedAction.title).toBe('Two Truths and a Glitch');
    expect(body.eventsGenerated.length).toBeGreaterThan(10);

    // Follow-up reads through the API.
    const task = await inject({ method: 'GET', url: `/api/tasks/${body.taskId}` });
    expect(task.json().task.status).toBe('COMPLETED');
    expect(task.json().jobs).toHaveLength(1);
    const job = await inject({ method: 'GET', url: `/api/jobs/${body.jobId}` });
    expect(job.json().job.status).toBe('COMPLETED');
    const decision = await inject({ method: 'GET', url: `/api/decisions/${body.decisionId}` });
    expect(decision.json().decision.status).toBe('SELECTED');
    const events = await inject({ method: 'GET', url: `/api/events?correlationId=${body.correlationId}&limit=500` });
    expect(events.json().count).toBe(body.eventsGenerated.length);
    const byType = await inject({ method: 'GET', url: '/api/events?type=DECISION_SELECTED' });
    expect(byType.json().events.every((e: { eventType: string }) => e.eventType === 'DECISION_SELECTED')).toBe(true);
  });

  it('POST /api/jovi/goal supports async mode', async () => {
    await start();
    const res = await inject({ method: 'POST', url: '/api/jovi/goal', payload: { goal: TEST_GOAL, mode: 'async' } });
    expect(res.statusCode).toBe(202);
    const { taskId } = res.json();
    await core.worker.drain();
    const poll = await inject({ method: 'GET', url: `/api/jovi/goal/${taskId}` });
    expect(poll.json().status).toBe('COMPLETED');
  });

  it('validates input and returns 404 for unknown ids', async () => {
    await start();
    expect((await inject({ method: 'POST', url: '/api/jovi/goal', payload: { goal: 'hi' } })).statusCode).toBe(400);
    expect((await inject({ method: 'POST', url: '/api/jovi/goal', payload: {} })).statusCode).toBe(400);
    expect((await inject({ method: 'GET', url: '/api/tasks/tsk_missing' })).statusCode).toBe(404);
    expect((await inject({ method: 'GET', url: '/api/decisions/dec_missing' })).statusCode).toBe(404);
    expect((await inject({ method: 'GET', url: '/api/events?type=NOPE' })).statusCode).toBe(400);
  });

  it('returns 503 when no model is available', async () => {
    core = await createTestCore({ providers: [] });
    app = buildApiServer(core);
    inject = authedInject(app, bearer(core));
    const res = await inject({ method: 'POST', url: '/api/jovi/goal', payload: { goal: TEST_GOAL } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'FAILED', error: { code: 'NO_MODEL_AVAILABLE' } });
  });

  it('POST/GET /api/memory', async () => {
    await start();
    const created = await inject({
      method: 'POST',
      url: '/api/memory',
      payload: { type: 'LEARNING', key: 'learning.api', value: { note: 'from api' }, importance: 0.6, confidence: 0.5, source: 'api-test', tags: ['api'] },
    });
    expect(created.statusCode).toBe(201);
    const updated = await inject({ method: 'POST', url: '/api/memory', payload: { type: 'LEARNING', key: 'learning.api', value: 2, source: 'api-test' } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().created).toBe(false);

    const list = await inject({ method: 'GET', url: '/api/memory?type=LEARNING' });
    expect(list.json().items.map((i: { key: string }) => i.key)).toEqual(['learning.api']);
    const search = await inject({ method: 'GET', url: '/api/memory?q=g-wagen%20cars&limit=3' });
    expect(search.json().items[0].key).toBe('lifestyle.cars');
    expect((await inject({ method: 'POST', url: '/api/memory', payload: { type: 'BAD', key: 'k', value: 1, source: 's' } })).statusCode).toBe(400);
  });

  it('GET /api/models and /api/agents', async () => {
    await start();
    const models = await inject({ method: 'GET', url: '/api/models?refresh=true' });
    expect(models.statusCode).toBe(200);
    expect(models.json().providers[0]).toMatchObject({ provider: 'mock', available: true });
    expect(models.json().models[0]).toMatchObject({ id: 'mock:jovi-mock-v1', status: 'AVAILABLE' });
    expect(models.json().competition.available).toBe(false);

    const agents = await inject({ method: 'GET', url: '/api/agents' });
    const list = agents.json().agents as Array<{ name: string; status: string; permissionLevel: string }>;
    expect(list.find((a) => a.name === 'executive')).toMatchObject({ status: 'ACTIVE', permissionLevel: 'LEVEL_2_MODIFY' });
    // Phase 7 planning and Phase 8 production agents are ACTIVE; only roadmap agents remain PLANNED.
    expect(list.filter((a) => a.status === 'ACTIVE').map((a) => a.name)).toEqual(
      expect.arrayContaining(['research', 'trends', 'strategy', 'ideation', 'script', 'storyboard', 'visual-prompt', 'image-generation', 'video-generation', 'voice', 'editing', 'qa']),
    );
    expect(list.filter((a) => a.status === 'PLANNED').map((a) => a.name).sort()).toEqual(['analytics', 'learning', 'publishing']);
    expect(agents.json().permissionCeiling).toBe('LEVEL_3_EXECUTE');
  });

  it('POST /api/evaluate for ad-hoc options and for an existing decision', async () => {
    await start();
    const adhoc = await inject({
      method: 'POST',
      url: '/api/evaluate',
      payload: { objective: 'Introduce Jovi', options: mockExecutiveProposal(TEST_GOAL).options.slice(0, 2) },
    });
    expect(adhoc.statusCode).toBe(200);
    expect(adhoc.json().evaluation).toMatchObject({ method: 'MODEL_AND_RULES', recommendedOptionId: 'A' });

    const goal = await inject({ method: 'POST', url: '/api/jovi/goal', payload: { goal: TEST_GOAL } });
    const byDecision = await inject({ method: 'POST', url: '/api/evaluate', payload: { decisionId: goal.json().decisionId } });
    expect(byDecision.statusCode).toBe(200);
    // The only model generated the options, so an independent model evaluation is unavailable.
    expect(byDecision.json().evaluation.modelCompetition.available).toBe(false);
    expect((await inject({ method: 'POST', url: '/api/evaluate', payload: { objective: 'x' } })).statusCode).toBe(400);
  });

  it('accepts an operator JOVI_API_TOKEN (read,operate by default) without leaking it', async () => {
    const token = 'operator-token-0123456789-abcdefghij';
    await start({ JOVI_API_TOKEN: token });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const denied = await app.inject({ method: 'GET', url: '/api/agents' });
    expect(denied.statusCode).toBe(401);
    expect(denied.body).not.toContain(token);
    const allowed = await app.inject({ method: 'GET', url: '/api/agents', headers: { authorization: `Bearer ${token}` } });
    expect(allowed.statusCode).toBe(200);
    const whoami = await app.inject({ method: 'GET', url: '/api/auth/whoami', headers: { authorization: `Bearer ${token}` } });
    expect(whoami.json()).toEqual({ principal: 'env:JOVI_API_TOKEN', scopes: ['read', 'operate'] });
  });

  it('refuses a weak JOVI_API_TOKEN at configuration time', async () => {
    await expect(createTestCore({ env: { JOVI_API_TOKEN: 'top-secret-token' } })).rejects.toThrow(/at least 32 characters/);
  });
});
