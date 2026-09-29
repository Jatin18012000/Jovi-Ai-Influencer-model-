import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Jovi Core v0.1 operational schema (SQLite).
 *
 * Conventions:
 *  - Primary keys are prefixed text ids (see src/core/ids.ts).
 *  - Timestamps are ISO-8601 UTC strings.
 *  - Structured payloads are JSON text columns, validated with Zod at the edges.
 *  - Nothing in this schema stores hidden chain-of-thought: decisions keep a
 *    concise, auditable reasoning summary only.
 */

type Json = unknown;

const createdAt = () => text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
const updatedAt = () => text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const joviIdentity = sqliteTable('jovi_identity', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  creatorName: text('creator_name').notNull(),
  activeVersion: integer('active_version').notNull(),
  profile: text('profile', { mode: 'json' }).$type<Json>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const identityVersions = sqliteTable(
  'identity_versions',
  {
    id: text('id').primaryKey(),
    identityId: text('identity_id')
      .notNull()
      .references(() => joviIdentity.id),
    version: integer('version').notNull(),
    profile: text('profile', { mode: 'json' }).$type<Json>().notNull(),
    changeSummary: text('change_summary').notNull(),
    approvedBy: text('approved_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('identity_versions_identity_version_uq').on(t.identityId, t.version)],
);

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export const strategyVersions = sqliteTable(
  'strategy_versions',
  {
    id: text('id').primaryKey(),
    version: integer('version').notNull(),
    name: text('name').notNull(),
    objective: text('objective').notNull(),
    status: text('status', { enum: ['DRAFT', 'ACTIVE', 'ARCHIVED'] }).notNull(),
    content: text('content', { mode: 'json' }).$type<Json>().notNull(),
    rationale: text('rationale').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    activatedAt: text('activated_at'),
  },
  (t) => [uniqueIndex('strategy_versions_version_uq').on(t.version), index('strategy_versions_status_idx').on(t.status)],
);

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  description: text('description').notNull(),
  status: text('status', { enum: ['ACTIVE', 'PLANNED', 'DISABLED'] }).notNull(),
  capabilities: text('capabilities', { mode: 'json' }).$type<string[]>().notNull(),
  allowedTools: text('allowed_tools', { mode: 'json' }).$type<string[]>().notNull(),
  permissionLevel: text('permission_level').notNull(),
  modelRequirements: text('model_requirements', { mode: 'json' }).$type<Json>().notNull(),
  costClass: text('cost_class').notNull(),
  riskLevel: text('risk_level').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    agentVersion: text('agent_version').notNull(),
    taskId: text('task_id'),
    jobId: text('job_id'),
    correlationId: text('correlation_id').notNull(),
    status: text('status', { enum: ['RUNNING', 'COMPLETED', 'FAILED'] }).notNull(),
    input: text('input', { mode: 'json' }).$type<Json>(),
    output: text('output', { mode: 'json' }).$type<Json>(),
    contextSummary: text('context_summary', { mode: 'json' }).$type<Json>(),
    error: text('error', { mode: 'json' }).$type<Json>(),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
    durationMs: integer('duration_ms'),
  },
  (t) => [index('agent_runs_task_idx').on(t.taskId), index('agent_runs_correlation_idx').on(t.correlationId)],
);

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export const models = sqliteTable(
  'models',
  {
    id: text('id').primaryKey(), // `${provider}:${model}`
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    kind: text('kind', { enum: ['LOCAL', 'CLOUD', 'MOCK'] }).notNull(),
    status: text('status', { enum: ['AVAILABLE', 'UNAVAILABLE'] }).notNull(),
    statusReason: text('status_reason'),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    capabilities: text('capabilities', { mode: 'json' }).$type<string[]>().notNull(),
    pricing: text('pricing', { mode: 'json' }).$type<Json>(),
    lastCheckedAt: text('last_checked_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('models_provider_idx').on(t.provider)],
);

export const modelRuns = sqliteTable(
  'model_runs',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    purpose: text('purpose').notNull(),
    taskId: text('task_id'),
    jobId: text('job_id'),
    agentRunId: text('agent_run_id'),
    correlationId: text('correlation_id').notNull(),
    routingCategory: text('routing_category').notNull(),
    routingReason: text('routing_reason').notNull(),
    attempt: integer('attempt').notNull(),
    isFallback: integer('is_fallback', { mode: 'boolean' }).notNull(),
    fallbackFrom: text('fallback_from'),
    status: text('status', { enum: ['SUCCEEDED', 'FAILED', 'INVALID_OUTPUT'] }).notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms').notNull(),
    estimatedApiCost: real('estimated_api_cost'),
    executionCostType: text('execution_cost_type').notNull(),
    error: text('error', { mode: 'json' }).$type<Json>(),
    createdAt: createdAt(),
  },
  (t) => [index('model_runs_correlation_idx').on(t.correlationId), index('model_runs_task_idx').on(t.taskId)],
);

// ---------------------------------------------------------------------------
// Tasks & jobs
// ---------------------------------------------------------------------------

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    goal: text('goal').notNull(),
    status: text('status', { enum: ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] }).notNull(),
    priority: integer('priority').notNull().default(5),
    input: text('input', { mode: 'json' }).$type<Json>(),
    result: text('result', { mode: 'json' }).$type<Json>(),
    error: text('error', { mode: 'json' }).$type<Json>(),
    correlationId: text('correlation_id').notNull(),
    parentTaskId: text('parent_task_id'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
  },
  (t) => [index('tasks_status_idx').on(t.status), index('tasks_correlation_idx').on(t.correlationId)],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    type: text('type').notNull(),
    status: text('status', { enum: ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'RETRYING', 'CANCELLED'] }).notNull(),
    payload: text('payload', { mode: 'json' }).$type<Json>().notNull(),
    result: text('result', { mode: 'json' }).$type<Json>(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    lastError: text('last_error', { mode: 'json' }).$type<Json>(),
    runAfter: text('run_after').notNull(),
    lockedAt: text('locked_at'),
    correlationId: text('correlation_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
  },
  (t) => [index('jobs_status_run_after_idx').on(t.status, t.runAfter), index('jobs_task_idx').on(t.taskId)],
);

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    eventType: text('event_type').notNull(),
    timestamp: text('timestamp').notNull(),
    source: text('source').notNull(),
    entityId: text('entity_id'),
    payload: text('payload', { mode: 'json' }).$type<Json>().notNull(),
    schemaVersion: integer('schema_version').notNull(),
    correlationId: text('correlation_id'),
    causationId: text('causation_id'),
    sequence: integer('sequence').notNull(),
  },
  (t) => [
    index('events_type_idx').on(t.eventType),
    index('events_correlation_idx').on(t.correlationId),
    index('events_entity_idx').on(t.entityId),
    index('events_sequence_idx').on(t.sequence),
  ],
);

// ---------------------------------------------------------------------------
// Decisions & evaluations
// ---------------------------------------------------------------------------

export const decisions = sqliteTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id'),
    decisionType: text('decision_type').notNull(),
    status: text('status', { enum: ['PROPOSED', 'EVALUATED', 'SELECTED', 'REJECTED'] }).notNull(),
    objective: text('objective').notNull(),
    context: text('context', { mode: 'json' }).$type<Json>().notNull(),
    options: text('options', { mode: 'json' }).$type<Json>().notNull(),
    selectedAction: text('selected_action', { mode: 'json' }).$type<Json>(),
    reasoningSummary: text('reasoning_summary').notNull(),
    confidence: real('confidence').notNull(),
    decisionAgent: text('decision_agent').notNull(),
    modelsUsed: text('models_used', { mode: 'json' }).$type<Json>().notNull(),
    evaluation: text('evaluation', { mode: 'json' }).$type<Json>(),
    nextActions: text('next_actions', { mode: 'json' }).$type<Json>(),
    correlationId: text('correlation_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('decisions_task_idx').on(t.taskId), index('decisions_created_idx').on(t.createdAt)],
);

export const evaluations = sqliteTable(
  'evaluations',
  {
    id: text('id').primaryKey(),
    decisionId: text('decision_id'),
    subjectType: text('subject_type').notNull(),
    method: text('method').notNull(),
    result: text('result', { mode: 'json' }).$type<Json>().notNull(),
    correlationId: text('correlation_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('evaluations_decision_idx').on(t.decisionId)],
);

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export const memoryItems = sqliteTable(
  'memory_items',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).$type<Json>().notNull(),
    importance: real('importance').notNull(),
    confidence: real('confidence').notNull(),
    source: text('source').notNull(),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    expiresAt: text('expires_at'),
  },
  (t) => [uniqueIndex('memory_items_type_key_uq').on(t.type, t.key), index('memory_items_importance_idx').on(t.importance)],
);
