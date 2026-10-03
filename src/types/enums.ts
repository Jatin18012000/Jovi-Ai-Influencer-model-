import { z } from 'zod';

/**
 * Shared enumerations for Jovi Core. Each enum is declared once as a Zod
 * schema so the same definition drives runtime validation and static types.
 */

export const TaskStatus = z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const JobStatus = z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'RETRYING', 'CANCELLED']);
export type JobStatus = z.infer<typeof JobStatus>;

export const MemoryType = z.enum([
  'IDENTITY',
  'FACT',
  'PREFERENCE',
  'LEARNING',
  'STRATEGY',
  'AUDIENCE',
  'CONTENT',
  'EXPERIMENT',
  'DECISION',
  'TEMPORARY',
]);
export type MemoryType = z.infer<typeof MemoryType>;

/** Ordered: a higher index grants strictly more power. */
export const PermissionLevel = z.enum([
  'LEVEL_0_READ',
  'LEVEL_1_GENERATE',
  'LEVEL_2_MODIFY',
  'LEVEL_3_EXECUTE',
  'LEVEL_4_EXTERNAL_ACTION',
  'LEVEL_5_INFRASTRUCTURE',
]);
export type PermissionLevel = z.infer<typeof PermissionLevel>;

/** Routing tier used by the Model Router (Phase 5 routing policy). */
export const RoutingTier = z.enum(['LOW', 'NORMAL', 'HIGH', 'STRATEGIC']);
export type RoutingTier = z.infer<typeof RoutingTier>;

export const PrivacyRequirement = z.enum(['STANDARD', 'SENSITIVE', 'LOCAL_ONLY']);
export type PrivacyRequirement = z.infer<typeof PrivacyRequirement>;

export const CostClass = z.enum(['FREE', 'LOW', 'MEDIUM', 'HIGH']);
export type CostClass = z.infer<typeof CostClass>;

export const LatencyRequirement = z.enum(['INTERACTIVE', 'STANDARD', 'BATCH']);
export type LatencyRequirement = z.infer<typeof LatencyRequirement>;

export const RiskLevel = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const ExecutionCostType = z.enum(['API', 'LOCAL_COMPUTE', 'NONE', 'UNKNOWN']);
export type ExecutionCostType = z.infer<typeof ExecutionCostType>;

export const ProviderKind = z.enum(['LOCAL', 'CLOUD', 'MOCK']);
export type ProviderKind = z.infer<typeof ProviderKind>;

export const EventType = z.enum([
  'TASK_CREATED',
  'TASK_STARTED',
  'TASK_COMPLETED',
  'TASK_FAILED',
  'TASK_CANCELLED',
  'JOB_CREATED',
  'JOB_STARTED',
  'JOB_COMPLETED',
  'JOB_RETRYING',
  'JOB_FAILED',
  'JOB_CANCELLED',
  'JOB_RECOVERED',
  'DECISION_CREATED',
  'DECISION_EVALUATED',
  'DECISION_SELECTED',
  'MODEL_SELECTED',
  'MODEL_FALLBACK',
  'MEMORY_CREATED',
  'MEMORY_UPDATED',
  'AGENT_STARTED',
  'AGENT_COMPLETED',
  'AGENT_FAILED',
  'EVALUATION_COMPLETED',
  // Phase 8 — creative production
  'CREATIVE_PRODUCTION_STARTED',
  'CREATIVE_PRODUCTION_STAGE_CHANGED',
  'SCRIPT_CREATED',
  'STORYBOARD_CREATED',
  'VISUAL_PROMPT_CREATED',
  'IMAGE_GENERATION_REQUESTED',
  'IMAGE_GENERATED',
  'VIDEO_GENERATION_REQUESTED',
  'VIDEO_GENERATED',
  'VOICE_GENERATION_REQUESTED',
  'VOICE_GENERATED',
  'RENDER_GENERATION_REQUESTED',
  'RENDER_GENERATED',
  'ASSET_GENERATION_FAILED',
  'ASSET_BLOCKED',
  'ASSET_SIMULATED',
  'ASSET_REJECTED',
  'EDITING_PLAN_CREATED',
  'QA_STARTED',
  'QA_COMPLETED',
  'CREATIVE_PRODUCTION_COMPLETED',
  'CREATIVE_PRODUCTION_BLOCKED',
  'CREATIVE_PRODUCTION_FAILED',
  'PRODUCTION_APPROVED',
  'PRODUCTION_REJECTED',
  // Phase 9 — real media generation
  'MEDIA_PROVIDER_FALLBACK',
  'ASSET_SUPERSEDED',
  'MEDIA_REGENERATION_REQUESTED',
  'VISUAL_IDENTITY_VERSION_CREATED',
  // Security remediation (R-01..R-04)
  'API_CREDENTIAL_CREATED',
  'API_CREDENTIAL_REVOKED',
  'SAFETY_REVIEW_COMPLETED',
]);

/** Kinds of media a production can require. */
export const MediaKind = z.enum(['IMAGE', 'VIDEO', 'VOICE', 'RENDER']);
export type MediaKind = z.infer<typeof MediaKind>;

/**
 * Media asset lifecycle. A prompt is never an asset: only a provider call that
 * returned a real, verifiable output may reach COMPLETED. SIMULATED marks
 * simulation-mode output and is never publishable. SUPERSEDED marks an asset
 * replaced by a human-requested media regeneration (kept for the audit trail).
 */
export const AssetStatus = z.enum(['REQUESTED', 'QUEUED', 'GENERATING', 'COMPLETED', 'SIMULATED', 'FAILED', 'BLOCKED', 'REJECTED', 'SUPERSEDED']);
export type AssetStatus = z.infer<typeof AssetStatus>;

/** Creative production lifecycle. Phase 8 ends at the human approval boundary. */
export const ProductionStatus = z.enum([
  'CREATED',
  'SCRIPTING',
  'STORYBOARDING',
  'PROMPTING',
  'SAFETY_REVIEW',
  'GENERATING_ASSETS',
  'EDITING',
  'QA',
  'AWAITING_HUMAN_APPROVAL',
  'APPROVED',
  'REJECTED',
  'BLOCKED',
  'FAILED',
]);
export type ProductionStatus = z.infer<typeof ProductionStatus>;

export const QAStatus = z.enum(['PASS', 'PASS_WITH_WARNINGS', 'FAIL', 'BLOCKED']);
export type QAStatus = z.infer<typeof QAStatus>;
export type EventType = z.infer<typeof EventType>;
