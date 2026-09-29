import { afterEach, describe, expect, it } from 'vitest';
import type { JoviCore } from '../../src/core/bootstrap.js';
import type { GenerateRequest, GenerateResult, ModelProvider } from '../../src/models/types.js';
import { ResearchInput, ResearchAgent, TrendsAgent, StrategyAgent, IdeationAgent } from '../../src/agents/planning/planning-agents.js';
import { createTestCore } from '../helpers.js';

class PlanningFakeProvider implements ModelProvider {
  readonly id = 'planning-fake';
  readonly kind = 'LOCAL' as const;
  readonly model = 'planning-fake-model';
  async checkAvailability() {
    return { provider: this.id, kind: this.kind, available: true, reason: 'test', selectedModel: this.model, models: [{ provider: this.id, model: this.model, kind: this.kind, isDefault: true, capabilities: ['chat'], loaded: true }], checkedAt: new Date().toISOString() };
  }
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const type = request.task.type;
    const outputs: Record<string, unknown> = {
      'planning.research': { topic: 'London fashion', findings: [{ claim: 'London supports diverse fashion storytelling.', evidence: 'test fixture', sourceType: 'KNOWLEDGE_BASE', confidence: 0.9, relevance: 0.9 }, { claim: 'Jovi uses fashion as personality expression.', evidence: 'identity', sourceType: 'MEMORY', confidence: 0.9, relevance: 0.9 }, { claim: 'Travel and fashion combine well visually.', evidence: 'test fixture', sourceType: 'MODEL_KNOWLEDGE', confidence: 0.7, relevance: 0.8 }], audienceAngles: ['city style', 'personal discovery'], risks: [] },
      'planning.trends': { trends: [{ name: 'city-fashion storytelling', signal: 'test', fitScore: 0.9, angle: 'London look diary', freshness: 'EVERGREEN' }, { name: 'travel micro-stories', signal: 'test', fitScore: 0.8, angle: 'one-place story', freshness: 'EVERGREEN' }, { name: 'creator POV', signal: 'test', fitScore: 0.8, angle: 'Jovi POV', freshness: 'CURRENT' }], avoid: [] },
      'planning.strategy': { objective: 'Grow discovery through personality-led London stories.', corePillars: ['Travel & Exploration', 'Fashion & Beauty'], supportingPillars: ['Lifestyle'], formats: [{ format: 'REEL', role: 'discovery' }, { format: 'STORY', role: 'community' }], cadenceGuideline: '1–2 feed pieces daily plus Stories', experiments: ['hook variants', 'story-first reels'], guardrails: ['AI transparency', 'privacy'], rationale: 'test' },
      'planning.ideation': { ideas: [1,2,3,4,5].map((n) => ({ title: `London idea ${n}`, format: 'REEL', pillar: 'Travel & Exploration', hook: `Hook ${n}`, concept: `Concept ${n}`, whyNow: 'Fits current plan', productionNotes: [] })), recommendedIdeaId: 'London idea 1', selectionRationale: 'test' },
    };
    return { provider: this.id, model: this.model, executionType: this.kind, output: JSON.stringify(outputs[type]), usage: { inputTokens: 10, outputTokens: 10 }, latencyMs: 1, cost: { estimatedApiCost: 0, executionCostType: 'LOCAL_COMPUTE', currency: 'USD', basis: 'test' }, metadata: {} };
  }
}

describe('Phase 7 planning layer', () => {
  let core: JoviCore;
  afterEach(async () => core?.close());

  it('registers Research, Trends, Strategy and Ideation as active agents', async () => {
    core = await createTestCore();
    const active = core.agents.list().filter((a) => a.status === 'ACTIVE').map((a) => a.definition.name);
    expect(active).toEqual(expect.arrayContaining(['executive', 'research', 'trends', 'strategy', 'ideation']));
  });

  it('exposes strict structured contracts for each planning stage', () => {
    const input = ResearchInput.parse({ goal: 'Plan a London fashion reel for Jovi.' });
    expect(input.goal).toContain('London');
    expect(() => ResearchInput.parse({ goal: 'x' })).toThrow();
    expect(new ResearchAgent().definition.permissionLevel).toBe('LEVEL_1_GENERATE');
    expect(new TrendsAgent().definition.permissionLevel).toBe('LEVEL_1_GENERATE');
    expect(new StrategyAgent().definition.permissionLevel).toBe('LEVEL_1_GENERATE');
    expect(new IdeationAgent().definition.permissionLevel).toBe('LEVEL_1_GENERATE');
  });
});

  it('runs the complete four-agent planning pipeline with a deterministic provider', async () => {
    core = await createTestCore({ providers: [new PlanningFakeProvider()] });
    const result = await core.planning.execute({ goal: 'Plan a London fashion reel for Jovi.', createdBy: 'test' });
    expect(result.status).toBe('COMPLETED');
    expect(result.research?.findings).toHaveLength(3);
    expect(result.trends?.trends).toHaveLength(3);
    expect(result.strategy?.corePillars).toContain('Fashion & Beauty');
    expect(result.ideation?.ideas).toHaveLength(5);
    expect(result.agentRuns).toHaveLength(4);
    expect(core.tasks.get(result.taskId).status).toBe('COMPLETED');
  });
});
