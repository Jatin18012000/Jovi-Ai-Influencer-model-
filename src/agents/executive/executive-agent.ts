import { InvalidModelOutputError } from '../../core/errors.js';
import type { DecisionService } from '../../core/decisions/decision-service.js';
import { ContextEngine, type JoviContext } from '../../core/orchestrator/context-engine.js';
import { PermissionGuard, atLeast } from '../../core/permissions/permissions.js';
import type { PromptLibrary } from '../../core/prompts/prompt-library.js';
import type { OperationalMemory } from '../../memory/operational/operational-memory.js';
import type { SemanticMemory } from '../../memory/semantic/semantic-memory.js';
import { slugify } from '../../memory/text.js';
import { compositeScore, type EvaluationResult, type Evaluator } from '../../models/evaluator/evaluator.js';
import { parseModelJson } from '../../models/json-output.js';
import type { ModelRouter, RoutedGeneration } from '../../models/router/model-router.js';
import type { RoutingTier } from '../../types/enums.js';
import type { Agent, AgentDefinition, AgentRunContext } from '../agent.js';
import {
  EXECUTIVE_PROPOSAL_SHAPE,
  ExecutiveDecisionSchema,
  ExecutiveInputSchema,
  ExecutiveProposalSchema,
  type ContentOption,
  type ExecutiveDecision,
  type ExecutiveInput,
  type ExecutiveProposal,
  type ModelUsage,
  type NextAction,
} from './executive-schema.js';

export const EXECUTIVE_AGENT_DEFINITION: AgentDefinition = {
  name: 'executive',
  version: '0.1.0',
  description:
    "Jovi's top-level decision maker: interprets goals, weighs options against identity and strategy, selects an action and delegates next steps.",
  capabilities: ['goal-interpretation', 'content-direction', 'option-generation', 'option-selection', 'delegation-planning'],
  allowedTools: [
    'identity.read',
    'strategy.read',
    'memory.read',
    'knowledge.read',
    'decision.read',
    'model.generate',
    'model.evaluate',
    'decision.write',
    'memory.write',
  ],
  // Deliberately below LEVEL_3/4/5: the Phase 6 Executive decides; it does not act externally.
  permissionLevel: 'LEVEL_2_MODIFY',
  modelRequirements: { defaultTier: 'NORMAL', privacy: 'STANDARD', latency: 'INTERACTIVE', structuredOutput: true },
  costClass: 'MEDIUM',
  riskLevel: 'MEDIUM',
};

/** An evaluator must beat the proposer's pick by this composite margin to override it. */
const EVALUATOR_OVERRIDE_MARGIN = 2;
const ALTERNATIVES_TTL_DAYS = 14;

export interface ExecutiveAgentDeps {
  contextEngine: ContextEngine;
  router: ModelRouter;
  evaluator: Evaluator;
  decisions: DecisionService;
  memory: OperationalMemory;
  semantic: SemanticMemory;
  prompts: PromptLibrary;
}

export class ExecutiveAgent implements Agent<ExecutiveInput, ExecutiveDecision, JoviContext> {
  readonly definition = EXECUTIVE_AGENT_DEFINITION;
  readonly inputSchema = ExecutiveInputSchema;
  readonly outputSchema = ExecutiveDecisionSchema;

  constructor(private readonly deps: ExecutiveAgentDeps) {}

  async loadContext(input: ExecutiveInput, ctx: AgentRunContext): Promise<JoviContext> {
    for (const tool of ['identity.read', 'strategy.read', 'memory.read', 'knowledge.read', 'decision.read'] as const) {
      ctx.permissions.assert(tool);
    }
    return this.deps.contextEngine.build({
      goal: input.goal,
      task: { id: ctx.taskId, type: 'EXECUTIVE_GOAL' },
      agent: { name: this.definition.name, allowedTools: this.definition.allowedTools, permissionLevel: ctx.permissions.effectiveLevel },
      extraConstraints: input.constraints,
    });
  }

  summarizeContext(context: JoviContext): Record<string, unknown> {
    return ContextEngine.summarize(context);
  }

  async execute(input: ExecutiveInput, context: JoviContext, ctx: AgentRunContext): Promise<ExecutiveDecision> {
    const tier = input.tier ?? classifyGoal(input.goal);

    // 1. Generate a structured proposal via the Model Router.
    ctx.permissions.assert('model.generate');
    const routed = await this.deps.router.generate(
      {
        task: { type: 'executive.proposal', description: 'Executive content decision proposal' },
        context: {
          system: this.deps.prompts.load('system/jovi-executive-system'),
          prompt: this.deps.prompts.render('executive/executive-decision', {
            goal: input.goal,
            tier,
            context: this.deps.contextEngine.render(context),
            output_shape: EXECUTIVE_PROPOSAL_SHAPE,
          }),
        },
        requirements: { json: true, temperature: 0.7, maxOutputTokens: 4000 },
      },
      {
        taskType: 'executive.proposal',
        complexity: tier,
        quality: tier,
        privacy: this.definition.modelRequirements.privacy,
        costClass: tier === 'LOW' ? 'LOW' : 'MEDIUM',
        latency: this.definition.modelRequirements.latency,
      },
      ctx.trace('executive.proposal'),
      (text) => parseModelJson(ExecutiveProposalSchema, text),
    );
    const proposal = routed.parsed;
    const generatorUsage = toModelUsage('executive.proposal', routed);

    // 2. Persist the proposal as a decision (PROPOSED).
    ctx.permissions.assert('decision.write');
    const decision = this.deps.decisions.propose(
      {
        taskId: ctx.taskId,
        decisionType: 'CONTENT_DIRECTION',
        objective: proposal.objective,
        context: { goal: input.goal, tier, ...ContextEngine.summarize(context) },
        options: proposal.options,
        reasoningSummary: proposal.rationaleSummary,
        confidence: proposal.confidence,
        decisionAgent: `${this.definition.name}@${this.definition.version}`,
        modelsUsed: [generatorUsage],
      },
      ctx.scope,
    );

    // 3. Evaluate the options (independent model where available + deterministic rules).
    ctx.permissions.assert('model.evaluate');
    const evaluation = await this.deps.evaluator.evaluate({
      objective: proposal.objective,
      options: proposal.options,
      knownPillars: context.identity.profile.contentCategories,
      generatorModels: [`${routed.result.provider}:${routed.result.model}`],
      tier,
      decisionId: decision.id,
      trace: ctx.trace('evaluation'),
    });
    const modelsUsed: ModelUsage[] = [generatorUsage];
    if (evaluation.modelUsage) modelsUsed.push({ purpose: 'evaluation', ...evaluation.modelUsage });
    this.deps.decisions.recordEvaluation(decision.id, evaluation, modelsUsed, ctx.scope, {
      evaluationId: evaluation.evaluationId,
      method: evaluation.method,
      modelCompetition: evaluation.modelCompetition.available,
      evaluatorRecommendedOptionId: evaluation.recommendedOptionId,
    });

    // 4. Select the final action.
    const selection = selectOption(proposal, evaluation);
    const nextActions = this.classifyNextActions(proposal, ctx.permissions);
    const rationaleSummary =
      selection.method === 'PROPOSER_RECOMMENDATION' || selection.method === 'EVALUATOR_AGREEMENT'
        ? proposal.rationaleSummary
        : `${selection.note} Original proposal rationale: ${proposal.rationaleSummary}`;

    this.deps.decisions.select(
      decision.id,
      { selectedAction: selection.option, reasoningSummary: rationaleSummary, confidence: selection.confidence, nextActions, modelsUsed },
      ctx.scope,
      { selectedOptionId: selection.option.id, title: selection.option.title, method: selection.method, confidence: selection.confidence },
    );

    return {
      decisionId: decision.id,
      objective: proposal.objective,
      interpretation: proposal.interpretation,
      priorities: proposal.priorities,
      contentDirection: proposal.contentDirection,
      options: proposal.options,
      selectedOption: selection.option,
      selection: {
        method: selection.method,
        proposerRecommendedOptionId: proposal.recommendedOptionId,
        evaluatorRecommendedOptionId: evaluation.recommendedOptionId,
        note: selection.note,
      },
      rationaleSummary,
      confidence: selection.confidence,
      nextActions,
      evaluationSummary: evaluation.summary,
      modelsUsed,
    };
  }

  /** Persists memory derived from the decision (never the model's raw reasoning). */
  persist(output: ExecutiveDecision, _input: ExecutiveInput, ctx: AgentRunContext): void {
    ctx.permissions.assert('memory.write');
    const selected = output.selectedOption;
    const source = `agent:${this.definition.name}`;
    const tags = ['executive', selected.format.toLowerCase(), ...slugify(selected.pillar).split('-')].filter(Boolean);

    this.deps.memory.upsert(
      {
        type: 'DECISION',
        key: `decision.${output.decisionId}`,
        value: {
          objective: output.objective,
          selected: { id: selected.id, title: selected.title, format: selected.format, pillar: selected.pillar, hook: selected.hook },
          selectionMethod: output.selection.method,
          confidence: output.confidence,
          taskId: ctx.taskId,
        },
        importance: 0.5,
        confidence: output.confidence,
        source,
        tags: ['decision', ...tags],
      },
      ctx.scope,
    );

    this.deps.memory.upsert(
      {
        type: 'CONTENT',
        key: `concept.${slugify(selected.title)}`,
        value: {
          title: selected.title,
          format: selected.format,
          pillar: selected.pillar,
          hook: selected.hook,
          concept: selected.concept,
          status: 'SELECTED_NOT_PRODUCED',
          decisionId: output.decisionId,
        },
        importance: 0.6,
        confidence: output.confidence,
        source,
        tags: ['concept', ...tags],
      },
      ctx.scope,
    );

    const alternatives = output.options.filter((o) => o.id !== selected.id);
    if (alternatives.length) {
      this.deps.memory.upsert(
        {
          type: 'TEMPORARY',
          key: `alternatives.${output.decisionId}`,
          value: { decisionId: output.decisionId, alternatives: alternatives.map((o) => ({ id: o.id, title: o.title, pillar: o.pillar, format: o.format })) },
          importance: 0.3,
          confidence: output.confidence,
          source,
          tags: ['alternatives', 'backlog'],
          expiresAt: new Date(Date.now() + ALTERNATIVES_TTL_DAYS * 86_400_000).toISOString(),
        },
        ctx.scope,
      );
    }

    void this.deps.semantic.index({
      id: output.decisionId,
      text: `${selected.title} — ${selected.format} · ${selected.pillar} — ${selected.concept}`,
      metadata: { pillar: selected.pillar, format: selected.format },
    });
  }

  /** Next actions above the agent's own level are proposals that need human approval. */
  private classifyNextActions(proposal: ExecutiveProposal, permissions: PermissionGuard): NextAction[] {
    return proposal.nextActions.map((a) => {
      const requiredPermission = PermissionGuard.classifyAction(a.action);
      const external = atLeast(requiredPermission, 'LEVEL_4_EXTERNAL_ACTION');
      const withinLevel = atLeast(permissions.effectiveLevel, requiredPermission);
      return {
        action: a.action,
        agent: a.agent,
        requiredPermission,
        status: external || !withinLevel ? 'REQUIRES_APPROVAL' : 'PROPOSED',
        ...(external ? { note: 'External action: blocked in Phase 6 and always requires human approval.' } : {}),
      };
    });
  }
}

/** Heuristic tiering of goals (overridable per request). */
export function classifyGoal(goal: string): RoutingTier {
  const g = goal.toLowerCase();
  if (/\b(strateg\w*|roadmap|quarter|positioning|long[- ]term|pivot|brand direction|monthly plan|content plan)\b/.test(g)) return 'STRATEGIC';
  if (/\b(concept|campaign|launch|introduc\w*|series|signature|collab\w*)\b/.test(g)) return 'HIGH';
  if (/\b(quick|hashtags?|rephrase|summari[sz]e|shortlist|tweak)\b/.test(g)) return 'LOW';
  return 'NORMAL';
}

interface Selection {
  option: ContentOption;
  method: ExecutiveDecision['selection']['method'];
  confidence: number;
  note: string;
}

/**
 * Final selection policy (auditable):
 *  1. A proposer pick that fails a blocking rule is overridden (RULE_OVERRIDE).
 *  2. A model evaluator may override only with a clear composite margin.
 *  3. Otherwise the proposer's recommendation stands.
 */
export function selectOption(proposal: ExecutiveProposal, evaluation: EvaluationResult): Selection {
  const byId = new Map(proposal.options.map((o) => [o.id, o]));
  const evalById = new Map(evaluation.options.map((o) => [o.optionId, o]));
  const proposed = byId.get(proposal.recommendedOptionId);
  if (!proposed) throw new InvalidModelOutputError('recommended option missing from options');
  const proposedEval = evalById.get(proposed.id);

  if (proposedEval?.blocked) {
    const fallbackId = evaluation.recommendedOptionId;
    const fallback = fallbackId ? byId.get(fallbackId) : undefined;
    if (!fallback) throw new InvalidModelOutputError('every proposed option failed blocking rule checks (privacy/transparency/safety)');
    const failed = proposedEval.ruleChecks.filter((c) => c.outcome === 'FAIL').map((c) => c.rule);
    return {
      option: fallback,
      method: 'RULE_OVERRIDE',
      confidence: round(proposal.confidence * 0.7),
      note: `Option ${proposed.id} failed ${failed.join(', ')}; selected option ${fallback.id} instead.`,
    };
  }

  const evaluatorPick = evaluation.recommendedOptionId;
  if (evaluation.method === 'MODEL_AND_RULES' && evaluatorPick && evaluatorPick !== proposed.id) {
    const pickScores = evalById.get(evaluatorPick)?.modelScores;
    const proposedScores = proposedEval?.modelScores;
    const candidate = byId.get(evaluatorPick);
    if (candidate && pickScores && proposedScores && compositeScore(pickScores) - compositeScore(proposedScores) >= EVALUATOR_OVERRIDE_MARGIN) {
      return {
        option: candidate,
        method: 'EVALUATOR_OVERRIDE',
        confidence: round(proposal.confidence * 0.85),
        note: `Independent evaluator rated option ${candidate.id} clearly above option ${proposed.id}; selected ${candidate.id}.`,
      };
    }
    return {
      option: proposed,
      method: 'PROPOSER_RECOMMENDATION',
      confidence: proposal.confidence,
      note: `Evaluator slightly preferred option ${evaluatorPick}, below the override margin; kept proposer's option ${proposed.id}.`,
    };
  }

  if (evaluation.method === 'MODEL_AND_RULES' && evaluatorPick === proposed.id) {
    return { option: proposed, method: 'EVALUATOR_AGREEMENT', confidence: proposal.confidence, note: 'Independent evaluator agreed with the proposer.' };
  }
  return {
    option: proposed,
    method: 'PROPOSER_RECOMMENDATION',
    confidence: proposal.confidence,
    note: 'Selected proposer recommendation; passed deterministic rule checks (no independent model evaluation).',
  };
}

function toModelUsage(purpose: string, routed: RoutedGeneration<unknown>): ModelUsage {
  return {
    purpose,
    provider: routed.result.provider,
    model: routed.result.model,
    routingCategory: routed.plan.category,
    routingReason: routed.plan.reason,
    fallbackUsed: routed.fallbackUsed,
    attempts: routed.attempts.length,
    latencyMs: routed.result.latencyMs,
    estimatedApiCost: routed.result.cost.estimatedApiCost,
    executionCostType: routed.result.cost.executionCostType,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
