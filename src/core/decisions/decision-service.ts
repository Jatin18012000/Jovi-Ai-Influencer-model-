import { desc, eq } from 'drizzle-orm';
import type { JoviDatabase } from '../../database/client.js';
import { decisions } from '../../database/schema.js';
import type { CorrelationScope } from '../events/event-bus.js';
import { NotFoundError } from '../errors.js';
import { newId, nowIso } from '../ids.js';

export type DecisionRow = typeof decisions.$inferSelect;

export interface DecisionRecord {
  id: string;
  taskId: string | null;
  decisionType: string;
  status: DecisionRow['status'];
  objective: string;
  context: unknown;
  options: unknown;
  selectedAction: unknown;
  reasoningSummary: string;
  confidence: number;
  decisionAgent: string;
  modelsUsed: unknown;
  evaluation: unknown;
  nextActions: unknown;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
}

const SOURCE = 'core.decisions';

/**
 * Persists decisions through their lifecycle: PROPOSED → EVALUATED → SELECTED.
 * Stores only concise, auditable reasoning summaries — never hidden
 * chain-of-thought.
 */
export class DecisionService {
  constructor(private readonly db: JoviDatabase) {}

  propose(
    input: {
      taskId: string | null;
      decisionType: string;
      objective: string;
      context: unknown;
      options: unknown;
      reasoningSummary: string;
      confidence: number;
      decisionAgent: string;
      modelsUsed: unknown;
    },
    scope: CorrelationScope,
  ): DecisionRecord {
    const now = nowIso();
    const row = {
      id: newId('decision'),
      taskId: input.taskId,
      decisionType: input.decisionType,
      status: 'PROPOSED' as const,
      objective: input.objective,
      context: input.context,
      options: input.options,
      selectedAction: null,
      reasoningSummary: input.reasoningSummary,
      confidence: input.confidence,
      decisionAgent: input.decisionAgent,
      modelsUsed: input.modelsUsed,
      evaluation: null,
      nextActions: null,
      correlationId: scope.correlationId,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(decisions).values(row).run();
    scope.emit('DECISION_CREATED', SOURCE, row.id, {
      decisionType: row.decisionType,
      taskId: row.taskId,
      optionCount: Array.isArray(input.options) ? input.options.length : null,
    });
    return row;
  }

  recordEvaluation(id: string, evaluation: unknown, modelsUsed: unknown, scope: CorrelationScope, summary: Record<string, unknown>): DecisionRecord {
    this.update(id, { status: 'EVALUATED', evaluation, modelsUsed });
    scope.emit('DECISION_EVALUATED', SOURCE, id, summary);
    return this.get(id);
  }

  select(
    id: string,
    input: { selectedAction: unknown; reasoningSummary: string; confidence: number; nextActions: unknown; modelsUsed: unknown },
    scope: CorrelationScope,
    summary: Record<string, unknown>,
  ): DecisionRecord {
    this.update(id, { status: 'SELECTED', ...input });
    scope.emit('DECISION_SELECTED', SOURCE, id, summary);
    return this.get(id);
  }

  get(id: string): DecisionRecord {
    const row = this.db.select().from(decisions).where(eq(decisions.id, id)).get();
    if (!row) throw new NotFoundError('Decision', id);
    return row;
  }

  findByTask(taskId: string): DecisionRecord | undefined {
    return this.db.select().from(decisions).where(eq(decisions.taskId, taskId)).orderBy(desc(decisions.createdAt)).get();
  }

  recent(limit = 5): DecisionRecord[] {
    return this.db
      .select()
      .from(decisions)
      .where(eq(decisions.status, 'SELECTED'))
      .orderBy(desc(decisions.createdAt))
      .limit(limit)
      .all();
  }

  private update(id: string, fields: Partial<DecisionRow>): void {
    const result = this.db
      .update(decisions)
      .set({ ...fields, updatedAt: nowIso() })
      .where(eq(decisions.id, id))
      .run();
    if (result.changes === 0) throw new NotFoundError('Decision', id);
  }
}
