import type Database from 'better-sqlite3';
import { asc, eq } from 'drizzle-orm';
import type { JoviDatabase } from '../../database/client.js';
import { jobs } from '../../database/schema.js';
import type { JobStatus } from '../../types/enums.js';
import type { Logger } from '../config/logger.js';
import { JoviError, NotFoundError, RateLimitedError, ValidationError, errorMessage, isRetryable, serializeError } from '../errors.js';
import type { CorrelationScope, EventBus } from '../events/event-bus.js';
import { newId, nowIso } from '../ids.js';

export type Job = typeof jobs.$inferSelect;

export interface JobHandlerContext {
  job: Job;
  attempt: number;
  scope: CorrelationScope;
  logger: Logger;
}

export interface JobHandler {
  execute(ctx: JobHandlerContext): Promise<unknown>;
  /** Called once when the job reaches FAILED (retries exhausted or permanent error). */
  onFinalFailure?(ctx: JobHandlerContext, error: unknown): void | Promise<void>;
}

export interface JobQueueOptions {
  defaultMaxAttempts: number;
  backoffMs: number;
  sleep?: (ms: number) => Promise<void>;
  /** How often a running (or reserved) job refreshes its lock, proving its owner is alive. */
  heartbeatMs?: number;
  /** R-05: maximum non-terminal jobs; enqueue beyond it is refused (RateLimitedError → 429). */
  maxQueued?: number;
}

const SOURCE = 'core.jobs';
const TERMINAL: JobStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

/**
 * SQLite-backed job queue. A Job is one execution of a Task and may take
 * several attempts. Temporary (retryable) failures are retried with
 * exponential backoff; permanent failures fail fast.
 *
 * Two execution modes share the same code path:
 *  - `run(jobId)`: the caller owns the job and drives it to a terminal state
 *    (used for synchronous API/CLI requests). The job stays reserved via
 *    `locked_at` so a background worker never steals it between retries.
 *  - `processNext()`: a worker claims the next due, unreserved job and runs a
 *    single attempt (used for asynchronous requests).
 */
export class JobQueue {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly db: JoviDatabase,
    private readonly sqlite: Database.Database,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    private readonly options: JobQueueOptions,
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  registerHandler(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  enqueue(
    input: { taskId: string; type: string; payload: unknown; maxAttempts?: number; reserve?: boolean },
    scope: CorrelationScope,
  ): Job {
    if (!this.handlers.has(input.type)) throw new ValidationError(`No handler registered for job type ${input.type}`);
    this.assertCapacity(input.type);
    const now = nowIso();
    const row = {
      id: newId('job'),
      taskId: input.taskId,
      type: input.type,
      status: 'QUEUED' as const,
      payload: input.payload ?? {},
      result: null,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? this.options.defaultMaxAttempts,
      lastError: null,
      runAfter: now,
      // Reserved jobs are driven by their creator via run(); workers skip them.
      lockedAt: input.reserve ? now : null,
      reserved: input.reserve ?? false,
      correlationId: scope.correlationId,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    };
    this.db.insert(jobs).values(row).run();
    scope.emit('JOB_CREATED', SOURCE, row.id, { taskId: row.taskId, type: row.type, maxAttempts: row.maxAttempts });
    return row;
  }

  /**
   * R-05: refuses new work when the queue is full. Entry points call it before
   * creating tasks (no orphans); enqueue calls it again as the backstop.
   */
  assertCapacity(type = 'job'): void {
    if (this.options.maxQueued === undefined) return;
    const pending = this.countPending();
    if (pending >= this.options.maxQueued) {
      this.logger.warn({ security: 'QUEUE_FULL', pending, maxQueued: this.options.maxQueued, type }, 'job refused: queue full');
      throw new RateLimitedError(`Job queue is full (${pending} unfinished jobs, max ${this.options.maxQueued})`, 30);
    }
  }

  /** Unfinished jobs (QUEUED, RETRYING, RUNNING). */
  countPending(): number {
    return (this.sqlite.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('QUEUED','RETRYING','RUNNING')").get() as { n: number }).n;
  }

  /**
   * R-05: unfinished asynchronous (unreserved) jobs. Each one holds a
   * concurrency slot until it reaches a terminal state, so async requests
   * cannot bypass the concurrency cap. Counted in SQLite, so it holds across
   * the API and worker processes.
   */
  countPendingAsync(): number {
    return (this.sqlite.prepare("SELECT count(*) AS n FROM jobs WHERE reserved = 0 AND status IN ('QUEUED','RETRYING','RUNNING')").get() as { n: number }).n;
  }

  get(id: string): Job {
    const row = this.find(id);
    if (!row) throw new NotFoundError('Job', id);
    return row;
  }

  find(id: string): Job | undefined {
    return this.db.select().from(jobs).where(eq(jobs.id, id)).get();
  }

  listByTask(taskId: string): Job[] {
    return this.db.select().from(jobs).where(eq(jobs.taskId, taskId)).orderBy(asc(jobs.createdAt)).all();
  }

  /** Drives an owned job through all attempts until it reaches a terminal state. */
  async run(jobId: string): Promise<Job> {
    for (;;) {
      const current = this.get(jobId);
      if (TERMINAL.includes(current.status)) return current;
      if (current.status === 'RUNNING') {
        throw new ValidationError(`Job ${jobId} is already running`);
      }
      const waitMs = Date.parse(current.runAfter) - Date.now();
      if (waitMs > 0) {
        this.touch(jobId);
        await this.sleep(waitMs);
      }
      const claimed = this.claim(jobId);
      if (!claimed) return this.get(jobId);
      await this.attempt(claimed, true);
    }
  }

  /** Worker entry point: claims and runs one attempt of the next due job. */
  async processNext(): Promise<Job | null> {
    const claimed = this.claimNext();
    if (!claimed) return null;
    return this.attempt(claimed, false);
  }

  cancel(jobId: string, scope: CorrelationScope): Job {
    const job = this.get(jobId);
    if (TERMINAL.includes(job.status)) return job;
    this.update(jobId, { status: 'CANCELLED', lockedAt: null, completedAt: nowIso() });
    scope.emit('JOB_CANCELLED', SOURCE, jobId, { taskId: job.taskId });
    return this.get(jobId);
  }

  /**
   * Crash recovery for jobs whose lock has not been refreshed for `staleMs`
   * (live owners refresh it via heartbeat):
   *  - RUNNING with attempts left       → RETRYING, lock released (a worker resumes it)
   *  - RUNNING with attempts exhausted  → FAILED (+ the handler's onFinalFailure, e.g. task FAILED)
   *  - QUEUED/RETRYING still reserved   → reservation released (the synchronous owner died)
   */
  async recoverStale(staleMs: number): Promise<{ requeued: number; failed: number; released: number }> {
    const now = nowIso();
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const stale = this.sqlite
      .prepare(
        `SELECT id, status, attempts, max_attempts AS maxAttempts FROM jobs
         WHERE status IN ('RUNNING', 'QUEUED', 'RETRYING') AND locked_at IS NOT NULL AND locked_at < @cutoff`,
      )
      .all({ cutoff }) as Array<{ id: string; status: JobStatus; attempts: number; maxAttempts: number }>;

    const counts = { requeued: 0, failed: 0, released: 0 };
    for (const row of stale) {
      const job = this.get(row.id);
      const scope = this.bus.scope(job.correlationId);
      if (row.status === 'RUNNING' && row.attempts >= row.maxAttempts) {
        const error = new JoviError('Job owner stopped responding and no attempts remain', { code: 'STALE_JOB', retryable: false });
        this.update(job.id, { status: 'FAILED', lastError: serializeError(error), lockedAt: null, completedAt: now });
        scope.emit('JOB_FAILED', SOURCE, job.id, { taskId: job.taskId, attempt: job.attempts, recovered: true, error: serializeError(error) });
        const handler = this.handlers.get(job.type);
        if (handler?.onFinalFailure) {
          const logger = this.logger.child({ jobId: job.id, taskId: job.taskId, correlationId: job.correlationId });
          try {
            await handler.onFinalFailure({ job, attempt: job.attempts, scope, logger }, error);
          } catch (hookError) {
            logger.error({ err: errorMessage(hookError) }, 'job onFinalFailure hook failed during recovery');
          }
        }
        counts.failed += 1;
      } else if (row.status === 'RUNNING') {
        this.update(job.id, { status: 'RETRYING', lockedAt: null, runAfter: now });
        scope.emit('JOB_RECOVERED', SOURCE, job.id, { taskId: job.taskId, from: 'RUNNING', to: 'RETRYING', attempts: job.attempts });
        counts.requeued += 1;
      } else {
        this.update(job.id, { lockedAt: null });
        scope.emit('JOB_RECOVERED', SOURCE, job.id, { taskId: job.taskId, from: `${row.status} (reserved)`, to: row.status, attempts: job.attempts });
        counts.released += 1;
      }
    }
    if (stale.length) this.logger.warn({ ...counts, staleMs }, 'recovered stale jobs');
    return counts;
  }

  private claim(jobId: string): Job | null {
    const now = nowIso();
    const row = this.sqlite
      .prepare(
        `UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1, locked_at = @now, updated_at = @now,
                started_at = COALESCE(started_at, @now)
         WHERE id = @id AND status IN ('QUEUED', 'RETRYING')
         RETURNING id`,
      )
      .get({ id: jobId, now }) as { id: string } | undefined;
    return row ? this.get(row.id) : null;
  }

  private claimNext(): Job | null {
    const now = nowIso();
    const row = this.sqlite
      .prepare(
        `UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1, locked_at = @now, updated_at = @now,
                started_at = COALESCE(started_at, @now)
         WHERE id = (
           SELECT id FROM jobs
           WHERE status IN ('QUEUED', 'RETRYING') AND run_after <= @now AND locked_at IS NULL
           ORDER BY run_after ASC, created_at ASC
           LIMIT 1
         )
         RETURNING id`,
      )
      .get({ now }) as { id: string } | undefined;
    return row ? this.get(row.id) : null;
  }

  private async attempt(job: Job, owned: boolean): Promise<Job> {
    const handler = this.handlers.get(job.type);
    const scope = this.bus.scope(job.correlationId);
    const logger = this.logger.child({ jobId: job.id, taskId: job.taskId, correlationId: job.correlationId, attempt: job.attempts });
    const ctx: JobHandlerContext = { job, attempt: job.attempts, scope, logger };

    scope.emit('JOB_STARTED', SOURCE, job.id, { taskId: job.taskId, attempt: job.attempts, maxAttempts: job.maxAttempts });
    const started = Date.now();
    // Heartbeat: keep the lock fresh while this process is working on the job.
    const heartbeat = this.options.heartbeatMs
      ? setInterval(() => this.touch(job.id), this.options.heartbeatMs)
      : null;
    heartbeat?.unref();

    try {
      if (!handler) throw new ValidationError(`No handler registered for job type ${job.type}`);
      const result = await handler.execute(ctx);
      this.update(job.id, { status: 'COMPLETED', result: result ?? null, lockedAt: null, completedAt: nowIso() });
      scope.emit('JOB_COMPLETED', SOURCE, job.id, { taskId: job.taskId, attempt: job.attempts, durationMs: Date.now() - started });
      logger.info({ durationMs: Date.now() - started, retries: job.attempts - 1 }, 'job completed');
    } catch (error) {
      const serialized = serializeError(error);
      const canRetry = isRetryable(error) && job.attempts < job.maxAttempts;
      if (canRetry) {
        const delay = this.options.backoffMs * 2 ** (job.attempts - 1);
        this.update(job.id, {
          status: 'RETRYING',
          lastError: serialized,
          runAfter: new Date(Date.now() + delay).toISOString(),
          // Owned jobs stay reserved so workers never steal them between attempts.
          lockedAt: owned ? nowIso() : null,
        });
        scope.emit('JOB_RETRYING', SOURCE, job.id, { taskId: job.taskId, attempt: job.attempts, delayMs: delay, error: serialized });
        logger.warn({ err: errorMessage(error), delayMs: delay }, 'job attempt failed; retrying');
      } else {
        this.update(job.id, { status: 'FAILED', lastError: serialized, lockedAt: null, completedAt: nowIso() });
        scope.emit('JOB_FAILED', SOURCE, job.id, { taskId: job.taskId, attempt: job.attempts, error: serialized });
        logger.error({ err: errorMessage(error), retries: job.attempts - 1 }, 'job failed');
        if (handler?.onFinalFailure) {
          try {
            await handler.onFinalFailure(ctx, error);
          } catch (hookError) {
            logger.error({ err: errorMessage(hookError) }, 'job onFinalFailure hook failed');
          }
        }
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    return this.get(job.id);
  }

  /** Refreshes the lock of a job this process owns. */
  private touch(jobId: string): void {
    this.sqlite.prepare(`UPDATE jobs SET locked_at = @now WHERE id = @id AND locked_at IS NOT NULL`).run({ id: jobId, now: nowIso() });
  }

  private update(id: string, fields: Partial<Job>): void {
    this.db
      .update(jobs)
      .set({ ...fields, updatedAt: nowIso() })
      .where(eq(jobs.id, id))
      .run();
  }
}
