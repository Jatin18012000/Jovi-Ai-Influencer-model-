import { afterEach, describe, expect, it } from 'vitest';
import { EXECUTIVE_AGENT_DEFINITION } from '../../src/agents/executive/executive-agent.js';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { PermissionDeniedError } from '../../src/core/errors.js';
import { BASE_CONSTRAINTS, ContextEngine } from '../../src/core/orchestrator/context-engine.js';
import { PermissionGuard, TOOL_REGISTRY } from '../../src/core/permissions/permissions.js';
import { createTestCore, TEST_GOAL } from '../helpers.js';

const agent = { name: 'executive', allowedTools: ['memory.read'], permissionLevel: 'LEVEL_2_MODIFY' };

describe('Context engine', () => {
  let core: JoviCore;
  afterEach(async () => core?.close());

  it('assembles task, identity, strategy, relevant memory, knowledge and constraints', async () => {
    core = await createTestCore();
    const ctx = await core.contextEngine.build({ goal: TEST_GOAL, task: { id: 'tsk_x', type: 'EXECUTIVE_GOAL' }, agent });

    expect(ctx.task).toEqual({ id: 'tsk_x', type: 'EXECUTIVE_GOAL', goal: TEST_GOAL });
    expect(ctx.identity.profile.creatorName).toBe('Jovi');
    expect(ctx.strategy.version).toBe(1);
    expect(ctx.audiencePhilosophy.communityName).toBe("Jovi's Crew");
    expect(ctx.memory.length).toBeGreaterThan(0);
    expect(ctx.knowledge.length).toBeGreaterThan(0);
    expect(ctx.constraints).toEqual(expect.arrayContaining(BASE_CONSTRAINTS));
    expect(ctx.resources.availableModels).toEqual(['mock:jovi-mock-v1']);
    expect(ctx.resources.semanticMemory).toMatch(/not vector/);
    expect(ctx.meta.estimatedTokens).toBeGreaterThan(100);
  });

  it('is bounded: it never dumps the whole memory store', async () => {
    core = await createTestCore();
    for (let i = 0; i < 40; i += 1) {
      core.memory.upsert({ type: 'FACT', key: `noise.${i}`, value: `irrelevant fact ${i}`, importance: 0.1, source: 'test' });
    }
    const ctx = await core.contextEngine.build({
      goal: TEST_GOAL,
      task: { id: null, type: 'T' },
      agent,
      limits: { memoryItems: 5, knowledgeSections: 2 },
    });
    expect(ctx.memory).toHaveLength(5);
    expect(ctx.knowledge.length).toBeLessThanOrEqual(2);
    expect(ctx.memory.some((m) => m.key.startsWith('noise.'))).toBe(false);
  });

  it('includes recent decisions after a goal runs', async () => {
    core = await createTestCore();
    const result = await core.orchestrator.executeGoal({ goal: TEST_GOAL });
    const ctx = await core.contextEngine.build({ goal: 'Another reel idea', task: { id: null, type: 'T' }, agent });
    expect(ctx.recentDecisions[0]).toMatchObject({ id: result.decisionId, selected: 'Two Truths and a Glitch' });
    expect(ctx.similarPastConcepts.length).toBeGreaterThan(0);
  });

  it('renders a compact prompt with the identity rules and constraints', async () => {
    core = await createTestCore();
    const ctx = await core.contextEngine.build({ goal: TEST_GOAL, task: { id: null, type: 'T' }, agent });
    const text = core.contextEngine.render(ctx);
    expect(text).toContain('Golden rule: Jovi should never sound like an AI writing an Instagram caption.');
    expect(text).toContain('Must never claim to be human');
    expect(text).toContain('## Constraints');
    const summary = ContextEngine.summarize(ctx);
    expect(summary).toMatchObject({ identityVersion: 1, strategyVersion: 1 });
  });
});

describe('Permissions', () => {
  const guard = new PermissionGuard(
    EXECUTIVE_AGENT_DEFINITION.name,
    EXECUTIVE_AGENT_DEFINITION.permissionLevel,
    EXECUTIVE_AGENT_DEFINITION.allowedTools,
    'LEVEL_3_EXECUTE',
  );

  it('does not give the Executive Agent Level 4/5 powers', () => {
    expect(guard.effectiveLevel).toBe('LEVEL_2_MODIFY');
    expect(guard.can('decision.write')).toBe(true);
    expect(guard.can('social.publish')).toBe(false);
    expect(guard.can('n8n.trigger')).toBe(false);
    expect(guard.can('infrastructure.modify')).toBe(false);
    expect(() => guard.assert('social.publish')).toThrow(PermissionDeniedError);
  });

  it('caps any grant at the deployment ceiling', () => {
    const publisher = new PermissionGuard('publishing', 'LEVEL_4_EXTERNAL_ACTION', ['social.publish'], 'LEVEL_3_EXECUTE');
    expect(publisher.effectiveLevel).toBe('LEVEL_3_EXECUTE');
    expect(() => publisher.assert('social.publish')).toThrow(/lacks LEVEL_4_EXTERNAL_ACTION/);
  });

  it('exposes no shell, filesystem or credential tools', () => {
    const names = Object.keys(TOOL_REGISTRY).join(' ');
    expect(names).not.toMatch(/shell|exec|fs\.|file|credential|secret/);
  });

  it('classifies proposed actions by required level', () => {
    expect(PermissionGuard.classifyAction('Publish the Reel to Instagram')).toBe('LEVEL_4_EXTERNAL_ACTION');
    expect(PermissionGuard.classifyAction('Send a DM to a brand')).toBe('LEVEL_4_EXTERNAL_ACTION');
    expect(PermissionGuard.classifyAction('Deploy a new server')).toBe('LEVEL_5_INFRASTRUCTURE');
    expect(PermissionGuard.classifyAction('Generate the shot images')).toBe('LEVEL_3_EXECUTE');
    expect(PermissionGuard.classifyAction('Write the script')).toBe('LEVEL_1_GENERATE');
  });
});
