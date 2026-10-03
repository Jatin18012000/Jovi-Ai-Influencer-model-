import { errorMessage } from '../../core/errors.js';
import type { JoviIdentity } from '../../core/identity/identity-schema.js';
import { newId } from '../../core/ids.js';
import type { PromptLibrary } from '../../core/prompts/prompt-library.js';
import { parseModelJson } from '../../models/json-output.js';
import type { ModelRouter } from '../../models/router/model-router.js';
import { modelReviewReasons, safetyReviewRequest, safetyRouting } from './model-safety-review.js';
import { SafetyModelReviewSchema } from './production-schemas.js';

export interface AppearanceReview {
  allow: boolean;
  reasons: string[];
  model: { provider: string; model: string } | null;
}

/**
 * Re-audit R2-02 (N-02): human-entered visual-identity anchors get the same
 * independent model review as generated media prompts, with the fixed safety
 * rubric (adult only, no real-person likeness, …). Keyword heuristics alone
 * miss a real person named directly ("Taylor Swift face"). Fails closed: no
 * model or an invalid review means the version is refused.
 */
export async function reviewAppearance(
  deps: { router: ModelRouter; prompts: PromptLibrary; identity: () => JoviIdentity; reviewerCalibration: (provider: string, model: string) => string | null },
  anchors: readonly string[],
): Promise<AppearanceReview> {
  const material = anchors.filter((a) => a && a.trim());
  try {
    const routed = await deps.router.generate(
      safetyReviewRequest(deps.prompts, deps.identity(), material, 'Review human-entered visual identity anchors before they are locked into every visual prompt.'),
      safetyRouting(),
      { purpose: 'appearance_review', correlationId: newId('correlation') },
      (text) => parseModelJson(SafetyModelReviewSchema, text),
    );
    const reasons = modelReviewReasons(routed.parsed);
    // Re-audit N-04: only a measured reviewer may approve anchors.
    const uncalibrated = deps.reviewerCalibration(routed.result.provider, routed.result.model);
    if (uncalibrated) reasons.push(uncalibrated);
    return { allow: routed.parsed.verdict === 'ALLOW' && reasons.length === 0, reasons, model: { provider: routed.result.provider, model: routed.result.model } };
  } catch (error) {
    return { allow: false, reasons: [`APPEARANCE_REVIEW_UNAVAILABLE: ${errorMessage(error).slice(0, 300)} (fail-closed)`], model: null };
  }
}
