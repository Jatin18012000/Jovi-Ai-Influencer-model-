import { afterEach, describe, expect, it } from 'vitest';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { newId } from '../../src/core/ids.js';
import { evaluations } from '../../src/database/schema.js';
import { APPROVED_JOVI_IDENTITY } from '../../src/database/seed/identity.js';
import { runRuleChecks } from '../../src/models/evaluator/rule-checks.js';
import { mockExecutiveProposal, MockProvider } from '../../src/models/providers/mock-provider.js';
import { competingMocks, createTestCore, TEST_GOAL } from '../helpers.js';

const PILLARS = ['Travel & Exploration', 'Fashion & Beauty', 'Entertainment & Personality'];

describe('Decision persistence', () => {
  let core: JoviCore;
  afterEach(async () => core?.close());

  it('persists a decision through PROPOSED → EVALUATED → SELECTED with events', async () => {
    core = await createTestCore();
    const scope = core.events.scope(newId('correlation'));
    const options = mockExecutiveProposal(TEST_GOAL).options;
    const proposed = core.decisions.propose(
      {
        taskId: null,
        decisionType: 'CONTENT_DIRECTION',
        objective: 'Introduce Jovi',
        context: { goal: TEST_GOAL },
        options,
        reasoningSummary: 'Concise summary.',
        confidence: 0.7,
        decisionAgent: 'executive@0.1.0',
        modelsUsed: [],
      },
      scope,
    );
    expect(proposed.status).toBe('PROPOSED');
    core.decisions.recordEvaluation(proposed.id, { method: 'RULES_ONLY' }, [], scope, {});
    const selected = core.decisions.select(
      proposed.id,
      { selectedAction: options[0], reasoningSummary: 'Final summary.', confidence: 0.7, nextActions: [], modelsUsed: [] },
      scope,
      {},
    );

    expect(selected.status).toBe('SELECTED');
    expect(selected.selectedAction).toMatchObject({ id: 'A' });
    expect(core.decisions.recent()).toHaveLength(1);
    expect(core.events.list({ entityId: proposed.id }).map((e) => e.eventType)).toEqual([
      'DECISION_CREATED',
      'DECISION_EVALUATED',
      'DECISION_SELECTED',
    ]);
    // Only a concise, auditable reasoning summary is stored — no chain-of-thought field exists.
    expect(Object.keys(selected)).not.toContain('chainOfThought');
    expect(Object.keys(selected)).toEqual(
      expect.arrayContaining(['decisionType', 'objective', 'context', 'options', 'selectedAction', 'reasoningSummary', 'confidence', 'decisionAgent', 'modelsUsed', 'createdAt']),
    );
  });
});

describe('Rule checks', () => {
  const option = (concept: string, extra: Record<string, unknown> = {}) => ({
    id: 'X',
    title: 'Test',
    concept,
    pillar: 'Travel & Exploration',
    personalityTraits: ['witty'],
    ...extra,
  });
  const outcome = (concept: string, rule: string, extra?: Record<string, unknown>) =>
    runRuleChecks(option(concept, extra), PILLARS).find((c) => c.rule === rule)?.outcome;

  it('fails content that claims Jovi is human', () => {
    expect(outcome("Jovi says 'I'm a real person, not an AI!'", 'AI_TRANSPARENCY')).toBe('FAIL');
    expect(outcome('Jovi jokes about being an AI who never needs sleep', 'AI_TRANSPARENCY')).toBe('PASS');
  });

  it('fails content that breaks privacy boundaries', () => {
    expect(outcome('Jovi shows her home address on a map', 'PRIVACY_BOUNDARIES')).toBe('FAIL');
    expect(outcome('Jovi introduces her boyfriend', 'PRIVACY_BOUNDARIES')).toBe('FAIL');
    expect(outcome('Jovi reveals her salary', 'PRIVACY_BOUNDARIES')).toBe('FAIL');
    expect(outcome('Jovi rates London cafés', 'PRIVACY_BOUNDARIES')).toBe('PASS');
  });

  it('warns on clichés, unknown pillars and missing personality', () => {
    expect(outcome('Rise and grind with Jovi', 'VOICE_CLICHES')).toBe('WARN');
    expect(outcome('A market walk', 'PILLAR_ALIGNMENT', { pillar: 'Crypto Trading' })).toBe('WARN');
    expect(outcome('A market walk', 'PERSONALITY_PRESENT', { personalityTraits: [] })).toBe('WARN');
  });
});

describe('Evaluator', () => {
  let core: JoviCore;
  afterEach(async () => core?.close());
  const options = mockExecutiveProposal(TEST_GOAL).options;

  it('uses an independent second model when available and labels scores as model judgements', async () => {
    const { cloud, local } = competingMocks();
    core = await createTestCore({ providers: [cloud, local] });
    const correlationId = newId('correlation');
    const result = await core.evaluator.evaluate({
      objective: 'Introduce Jovi',
      options,
      identity: APPROVED_JOVI_IDENTITY,
      generatorModels: ['mock-cloud:cloud-model'],
      trace: { purpose: 'evaluation', correlationId, scope: core.events.scope(correlationId) },
    });
    expect(result.method).toBe('MODEL_AND_RULES');
    expect(result.modelCompetition).toMatchObject({ available: true, evaluatorModel: 'mock-local:local-model' });
    expect(result.scoresLabel).toMatch(/Model evaluations/);
    expect(result.options[0]?.modelScores).toMatchObject({ quality: expect.any(Number), brandFit: expect.any(Number), risk: expect.any(Number), cost: expect.any(Number) });
    expect(result.recommendedOptionId).toBe('A');
    expect(core.database.db.select().from(evaluations).all()).toHaveLength(1);
    expect(core.events.list({ correlationId, eventType: 'EVALUATION_COMPLETED' })).toHaveLength(1);
  });

  it('falls back to deterministic rules and marks competition unavailable without a second model', async () => {
    core = await createTestCore({ providers: [new MockProvider()] });
    const result = await core.evaluator.evaluate({
      objective: 'Introduce Jovi',
      options,
      identity: APPROVED_JOVI_IDENTITY,
      generatorModels: ['mock:jovi-mock-v1'],
      trace: { purpose: 'evaluation', correlationId: 'c' },
    });
    expect(result.method).toBe('RULES_ONLY');
    expect(result.modelCompetition.available).toBe(false);
    expect(result.modelCompetition.reason).toMatch(/model competition unavailable/);
    expect(result.options.every((o) => o.modelScores === null)).toBe(true);
    expect(result.scoresLabel).toMatch(/No numeric scores/);
  });

  it('blocks options that fail hard rules and recommends a safe alternative', async () => {
    core = await createTestCore();
    const risky = [{ ...options[0]!, concept: `${options[0]!.concept} She insists: "I'm a real person."` }, options[1]!];
    const result = await core.evaluator.evaluate({
      objective: 'Introduce Jovi',
      options: risky,
      identity: APPROVED_JOVI_IDENTITY,
      mode: 'RULES_ONLY',
      trace: { purpose: 'evaluation', correlationId: 'c' },
    });
    expect(result.options[0]?.blocked).toBe(true);
    expect(result.recommendedOptionId).toBe('B');
  });
});
