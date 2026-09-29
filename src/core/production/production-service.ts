import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { JoviDatabase } from '../../database/client.js';
import { productionArtifacts, productions } from '../../database/schema.js';
import type { EventType, ProductionStatus, QAStatus } from '../../types/enums.js';
import { ConflictError, NotFoundError, ValidationError, serializeError } from '../errors.js';
import type { CorrelationScope } from '../events/event-bus.js';
import { newId, nowIso } from '../ids.js';
import type { AssetService } from './asset-service.js';
import { evaluatePublishingGate, type PublishingGateResult } from './publishing-gate.js';

export type Production = typeof productions.$inferSelect;
export type ArtifactKind = (typeof productionArtifacts.$inferSelect)['kind'];

const SOURCE = 'production';

/**
 * Production lifecycle. Agents/pipeline can only move a production forward to
 * the human approval boundary. APPROVED/REJECTED are reachable only through
 * `recordHumanDecision`, and there is no PUBLISHED state in Phase 8.
 */
export const PRODUCTION_TRANSITIONS: Record<ProductionStatus, ProductionStatus[]> = {
  CREATED: ['SCRIPTING', 'FAILED'],
  SCRIPTING: ['STORYBOARDING', 'FAILED'],
  STORYBOARDING: ['PROMPTING', 'FAILED'],
  PROMPTING: ['GENERATING_ASSETS', 'FAILED'],
  GENERATING_ASSETS: ['EDITING', 'FAILED'],
  EDITING: ['QA', 'FAILED'],
  QA: ['AWAITING_HUMAN_APPROVAL', 'BLOCKED', 'FAILED'],
  AWAITING_HUMAN_APPROVAL: ['APPROVED', 'REJECTED'],
  BLOCKED: ['REJECTED'],
  APPROVED: [],
  REJECTED: [],
  FAILED: [],
};
const HUMAN_ONLY: ProductionStatus[] = ['APPROVED', 'REJECTED'];

const ARTIFACT_EVENT: Record<ArtifactKind, EventType> = {
  SCRIPT: 'SCRIPT_CREATED',
  STORYBOARD: 'STORYBOARD_CREATED',
  VISUAL_PROMPTS: 'VISUAL_PROMPT_CREATED',
  EDIT_PLAN: 'EDITING_PLAN_CREATED',
  QA_REPORT: 'QA_COMPLETED',
};

export const HumanDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  reviewer: z.string().trim().min(2).max(100),
  note: z.string().max(2000).optional(),
  /** Required to approve a PASS_WITH_WARNINGS result: the human reviewed the warnings. */
  acknowledgeWarnings: z.boolean().default(false),
});
export type HumanDecision = z.input<typeof HumanDecisionSchema>;

export class ProductionService {
  constructor(
    private readonly db: JoviDatabase,
    private readonly assets: AssetService,
  ) {}

  create(
    input: {
      taskId: string;
      sourceType: 'PLANNING' | 'DIRECT';
      sourcePlanningTaskId: string | null;
      ideaId: string;
      idea: unknown;
      productionContext: unknown;
      identityVersion: number;
      visualIdentityVersion: number;
      simulated: boolean;
    },
    scope: CorrelationScope,
  ): Production {
    const now = nowIso();
    const row = {
      id: newId('production'),
      ...input,
      correlationId: scope.correlationId,
      status: 'CREATED',
      qaStatus: null,
      approvalDecision: null,
      approvedBy: null,
      approvalNote: null,
      decidedAt: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(productions).values(row).run();
    scope.emit('CREATIVE_PRODUCTION_STARTED', SOURCE, row.id, { taskId: input.taskId, ideaId: input.ideaId, sourceType: input.sourceType, simulated: input.simulated });
    return this.get(row.id);
  }

  get(id: string): Production {
    const row = this.db.select().from(productions).where(eq(productions.id, id)).get();
    if (!row) throw new NotFoundError('Production', id);
    return row;
  }

  findByTask(taskId: string): Production | undefined {
    return this.db.select().from(productions).where(eq(productions.taskId, taskId)).get();
  }

  /** Pipeline-driven transitions. Refuses the human-only states. */
  advance(id: string, to: ProductionStatus, scope: CorrelationScope, fields: Partial<Production> = {}): Production {
    if (HUMAN_ONLY.includes(to)) throw new ValidationError(`${to} can only be set by a human decision`);
    return this.transition(id, to, scope, fields);
  }

  fail(id: string, error: unknown, scope: CorrelationScope): Production {
    const current = this.get(id);
    if (PRODUCTION_TRANSITIONS[current.status as ProductionStatus].includes('FAILED')) {
      return this.transition(id, 'FAILED', scope, { error: serializeError(error) });
    }
    return current;
  }

  saveArtifact(productionId: string, kind: ArtifactKind, content: unknown, agentRunId: string | null, scope: CorrelationScope) {
    const latest = this.latestArtifactRow(productionId, kind);
    const row = { id: newId('artifact'), productionId, kind, version: (latest?.version ?? 0) + 1, content, agentRunId, createdAt: nowIso() };
    this.db.insert(productionArtifacts).values(row).run();
    const payload: Record<string, unknown> = { productionId, version: row.version, agentRunId };
    if (kind === 'QA_REPORT') {
      const status = (content as { status?: QAStatus }).status ?? null;
      payload.status = status;
      this.db.update(productions).set({ qaStatus: status, updatedAt: nowIso() }).where(eq(productions.id, productionId)).run();
    }
    scope.emit(ARTIFACT_EVENT[kind], SOURCE, row.id, payload);
    return row;
  }

  latestArtifact<T = unknown>(productionId: string, kind: ArtifactKind): T | null {
    return (this.latestArtifactRow(productionId, kind)?.content as T | undefined) ?? null;
  }

  /**
   * The human approval boundary. Approval requires a QA verdict of PASS (or
   * PASS_WITH_WARNINGS with warnings acknowledged). FAIL/BLOCKED results
   * cannot be approved; they can only be rejected. Approval does NOT publish.
   */
  recordHumanDecision(id: string, input: HumanDecision, scope: CorrelationScope): Production {
    const decision = HumanDecisionSchema.parse(input);
    const production = this.get(id);
    const status = production.status as ProductionStatus;

    if (decision.decision === 'REJECT') {
      if (!PRODUCTION_TRANSITIONS[status].includes('REJECTED')) throw new ConflictError(`Production in status ${status} cannot be rejected`);
      const updated = this.transition(id, 'REJECTED', scope, {
        approvalDecision: 'REJECT',
        approvedBy: decision.reviewer,
        approvalNote: decision.note ?? null,
        decidedAt: nowIso(),
      });
      for (const asset of this.assets.list(id)) {
        if (asset.status !== 'REJECTED') this.assets.transition(asset.id, 'REJECTED', { statusReason: `production rejected by ${decision.reviewer}` }, scope);
      }
      return updated;
    }

    if (status !== 'AWAITING_HUMAN_APPROVAL') {
      throw new ConflictError(`Production in status ${status} cannot be approved (QA ${production.qaStatus ?? 'not run'})`);
    }
    const qa = production.qaStatus as QAStatus | null;
    if (qa !== 'PASS' && qa !== 'PASS_WITH_WARNINGS') throw new ConflictError(`QA status ${qa ?? 'missing'} blocks approval`);
    if (qa === 'PASS_WITH_WARNINGS' && !decision.acknowledgeWarnings) {
      throw new ConflictError('QA passed with warnings: set acknowledgeWarnings=true after reviewing them');
    }
    return this.transition(id, 'APPROVED', scope, {
      approvalDecision: 'APPROVE',
      approvedBy: decision.reviewer,
      approvalNote: decision.note ?? null,
      decidedAt: nowIso(),
    });
  }

  publishingGate(id: string): PublishingGateResult {
    return evaluatePublishingGate(this.get(id), this.assets.list(id));
  }

  private transition(id: string, to: ProductionStatus, scope: CorrelationScope, fields: Partial<Production>): Production {
    const current = this.get(id);
    const from = current.status as ProductionStatus;
    if (!PRODUCTION_TRANSITIONS[from].includes(to)) throw new ValidationError(`Invalid production transition ${from} -> ${to}`, { productionId: id });
    this.db
      .update(productions)
      .set({ ...fields, status: to, updatedAt: nowIso() })
      .where(eq(productions.id, id))
      .run();
    const payload = { from, to, taskId: current.taskId };
    scope.emit('CREATIVE_PRODUCTION_STAGE_CHANGED', SOURCE, id, payload);
    if (to === 'AWAITING_HUMAN_APPROVAL') scope.emit('CREATIVE_PRODUCTION_COMPLETED', SOURCE, id, { ...payload, qaStatus: current.qaStatus });
    if (to === 'BLOCKED') scope.emit('CREATIVE_PRODUCTION_BLOCKED', SOURCE, id, { ...payload, qaStatus: current.qaStatus });
    if (to === 'FAILED') scope.emit('CREATIVE_PRODUCTION_FAILED', SOURCE, id, { ...payload, error: fields.error ?? null });
    if (to === 'APPROVED') scope.emit('PRODUCTION_APPROVED', SOURCE, id, { ...payload, reviewer: fields.approvedBy });
    if (to === 'REJECTED') scope.emit('PRODUCTION_REJECTED', SOURCE, id, { ...payload, reviewer: fields.approvedBy });
    return this.get(id);
  }

  private latestArtifactRow(productionId: string, kind: ArtifactKind) {
    return this.db
      .select()
      .from(productionArtifacts)
      .where(and(eq(productionArtifacts.productionId, productionId), eq(productionArtifacts.kind, kind)))
      .orderBy(desc(productionArtifacts.version))
      .get();
  }
}
