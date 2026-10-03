import { z } from 'zod';
import { errorMessage } from '../../core/errors.js';
import { nowIso } from '../../core/ids.js';
import type { PromptLibrary } from '../../core/prompts/prompt-library.js';
import { parseModelJson } from '../../models/json-output.js';
import type { Agent, AgentDefinition, AgentRunContext } from '../agent.js';
import { CODE_NEGATIVE_PROMPT } from './creative-agents.js';
import { findIdentityViolations } from './identity-guard.js';
import { SAFETY_TASK_TYPE, modelReviewReasons, safetyReviewRequest, safetyRouting } from './model-safety-review.js';
import {
  ProductionIdeaSchema,
  SafetyModelReviewSchema,
  SafetyReviewSchema,
  type SafetyReview,
  type Script,
  type Storyboard,
  type VisualPrompts,
} from './production-schemas.js';

export const SAFETY_REVIEW_AGENT_DEFINITION: AgentDefinition = {
  name: 'safety-review',
  version: '0.1.0',
  description: 'Pre-generation safety gate: heuristic identity/safety checks plus an independent model-graded rubric. Fails closed.',
  capabilities: ['safety-review', 'minor-protection', 'ai-transparency'],
  allowedTools: ['identity.read', 'production.read', 'production.write:SAFETY_REVIEW', 'model.generate'],
  permissionLevel: 'LEVEL_2_MODIFY',
  modelRequirements: { defaultTier: 'NORMAL', privacy: 'STANDARD', latency: 'STANDARD', structuredOutput: true },
  costClass: 'LOW',
  riskLevel: 'LOW',
};

export const SafetyReviewInputSchema = z.object({
  productionId: z.string().min(1),
  privacy: z.enum(['STANDARD', 'SENSITIVE', 'LOCAL_ONLY']).default('STANDARD'),
});
export type SafetyReviewInput = z.infer<typeof SafetyReviewInputSchema>;

/** Null when `provider:model` may act as the reviewer; otherwise why not (re-audit N-04 calibration gate). */
export type ReviewerCalibrationCheck = (provider: string, model: string) => string | null;

/**
 * Every text that will drive media generation. Re-audit R2-02: the full image
 * and video prompts are reviewed, including the character lock, because the
 * lock carries human-entered visual-identity anchors. Negative prompts are
 * code-authored (R2-01) and verified separately (`nonCodeNegatives`).
 */
export function materialForReview(idea: unknown, script: Script | null, storyboard: Storyboard | null, prompts: VisualPrompts | null): string[] {
  const i = ProductionIdeaSchema.partial().safeParse(idea);
  const texts: string[] = [];
  if (i.success) texts.push(...[i.data.title, i.data.hook, i.data.concept, i.data.audienceValue].filter((t): t is string => Boolean(t)));
  if (script) {
    texts.push(script.title, script.hook, script.cta, script.personalityIntent, script.visualIntent, script.audioIntent);
    for (const s of script.sections) texts.push(s.visualIntent, ...s.onScreenText, ...s.dialogue.map((d) => d.line));
  }
  if (storyboard) {
    for (const s of storyboard.scenes) texts.push(s.subject, s.joviAppearance, s.action, s.location, s.environment, s.wardrobe, ...s.onScreenText);
  }
  if (prompts) {
    for (const p of prompts.prompts) texts.push(p.imagePrompt, p.videoPrompt);
  }
  return texts.filter((t) => t && t.trim());
}

/** Scenes whose negative prompt is not the code-authored constant (R2-01): refused, never reviewed into acceptance. */
export function nonCodeNegatives(prompts: VisualPrompts | null): string[] {
  return (prompts?.prompts ?? []).filter((p) => p.negativePrompt !== CODE_NEGATIVE_PROMPT).map((p) => p.sceneId);
}

/**
 * Security remediation R-02: the gate between text and media. Runs after the
 * visual prompts exist and before ANY media request. ALLOW requires all of:
 *  - no heuristic identity/safety violation (age, minors, AI transparency,
 *    origin, explicit content, real-person likeness);
 *  - an independent model review with a fixed rubric, in a separate call that
 *    sees only the material (no creative instructions), passing every check.
 * It fails closed: if the model review cannot run or its output is invalid,
 * the verdict is BLOCK. MediaService independently refuses to generate for a
 * production without a current ALLOW review.
 */
export class SafetyReviewAgent implements Agent<SafetyReviewInput, SafetyReview, null> {
  readonly definition = SAFETY_REVIEW_AGENT_DEFINITION;
  readonly inputSchema = SafetyReviewInputSchema;
  readonly outputSchema = SafetyReviewSchema;

  constructor(
    private readonly prompts: PromptLibrary,
    private readonly reviewerCalibration: ReviewerCalibrationCheck,
  ) {}

  async loadContext(): Promise<null> {
    return null;
  }

  async execute(input: SafetyReviewInput, _c: null, ctx: AgentRunContext): Promise<SafetyReview> {
    const { tools } = ctx;
    const identity = tools.identity.getActive();
    const visual = tools.identity.getVisual();
    const production = tools.production.get(input.productionId);
    const material = materialForReview(
      production.idea,
      tools.production.getArtifact<Script>(input.productionId, 'SCRIPT'),
      tools.production.getArtifact<Storyboard>(input.productionId, 'STORYBOARD'),
      tools.production.getArtifact<VisualPrompts>(input.productionId, 'VISUAL_PROMPTS'),
    );

    const violations = findIdentityViolations(material, identity.profile, { likeness: true, allowNames: [identity.profile.name, identity.profile.creatorName] });
    const foreignNegatives = nonCodeNegatives(tools.production.getArtifact<VisualPrompts>(input.productionId, 'VISUAL_PROMPTS'));

    let model: SafetyReview['model'];
    try {
      const routed = await tools.models.generate(
        safetyReviewRequest(this.prompts, identity.profile, material, this.definition.description),
        safetyRouting(input.privacy),
        SAFETY_TASK_TYPE,
        (text) => parseModelJson(SafetyModelReviewSchema, text),
      );
      model = { available: true, provider: routed.result.provider, model: routed.result.model, review: routed.parsed };
    } catch (error) {
      model = { available: false, reason: errorMessage(error).slice(0, 300) };
    }

    const reasons = [
      ...violations.map((v) => `heuristic ${v.rule}: "${v.match}"`),
      ...(foreignNegatives.length ? [`NEGATIVE_PROMPT_NOT_CODE_AUTHORED: scenes ${foreignNegatives.join(', ')} (start a new production)`] : []),
      ...(model.available
        ? [
            ...modelReviewReasons(model.review),
            // Re-audit N-04: an unmeasured reviewer cannot clear media generation.
            ...[this.reviewerCalibration(model.provider, model.model)].filter((r): r is string => r !== null),
          ]
        : [`SAFETY_REVIEW_UNAVAILABLE: ${model.reason} (fail-closed)`]),
    ];
    const allow = violations.length === 0 && model.available && model.review.verdict === 'ALLOW' && reasons.length === 0;

    return {
      verdict: allow ? 'ALLOW' : 'BLOCK',
      reasons,
      heuristic: { violations },
      model,
      textsReviewed: material.length,
      identityVersion: identity.version,
      visualIdentityVersion: visual.version,
      reviewedAt: nowIso(),
    };
  }

  persist(output: SafetyReview, input: SafetyReviewInput, ctx: AgentRunContext): void {
    ctx.tools.production.saveArtifact(input.productionId, 'SAFETY_REVIEW', output);
  }
}
