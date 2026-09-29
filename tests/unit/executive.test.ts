import { describe, expect, it } from 'vitest';
import { classifyGoal, selectOption } from '../../src/agents/executive/executive-agent.js';
import { ExecutiveDecisionSchema, ExecutiveInputSchema, ExecutiveProposalSchema } from '../../src/agents/executive/executive-schema.js';
import { InvalidModelOutputError } from '../../src/core/errors.js';
import type { EvaluationResult, OptionEvaluation } from '../../src/models/evaluator/evaluator.js';
import { extractJsonObject, parseModelJson } from '../../src/models/json-output.js';
import { mockExecutiveProposal } from '../../src/models/providers/mock-provider.js';
import { TEST_GOAL } from '../helpers.js';

const base = () => mockExecutiveProposal(TEST_GOAL);

describe('Executive proposal schema', () => {
  it('accepts a well-formed proposal', () => {
    const parsed = ExecutiveProposalSchema.parse(base());
    expect(parsed.options).toHaveLength(3);
    expect(parsed.recommendedOptionId).toBe('A');
    expect(parsed.nextActions[0]).toEqual({ action: expect.any(String), agent: 'script' });
  });

  it('normalises common model quirks without inventing content', () => {
    const quirky = {
      ...base(),
      confidence: '80',
      options: base().options.map((o, i) => ({ ...o, format: i === 0 ? 'Instagram Reel' : 'story', estimatedEffort: 'low' })),
      nextActions: ['Write the script', { action: 'Plan the shots', agent: 'visual' }],
    };
    const parsed = ExecutiveProposalSchema.parse(quirky);
    expect(parsed.confidence).toBe(0.8);
    expect(parsed.options[0]?.format).toBe('REEL');
    expect(parsed.options[1]?.format).toBe('STORY');
    expect(parsed.options[0]?.estimatedEffort).toBe('LOW');
    expect(parsed.nextActions[0]).toEqual({ action: 'Write the script', agent: 'executive' });
  });

  it('rejects a recommendation that is not one of the options', () => {
    const result = ExecutiveProposalSchema.safeParse({ ...base(), recommendedOptionId: 'Z' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['recommendedOptionId']);
  });

  it('rejects duplicate option ids, too few options and out-of-range confidence', () => {
    const b = base();
    expect(ExecutiveProposalSchema.safeParse({ ...b, options: [b.options[0], b.options[0]] }).success).toBe(false);
    expect(ExecutiveProposalSchema.safeParse({ ...b, options: [b.options[0]] }).success).toBe(false);
    expect(ExecutiveProposalSchema.safeParse({ ...b, confidence: 140 }).success).toBe(false);
    const { interpretation: _omit, ...missing } = b;
    expect(ExecutiveProposalSchema.safeParse(missing).success).toBe(false);
  });

  it('parses JSON from fenced / chatty model output and reports schema errors clearly', () => {
    const text = `Sure! Here you go:\n\`\`\`json\n${JSON.stringify(base())}\n\`\`\``;
    expect(parseModelJson(ExecutiveProposalSchema, text).objective).toBe(TEST_GOAL);
    expect(extractJsonObject('prefix {"a": "}"} suffix')).toEqual({ a: '}' });
    expect(() => parseModelJson(ExecutiveProposalSchema, '{"objective": "x"}')).toThrow(InvalidModelOutputError);
    expect(() => extractJsonObject('no json here')).toThrow(InvalidModelOutputError);
  });

  it('validates executive input', () => {
    expect(ExecutiveInputSchema.safeParse({ goal: 'hi' }).success).toBe(false);
    expect(ExecutiveInputSchema.parse({ goal: '  Plan a reel  ' }).goal).toBe('Plan a reel');
    expect(ExecutiveInputSchema.safeParse({ goal: 'Plan a reel', tier: 'EXTREME' }).success).toBe(false);
  });

  it('exposes a strict final decision schema', () => {
    expect(ExecutiveDecisionSchema.safeParse({ decisionId: 'x' }).success).toBe(false);
  });
});

describe('Goal classification', () => {
  it('maps goals to routing tiers', () => {
    expect(classifyGoal(TEST_GOAL)).toBe('HIGH');
    expect(classifyGoal('Draft our long-term content strategy for Q3')).toBe('STRATEGIC');
    expect(classifyGoal('Give me quick hashtags for a beach post')).toBe('LOW');
    expect(classifyGoal('What should Jovi post today?')).toBe('NORMAL');
  });
});

describe('Final option selection', () => {
  const proposal = ExecutiveProposalSchema.parse(base());
  const scores = (n: number) => ({ quality: n, brandFit: n, objectiveFit: n, originality: n, audienceFit: n, risk: 2, cost: 2 });
  const opt = (id: string, over: Partial<OptionEvaluation> = {}): OptionEvaluation => ({
    optionId: id,
    modelScores: null,
    strengths: [],
    concerns: [],
    ruleChecks: [],
    blocked: false,
    ...over,
  });
  const evaluation = (over: Partial<EvaluationResult>): EvaluationResult => ({
    evaluationId: 'evl_1',
    method: 'RULES_ONLY',
    scoresLabel: '',
    modelCompetition: { available: false, reason: '', evaluatorModel: null, generatorModels: [] },
    options: [opt('A'), opt('B'), opt('C')],
    recommendedOptionId: 'A',
    summary: '',
    modelUsage: null,
    ...over,
  });

  it('keeps the proposer pick when rules pass and no model evaluated', () => {
    const s = selectOption(proposal, evaluation({}));
    expect(s.option.id).toBe('A');
    expect(s.method).toBe('PROPOSER_RECOMMENDATION');
    expect(s.confidence).toBe(proposal.confidence);
  });

  it('records agreement when an independent evaluator agrees', () => {
    const s = selectOption(proposal, evaluation({ method: 'MODEL_AND_RULES', options: [opt('A', { modelScores: scores(4) }), opt('B', { modelScores: scores(3) })] }));
    expect(s.method).toBe('EVALUATOR_AGREEMENT');
  });

  it('overrides a pick that fails a blocking rule', () => {
    const s = selectOption(
      proposal,
      evaluation({
        options: [opt('A', { blocked: true, ruleChecks: [{ rule: 'AI_TRANSPARENCY', outcome: 'FAIL', detail: '' }] }), opt('B'), opt('C')],
        recommendedOptionId: 'B',
      }),
    );
    expect(s.option.id).toBe('B');
    expect(s.method).toBe('RULE_OVERRIDE');
    expect(s.confidence).toBeLessThan(proposal.confidence);
    expect(s.note).toMatch(/AI_TRANSPARENCY/);
  });

  it('lets the evaluator override only with a clear margin', () => {
    const clear = selectOption(
      proposal,
      evaluation({ method: 'MODEL_AND_RULES', recommendedOptionId: 'B', options: [opt('A', { modelScores: scores(2) }), opt('B', { modelScores: scores(4) })] }),
    );
    expect(clear.option.id).toBe('B');
    expect(clear.method).toBe('EVALUATOR_OVERRIDE');

    const slight = selectOption(
      proposal,
      evaluation({
        method: 'MODEL_AND_RULES',
        recommendedOptionId: 'B',
        options: [opt('A', { modelScores: scores(4) }), opt('B', { modelScores: { ...scores(4), quality: 5 } })],
      }),
    );
    expect(slight.option.id).toBe('A');
    expect(slight.method).toBe('PROPOSER_RECOMMENDATION');
  });

  it('fails when every option is blocked', () => {
    expect(() =>
      selectOption(proposal, evaluation({ options: [opt('A', { blocked: true }), opt('B', { blocked: true }), opt('C', { blocked: true })], recommendedOptionId: null })),
    ).toThrow(InvalidModelOutputError);
  });
});
