import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { JoviDatabase } from '../../database/client.js';
import { productionArtifacts, productions } from '../../database/schema.js';
import { MediaKind, type AssetStatus, type EventType, type ProductionStatus, type QAStatus } from '../../types/enums.js';
import { ConflictError, NotFoundError, ValidationError, serializeError } from '../errors.js';
import type { CorrelationScope, EventAttestation, EventBus } from '../events/event-bus.js';
import { newId, nowIso } from '../ids.js';
import { INACTIVE_ASSET_STATUSES, type AssetService } from './asset-service.js';
import { evaluatePublishingGate, type PublishingGateResult } from './publishing-gate.js';

export type Production = typeof productions.$inferSelect;
export type ArtifactKind = (typeof productionArtifacts.$inferSelect)['kind'];

const SOURCE = 'production';

/**
 * Production lifecycle. Agents/pipeline can only move a production forward to
 * the human approval boundary. APPROVED/REJECTED are reachable only through
 * `recordHumanDecision`, and there is no PUBLISHED state. Leaving BLOCKED or
 * AWAITING_HUMAN_APPROVAL back to SAFETY_REVIEW (media regeneration) is only
 * possible through `requestMediaRegeneration`, a human/operator action.
 */
export const PRODUCTION_TRANSITIONS: Record<ProductionStatus, ProductionStatus[]> = {
  CREATED: ['SCRIPTING', 'FAILED'],
  SCRIPTING: ['STORYBOARDING', 'FAILED'],
  STORYBOARDING: ['PROMPTING', 'FAILED'],
  PROMPTING: ['SAFETY_REVIEW', 'FAILED'],
  // R-02: no media is requested until the pre-generation safety review allows it.
  SAFETY_REVIEW: ['GENERATING_ASSETS', 'BLOCKED', 'FAILED'],
  GENERATING_ASSETS: ['EDITING', 'FAILED'],
  EDITING: ['QA', 'FAILED'],
  QA: ['AWAITING_HUMAN_APPROVAL', 'BLOCKED', 'FAILED'],
  AWAITING_HUMAN_APPROVAL: ['APPROVED', 'REJECTED', 'SAFETY_REVIEW'],
  BLOCKED: ['REJECTED', 'SAFETY_REVIEW'],
  APPROVED: [],
  REJECTED: [],
  FAILED: [],
};
const HUMAN_ONLY: ProductionStatus[] = ['APPROVED', 'REJECTED'];
/** States only a human decision or a human regeneration request may leave. */
const HUMAN_GATED_FROM: ProductionStatus[] = ['AWAITING_HUMAN_APPROVAL', 'BLOCKED'];
const REGENERABLE_KINDS = ['IMAGE', 'VIDEO', 'VOICE'] as const;

const ARTIFACT_EVENT: Record<ArtifactKind, EventType> = {
  SCRIPT: 'SCRIPT_CREATED',
  STORYBOARD: 'STORYBOARD_CREATED',
  VISUAL_PROMPTS: 'VISUAL_PROMPT_CREATED',
  SAFETY_REVIEW: 'SAFETY_REVIEW_COMPLETED',
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

export const MediaRegenerationSchema = z.object({
  requestedBy: z.string().trim().min(2).max(100),
  reason: z.string().max(1000).optional(),
  /** Which kinds to regenerate (default all). The final render is always redone. */
  kinds: z.array(MediaKind.extract([...REGENERABLE_KINDS])).min(1).optional(),
  /** Also replace COMPLETED assets of those kinds (e.g. a human disliked the images). */
  includeCompleted: z.boolean().default(false),
});
export type MediaRegenerationRequest = z.input<typeof MediaRegenerationSchema>;

export class ProductionService {
  constructor(
    private readonly db: JoviDatabase,
    private readonly assets: AssetService,
    /** R-08: approval/rejection events are attested; the publishing gate reconciles state with them. */
    private readonly audit: { bus: EventBus; attestation: EventAttestation },
    /** R-05: human-requested media regenerations allowed per production. */
    private readonly maxRegenerations = 5,
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
    const from = this.get(id).status as ProductionStatus;
    if (HUMAN_GATED_FROM.includes(from)) throw new ValidationError(`a production in ${from} can only be moved by a human decision or regeneration request`);
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
    if (kind === 'SAFETY_REVIEW') payload.verdict = (content as { verdict?: string }).verdict ?? null;
    if (kind === 'QA_REPORT') {
      const status = (content as { status?: QAStatus }).status ?? null;
      payload.status = status;
      this.db.update(productions).set({ qaStatus: status, updatedAt: nowIso() }).where(eq(productions.id, productionId)).run();
    }
    scope.emit(ARTIFACT_EVENT[kind], SOURCE, row.id, payload);
    return row;
  }

  /**
   * R-02: media may be generated for a production only with a current ALLOW
   * safety review (newer than the visual prompts it reviewed). Returns the
   * refusal reason, or null when cleared.
   */
  safetyClearance(productionId: string): string | null {
    const review = this.latestArtifact<{ verdict?: string; reasons?: string[] }>(productionId, 'SAFETY_REVIEW');
    if (!review) return 'SAFETY_REVIEW_REQUIRED: no pre-generation safety review exists for this production';
    if (review.verdict !== 'ALLOW') return `SAFETY_REVIEW_BLOCKED: ${(review.reasons ?? []).join('; ').slice(0, 300)}`;
    const reviewedAt = this.artifactCreatedAt(productionId, 'SAFETY_REVIEW');
    const promptsAt = this.artifactCreatedAt(productionId, 'VISUAL_PROMPTS');
    if (promptsAt && reviewedAt && promptsAt > reviewedAt) return 'SAFETY_REVIEW_STALE: the visual prompts changed after the last review';
    return null;
  }

  /** When the latest artifact of a kind was stored (null if none). */
  artifactCreatedAt(productionId: string, kind: ArtifactKind): string | null {
    return this.latestArtifactRow(productionId, kind)?.createdAt ?? null;
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
        if (!INACTIVE_ASSET_STATUSES.includes(asset.status as AssetStatus)) this.assets.transition(asset.id, 'REJECTED', { statusReason: `production rejected by ${decision.reviewer}` }, scope);
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

  /**
   * Human/operator request to regenerate media for an existing production
   * (e.g. after configuring a provider, or to replace images a human
   * rejected), without re-running the text stages. Unusable assets of the
   * chosen kinds — and COMPLETED ones when `includeCompleted` — plus every
   * render are SUPERSEDED (kept for audit); QA is reset and must run again.
   */
  requestMediaRegeneration(id: string, input: MediaRegenerationRequest, scope: CorrelationScope): Production {
    const request = MediaRegenerationSchema.parse(input);
    const production = this.get(id);
    const status = production.status as ProductionStatus;
    if (!HUMAN_GATED_FROM.includes(status)) throw new ConflictError(`Production in status ${status} cannot regenerate media (only BLOCKED or AWAITING_HUMAN_APPROVAL)`);
    const previous = this.regenerationCount(id);
    if (previous >= this.maxRegenerations) {
      throw new ConflictError(`Production ${id} reached the media regeneration limit (${this.maxRegenerations}); start a new production instead`);
    }
    for (const kind of ['SCRIPT', 'STORYBOARD', 'VISUAL_PROMPTS'] as const) {
      if (!this.latestArtifact(id, kind)) throw new ConflictError(`Production has no ${kind} artifact; start a new production instead`);
    }
    const kinds: readonly string[] = request.kinds ?? REGENERABLE_KINDS;
    const superseded: string[] = [];
    for (const asset of this.assets.list(id)) {
      const current = asset.status as AssetStatus;
      if (INACTIVE_ASSET_STATUSES.includes(current)) continue;
      const replace = asset.kind === 'RENDER' || (kinds.includes(asset.kind) && (current !== 'COMPLETED' || request.includeCompleted));
      if (!replace) continue;
      if (['REQUESTED', 'QUEUED', 'GENERATING'].includes(current)) {
        this.assets.transition(asset.id, 'FAILED', { statusReason: 'interrupted: generation did not finish' }, scope);
      }
      this.assets.transition(asset.id, 'SUPERSEDED', { statusReason: `superseded by media regeneration requested by ${request.requestedBy}` }, scope);
      superseded.push(asset.id);
    }
    scope.emit('MEDIA_REGENERATION_REQUESTED', SOURCE, id, { requestedBy: request.requestedBy, reason: request.reason ?? null, kinds, includeCompleted: request.includeCompleted, superseded });
    // Regeneration re-enters through the safety gate (R-02): media is never requested without a fresh review.
    return this.transition(id, 'SAFETY_REVIEW', scope, { qaStatus: null, error: null });
  }

  /** Number of human-requested media regenerations recorded for a production. */
  regenerationCount(id: string): number {
    return this.audit.bus.list({ entityId: id, eventType: 'MEDIA_REGENERATION_REQUESTED', limit: 1000 }).length;
  }

  publishingGate(id: string): PublishingGateResult {
    const production = this.get(id);
    return evaluatePublishingGate(production, this.assets.list(id), this.approvalAttestationBlocker(production));
  }

  /**
   * R-08: an APPROVED status counts only when a matching, hash-chain-valid
   * PRODUCTION_APPROVED event (emitted by this service with the attestation
   * capability) names the same reviewer. A status set by editing the
   * database alone is reported as "approval not attested".
   */
  private approvalAttestationBlocker(production: Production): string | null {
    if (production.status !== 'APPROVED') return null;
    const event = this.audit.bus.list({ entityId: production.id, eventType: 'PRODUCTION_APPROVED', limit: 5 }).at(-1);
    if (!event) return 'approval not attested: no PRODUCTION_APPROVED event exists for this production';
    if (event.source !== SOURCE || event.payload.reviewer !== production.approvedBy) {
      return `approval not attested: the approval event does not match the recorded approver (${production.approvedBy ?? 'none'})`;
    }
    const integrity = this.audit.bus.verifyEvent(event.eventId);
    if (!integrity.ok) return `approval not attested: approval event failed the audit hash chain (${integrity.reason})`;
    return null;
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
    if (to === 'APPROVED') scope.emit('PRODUCTION_APPROVED', SOURCE, id, { ...payload, reviewer: fields.approvedBy }, this.audit.attestation);
    if (to === 'REJECTED') scope.emit('PRODUCTION_REJECTED', SOURCE, id, { ...payload, reviewer: fields.approvedBy }, this.audit.attestation);
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
