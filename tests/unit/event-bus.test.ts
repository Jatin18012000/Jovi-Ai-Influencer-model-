import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { JoviEventSchema } from '../../src/core/events/event-bus.js';
import { createTestCore } from '../helpers.js';

describe('Event bus', () => {
  let core: JoviCore;
  afterEach(async () => core?.close());

  it('persists events with the full envelope', async () => {
    core = await createTestCore();
    const event = core.events.emit({
      eventType: 'TASK_CREATED',
      source: 'test',
      entityId: 'tsk_1',
      payload: { hello: 'world' },
      correlationId: 'cor_1',
    });
    expect(JoviEventSchema.parse(event)).toBeTruthy();
    expect(event.schemaVersion).toBe(1);
    expect(event.causationId).toBeNull();

    const [stored] = core.events.list({ correlationId: 'cor_1' });
    expect(stored).toEqual(event);
  });

  it('keeps a monotonic sequence and filters by type/entity/correlation', async () => {
    core = await createTestCore();
    const a = core.events.emit({ eventType: 'TASK_CREATED', source: 't', entityId: 'x', correlationId: 'c1' });
    const b = core.events.emit({ eventType: 'TASK_STARTED', source: 't', entityId: 'x', correlationId: 'c1' });
    core.events.emit({ eventType: 'TASK_CREATED', source: 't', entityId: 'y', correlationId: 'c2' });
    expect(b.sequence).toBeGreaterThan(a.sequence);
    expect(core.events.list({ correlationId: 'c1' }).map((e) => e.eventType)).toEqual(['TASK_CREATED', 'TASK_STARTED']);
    expect(core.events.list({ eventType: 'TASK_CREATED' })).toHaveLength(2);
    expect(core.events.list({ entityId: 'y' })).toHaveLength(1);
    expect(core.events.list({ afterSequence: a.sequence, correlationId: 'c1' })).toHaveLength(1);
  });

  it('dispatches to typed and wildcard subscribers and supports unsubscribe', async () => {
    core = await createTestCore();
    const typed = vi.fn();
    const all = vi.fn();
    const off = core.events.subscribe('DECISION_CREATED', typed);
    core.events.subscribe('*', all);
    core.events.emit({ eventType: 'DECISION_CREATED', source: 't' });
    core.events.emit({ eventType: 'MEMORY_CREATED', source: 't' });
    expect(typed).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledTimes(2);
    off();
    core.events.emit({ eventType: 'DECISION_CREATED', source: 't' });
    expect(typed).toHaveBeenCalledTimes(1);
  });

  it('isolates failing subscribers from the emitter', async () => {
    core = await createTestCore();
    core.events.subscribe('*', () => {
      throw new Error('boom');
    });
    core.events.subscribe('*', async () => {
      throw new Error('async boom');
    });
    expect(() => core.events.emit({ eventType: 'TASK_CREATED', source: 't' })).not.toThrow();
    expect(core.events.list({ eventType: 'TASK_CREATED' })).toHaveLength(1);
  });

  it('chains causation ids within a correlation scope', async () => {
    core = await createTestCore();
    const scope = core.events.scope('cor_chain');
    const first = scope.emit('TASK_CREATED', 't', 'tsk');
    const second = scope.emit('TASK_STARTED', 't', 'tsk');
    const third = scope.emit('TASK_COMPLETED', 't', 'tsk');
    expect(first.causationId).toBeNull();
    expect(second.causationId).toBe(first.eventId);
    expect(third.causationId).toBe(second.eventId);

    // A new scope for the same correlation resumes the chain (e.g. worker process).
    const resumed = core.events.scope('cor_chain').emit('JOB_STARTED', 't', 'job');
    expect(resumed.causationId).toBe(third.eventId);
  });

  it('rejects unknown event types', async () => {
    core = await createTestCore();
    expect(() => core.events.emit({ eventType: 'NOT_REAL' as never, source: 't' })).toThrow();
  });
});
