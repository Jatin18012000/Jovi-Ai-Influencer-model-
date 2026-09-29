import { afterEach, describe, expect, it } from 'vitest';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { ResearchInput, ResearchAgent, TrendsAgent, StrategyAgent, IdeationAgent } from '../../src/agents/planning/planning-agents.js';
import { createTestCore } from '../helpers.js';

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
