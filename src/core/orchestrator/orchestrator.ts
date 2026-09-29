import { z } from 'zod';
import type { AgentRunner } from '../../agents/agent-runner.js';
import type { ExecutiveAgent } from '../../agents/executive/executive-agent.js';
import { ExecutiveDecisionSchema, type ExecutiveDecision } from '../../agents/executive/executive-schema.js';
import { RoutingTier } from '../../types/enums.js';
import type { Logger } from '../config/logger.js';
import { errorMessage } from '../errors.js';
import type { EventBus, JoviEvent } from '../events/event-bus.js';
import { newId } from '../ids.js';
import type { Job, JobQueue } from '../jobs/job-queue.js';
import type { Task, TaskService } from '../jobs/task-service.js';

export const GoalRequestSchema = z.object({
  goal: z.string().trim().min(5, 'goal must be at least 5 characters').max(2000),
  tier: RoutingTier.optional(),
  constraints: z.array(z.string().max(300)).max(10).optional(),
  mode: z.enum(['sync', 'async']).default('sync'),
  createdBy: z.string().max(100).default('api'),
});
export type GoalRequest = z.input<typeof GoalRequestSchema>;

export interface GoalExecutionResult {
  status: Task['status'];
  taskId: string;
  jobId: string;
  correlationId: string;
  decisionId: string | null;
  objective: string | null;
  selectedAction: ExecutiveDecision['selectedOption'] | null;
  selection: ExecutiveDecision['selection'] | null;
  options: ExecutiveDecision['options'];
  confidence: number | null;
  reasoningSummary: string | null;
  interpretation: string | null;
  priorities: string[];
  contentDirection: string | null;
  nextActions: ExecutiveDecision['nextActions'];
  evaluationSummary: string | null;
  modelsUsed: ExecutiveDecision['modelsUsed'];
  eventsGenerated: Array<Pick<JoviEvent, 'eventId' | 'eventType' | 'timestamp' | 'entityId' | 'source'>>;
  attempts: number;
  durationMs: number | null;
  error: unknown;
}

export const EXECUTIVE_GOAL_JOB = 'executive.goal';

/**
 * The Jovi Core orchestrator. `executeGoal` is the single entry point for
 * GOAL → EXECUTIVE AGENT → CONTEXT → ROUTER → MODEL → DECISION → MEMORY →
 * EVENTS → RESULT. The API and CLI both call it; neither duplicates logic.
 */
export class JoviOrchestrator {
  constructor(
    private readonly deps: {
      tasks: TaskService;
      jobs: JobQueue;
      events: EventBus;
      runner: AgentRunner;
      executive: ExecutiveAgent;
      logger: Logger;
    },
  ) {
    deps.jobs.registerHandler(EXECUTIVE_GOAL_JOB, {
      execute: async ({ job, scope }) => {
        const payload = job.payload as { goal: string; tier?: string; constraints?: string[] };
        this.deps.tasks.start(job.taskId, scope);
        const { output, agentRunId } = await this.deps.runner.run(this.deps.executive, payload, {
          taskId: job.taskId,
          jobId: job.id,
          scope,
        });
        this.deps.tasks.complete(job.taskId, { decisionId: output.decisionId, agentRunId, decision: output }, scope);
        return { decisionId: output.decisionId, agentRunId, decision: output };
      },
      onFinalFailure: ({ job, scope }, error) => {
        const task = this.deps.tasks.find(job.taskId);
        if (task && task.status !== 'COMPLETED' && task.status !== 'CANCELLED') this.deps.tasks.fail(job.taskId, error, scope);
      },
    });
  }

  async executeGoal(request: GoalRequest): Promise<GoalExecutionResult> {
    const input = GoalRequestSchema.parse(request);
    const correlationId = newId('correlation');
    const scope = this.deps.events.scope(correlationId);
    const logger = this.deps.logger.child({ correlationId });
    const started = Date.now();

    const agentInput = {
      goal: input.goal,
      ...(input.tier ? { tier: input.tier } : {}),
      ...(input.constraints ? { constraints: input.constraints } : {}),
    };
    const task = this.deps.tasks.create({ type: 'EXECUTIVE_GOAL', goal: input.goal, input: agentInput, createdBy: input.createdBy }, scope);
    const job = this.deps.jobs.enqueue(
      { taskId: task.id, type: EXECUTIVE_GOAL_JOB, payload: agentInput, reserve: input.mode === 'sync' },
      scope,
    );
    logger.info({ taskId: task.id, jobId: job.id, mode: input.mode }, 'goal received');

    if (input.mode === 'async') return this.getGoalResult(task.id);

    const finished = await this.deps.jobs.run(job.id);
    const result = this.getGoalResult(task.id, finished);
    logger.info(
      {
        taskId: task.id,
        jobId: job.id,
        status: result.status,
        decisionId: result.decisionId,
        retries: Math.max(0, finished.attempts - 1),
        durationMs: Date.now() - started,
        models: result.modelsUsed.map((m) => `${m.provider}:${m.model}`),
        ...(result.status === 'FAILED' ? { err: errorMessage((finished.lastError as { message?: string } | null)?.message ?? 'unknown') } : {}),
      },
      'goal finished',
    );
    return result;
  }

  /** Assembles the goal result from persisted state (works for sync and async runs). */
  getGoalResult(taskId: string, jobOverride?: Job): GoalExecutionResult {
    const task = this.deps.tasks.get(taskId);
    const job = jobOverride ?? this.deps.jobs.listByTask(taskId).at(-1);
    if (!job) throw new Error(`Task ${taskId} has no job`);
    const decisionParse = ExecutiveDecisionSchema.safeParse((task.result as { decision?: unknown } | null)?.decision);
    const decision = decisionParse.success ? decisionParse.data : null;
    const events = this.deps.events.list({ correlationId: task.correlationId, limit: 1000 });

    return {
      status: task.status,
      taskId: task.id,
      jobId: job.id,
      correlationId: task.correlationId,
      decisionId: decision?.decisionId ?? null,
      objective: decision?.objective ?? null,
      selectedAction: decision?.selectedOption ?? null,
      selection: decision?.selection ?? null,
      options: decision?.options ?? [],
      confidence: decision?.confidence ?? null,
      reasoningSummary: decision?.rationaleSummary ?? null,
      interpretation: decision?.interpretation ?? null,
      priorities: decision?.priorities ?? [],
      contentDirection: decision?.contentDirection ?? null,
      nextActions: decision?.nextActions ?? [],
      evaluationSummary: decision?.evaluationSummary ?? null,
      modelsUsed: decision?.modelsUsed ?? [],
      eventsGenerated: events.map((e) => ({ eventId: e.eventId, eventType: e.eventType, timestamp: e.timestamp, entityId: e.entityId, source: e.source })),
      attempts: job.attempts,
      durationMs: task.startedAt && task.completedAt ? Date.parse(task.completedAt) - Date.parse(task.createdAt) : null,
      error: task.error ?? job.lastError ?? null,
    };
  }
}
