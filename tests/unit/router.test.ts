import { afterEach, describe, expect, it } from 'vitest';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { NoModelAvailableError } from '../../src/core/errors.js';
import { newId } from '../../src/core/ids.js';
import { modelRuns } from '../../src/database/schema.js';
import { parseModelJson } from '../../src/models/json-output.js';
import { MockProvider } from '../../src/models/providers/mock-provider.js';
import { ModelRouter, RoutingRequestSchema } from '../../src/models/router/model-router.js';
import { z } from 'zod';
import { createTestCore } from '../helpers.js';

const cloudA = () => new MockProvider({ id: 'anthropic', kind: 'CLOUD', model: 'cloud-a' });
const cloudB = () => new MockProvider({ id: 'openai', kind: 'CLOUD', model: 'cloud-b' });
const local = () => new MockProvider({ id: 'ollama', kind: 'LOCAL', model: 'local-1' });
const mock = () => new MockProvider();

describe('Model router — selection policy', () => {
  let core: JoviCore;
  afterEach(async () => core?.close());

  it('computes the tier as max(complexity, quality)', () => {
    expect(ModelRouter.tierOf(RoutingRequestSchema.parse({ taskType: 't', complexity: 'LOW', quality: 'HIGH' }))).toBe('HIGH');
    expect(ModelRouter.tierOf(RoutingRequestSchema.parse({ taskType: 't' }))).toBe('NORMAL');
  });

  it('LOW prefers local; NORMAL prefers cloud; mock is always last', async () => {
    core = await createTestCore({ providers: [mock(), cloudA(), local()] });
    const low = await core.router.plan({ taskType: 't', complexity: 'LOW' });
    expect(low.candidates.map((c) => c.provider)).toEqual(['ollama', 'anthropic', 'mock']);
    expect(low.reason).toMatch(/prefer local/);

    const normal = await core.router.plan({ taskType: 't', complexity: 'NORMAL' });
    expect(normal.candidates.map((c) => c.provider)).toEqual(['anthropic', 'ollama', 'mock']);
    expect(normal.degraded).toBe(false);
  });

  it('HIGH/STRATEGIC use cloud, and flag degraded local fallback when cloud is unavailable', async () => {
    core = await createTestCore({ providers: [local(), cloudA()] });
    expect((await core.router.plan({ taskType: 't', complexity: 'STRATEGIC' })).candidates[0]?.provider).toBe('anthropic');
    await core.close();

    core = await createTestCore({ providers: [local()] });
    const high = await core.router.plan({ taskType: 't', quality: 'HIGH' });
    expect(high.candidates.map((c) => c.provider)).toEqual(['ollama']);
    expect(high.degraded).toBe(true);
    expect(high.reason).toMatch(/degraded/);
  });

  it('honours the configured cloud preference order', async () => {
    core = await createTestCore({ providers: [cloudA(), cloudB()], env: { JOVI_CLOUD_PREFERENCE: 'openai,anthropic' } });
    const plan = await core.router.plan({ taskType: 't' });
    expect(plan.candidates.map((c) => c.provider)).toEqual(['openai', 'anthropic']);
  });

  it('LOCAL_ONLY privacy never routes to cloud', async () => {
    core = await createTestCore({ providers: [cloudA(), local()] });
    const plan = await core.router.plan({ taskType: 't', complexity: 'STRATEGIC', privacy: 'LOCAL_ONLY' });
    expect(plan.candidates.map((c) => c.provider)).toEqual(['ollama']);
  });

  it('excludes models (e.g. evaluator must differ from generator) and lists unavailable providers', async () => {
    core = await createTestCore({ providers: [cloudA(), local(), new MockProvider({ id: 'gemini', kind: 'CLOUD', available: false })] });
    const plan = await core.router.plan({ taskType: 't', excludeModels: ['anthropic:cloud-a'] });
    expect(plan.candidates.map((c) => c.provider)).toEqual(['ollama']);
    expect(plan.unavailable.map((u) => u.provider)).toEqual(['gemini']);
  });

  it('throws a clear error when no provider is available', async () => {
    core = await createTestCore({ providers: [] });
    const error = await core.router
      .generate({ task: { type: 't' }, context: { system: '', prompt: '' } }, { taskType: 't' }, { purpose: 'test', correlationId: 'c' }, (t) => t)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoModelAvailableError);
    expect((error as Error).message).toMatch(/JOVI_ENABLE_MOCK_PROVIDER/);
  });
});

describe('Model router — fallback and observability', () => {
  let core: JoviCore;
  afterEach(async () => core?.close());

  const Schema = z.object({ ok: z.literal(true) });
  const run = (c: JoviCore, correlationId: string) =>
    c.router.generate(
      { task: { type: 'test.json' }, context: { system: 's', prompt: 'p' }, requirements: { json: true } },
      { taskType: 'test.json', complexity: 'NORMAL' },
      { purpose: 'test', correlationId, scope: c.events.scope(correlationId) },
      (text) => parseModelJson(Schema, text),
    );

  it('falls back to the next provider on failure and records everything', async () => {
    const failing = new MockProvider({ id: 'anthropic', kind: 'CLOUD', model: 'cloud-a', failures: 5, failureMode: 'PERMANENT' });
    const backup = new MockProvider({ id: 'ollama', kind: 'LOCAL', model: 'local-1', responder: () => '{"ok":true}' });
    core = await createTestCore({ providers: [failing, backup] });
    const correlationId = newId('correlation');

    const routed = await run(core, correlationId);
    expect(routed.result.provider).toBe('ollama');
    expect(routed.fallbackUsed).toBe(true);
    expect(routed.attempts.map((a) => [a.provider, a.status])).toEqual([
      ['anthropic', 'FAILED'],
      ['ollama', 'SUCCEEDED'],
    ]);

    const events = core.events.list({ correlationId });
    expect(events.map((e) => e.eventType)).toEqual(['MODEL_SELECTED', 'MODEL_FALLBACK']);
    expect(events[1]?.payload).toMatchObject({ from: 'anthropic:cloud-a', to: 'ollama:local-1' });

    const runs = core.database.db.select().from(modelRuns).all().filter((r) => r.correlationId === correlationId);
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.status === 'SUCCEEDED')).toMatchObject({ isFallback: true, fallbackFrom: 'anthropic:cloud-a', routingCategory: 'NORMAL' });
    expect(runs.find((r) => r.status === 'FAILED')?.error).toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('repairs invalid JSON once on the same model before falling back', async () => {
    let calls = 0;
    const flaky = new MockProvider({
      id: 'anthropic',
      kind: 'CLOUD',
      responder: () => (++calls === 1 ? 'not json at all' : '```json\n{"ok":true}\n```'),
    });
    core = await createTestCore({ providers: [flaky] });
    const routed = await run(core, newId('correlation'));
    expect(routed.fallbackUsed).toBe(false);
    expect(routed.attempts.map((a) => a.status)).toEqual(['INVALID_OUTPUT', 'SUCCEEDED']);
    expect(flaky.calls[1]?.context.prompt).toContain('<repair_request>');
  });

  it('falls back when a model keeps returning invalid output', async () => {
    const invalid = new MockProvider({ id: 'anthropic', kind: 'CLOUD', responder: () => '{"ok":false}' });
    const valid = new MockProvider({ id: 'openai', kind: 'CLOUD', responder: () => '{"ok":true}' });
    core = await createTestCore({ providers: [invalid, valid] });
    const routed = await run(core, newId('correlation'));
    expect(routed.result.provider).toBe('openai');
    expect(routed.attempts.map((a) => a.status)).toEqual(['INVALID_OUTPUT', 'INVALID_OUTPUT', 'SUCCEEDED']);
  });

  it('fails with a retryable error when all candidates fail temporarily', async () => {
    core = await createTestCore({
      providers: [
        new MockProvider({ id: 'anthropic', kind: 'CLOUD', failures: 9 }),
        new MockProvider({ id: 'ollama', kind: 'LOCAL', failures: 9 }),
      ],
    });
    const error = await run(core, newId('correlation')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoModelAvailableError);
    expect((error as NoModelAvailableError).retryable).toBe(true);
  });

  it('fails with a permanent error when all candidates fail permanently', async () => {
    core = await createTestCore({ providers: [new MockProvider({ id: 'anthropic', kind: 'CLOUD', failures: 9, failureMode: 'PERMANENT' })] });
    const error = await run(core, newId('correlation')).catch((e: unknown) => e);
    expect((error as NoModelAvailableError).retryable).toBe(false);
  });
});
