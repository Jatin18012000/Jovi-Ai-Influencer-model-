import { asc, desc, eq } from 'drizzle-orm';
import type { JoviDatabase } from '../../database/client.js';
import { tasks } from '../../database/schema.js';
import type { TaskStatus } from '../../types/enums.js';
import { NotFoundError, ValidationError, serializeError } from '../errors.js';
import type { CorrelationScope } from '../events/event-bus.js';
import { newId, nowIso } from '../ids.js';

export type Task = typeof tasks.$inferSelect;

const SOURCE = 'core.tasks';

/** Allowed task state transitions. */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  QUEUED: ['RUNNING', 'CANCELLED', 'FAILED'],
  RUNNING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

/**
 * A Task is *what Jovi wants done*. Execution attempts live in Jobs.
 */
export class TaskService {
  constructor(private readonly db: JoviDatabase) {}

  create(
    input: { type: string; goal: string; input?: unknown; priority?: number; createdBy: string; parentTaskId?: string },
    scope: CorrelationScope,
  ): Task {
    const now = nowIso();
    const row = {
      id: newId('task'),
      type: input.type,
      goal: input.goal,
      status: 'QUEUED' as const,
      priority: input.priority ?? 5,
      input: input.input ?? null,
      result: null,
      error: null,
      correlationId: scope.correlationId,
      parentTaskId: input.parentTaskId ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    };
    this.db.insert(tasks).values(row).run();
    scope.emit('TASK_CREATED', SOURCE, row.id, { type: row.type, goal: row.goal, createdBy: row.createdBy });
    return row;
  }

  get(id: string): Task {
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!row) throw new NotFoundError('Task', id);
    return row;
  }

  find(id: string): Task | undefined {
    return this.db.select().from(tasks).where(eq(tasks.id, id)).get();
  }

  list(limit = 50): Task[] {
    return this.db.select().from(tasks).orderBy(desc(tasks.createdAt)).limit(limit).all();
  }

  /** Follow-up tasks created under a parent (oldest first). */
  listChildren(parentTaskId: string): Task[] {
    return this.db.select().from(tasks).where(eq(tasks.parentTaskId, parentTaskId)).orderBy(asc(tasks.createdAt)).all();
  }

  /** Idempotent: a retried job re-entering an already running task is a no-op. */
  start(id: string, scope: CorrelationScope): Task {
    const task = this.get(id);
    if (task.status === 'RUNNING') return task;
    this.transition(task, 'RUNNING', { startedAt: nowIso() });
    scope.emit('TASK_STARTED', SOURCE, id, { type: task.type });
    return this.get(id);
  }

  complete(id: string, result: unknown, scope: CorrelationScope): Task {
    const task = this.get(id);
    this.transition(task, 'COMPLETED', { result, completedAt: nowIso() });
    scope.emit('TASK_COMPLETED', SOURCE, id, { type: task.type });
    return this.get(id);
  }

  fail(id: string, error: unknown, scope: CorrelationScope): Task {
    const task = this.get(id);
    if (task.status === 'FAILED') return task;
    const serialized = serializeError(error);
    this.transition(task, 'FAILED', { error: serialized, completedAt: nowIso() });
    scope.emit('TASK_FAILED', SOURCE, id, { type: task.type, error: serialized });
    return this.get(id);
  }

  cancel(id: string, scope: CorrelationScope): Task {
    const task = this.get(id);
    this.transition(task, 'CANCELLED', { completedAt: nowIso() });
    scope.emit('TASK_CANCELLED', SOURCE, id, { type: task.type });
    return this.get(id);
  }

  private transition(task: Task, to: TaskStatus, fields: Partial<Task>): void {
    if (!TRANSITIONS[task.status].includes(to)) {
      throw new ValidationError(`Invalid task transition ${task.status} -> ${to}`, { taskId: task.id });
    }
    this.db
      .update(tasks)
      .set({ ...fields, status: to, updatedAt: nowIso() })
      .where(eq(tasks.id, task.id))
      .run();
  }
}
