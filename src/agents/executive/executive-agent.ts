import { createHash } from 'node:crypto';
import { InvalidModelOutputError } from '../../core/errors.js';
import { identityPromptVariables } from '../../core/identity/identity-prompt.js';
import { ContextEngine, type JoviContext } from '../../core/orchestrator/context-engine.js';
import { atLeast, requiredLevelForAction } from '../../core/permissions/permissions.js';
import type { PromptLibrary } from '../../core/prompts/prompt-library.js';
import { slugify } from '../../memory/text.js';
import { compositeScore, type EvaluationResult } from '../../models/evaluator/evaluator.js';
import { parseModelJson } from '../../models/json-output.js';
import type { RoutedGeneration } from '../../models/router/model-router.js';
import type { RoutingTier } from '../../types/enums.js';
import type { Agent, AgentDefinition, AgentRunContext } from '../agent.js';
import type { ToolKit } from '../toolkit.js';
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
  version: '0.2.0',
  description:
    "Jovi's top-level decision maker: interprets goals, weighs options against identity and strategy, selects an action and delegates next steps.",
  capabilities: ['goal-interpretation', 'content-direction', 'option-generation', 'option-selection', 'delegation-planning'],
  allowedTools: [
    'identity.read',
    'strategy.read',
    'memory.read',
    'knowledge.read',
    'decision.read',
    'agent.read',
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

/**
 * The Executive Agent holds no services. Everything it reads or writes goes
 * through `ctx.tools`, which enforces its permission level on every call.
 * Its only constructor dependency is the read-only prompt library.
 */
export class ExecutiveAgent implements Agent<ExecutiveInput, ExecutiveDecision, JoviContext> {
  readonly definition = EXECUTIVE_AGENT_DEFINITION;
  readonly inputSchema = ExecutiveInputSchema;
  readonly outputSchema = ExecutiveDecisionSchema;

  constructor(private readonly prompts: PromptLibrary) {}

  async loadContext(input: ExecutiveInput, ctx: AgentRunContext): Promise<JoviContext> {
    return ctx.tools.context.build({
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
    const { tools } = ctx;
    const tier = input.tier ?? classifyGoal(input.goal);
    const privacy = input.privacy ?? this.definition.modelRequirements.privacy;
    const identityVars = identityPromptVariables(context.identity.profile);

    // 1. Generate a structured proposal via the Model Router.
    const routed = await tools.models.generate(
      {
        task: { type: 'executive.proposal', description: 'Executive content decision proposal' },
        context: {
          // Identity facts come from the ACTIVE identity version, never from static prompt text.
          system: this.prompts.render('system/jovi-executive-system', identityVars),
          prompt: this.prompts.render('executive/executive-decision', {
            creator_name: identityVars.creator_name ?? context.identity.profile.creatorName,
            goal: input.goal,
            tier,
            context: tools.context.render(context),
            output_shape: EXECUTIVE_PROPOSAL_SHAPE,
          }),
        },
        requirements: { json: true, temperature: 0.7, maxOutputTokens: 4000 },
      },
      {
        taskType: 'executive.proposal',
        complexity: tier,
        quality: tier,
        privacy,
        costClass: tier === 'LOW' ? 'LOW' : 'MEDIUM',
        latency: this.definition.modelRequirements.latency,
      },
      'executive.proposal',
      (text) => parseModelJson(ExecutiveProposalSchema, text),
    );
    const proposal = routed.parsed;
    const generatorUsage = toModelUsage('executive.proposal', routed);

    // 2. Persist the proposal as a decision (PROPOSED).
    const decision = tools.decisions.propose({
      taskId: ctx.taskId,
      decisionType: 'CONTENT_DIRECTION',
      objective: proposal.objective,
      context: { goal: input.goal, tier, privacy, ...ContextEngine.summarize(context) },
      options: proposal.options,
      reasoningSummary: proposal.rationaleSummary,
      confidence: proposal.confidence,
      decisionAgent: `${this.definition.name}@${this.definition.version}`,
      modelsUsed: [generatorUsage],
    });

    // 3. Evaluate the options (independent model where available + deterministic rules).
    const evaluation = await tools.evaluation.evaluate({
      objective: proposal.objective,
      options: proposal.options,
      identity: context.identity.profile,
      generatorModels: [`${routed.result.provider}:${routed.result.model}`],
      tier,
      privacy,
      decisionId: decision.id,
    });
    const modelsUsed: ModelUsage[] = [generatorUsage];
    if (evaluation.modelUsage) {
      modelsUsed.push({ purpose: 'evaluation', executionType: executionTypeOf(evaluation.modelUsage.executionCostType), ...evaluation.modelUsage });
    }
    tools.decisions.recordEvaluation(decision.id, evaluation, modelsUsed, {
      evaluationId: evaluation.evaluationId,
      method: evaluation.method,
      modelCompetition: evaluation.modelCompetition.available,
      evaluatorRecommendedOptionId: evaluation.recommendedOptionId,
    });

    // 4. Select the final action.
    const selection = selectOption(proposal, evaluation);
    const nextActions = classifyNextActions(proposal, tools);
    const rationaleSummary =
      selection.method === 'PROPOSER_RECOMMENDATION' || selection.method === 'EVALUATOR_AGREEMENT'
        ? proposal.rationaleSummary
        : `${selection.note} Original proposal rationale: ${proposal.rationaleSummary}`;

    tools.decisions.select(
      decision.id,
      { selectedAction: selection.option, reasoningSummary: rationaleSummary, confidence: selection.confidence, nextActions, modelsUsed },
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
  async persist(output: ExecutiveDecision, _input: ExecutiveInput, ctx: AgentRunContext): Promise<void> {
    const { tools } = ctx;
    const selected = output.selectedOption;
    const tags = ['executive', selected.format.toLowerCase(), ...slugify(selected.pillar).split('-')].filter(Boolean);

    tools.memory.write({
      type: 'DECISION',
      key: `decision.${output.decisionId}`,
      value: {
        // R-03: the objective is user/API text; memory keeps only its fingerprint (the decision record keeps the audit copy).
        objectiveSha256: createHash('sha256').update(output.objective).digest('hex'),
        selected: { id: selected.id, title: selected.title, format: selected.format, pillar: selected.pillar, hook: selected.hook },
        selectionMethod: output.selection.method,
        confidence: output.confidence,
        taskId: ctx.taskId,
      },
      importance: 0.5,
      confidence: output.confidence,
      tags: ['decision', ...tags],
    });

    tools.memory.write({
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
      tags: ['concept', ...tags],
    });

    const alternatives = output.options.filter((o) => o.id !== selected.id);
    if (alternatives.length) {
      tools.memory.write({
        type: 'TEMPORARY',
        key: `alternatives.${output.decisionId}`,
        value: { decisionId: output.decisionId, alternatives: alternatives.map((o) => ({ id: o.id, title: o.title, pillar: o.pillar, format: o.format })) },
        importance: 0.3,
        confidence: output.confidence,
        tags: ['alternatives', 'backlog'],
        expiresAt: new Date(Date.now() + ALTERNATIVES_TTL_DAYS * 86_400_000).toISOString(),
      });
    }

    await tools.memory.indexConcept({
      id: output.decisionId,
      text: `${selected.title} — ${selected.format} · ${selected.pillar} — ${selected.concept}`,
      metadata: { pillar: selected.pillar, format: selected.format },
    });
  }
}

/**
 * Next actions: the required level is the higher of what the text implies and
 * the owning agent's declared level. External (LEVEL_4+) actions and actions
 * for unknown agents always require human approval.
 */
export function classifyNextActions(proposal: ExecutiveProposal, tools: Pick<ToolKit, 'agents'>): NextAction[] {
  return proposal.nextActions.map((a) => {
    const owner = tools.agents.describe(a.agent);
    const requiredPermission = requiredLevelForAction(a.action, owner?.permissionLevel ?? null);
    const external = atLeast(requiredPermission, 'LEVEL_4_EXTERNAL_ACTION');
    const needsApproval = external || owner === null;
    const note = external
      ? 'External action: blocked in Phase 6 and always requires human approval.'
      : owner === null
        ? `Unknown agent "${a.agent}": requires human review.`
        : undefined;
    return {
      action: a.action,
      agent: a.agent,
      requiredPermission,
      status: needsApproval ? 'REQUIRES_APPROVAL' : 'PROPOSED',
      ...(note ? { note } : {}),
    };
  });
}

function executionTypeOf(costType: string): ModelUsage['executionType'] {
  return costType === 'LOCAL_COMPUTE' ? 'LOCAL' : costType === 'NONE' ? 'MOCK' : 'CLOUD';
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
    executionType: routed.result.executionType,
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
