import type { z } from 'zod';
import type { Logger } from '../core/config/logger.js';
import type { CorrelationScope } from '../core/events/event-bus.js';
import type { PermissionGuard, ToolName } from '../core/permissions/permissions.js';
import type { ToolKit } from './toolkit.js';
import type { CostClass, LatencyRequirement, PermissionLevel, PrivacyRequirement, RiskLevel, RoutingTier } from '../types/enums.js';

export interface ModelRequirements {
  defaultTier: RoutingTier;
  privacy: PrivacyRequirement;
  latency: LatencyRequirement;
  structuredOutput: boolean;
}

/** Static description of an agent — persisted to the `agents` table. */
export interface AgentDefinition {
  name: string;
  version: string;
  description: string;
  capabilities: readonly string[];
  allowedTools: readonly ToolName[];
  permissionLevel: PermissionLevel;
  modelRequirements: ModelRequirements;
  costClass: CostClass;
  riskLevel: RiskLevel;
}

/**
 * Runtime handles given to an agent for a single run. Agents act on the system
 * ONLY through `tools`: every tool call is permission-checked and audited.
 * `scope` is for emitting the agent's own domain events.
 */
export interface AgentRunContext {
  agentRunId: string;
  taskId: string | null;
  jobId: string | null;
  correlationId: string;
  scope: CorrelationScope;
  logger: Logger;
  /** Read-only view of the agent's effective permissions. */
  permissions: Pick<PermissionGuard, 'agentName' | 'effectiveLevel' | 'can'>;
  tools: ToolKit;
}

/**
 * Agent contract. The AgentRunner enforces the lifecycle:
 * validate input → load context → execute → validate output → persist → emit → return.
 */
export interface Agent<I, O, C> {
  readonly definition: AgentDefinition;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  loadContext(input: I, ctx: AgentRunContext): Promise<C>;
  execute(input: I, context: C, ctx: AgentRunContext): Promise<O>;
  persist?(output: O, input: I, ctx: AgentRunContext): Promise<void> | void;
  /** Compact, auditable summary of the context stored on the agent run. */
  summarizeContext?(context: C): Record<string, unknown>;
}

export type AnyAgent = Agent<any, any, any>;
