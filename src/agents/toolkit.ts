import type { DecisionService } from '../core/decisions/decision-service.js';
import type { CorrelationScope } from '../core/events/event-bus.js';
import type { IdentityService } from '../core/identity/identity-service.js';
import { nowIso } from '../core/ids.js';
import type { ContextEngine, ContextRequest, JoviContext } from '../core/orchestrator/context-engine.js';
import type { PermissionGuard, ToolName } from '../core/permissions/permissions.js';
import type { StrategyService } from '../core/strategy/strategy-service.js';
import type { KnowledgeBase } from '../memory/knowledge/knowledge-base.js';
import type { MemoryInput, MemoryQuery, OperationalMemory } from '../memory/operational/operational-memory.js';
import type { SemanticDocument, SemanticMemory } from '../memory/semantic/semantic-memory.js';
import type { EvaluationRequest, Evaluator } from '../models/evaluator/evaluator.js';
import type { ModelRouter, RoutingRequest, RunTrace } from '../models/router/model-router.js';
import type { GenerateRequest } from '../models/types.js';
import type { PermissionLevel } from '../types/enums.js';

/** Services the ToolKit mediates. Agents never receive these directly. */
export interface ToolServices {
  identity: IdentityService;
  strategy: StrategyService;
  memory: OperationalMemory;
  knowledge: KnowledgeBase;
  semantic: SemanticMemory;
  decisions: DecisionService;
  router: ModelRouter;
  evaluator: Evaluator;
  contextEngine: ContextEngine;
  /** Read-only agent directory (name → declared permission level, status). */
  agentDirectory: () => ReadonlyArray<{ name: string; permissionLevel: PermissionLevel; status: string }>;
}

export interface ToolCallRecord {
  tool: ToolName;
  allowed: boolean;
  at: string;
}

export interface ToolRunBinding {
  scope: CorrelationScope;
  trace: (purpose: string) => RunTrace;
}

type DecisionService_ = DecisionService;
type ProposeInput = Parameters<DecisionService_['propose']>[0];
type SelectInput = Parameters<DecisionService_['select']>[1];

/**
 * Builds the controlled tool layer for one agent run. Every method first
 * asserts the agent's permission for the underlying tool (allow-list AND
 * level, capped by the deployment ceiling) and records the call — allowed or
 * denied — for the audit trail stored on `agent_runs.tool_calls`.
 *
 * There are deliberately no shell, filesystem, network, credential,
 * publishing or infrastructure tools.
 */
export function createToolKit(services: ToolServices, guard: PermissionGuard, run: ToolRunBinding) {
  const calls: ToolCallRecord[] = [];
  const use = <T>(tool: ToolName, fn: () => T): T => {
    try {
      guard.assert(tool);
    } catch (error) {
      calls.push({ tool, allowed: false, at: nowIso() });
      throw error;
    }
    calls.push({ tool, allowed: true, at: nowIso() });
    return fn();
  };
  const agentSource = `agent:${guard.agentName}`;

  return {
    calls,

    identity: {
      getActive: () => use('identity.read', () => services.identity.getActive()),
    },

    strategy: {
      getActive: () => use('strategy.read', () => services.strategy.getActive()),
    },

    knowledge: {
      search: (query: string, limit?: number) => use('knowledge.read', () => services.knowledge.search(query, limit)),
    },

    memory: {
      search: (text: string, query?: MemoryQuery) => use('memory.read', () => services.memory.search(text, query)),
      /** Agent writes are always attributed to the agent (trusted source); callers cannot spoof it. */
      write: (input: Omit<MemoryInput, 'source'>) =>
        use('memory.write', () => services.memory.upsert({ ...input, source: agentSource }, run.scope).item),
      indexConcept: (document: SemanticDocument) => use('memory.write', () => services.semantic.index(document)),
    },

    decisions: {
      recent: (limit?: number) => use('decision.read', () => services.decisions.recent(limit)),
      propose: (input: ProposeInput) => use('decision.write', () => services.decisions.propose(input, run.scope)),
      recordEvaluation: (id: string, evaluation: unknown, modelsUsed: unknown, summary: Record<string, unknown>) =>
        use('decision.write', () => services.decisions.recordEvaluation(id, evaluation, modelsUsed, run.scope, summary)),
      select: (id: string, input: SelectInput, summary: Record<string, unknown>) =>
        use('decision.write', () => services.decisions.select(id, input, run.scope, summary)),
    },

    models: {
      generate: <T>(
        request: Omit<GenerateRequest, 'requirements'> & { requirements?: GenerateRequest['requirements'] },
        routing: RoutingRequest,
        purpose: string,
        parse: (output: string) => T,
      ) => use('model.generate', () => services.router.generate(request, routing, run.trace(purpose), parse)),
    },

    evaluation: {
      evaluate: (request: Omit<EvaluationRequest, 'trace'>) =>
        use('model.evaluate', () => services.evaluator.evaluate({ ...request, trace: run.trace('evaluation') })),
    },

    context: {
      /** Context assembly reads identity, strategy, memory, knowledge and decisions. */
      build: (request: ContextRequest): Promise<JoviContext> => {
        for (const tool of ['identity.read', 'strategy.read', 'memory.read', 'knowledge.read', 'decision.read'] as const) use(tool, () => undefined);
        return services.contextEngine.build(request);
      },
      render: (context: JoviContext) => services.contextEngine.render(context),
    },

    agents: {
      describe: (name: string) => use('agent.read', () => services.agentDirectory().find((a) => a.name === name) ?? null),
    },
  };
}

export type ToolKit = ReturnType<typeof createToolKit>;
