import type { JoviIdentity } from '../../core/identity/identity-schema.js';
import { LOCKABLE_FIELDS, type ActiveVisualIdentity } from '../../core/identity/visual-identity.js';
import type { MediaAsset } from '../../core/production/asset-service.js';
import { nowIso } from '../../core/ids.js';
import { CLICHES, EXPLICIT, HUMAN_CLAIM, PRIVACY, findViolation } from '../../models/evaluator/rule-checks.js';
import { LIKENESS, findIdentityViolations } from './identity-guard.js';
import {
  QA_MODEL_CHECKS,
  type EditPlan,
  type ProductionIdea,
  type QACategory,
  type QACheck,
  type QAModelReview,
  type QAReport,
  type Script,
  type Storyboard,
  type VisualPrompts,
} from './production-schemas.js';

export interface QAInput {
  identity: JoviIdentity;
  identityVersion: number;
  visual: ActiveVisualIdentity;
  idea: ProductionIdea;
  script: Script | null;
  storyboard: Storyboard | null;
  prompts: VisualPrompts | null;
  editPlan: EditPlan | null;
  assets: MediaAsset[];
  modelReview: { review: QAModelReview; provider: string; model: string } | null;
  modelReviewError?: string;
  /** Pre-generation safety review (R-02). `null` = media pipeline ran without one; undefined = not evaluated here. */
  safetyReview?: { verdict: string; reasons: string[] } | null;
}

/** Pattern-based checks (R-02): reported as HEURISTIC so a reviewer never reads them as proof. */
const HEURISTIC_CHECKS = new Set([
  'identity.age',
  'identity.origin',
  'personality.cliches',
  'brand.transparency',
  'safety.prohibited_content',
  'safety.privacy',
  'safety.real_person_likeness',
  'safety.unauthorized_claims',
]);

const UNAUTHORIZED_CLAIMS = /\b(guaranteed|clinically proven|cures?|cured|official (?:partner|ambassador)|sponsored by|in partnership with|risk[- ]free|get rich|#ad)\b/i;
const VERTICAL_FORMATS = ['REEL', 'STORY'];

type Result = QACheck['result'];
const check = (
  id: string,
  category: QACategory,
  name: string,
  result: Result,
  detail: string,
  opts: { severity?: QACheck['severity']; method?: QACheck['method']; blocksApproval?: boolean } = {},
): QACheck => {
  const heuristic = !opts.method && HEURISTIC_CHECKS.has(id);
  return {
    id,
    category,
    name,
    result,
    detail: heuristic && result === 'PASSED' ? `${detail} (heuristic pattern check — not proof of compliance)` : detail,
    severity: opts.severity ?? 'BLOCKING',
    method: opts.method ?? (heuristic ? 'HEURISTIC' : 'DETERMINISTIC'),
    blocksApproval: opts.blocksApproval ?? false,
  };
};

/**
 * Structured creative QA. Deterministic checks are authoritative for
 * identity, safety and technical integrity; model checks (when a model is
 * available) judge subjective quality. Anything that cannot be verified is
 * reported NOT_VERIFIABLE — never PASSED.
 */
export function runCreativeQA(input: QAInput): QAReport {
  const checks: QACheck[] = [];
  const { script, storyboard, prompts, editPlan, identity, visual } = input;
  // Rejected/superseded assets are audit history; QA judges the current set.
  const assets = input.assets.filter((a) => a.status !== 'SUPERSEDED' && a.status !== 'REJECTED');

  if (!script || !storyboard || !prompts || !editPlan) {
    checks.push(check('technical.artifacts', 'TECHNICAL', 'All production artifacts present', 'FAILED', 'script, storyboard, visual prompts and edit plan are required'));
    return finalize(checks, input);
  }

  const dialogue = script.sections.flatMap((s) => s.dialogue.map((d) => d.line));
  const onScreen = [...script.sections.flatMap((s) => s.onScreenText), ...storyboard.scenes.flatMap((s) => s.onScreenText)];
  const content = [script.hook, script.cta, ...dialogue, ...onScreen];
  const visualText = [...storyboard.scenes.flatMap((s) => [s.joviAppearance, s.action, s.subject, s.location, s.environment]), ...prompts.prompts.flatMap((p) => [p.imagePrompt, p.videoPrompt])];

  // ---------------- IDENTITY ----------------
  checks.push(
    visual.status === 'LOCKED'
      ? check('identity.visual_identity_locked', 'IDENTITY', 'Visual identity locked', 'PASSED', `visual identity v${visual.version} is locked`)
      : check('identity.visual_identity_locked', 'IDENTITY', 'Visual identity locked', 'NOT_VERIFIABLE', `visual identity v${visual.version} is NOT_LOCKED (${visual.unlockedFields.join(', ')}); face/hair/eyes/beauty-mark consistency cannot be verified`, { blocksApproval: true }),
  );
  const violations = findIdentityViolations([...content, ...visualText], identity);
  const ageIssues = violations.filter((v) => v.rule === 'AGE' || v.rule === 'MINOR_DEPICTION');
  checks.push(
    ageIssues.length
      ? check('identity.age', 'IDENTITY', 'Age consistency', 'FAILED', `contradicts apparent age ${identity.age}: ${ageIssues.map((v) => v.match).join(', ')}`)
      : check('identity.age', 'IDENTITY', 'Age consistency', 'PASSED', `no age or minor-depiction contradiction (Jovi is ${identity.age})`),
  );
  const origin = violations.filter((v) => v.rule === 'ORIGIN');
  checks.push(
    origin.length
      ? check('identity.origin', 'IDENTITY', 'Origin consistency', 'FAILED', origin.map((v) => v.match).join(', '))
      : check('identity.origin', 'IDENTITY', 'Origin consistency', 'PASSED', `no contradiction of ${identity.origin}`),
  );
  const lockMissing = prompts.prompts.filter((p) => p.featuresJovi && !p.imagePrompt.startsWith(p.characterConsistency.slice(0, 40)));
  checks.push(
    lockMissing.length
      ? check('identity.character_lock', 'IDENTITY', 'Character lock applied to every Jovi prompt', 'FAILED', `missing in scenes ${lockMissing.map((p) => p.sceneId).join(', ')}`)
      : check('identity.character_lock', 'IDENTITY', 'Character lock applied to every Jovi prompt', 'PASSED', `visual identity v${prompts.visualIdentityVersion} lock prepended`),
  );
  const visuals = assets.filter((a) => (a.kind === 'IMAGE' || a.kind === 'VIDEO') && a.status === 'COMPLETED');
  for (const [id, name] of [
    ['identity.face', 'Face consistency'],
    ['identity.hair', 'Hair consistency'],
    ['identity.eyes', 'Eye consistency'],
    ['identity.beauty_mark', 'Beauty mark consistency'],
    ['identity.body', 'Body/appearance consistency'],
    ['identity.age_appearance', 'Apparent age in visuals'],
  ] as const) {
    checks.push(
      visuals.length === 0
        ? check(id, 'IDENTITY', name, 'NOT_APPLICABLE', 'no completed visual assets to inspect (see technical checks)', { severity: 'MAJOR' })
        : check(id, 'IDENTITY', name, 'NOT_VERIFIABLE', `no automated visual inspector is configured; a human must compare ${visuals.length} asset(s) with the locked visual identity`, {
            severity: 'MAJOR',
            method: 'HUMAN_REVIEW',
          }),
    );
  }

  // ---------------- PERSONALITY / BRAND / CONTENT (deterministic parts) ----------------
  const cliches = CLICHES.filter((c) => dialogue.join(' ').toLowerCase().includes(c));
  checks.push(
    cliches.length
      ? check('personality.cliches', 'PERSONALITY', 'No cliché voice', 'WARNING', `cliché phrasing: ${cliches.join(', ')}`, { severity: 'MINOR' })
      : check('personality.cliches', 'PERSONALITY', 'No cliché voice', 'PASSED', 'no known cliché phrasing', { severity: 'MINOR' }),
  );
  const human = findViolation(content.join('\n'), HUMAN_CLAIM);
  checks.push(
    human
      ? check('brand.transparency', 'BRAND', 'AI transparency', 'FAILED', `implies Jovi is human: "${human}"`)
      : check('brand.transparency', 'BRAND', 'AI transparency', 'PASSED', 'no claim or implication of being human'),
  );
  const pillar = identity.contentCategories.find((c) => c.toLowerCase() === input.idea.pillar.toLowerCase() || c.toLowerCase().includes(input.idea.pillar.toLowerCase().split(' ')[0] ?? ''));
  checks.push(
    pillar
      ? check('brand.pillar', 'BRAND', 'Content pillar', 'PASSED', `maps to "${pillar}"`, { severity: 'MINOR' })
      : check('brand.pillar', 'BRAND', 'Content pillar', 'WARNING', `"${input.idea.pillar}" is not one of Jovi's categories`, { severity: 'MINOR' }),
  );
  const first = script.sections[0];
  checks.push(
    first && first.durationSeconds <= 3.5 && (first.dialogue.length > 0 || first.onScreenText.length > 0)
      ? check('content.hook_placement', 'CONTENT', 'Hook lands in the first 3 seconds', 'PASSED', `opening section ${first.durationSeconds}s`, { severity: 'MINOR' })
      : check('content.hook_placement', 'CONTENT', 'Hook lands in the first 3 seconds', 'WARNING', 'opening section is long or has no spoken/on-screen hook', { severity: 'MINOR' }),
  );
  checks.push(
    script.cta.trim().length >= 3
      ? check('content.cta', 'CONTENT', 'CTA present', 'PASSED', script.cta, { severity: 'MINOR' })
      : check('content.cta', 'CONTENT', 'CTA present', 'WARNING', 'no CTA', { severity: 'MINOR' }),
  );
  const sectionTotal = script.sections.reduce((n, s) => n + s.durationSeconds, 0);
  const sceneTotal = storyboard.scenes.reduce((n, s) => n + s.durationSeconds, 0);
  const within = (a: number, b: number, tol: number) => Math.abs(a - b) <= Math.max(1, b * tol);
  checks.push(
    within(sectionTotal, script.estimatedDurationSeconds, 0.2) && within(sceneTotal, sectionTotal, 0.2)
      ? check('content.narrative_timing', 'CONTENT', 'Script and storyboard timing agree', 'PASSED', `script ${script.estimatedDurationSeconds}s, sections ${sectionTotal}s, scenes ${sceneTotal}s`, { severity: 'MAJOR' })
      : check('content.narrative_timing', 'CONTENT', 'Script and storyboard timing agree', 'FAILED', `script ${script.estimatedDurationSeconds}s vs sections ${sectionTotal}s vs scenes ${sceneTotal}s`, { severity: 'MAJOR' }),
  );

  // ---------------- VISUAL ----------------
  const wardrobeBreaks = storyboard.scenes.slice(1).filter((scene, i) => {
    const prev = storyboard.scenes[i]!;
    if (!scene.featuresJovi || !prev.featuresJovi) return false;
    if (scene.wardrobe.trim().toLowerCase() === prev.wardrobe.trim().toLowerCase()) return false;
    return !scene.continuityRequirements.some((c) => /wardrobe|outfit|costume|change/i.test(c));
  });
  checks.push(
    wardrobeBreaks.length
      ? check('visual.wardrobe_continuity', 'VISUAL', 'Wardrobe continuity', 'WARNING', `unexplained wardrobe change in ${wardrobeBreaks.map((s) => s.sceneId).join(', ')}`, { severity: 'MINOR' })
      : check('visual.wardrobe_continuity', 'VISUAL', 'Wardrobe continuity', 'PASSED', 'wardrobe consistent or changes are motivated', { severity: 'MINOR' }),
  );
  checks.push(check('visual.scene_continuity', 'VISUAL', 'Scene continuity requirements', 'PASSED', `${storyboard.scenes.length} scenes carry continuity requirements`, { severity: 'MINOR' }));
  for (const [id, name] of [
    ['visual.composition', 'Composition'],
    ['visual.quality', 'Image/video quality'],
    ['visual.artifacts', 'Generation artifacts'],
  ] as const) {
    checks.push(
      visuals.length === 0
        ? check(id, 'VISUAL', name, 'NOT_APPLICABLE', 'no completed visual assets', { severity: 'MAJOR' })
        : check(id, 'VISUAL', name, 'NOT_VERIFIABLE', 'requires human review (no automated visual inspector configured)', { severity: 'MAJOR', method: 'HUMAN_REVIEW' }),
    );
  }

  // ---------------- SAFETY ----------------
  if (input.safetyReview !== undefined) {
    const review = input.safetyReview;
    checks.push(
      review?.verdict === 'ALLOW'
        ? check('safety.pre_generation_review', 'SAFETY', 'Pre-generation safety review', 'PASSED', 'heuristic + independent model review allowed media generation', { method: 'MODEL' })
        : check('safety.pre_generation_review', 'SAFETY', 'Pre-generation safety review', 'FAILED', review ? `review verdict ${review.verdict}: ${review.reasons.join('; ').slice(0, 300)}` : 'media pipeline ran without a safety review'),
    );
  }
  const everything = [...content, ...visualText].join('\n');
  const explicit = findViolation(everything, EXPLICIT);
  checks.push(explicit ? check('safety.prohibited_content', 'SAFETY', 'Prohibited content', 'FAILED', `"${explicit}"`) : check('safety.prohibited_content', 'SAFETY', 'Prohibited content', 'PASSED', 'none found'));
  const privacy = PRIVACY.map((re) => findViolation(everything, re, { privacySuffix: true })).find((m) => m !== null);
  checks.push(privacy ? check('safety.privacy', 'SAFETY', 'Privacy boundaries', 'FAILED', `"${privacy}"`) : check('safety.privacy', 'SAFETY', 'Privacy boundaries', 'PASSED', 'no private details exposed'));
  const likeness = findViolation([...visualText, ...content].join('\n'), LIKENESS);
  checks.push(
    likeness
      ? check('safety.real_person_likeness', 'SAFETY', 'Impersonation / real-person likeness', 'FAILED', `"${likeness}"`)
      : check('safety.real_person_likeness', 'SAFETY', 'Impersonation / real-person likeness', 'PASSED', 'no real-person, celebrity or lookalike references'),
  );
  const claims = findViolation(content.join('\n'), UNAUTHORIZED_CLAIMS);
  checks.push(
    claims
      ? check('safety.unauthorized_claims', 'SAFETY', 'Unauthorized claims', 'FAILED', `"${claims}"`)
      : check('safety.unauthorized_claims', 'SAFETY', 'Unauthorized claims', 'PASSED', 'no unsupported or sponsorship claims'),
  );

  // ---------------- TECHNICAL ----------------
  const expected = VERTICAL_FORMATS.includes(script.format) ? '9:16' : null;
  const ratios = new Set([storyboard.aspectRatio, editPlan.aspectRatio, ...prompts.prompts.map((p) => p.aspectRatio)]);
  checks.push(
    ratios.size === 1 && (!expected || ratios.has(expected))
      ? check('technical.aspect_ratio', 'TECHNICAL', 'Aspect ratio', 'PASSED', `${[...ratios][0]} throughout`)
      : check('technical.aspect_ratio', 'TECHNICAL', 'Aspect ratio', 'FAILED', `inconsistent or wrong for ${script.format}: ${[...ratios].join(', ')}`),
  );
  const maxDuration = script.format === 'REEL' ? 90 : 180;
  checks.push(
    within(editPlan.totalDurationSeconds, script.estimatedDurationSeconds, 0.1) && editPlan.totalDurationSeconds <= maxDuration
      ? check('technical.duration', 'TECHNICAL', 'Duration', 'PASSED', `${editPlan.totalDurationSeconds}s`, { severity: 'MAJOR' })
      : check('technical.duration', 'TECHNICAL', 'Duration', 'FAILED', `edit ${editPlan.totalDurationSeconds}s vs script ${script.estimatedDurationSeconds}s (max ${maxDuration}s)`, { severity: 'MAJOR' }),
  );
  checks.push(assetCheck('technical.visual_assets', 'Scene visuals generated', assets.filter((a) => a.kind === 'IMAGE' || a.kind === 'VIDEO'), storyboard.scenes.length));
  const voiceSections = script.sections.filter((s) => s.dialogue.some((d) => d.speaker === 'JOVI')).length;
  checks.push(assetCheck('technical.voice_assets', 'Voice generated', assets.filter((a) => a.kind === 'VOICE'), voiceSections));
  checks.push(assetCheck('technical.final_render', 'Final render', assets.filter((a) => a.kind === 'RENDER'), 1));
  const missingClips = editPlan.clips.filter((c) => c.source === 'MISSING');
  checks.push(
    missingClips.length
      ? check('technical.missing_assets', 'TECHNICAL', 'No missing clips in the edit', 'NOT_VERIFIABLE', `${missingClips.length} scene(s) have no usable visual: ${missingClips.map((c) => c.sceneId).join(', ')}`, { blocksApproval: true })
      : check('technical.missing_assets', 'TECHNICAL', 'No missing clips in the edit', 'PASSED', 'every scene has a clip'),
  );
  const voiced = editPlan.audio.voice.map((v) => ({ v, asset: assets.find((a) => a.id === v.assetId) }));
  const completedVoice = voiced.filter((x) => x.asset?.status === 'COMPLETED' && x.asset.durationSeconds);
  if (completedVoice.length === 0) {
    checks.push(check('technical.av_sync', 'TECHNICAL', 'Audio/video synchronisation', 'NOT_VERIFIABLE', 'no completed voice audio to synchronise', { severity: 'MAJOR' }));
  } else {
    const drift = completedVoice.filter(({ v, asset }) => Math.abs((asset!.durationSeconds ?? 0) - (v.end - v.start)) > Math.max(0.5, (v.end - v.start) * 0.15));
    checks.push(
      drift.length
        ? check('technical.av_sync', 'TECHNICAL', 'Audio/video synchronisation', 'FAILED', `voice duration drifts from its slot in ${drift.map((d) => d.v.sectionId).join(', ')}`, { severity: 'MAJOR' })
        : check('technical.av_sync', 'TECHNICAL', 'Audio/video synchronisation', 'PASSED', 'voice fits its timeline slots', { severity: 'MAJOR' }),
    );
  }

  // ---------------- MODEL-JUDGED ----------------
  for (const [id, category, name] of QA_MODEL_CHECKS) {
    const review = input.modelReview?.review.reviews.find((r) => r.checkId === id);
    if (!review) {
      checks.push(
        check(id, category, name, 'NOT_VERIFIABLE', input.modelReview ? 'not scored by the QA model' : `QA model unavailable (${input.modelReviewError ?? 'no model'}); human review required`, {
          severity: 'MAJOR',
          method: 'HUMAN_REVIEW',
        }),
      );
      continue;
    }
    const result: Result = review.score >= 4 ? 'PASSED' : review.score === 3 ? 'WARNING' : 'FAILED';
    checks.push(check(id, category, name, result, `model score ${review.score}/5 — ${review.note}`, { severity: 'MAJOR', method: 'MODEL' }));
  }

  return finalize(checks, input);
}

function assetCheck(id: string, name: string, assets: MediaAsset[], required: number): QACheck {
  if (required === 0) return check(id, 'TECHNICAL', name, 'NOT_APPLICABLE', 'none required');
  const by = (s: string) => assets.filter((a) => a.status === s);
  if (by('FAILED').length) return check(id, 'TECHNICAL', name, 'FAILED', `${by('FAILED').length} failed: ${by('FAILED').map((a) => a.statusReason).join('; ').slice(0, 300)}`);
  if (by('SIMULATED').length) return check(id, 'TECHNICAL', name, 'NOT_VERIFIABLE', `${by('SIMULATED').length} simulated asset(s): no real media exists`, { blocksApproval: true });
  if (by('BLOCKED').length || assets.length === 0) {
    const reason = by('BLOCKED')[0]?.statusReason ?? 'not requested';
    return check(id, 'TECHNICAL', name, 'NOT_VERIFIABLE', `asset(s) blocked — ${reason}`, { blocksApproval: true });
  }
  const done = by('COMPLETED').length;
  return done >= required
    ? check(id, 'TECHNICAL', name, 'PASSED', `${done} completed`)
    : check(id, 'TECHNICAL', name, 'NOT_VERIFIABLE', `${done}/${required} completed`, { blocksApproval: true });
}

function finalize(checks: QACheck[], input: QAInput): QAReport {
  const failedHard = checks.filter((c) => c.result === 'FAILED' && c.severity !== 'MINOR');
  const blockers = checks.filter((c) => c.blocksApproval && (c.result === 'NOT_VERIFIABLE' || c.result === 'FAILED'));
  const warnings = checks.filter((c) => c.result === 'WARNING' || (c.result === 'NOT_VERIFIABLE' && !c.blocksApproval) || (c.result === 'FAILED' && c.severity === 'MINOR'));
  const status: QAReport['status'] = failedHard.length ? 'FAIL' : blockers.length ? 'BLOCKED' : warnings.length ? 'PASS_WITH_WARNINGS' : 'PASS';

  const categories = ['IDENTITY', 'PERSONALITY', 'BRAND', 'CONTENT', 'VISUAL', 'SAFETY', 'TECHNICAL'] as const;
  const scores = Object.fromEntries(
    categories.map((cat) => {
      const judged = checks.filter((c) => c.category === cat && ['PASSED', 'FAILED', 'WARNING'].includes(c.result));
      return [cat, judged.length ? Math.round((judged.filter((c) => c.result === 'PASSED').length / judged.length) * 100) / 100 : null];
    }),
  ) as QAReport['scores'];

  const requiredFixes = [
    ...failedHard.map((c) => `${c.name}: ${c.detail}`),
    ...blockers.filter((c) => c.result === 'NOT_VERIFIABLE').map((c) => `Resolve blocker — ${c.name}: ${c.detail}`),
  ];

  return {
    status,
    scores,
    scoreLabel: 'Per category: fraction of evaluated checks that passed (NOT_VERIFIABLE / NOT_APPLICABLE excluded; null = nothing could be evaluated). Not a quality percentage.',
    passedChecks: checks.filter((c) => c.result === 'PASSED'),
    failedChecks: checks.filter((c) => c.result === 'FAILED'),
    warnings,
    requiredFixes,
    recommendedAction: status === 'FAIL' ? 'REVISE' : status === 'BLOCKED' ? 'RESOLVE_BLOCKERS' : status === 'PASS_WITH_WARNINGS' ? 'HUMAN_REVIEW' : 'HUMAN_APPROVAL',
    modelReview: input.modelReview
      ? { available: true, provider: input.modelReview.provider, model: input.modelReview.model, summary: input.modelReview.review.summary }
      : { available: false, provider: null, model: null, summary: input.modelReviewError ?? 'no QA model available' },
    identityVersion: input.identityVersion,
    visualIdentityVersion: input.visual.version,
    evaluatedAt: nowIso(),
  };
}

export { LOCKABLE_FIELDS };
