import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { JoviError, ValidationError } from '../../src/core/errors.js';
import { createTestCore } from '../helpers.js';

const temporary = () => new JoviError('temporary outage', { code: 'TEMP', retryable: true });

describe('Task service', () => {
  let core: JoviCore;
  afterEach(async () => core?.close());

  it('creates a QUEUED task and emits TASK_CREATED', async () => {
    core = await createTestCore();
    const scope = core.events.scope('cor_t1');
    const task = core.tasks.create({ type: 'TEST', goal: 'do a thing', createdBy: 'test' }, scope);
    expect(task.id).toMatch(/^tsk_/);
    expect(task.status).toBe('QUEUED');
    expect(task.correlationId).toBe('cor_t1');
    expect(core.tasks.get(task.id).goal).toBe('do a thing');
    expect(core.events.list({ correlationId: 'cor_t1' }).map((e) => e.eventType)).toEqual(['TASK_CREATED']);
  });

  it('enforces state transitions', async () => {
    core = await createTestCore();
    const scope = core.events.scope('cor_t2');
    const task = core.tasks.create({ type: 'TEST', goal: 'x', createdBy: 'test' }, scope);
    expect(() => core.tasks.complete(task.id, {}, scope)).toThrow(ValidationError);
    core.tasks.start(task.id, scope);
    core.tasks.start(task.id, scope); // idempotent
    const done = core.tasks.complete(task.id, { ok: true }, scope);
    expect(done.status).toBe('COMPLETED');
    expect(done.completedAt).toBeTruthy();
    expect(() => core.tasks.start(task.id, scope)).toThrow(ValidationError);
    expect(core.events.list({ correlationId: 'cor_t2' }).map((e) => e.eventType)).toEqual(['TASK_CREATED', 'TASK_STARTED', 'TASK_COMPLETED']);
  });

  it('records failure with a serialized error', async () => {
    core = await createTestCore();
    const scope = core.events.scope('cor_t3');
    const task = core.tasks.create({ type: 'TEST', goal: 'x', createdBy: 'test' }, scope);
    const failed = core.tasks.fail(task.id, new Error('nope'), scope);
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toMatchObject({ message: 'nope' });
  });
});

describe('Job queue', () => {
  let core: JoviCore;
  afterEach(async () => core?.close());

  async function setup(execute: () => Promise<unknown>, onFinalFailure?: () => void) {
    core = await createTestCore();
    core.jobs.registerHandler('test.job', { execute, ...(onFinalFailure ? { onFinalFailure } : {}) });
    const scope = core.events.scope(`cor_${Math.random()}`);
    const task = core.tasks.create({ type: 'TEST', goal: 'x', createdBy: 'test' }, scope);
    return { scope, task };
  }

  it('executes a job to completion', async () => {
    const { scope, task } = await setup(async () => ({ answer: 42 }));
    const job = core.jobs.enqueue({ taskId: task.id, type: 'test.job', payload: {}, reserve: true }, scope);
    const done = await core.jobs.run(job.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.attempts).toBe(1);
    expect(done.result).toEqual({ answer: 42 });
    expect(done.lockedAt).toBeNull();
    expect(core.events.list({ entityId: job.id }).map((e) => e.eventType)).toEqual(['JOB_CREATED', 'JOB_STARTED', 'JOB_COMPLETED']);
  });

  it('retries temporary failures and then succeeds', async () => {
    let calls = 0;
    const { scope, task } = await setup(async () => {
      calls += 1;
      if (calls < 3) throw temporary();
      return 'ok';
    });
    const job = core.jobs.enqueue({ taskId: task.id, type: 'test.job', payload: {}, maxAttempts: 3, reserve: true }, scope);
    const done = await core.jobs.run(job.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.attempts).toBe(3);
    expect(core.events.list({ entityId: job.id, eventType: 'JOB_RETRYING' })).toHaveLength(2);
  });

  it('fails fast on permanent errors and calls onFinalFailure once', async () => {
    const onFinalFailure = vi.fn();
    const { scope, task } = await setup(async () => {
      throw new ValidationError('bad input');
    }, onFinalFailure);
    const job = core.jobs.enqueue({ taskId: task.id, type: 'test.job', payload: {}, maxAttempts: 3, reserve: true }, scope);
    const done = await core.jobs.run(job.id);
    expect(done.status).toBe('FAILED');
    expect(done.attempts).toBe(1);
    expect(done.lastError).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(onFinalFailure).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts on repeated temporary failures', async () => {
    const onFinalFailure = vi.fn();
    const { scope, task } = await setup(async () => {
      throw temporary();
    }, onFinalFailure);
    const job = core.jobs.enqueue({ taskId: task.id, type: 'test.job', payload: {}, maxAttempts: 2, reserve: true }, scope);
    const done = await core.jobs.run(job.id);
    expect(done.status).toBe('FAILED');
    expect(done.attempts).toBe(2);
    expect(onFinalFailure).toHaveBeenCalledTimes(1);
  });

  it('lets a worker process unreserved jobs but never reserved ones', async () => {
    const { scope, task } = await setup(async () => 'done');
    const reserved = core.jobs.enqueue({ taskId: task.id, type: 'test.job', payload: {}, reserve: true }, scope);
    const open = core.jobs.enqueue({ taskId: task.id, type: 'test.job', payload: {} }, scope);
    const processed = await core.jobs.processNext();
    expect(processed?.id).toBe(open.id);
    expect(processed?.status).toBe('COMPLETED');
    expect(await core.jobs.processNext()).toBeNull();
    expect(core.jobs.get(reserved.id).status).toBe('QUEUED');
  });

  it('refuses unknown job types and supports cancellation', async () => {
    const { scope, task } = await setup(async () => 'done');
    expect(() => core.jobs.enqueue({ taskId: task.id, type: 'unknown', payload: {} }, scope)).toThrow(ValidationError);
    const job = core.jobs.enqueue({ taskId: task.id, type: 'test.job', payload: {} }, scope);
    expect(core.jobs.cancel(job.id, scope).status).toBe('CANCELLED');
    expect(core.events.list({ entityId: job.id }).map((e) => e.eventType)).toEqual(['JOB_CREATED', 'JOB_CANCELLED']);
    expect(await core.jobs.processNext()).toBeNull();
  });

  it('recovers stale running jobs', async () => {
    const { scope, task } = await setup(async () => 'done');
    const job = core.jobs.enqueue({ taskId: task.id, type: 'test.job', payload: {} }, scope);
    core.database.sqlite
      .prepare(`UPDATE jobs SET status = 'RUNNING', locked_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`)
      .run(job.id);
    expect(core.jobs.recoverStale(60_000)).toBe(1);
    expect(core.jobs.get(job.id).status).toBe('RETRYING');
    expect((await core.jobs.processNext())?.status).toBe('COMPLETED');
  });
});
