import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { agentRuns, modelRuns } from '../../src/database/schema.js';
import { MockProvider } from '../../src/models/providers/mock-provider.js';
import { competingMocks, createTestCore, proposalJson, TEST_GOAL } from '../helpers.js';

describe('End-to-end: GOAL → EXECUTIVE → CONTEXT → ROUTER → MODEL → DECISION → MEMORY → EVENTS → RESULT', () => {
  let core: JoviCore;
  afterEach(async () => core?.close());

  it('executes a goal with independent generator and evaluator models', async () => {
    const { cloud, local } = competingMocks();
    core = await createTestCore({ providers: [cloud, local] });

    const result = await core.orchestrator.executeGoal({ goal: TEST_GOAL });

    // --- API-level result -------------------------------------------------
    expect(result.status).toBe('COMPLETED');
    expect(result.taskId).toMatch(/^tsk_/);
    expect(result.jobId).toMatch(/^job_/);
    expect(result.decisionId).toMatch(/^dec_/);
    expect(result.selectedAction?.id).toBe('A');
    expect(result.options).toHaveLength(3);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasoningSummary).toBeTruthy();
    expect(result.nextActions.length).toBeGreaterThan(0);
    expect(result.selection?.method).toBe('EVALUATOR_AGREEMENT');

    // Generator routed to the "cloud" model (HIGH tier); evaluator used the other model.
    expect(result.modelsUsed.map((m) => [m.purpose, m.provider])).toEqual([
      ['executive.proposal', 'mock-cloud'],
      ['evaluation', 'mock-local'],
    ]);
    expect(result.modelsUsed[0]?.routingCategory).toBe('HIGH');

    // External actions are never executed; they require approval.
    const publish = result.nextActions.find((a) => a.agent === 'publishing');
    expect(publish).toMatchObject({ requiredPermission: 'LEVEL_4_EXTERNAL_ACTION', status: 'REQUIRES_APPROVAL' });

    // --- Events (ordered, causally chained) --------------------------------
    const types = result.eventsGenerated.map((e) => e.eventType);
    for (const required of [
      'TASK_CREATED',
      'TASK_STARTED',
      'AGENT_STARTED',
      'MODEL_SELECTED',
      'DECISION_CREATED',
      'DECISION_EVALUATED',
      'DECISION_SELECTED',
      'MEMORY_CREATED',
      'AGENT_COMPLETED',
      'TASK_COMPLETED',
    ]) {
      expect(types).toContain(required);
    }
    expect(types[0]).toBe('TASK_CREATED');
    expect(types.indexOf('DECISION_CREATED')).toBeLessThan(types.indexOf('DECISION_EVALUATED'));
    expect(types.indexOf('DECISION_EVALUATED')).toBeLessThan(types.indexOf('DECISION_SELECTED'));
    expect(types.indexOf('AGENT_COMPLETED')).toBeLessThan(types.indexOf('TASK_COMPLETED'));
    const events = core.events.list({ correlationId: result.correlationId, limit: 1000 });
    for (let i = 1; i < events.length; i += 1) expect(events[i]?.causationId).toBe(events[i - 1]?.eventId);

    // --- Persistence ---------------------------------------------------------
    const task = core.tasks.get(result.taskId);
    expect(task.status).toBe('COMPLETED');
    expect(core.jobs.get(result.jobId)).toMatchObject({ status: 'COMPLETED', attempts: 1 });

    const decision = core.decisions.get(result.decisionId!);
    expect(decision).toMatchObject({ status: 'SELECTED', decisionType: 'CONTENT_DIRECTION', decisionAgent: 'executive@0.1.0', taskId: result.taskId });
    expect(decision.selectedAction).toMatchObject({ id: 'A', title: 'Two Truths and a Glitch' });
    expect(decision.evaluation).toMatchObject({ method: 'MODEL_AND_RULES' });
    expect((decision.modelsUsed as unknown[]).length).toBe(2);

    expect(core.memory.findByKey('DECISION', `decision.${result.decisionId}`)).toBeDefined();
    expect(core.memory.findByKey('CONTENT', 'concept.two-truths-and-a-glitch')?.value).toMatchObject({ status: 'SELECTED_NOT_PRODUCED' });
    const alternatives = core.memory.findByKey('TEMPORARY', `alternatives.${result.decisionId}`);
    expect(alternatives?.expiresAt).toBeTruthy();

    const runs = core.database.db.select().from(modelRuns).where(eq(modelRuns.correlationId, result.correlationId)).all();
    expect(runs.map((r) => r.purpose).sort()).toEqual(['evaluation', 'executive.proposal']);
    expect(runs.every((r) => r.status === 'SUCCEEDED' && r.taskId === result.taskId)).toBe(true);

    const [agentRun] = core.database.db.select().from(agentRuns).where(eq(agentRuns.taskId, result.taskId)).all();
    expect(agentRun).toMatchObject({ agentId: 'executive', status: 'COMPLETED' });
    expect(agentRun?.contextSummary).toMatchObject({ identityVersion: 1, strategyVersion: 1 });

    // The executive received identity + strategy + constraints in its prompt.
    const prompt = cloud.calls[0]!.context.prompt;
    expect(prompt).toContain(`<goal>${TEST_GOAL}</goal>`);
    expect(prompt).toContain("Jovi's Crew");
    expect(prompt).toContain('Core pillars: Travel & Exploration, Fashion & Beauty, Entertainment & Personality');
    expect(cloud.calls[0]!.context.system).toContain('executive decision layer');
  });

  it('works with a single provider (rules-only evaluation, model competition unavailable)', async () => {
    core = await createTestCore({ providers: [new MockProvider()] });
    const result = await core.orchestrator.executeGoal({ goal: TEST_GOAL });
    expect(result.status).toBe('COMPLETED');
    expect(result.modelsUsed).toHaveLength(1);
    expect(result.evaluationSummary).toMatch(/No model evaluation/);
    const decision = core.decisions.get(result.decisionId!);
    expect(decision.evaluation).toMatchObject({ method: 'RULES_ONLY', modelCompetition: { available: false } });
  });

  it('falls back to another provider when the preferred one fails', async () => {
    const broken = new MockProvider({ id: 'mock-cloud', kind: 'CLOUD', failures: 99, failureMode: 'PERMANENT' });
    const backup = new MockProvider({ id: 'mock-local', kind: 'LOCAL' });
    core = await createTestCore({ providers: [broken, backup] });
    const result = await core.orchestrator.executeGoal({ goal: TEST_GOAL });
    expect(result.status).toBe('COMPLETED');
    expect(result.modelsUsed[0]).toMatchObject({ provider: 'mock-local', fallbackUsed: true });
    expect(result.eventsGenerated.map((e) => e.eventType)).toContain('MODEL_FALLBACK');
  });

  it('retries the job after a temporary failure of every provider', async () => {
    core = await createTestCore({ providers: [new MockProvider({ failures: 1, failureMode: 'TEMPORARY' })] });
    const result = await core.orchestrator.executeGoal({ goal: TEST_GOAL });
    expect(result.status).toBe('COMPLETED');
    expect(result.attempts).toBe(2);
    expect(result.eventsGenerated.map((e) => e.eventType)).toEqual(expect.arrayContaining(['AGENT_FAILED', 'JOB_RETRYING', 'AGENT_COMPLETED']));
  });

  it('marks the task FAILED (with TASK_FAILED) when no model can produce a valid decision', async () => {
    core = await createTestCore({ providers: [new MockProvider({ responder: () => '{"nope": true}' })] });
    const result = await core.orchestrator.executeGoal({ goal: TEST_GOAL });
    expect(result.status).toBe('FAILED');
    expect(result.decisionId).toBeNull();
    expect(result.attempts).toBe(3);
    expect(result.error).toMatchObject({ code: 'NO_MODEL_AVAILABLE' });
    expect(result.eventsGenerated.map((e) => e.eventType)).toContain('TASK_FAILED');
    expect(core.tasks.get(result.taskId).status).toBe('FAILED');
  });

  it('overrides a recommendation that breaks AI transparency', async () => {
    const proposal = JSON.parse(proposalJson()) as { options: Array<{ concept: string }> };
    proposal.options[0]!.concept += " She tells everyone: I'm a real person, not an AI.";
    core = await createTestCore({ providers: [new MockProvider({ responder: () => JSON.stringify(proposal) })] });
    const result = await core.orchestrator.executeGoal({ goal: TEST_GOAL });
    expect(result.status).toBe('COMPLETED');
    expect(result.selectedAction?.id).not.toBe('A');
    expect(result.selection?.method).toBe('RULE_OVERRIDE');
  });

  it('supports asynchronous execution through the SQLite-backed worker', async () => {
    core = await createTestCore();
    const queued = await core.orchestrator.executeGoal({ goal: TEST_GOAL, mode: 'async' });
    expect(queued.status).toBe('QUEUED');
    expect(await core.worker.drain()).toBe(1);
    const done = core.orchestrator.getGoalResult(queued.taskId);
    expect(done.status).toBe('COMPLETED');
    expect(done.decisionId).toMatch(/^dec_/);
  });
});
