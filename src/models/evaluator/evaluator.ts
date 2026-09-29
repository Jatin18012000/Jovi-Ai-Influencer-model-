import { z } from 'zod';
import type { Logger } from '../../core/config/logger.js';
import { errorMessage } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import type { PromptLibrary } from '../../core/prompts/prompt-library.js';
import type { JoviDatabase } from '../../database/client.js';
import { evaluations } from '../../database/schema.js';
import type { JoviIdentity } from '../../core/identity/identity-schema.js';
import { identityPromptVariables } from '../../core/identity/identity-prompt.js';
import type { PrivacyRequirement, RoutingTier } from '../../types/enums.js';
import { parseModelJson } from '../json-output.js';
import type { ModelRouter, RunTrace } from '../router/model-router.js';
import { isBlocked, runRuleChecks, type EvaluableOption, type RuleCheck } from './rule-checks.js';

const Score = z.coerce.number().int().min(1).max(5);

export const ModelEvaluationSchema = z.object({
  evaluations: z
    .array(
      z.object({
        optionId: z.coerce.string(),
        scores: z.object({
          quality: Score,
          brandFit: Score,
          objectiveFit: Score,
          originality: Score,
          audienceFit: Score,
          risk: Score,
          cost: Score,
        }),
        strengths: z.array(z.string()).max(6).default([]),
        concerns: z.array(z.string()).max(6).default([]),
      }),
    )
    .min(1),
  recommendedOptionId: z.coerce.string(),
  summary: z.string().max(1200),
});

export type ModelScores = z.infer<typeof ModelEvaluationSchema>['evaluations'][number]['scores'];

export const SCORE_SCALE =
  'Ordinal 1–5 model judgement (not a measurement). quality/brandFit/objectiveFit/originality/audienceFit: higher is better. risk/cost: higher means riskier/more expensive.';

export interface OptionEvaluation {
  optionId: string;
  modelScores: ModelScores | null;
  strengths: string[];
  concerns: string[];
  ruleChecks: RuleCheck[];
  blocked: boolean;
}

export interface EvaluationResult {
  evaluationId: string;
  method: 'MODEL_AND_RULES' | 'RULES_ONLY';
  scoresLabel: string;
  modelCompetition: {
    available: boolean;
    reason: string;
    evaluatorModel: string | null;
    generatorModels: string[];
  };
  options: OptionEvaluation[];
  recommendedOptionId: string | null;
  summary: string;
  modelUsage: {
    provider: string;
    model: string;
    routingCategory: string;
    routingReason: string;
    fallbackUsed: boolean;
    attempts: number;
    latencyMs: number;
    estimatedApiCost: number | null;
    executionCostType: string;
  } | null;
}

export interface EvaluationRequest {
  objective: string;
  options: EvaluableOption[];
  /** Active identity version: drives pillar checks and the evaluator's creator brief. */
  identity: JoviIdentity;
  /** Routing privacy for the evaluator model (LOCAL_ONLY keeps evaluation on LM Studio). */
  privacy?: PrivacyRequirement;
  /** Models that generated the options; the evaluator will avoid them. */
  generatorModels?: string[];
  tier?: RoutingTier;
  mode?: 'AUTO' | 'RULES_ONLY';
  decisionId?: string | null;
  subjectType?: string;
  trace: RunTrace;
}

/**
 * Evaluator. Combines deterministic rule checks (always) with an independent
 * model judgement (when a model other than the generator is available).
 * Scores are coarse ordinal judgements and are labeled as such.
 */
export class Evaluator {
  constructor(
    private readonly router: ModelRouter,
    private readonly prompts: PromptLibrary,
    private readonly db: JoviDatabase,
    private readonly logger: Logger,
  ) {}

  async evaluate(request: EvaluationRequest): Promise<EvaluationResult> {
    const generatorModels = request.generatorModels ?? [];
    const knownPillars = request.identity.contentCategories;
    const routing = {
      taskType: 'evaluation.options',
      complexity: 'NORMAL' as const,
      excludeModels: generatorModels,
      ...(request.privacy ? { privacy: request.privacy } : {}),
    };
    const ruleResults = new Map(request.options.map((o) => [o.id, runRuleChecks(o, knownPillars)]));

    let modelEval: z.infer<typeof ModelEvaluationSchema> | null = null;
    let modelUsage: EvaluationResult['modelUsage'] = null;
    let competitionReason: string;
    let evaluatorModel: string | null = null;

    if (request.mode === 'RULES_ONLY') {
      competitionReason = 'rules-only evaluation requested';
    } else if (request.tier === 'LOW') {
      competitionReason = 'LOW tier: model evaluation skipped to save cost; deterministic rules applied';
    } else {
      const plan = await this.router.plan(routing);
      if (plan.candidates.length === 0) {
        competitionReason = 'model competition unavailable: no second model available (evaluator must differ from generator)';
      } else {
        try {
          const prompt = this.prompts.render('evaluation/evaluate-options', {
            objective: request.objective,
            known_pillars: knownPillars.join(', '),
            options_json: JSON.stringify(request.options, null, 2),
          });
          const routed = await this.router.generate(
            {
              task: { type: 'evaluation.options', description: 'Independent evaluation of content options' },
              context: { system: this.prompts.render('evaluation/evaluator-system', identityPromptVariables(request.identity)), prompt },
              requirements: { json: true, temperature: 0.2, maxOutputTokens: 2000 },
            },
            routing,
            { ...request.trace, purpose: 'evaluation' },
            (text) => parseModelJson(ModelEvaluationSchema, text),
          );
          modelEval = routed.parsed;
          evaluatorModel = `${routed.result.provider}:${routed.result.model}`;
          competitionReason = `independent evaluator ${evaluatorModel} (generator: ${generatorModels.join(', ') || 'n/a'})`;
          modelUsage = {
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
        } catch (error) {
          competitionReason = `model evaluation failed, rules only: ${errorMessage(error)}`;
          this.logger.warn({ correlationId: request.trace.correlationId, err: errorMessage(error) }, 'model evaluation failed; using rules only');
        }
      }
    }

    const options: OptionEvaluation[] = request.options.map((o) => {
      const checks = ruleResults.get(o.id) ?? [];
      const m = modelEval?.evaluations.find((e) => e.optionId === o.id);
      return {
        optionId: o.id,
        modelScores: m?.scores ?? null,
        strengths: m?.strengths ?? [],
        concerns: [...(m?.concerns ?? []), ...checks.filter((c) => c.outcome !== 'PASS').map((c) => `${c.rule}: ${c.detail}`)],
        ruleChecks: checks,
        blocked: isBlocked(checks),
      };
    });

    const recommendedOptionId = this.recommend(options, modelEval?.recommendedOptionId ?? null);
    const blockedCount = options.filter((o) => o.blocked).length;
    const summary = [
      modelEval ? `Model evaluation (${evaluatorModel}): ${modelEval.summary}` : 'No model evaluation.',
      `Rule checks: ${blockedCount} of ${options.length} option(s) blocked.`,
      recommendedOptionId ? `Evaluator recommends option ${recommendedOptionId}.` : 'No selectable option.',
    ].join(' ');

    const result: EvaluationResult = {
      evaluationId: newId('evaluation'),
      method: modelEval ? 'MODEL_AND_RULES' : 'RULES_ONLY',
      scoresLabel: modelEval ? `Model evaluations — ${SCORE_SCALE}` : 'No numeric scores: deterministic rule outcomes only (PASS/WARN/FAIL).',
      modelCompetition: { available: modelEval !== null, reason: competitionReason, evaluatorModel, generatorModels },
      options,
      recommendedOptionId,
      summary,
      modelUsage,
    };

    this.db
      .insert(evaluations)
      .values({
        id: result.evaluationId,
        decisionId: request.decisionId ?? null,
        subjectType: request.subjectType ?? 'content_options',
        method: result.method,
        result,
        correlationId: request.trace.correlationId,
      })
      .run();
    request.trace.scope?.emit('EVALUATION_COMPLETED', 'models.evaluator', result.evaluationId, {
      decisionId: request.decisionId ?? null,
      method: result.method,
      recommendedOptionId,
      modelCompetition: result.modelCompetition.available,
    });
    return result;
  }

  /**
   * Ranking among non-blocked options: model recommendation if selectable,
   * otherwise best composite of model scores, otherwise fewest rule warnings.
   */
  private recommend(options: OptionEvaluation[], modelChoice: string | null): string | null {
    const selectable = options.filter((o) => !o.blocked);
    if (selectable.length === 0) return null;
    if (modelChoice && selectable.some((o) => o.optionId === modelChoice)) return modelChoice;
    const scored = selectable.map((o) => ({
      id: o.optionId,
      composite: o.modelScores ? compositeScore(o.modelScores) : null,
      warnings: o.ruleChecks.filter((c) => c.outcome === 'WARN').length,
    }));
    if (scored.some((s) => s.composite !== null)) {
      scored.sort((a, b) => (b.composite ?? -Infinity) - (a.composite ?? -Infinity));
    } else {
      scored.sort((a, b) => a.warnings - b.warnings);
    }
    return scored[0]?.id ?? null;
  }
}

/** Simple, documented composite for ranking only (never shown as a precise score). */
export function compositeScore(s: ModelScores): number {
  return s.quality + s.brandFit + s.objectiveFit + s.originality + s.audienceFit - 0.5 * (s.risk + s.cost);
}
