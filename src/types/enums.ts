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
]);
export type EventType = z.infer<typeof EventType>;
