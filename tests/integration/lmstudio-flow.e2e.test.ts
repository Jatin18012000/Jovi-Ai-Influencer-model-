import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { agentRuns, modelRuns } from '../../src/database/schema.js';
import { LMStudioProvider } from '../../src/models/providers/lmstudio-provider.js';
import { MockProvider } from '../../src/models/providers/mock-provider.js';
import type { ModelProvider } from '../../src/models/types.js';
import { closedPortUrl, startFakeLMStudio } from '../fakes/fake-lmstudio.js';
import { createTestCore } from '../helpers.js';

const GOAL = 'Create an Instagram Reel concept that introduces Jovi to a new audience and makes viewers curious about who she is.';

type Fake = Awaited<ReturnType<typeof startFakeLMStudio>>;
let fake: Fake | undefined;
let core: JoviCore | undefined;

afterEach(async () => {
  await core?.close();
  await fake?.close();
  core = undefined;
  fake = undefined;
});

const lmstudio = (url: string, model?: string) => new LMStudioProvider({ url, model, timeoutMs: 10_000 });
/** Stand-in for a configured cloud provider (kind CLOUD — not the simulation mock). */
const cloud = (opts: ConstructorParameters<typeof MockProvider>[0] = {}) => new MockProvider({ id: 'anthropic', kind: 'CLOUD', model: 'cloud-model', ...opts });
const start = async (providers: ModelProvider[], env: Record<string, string> = {}) => (core = await createTestCore({ providers, env }));

describe('Full goal flow through the real LMStudioProvider (fake LM Studio server)', () => {
  it('Goal → Task → Job → Context → Executive → Router → LM Studio → Zod → Evaluation → Decision → Memory → Events → Result', async () => {
    fake = await startFakeLMStudio({
      models: [
        { id: 'qwen2.5-7b-instruct', loaded: true },
        { id: 'llama-3.2-3b-instruct', loaded: true },
      ],
    });
    await start([lmstudio(fake.url)]);

    const result = await core!.orchestrator.executeGoal({ goal: GOAL, privacy: 'LOCAL_ONLY' });

    expect(result.status).toBe('COMPLETED');
    expect(result.simulated).toBe(false);
    expect(result.modelsUsed[0]).toMatchObject({
      purpose: 'executive.proposal',
      provider: 'lmstudio',
      model: 'qwen2.5-7b-instruct',
      executionType: 'LOCAL',
      estimatedApiCost: 0,
      executionCostType: 'LOCAL_COMPUTE',
    });
    expect(result.options.length).toBeGreaterThanOrEqual(2);
    expect(result.selectedAction).not.toBeNull();
    // The <think> block and code fence from the model were stripped/parsed; no chain-of-thought persisted.
    expect(JSON.stringify(core!.decisions.get(result.decisionId!))).not.toContain('internal reasoning');

    const types = result.eventsGenerated.map((e) => e.eventType);
    for (const t of ['TASK_CREATED', 'JOB_CREATED', 'TASK_STARTED', 'AGENT_STARTED', 'MODEL_SELECTED', 'DECISION_CREATED', 'EVALUATION_COMPLETED', 'DECISION_EVALUATED', 'DECISION_SELECTED', 'MEMORY_CREATED', 'AGENT_COMPLETED', 'TASK_COMPLETED', 'JOB_COMPLETED']) {
      expect(types).toContain(t);
    }
    expect(core!.jobs.get(result.jobId).status).toBe('COMPLETED');
    expect(core!.memory.findByKey('DECISION', `decision.${result.decisionId}`)?.source).toBe('agent:executive');

    // The prompt LM Studio received carries the ACTIVE identity from the database.
    const [executiveCall] = fake.chatRequests();
    expect(executiveCall?.messages[1]?.content).toContain(`<goal>${GOAL}</goal>`);
    expect(executiveCall?.messages[1]?.content).toContain("Jovi's Crew");

    // Cost metadata recorded per attempt.
    const runs = core!.database.db.select().from(modelRuns).where(eq(modelRuns.correlationId, result.correlationId)).all();
    expect(runs.find((r) => r.purpose === 'executive.proposal')).toMatchObject({
      provider: 'lmstudio',
      status: 'SUCCEEDED',
      inputTokens: 1500,
      outputTokens: 700,
      estimatedApiCost: 0,
      executionCostType: 'LOCAL_COMPUTE',
    });

    // Every tool the Executive used is on the audit trail, all allowed.
    const [run] = core!.database.db.select().from(agentRuns).where(eq(agentRuns.taskId, result.taskId)).all();
    const calls = run?.toolCalls as Array<{ tool: string; allowed: boolean }>;
    expect(calls.map((c) => c.tool)).toEqual(expect.arrayContaining(['identity.read', 'model.generate', 'model.evaluate', 'decision.write', 'memory.write', 'agent.read']));
    expect(calls.every((c) => c.allowed)).toBe(true);
  });

  it('LOCAL_ONLY with one loaded model: evaluation falls back to rules (no second local model), no cloud used', async () => {
    fake = await startFakeLMStudio();
    await start([lmstudio(fake.url), cloud()]);
    const result = await core!.orchestrator.executeGoal({ goal: GOAL, privacy: 'LOCAL_ONLY' });
    expect(result.status).toBe('COMPLETED');
    expect(result.modelsUsed.map((m) => m.provider)).toEqual(['lmstudio']);
    expect(result.evaluationSummary).toMatch(/No model evaluation/);
  });
});

describe('Router selection with LM Studio', () => {
  it('LOW → LM Studio first; HIGH → cloud first; LOCAL_ONLY → LM Studio only', async () => {
    fake = await startFakeLMStudio();
    await start([lmstudio(fake.url), cloud()]);
    expect((await core!.router.plan({ taskType: 't', complexity: 'LOW' })).candidates.map((c) => c.provider)).toEqual(['lmstudio', 'anthropic']);
    expect((await core!.router.plan({ taskType: 't', complexity: 'HIGH' })).candidates.map((c) => c.provider)).toEqual(['anthropic', 'lmstudio']);
    expect((await core!.router.plan({ taskType: 't', complexity: 'STRATEGIC', privacy: 'LOCAL_ONLY' })).candidates.map((c) => c.provider)).toEqual(['lmstudio']);
  });

  it('LM Studio unavailable: LOW uses cloud only when JOVI_ALLOW_CLOUD_FALLBACK allows it', async () => {
    const down = await closedPortUrl();
    await start([lmstudio(down), cloud()]);
    const allowed = await core!.router.plan({ taskType: 't', complexity: 'LOW' });
    expect(allowed.candidates.map((c) => c.provider)).toEqual(['anthropic']);
    expect(allowed.unavailable.find((u) => u.provider === 'lmstudio')?.reason).toMatch(/not reachable/);
    await core!.close();

    await start([lmstudio(down), cloud()], { JOVI_ALLOW_CLOUD_FALLBACK: 'false' });
    const blocked = await core!.orchestrator.executeGoal({ goal: GOAL, tier: 'LOW' });
    expect(blocked.status).toBe('FAILED');
    expect(blocked.error).toMatchObject({ code: 'NO_MODEL_AVAILABLE' });
  });

  it('no model loaded in LM Studio and no cloud key: the goal fails cleanly, the app keeps running', async () => {
    fake = await startFakeLMStudio({ models: [{ id: 'qwen2.5-7b-instruct', loaded: false }] });
    await start([lmstudio(fake.url)]);
    const result = await core!.orchestrator.executeGoal({ goal: GOAL });
    expect(result.status).toBe('FAILED');
    expect(result.error).toMatchObject({ code: 'NO_MODEL_AVAILABLE' });
    expect(fake.chatRequests()).toHaveLength(0);
    expect((await core!.providers.statusesFresh(true))[0]?.reason).toMatch(/No model is loaded/);
  });
});

describe('Provider fallback with the real LM Studio adapter', () => {
  it('LM Studio HTTP 500 → falls back to the configured cloud provider (never to the mock)', async () => {
    fake = await startFakeLMStudio({ chat: () => ({ status: 500, json: { error: 'model crashed' } }) });
    await start([lmstudio(fake.url), cloud()]);
    const result = await core!.orchestrator.executeGoal({ goal: GOAL, tier: 'LOW' });
    expect(result.status).toBe('COMPLETED');
    expect(result.modelsUsed[0]).toMatchObject({ provider: 'anthropic', fallbackUsed: true, executionType: 'CLOUD' });
    const fallback = core!.events.list({ correlationId: result.correlationId, eventType: 'MODEL_FALLBACK' })[0];
    expect(fallback?.payload).toMatchObject({ from: 'lmstudio:qwen2.5-7b-instruct', to: 'anthropic:cloud-model' });
  });

  it('cloud failure → falls back to LM Studio (flagged degraded for HIGH tier)', async () => {
    fake = await startFakeLMStudio();
    await start([cloud({ failures: 99, failureMode: 'TEMPORARY' }), lmstudio(fake.url)]);
    const result = await core!.orchestrator.executeGoal({ goal: GOAL, tier: 'HIGH' });
    expect(result.status).toBe('COMPLETED');
    expect(result.modelsUsed[0]).toMatchObject({ provider: 'lmstudio', fallbackUsed: true, executionType: 'LOCAL' });
  });

  it('invalid JSON from LM Studio gets one repair request, then validates with Zod', async () => {
    let calls = 0;
    fake = await startFakeLMStudio();
    const { defaultChat } = await import('../fakes/fake-lmstudio.js');
    fake.setChat((body) => {
      calls += 1;
      if (calls === 1) return { json: { model: body.model, choices: [{ message: { content: 'Sure! Here is a great idea for Jovi…' } }] } };
      return defaultChat(body);
    });
    await start([lmstudio(fake.url)]);
    const result = await core!.orchestrator.executeGoal({ goal: GOAL, privacy: 'LOCAL_ONLY' });
    expect(result.status).toBe('COMPLETED');
    expect(fake.chatRequests()[1]?.messages[1]?.content).toContain('<repair_request>');
    const statuses = core!.database.db.select().from(modelRuns).where(eq(modelRuns.correlationId, result.correlationId)).all().map((r) => r.status);
    expect(statuses.slice(0, 2)).toEqual(['INVALID_OUTPUT', 'SUCCEEDED']);
  });
});
