import { z } from 'zod';
import { AspectRatio } from '../../media/types.js';
import { AssetStatus, MediaKind, PrivacyRequirement, QAStatus } from '../../types/enums.js';
import { ContentFormat } from '../executive/executive-schema.js';

/**
 * Phase 8 contracts. Every creative artifact is Zod-validated; model output
 * that does not match is repaired once and otherwise falls back/fails.
 */

const text = (max: number) => z.string().trim().min(1).max(max);
const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v);

// ---------------------------------------------------------------------------
// Input: a Phase 7 idea (IdeationOutput.ideas[n])
// ---------------------------------------------------------------------------

export const ProductionIdeaSchema = z.object({
  id: text(60),
  title: text(160),
  format: text(80),
  pillar: text(120),
  hook: text(300),
  concept: text(900),
  whyNow: z.string().max(400).default(''),
  personalityTraits: z.array(z.string().max(60)).max(8).default([]),
  audienceValue: z.string().max(400).default(''),
  productionNotes: z.array(z.string().max(250)).max(6).default([]),
});
export type ProductionIdea = z.infer<typeof ProductionIdeaSchema>;

export const ProductionContextSchema = z.object({
  goal: z.string().max(2000).nullable().default(null),
  audience: z.array(z.string().max(300)).max(8).default([]),
  strategy: z.object({
    objective: z.string().max(500),
    guardrails: z.array(z.string().max(300)).max(10).default([]),
    formats: z.array(z.object({ format: z.string(), role: z.string() })).max(8).default([]),
  }),
  privacy: PrivacyRequirement.default('STANDARD'),
});
export type ProductionContext = z.infer<typeof ProductionContextSchema>;

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

export const Pacing = z.preprocess(lower, z.enum(['slow', 'natural', 'fast']));

export const ScriptLineSchema = z.object({
  speaker: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase().replace(/\s+/g, '_') : v), z.enum(['JOVI', 'VOICEOVER'])),
  line: text(400),
  emotion: text(60),
  pacing: Pacing.default('natural'),
});

export const ScriptSectionSchema = z.object({
  sectionId: text(20),
  purpose: text(200),
  durationSeconds: z.coerce.number().min(0.5).max(60),
  dialogue: z.array(ScriptLineSchema).max(8).default([]),
  onScreenText: z.array(z.string().max(120)).max(4).default([]),
  visualIntent: text(400),
});

export const ScriptSchema = z
  .object({
    title: text(160),
    hook: text(300),
    objective: text(400),
    format: ContentFormat,
    estimatedDurationSeconds: z.coerce.number().min(3).max(180),
    language: z.string().min(2).max(10).default('en-GB'),
    sections: z.array(ScriptSectionSchema).min(1).max(12),
    cta: text(200),
    personalityIntent: text(500),
    visualIntent: text(500),
    audioIntent: text(500),
    productionNotes: z.array(z.string().max(250)).max(8).default([]),
  })
  .superRefine((s, ctx) => {
    const ids = s.sections.map((x) => x.sectionId);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['sections'], message: 'sectionIds must be unique' });
  });
export type Script = z.infer<typeof ScriptSchema>;

// ---------------------------------------------------------------------------
// Storyboard
// ---------------------------------------------------------------------------

export const StoryboardSceneSchema = z.object({
  sceneId: text(20),
  sectionId: text(20),
  durationSeconds: z.coerce.number().min(0.5).max(60),
  purpose: text(200),
  location: text(200),
  subject: text(200),
  featuresJovi: z.boolean().default(true),
  joviAppearance: text(400),
  action: text(400),
  camera: text(200),
  framing: text(120),
  lighting: text(200),
  environment: text(300),
  wardrobe: text(300),
  props: z.array(z.string().max(80)).max(8).default([]),
  transition: text(120),
  audioReference: z.string().max(400).default(''),
  onScreenText: z.array(z.string().max(120)).max(4).default([]),
  continuityRequirements: z.array(z.string().max(200)).min(1).max(6),
});
export type StoryboardScene = z.infer<typeof StoryboardSceneSchema>;

export const StoryboardSchema = z
  .object({
    aspectRatio: AspectRatio,
    scenes: z.array(StoryboardSceneSchema).min(1).max(12),
    continuityNotes: z.array(z.string().max(250)).min(1).max(8),
  })
  .superRefine((s, ctx) => {
    const ids = s.scenes.map((x) => x.sceneId);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['scenes'], message: 'sceneIds must be unique' });
  });
export type Storyboard = z.infer<typeof StoryboardSchema>;

// ---------------------------------------------------------------------------
// Visual prompts
// ---------------------------------------------------------------------------

/** What the model writes per scene. Identity/aspect/duration fields are set by the agent, not the model. */
export const VisualPromptDraftSchema = z.object({
  prompts: z
    .array(
      z.object({
        sceneId: text(20),
        imagePrompt: text(1500),
        videoPrompt: text(1500),
        negativePrompt: z.string().max(800).default(''),
        environmentConsistency: text(400),
        wardrobeConsistency: text(400),
        cameraSpecification: text(300),
        lightingSpecification: text(300),
      }),
    )
    .min(1)
    .max(12),
  globalStyle: text(500),
});
export type VisualPromptDraft = z.infer<typeof VisualPromptDraftSchema>;

export const VisualPromptSceneSchema = z.object({
  sceneId: text(20),
  imagePrompt: text(3000),
  videoPrompt: text(3000),
  negativePrompt: text(1500),
  /** Canonical character lock from the active visual identity (never model-authored). */
  characterConsistency: text(1500),
  environmentConsistency: text(400),
  wardrobeConsistency: text(400),
  cameraSpecification: text(300),
  lightingSpecification: text(300),
  aspectRatio: AspectRatio,
  targetDurationSeconds: z.number().min(0.5).max(60),
  featuresJovi: z.boolean(),
});
export type VisualPromptScene = z.infer<typeof VisualPromptSceneSchema>;

export const VisualPromptsSchema = z.object({
  prompts: z.array(VisualPromptSceneSchema).min(1).max(12),
  globalStyle: text(500),
  visualIdentityVersion: z.number().int().positive(),
});
export type VisualPrompts = z.infer<typeof VisualPromptsSchema>;

// ---------------------------------------------------------------------------
// Media agent output (asset summaries — never the assets themselves)
// ---------------------------------------------------------------------------

export const AssetSummarySchema = z.object({
  assetId: z.string(),
  kind: MediaKind,
  sceneId: z.string().nullable(),
  status: AssetStatus,
  provider: z.string().nullable(),
  reason: z.string().nullable(),
});

export const MediaAgentOutputSchema = z.object({
  kind: MediaKind,
  assets: z.array(AssetSummarySchema),
  counts: z.record(z.string(), z.number().int().nonnegative()),
});
export type MediaAgentOutput = z.infer<typeof MediaAgentOutputSchema>;

// ---------------------------------------------------------------------------
// Edit plan
// ---------------------------------------------------------------------------

const Span = { start: z.number().min(0), end: z.number().min(0) };

export const EditPlanSchema = z.object({
  aspectRatio: AspectRatio,
  totalDurationSeconds: z.number().positive(),
  timeline: z.array(z.object({ sceneId: z.string(), ...Span })).min(1),
  clips: z.array(
    z.object({
      clipId: z.string(),
      sceneId: z.string(),
      source: z.enum(['VIDEO', 'IMAGE', 'MISSING']),
      assetId: z.string().nullable(),
      assetStatus: z.string().nullable(),
      ...Span,
      motion: z.string().nullable(),
    }),
  ),
  transitions: z.array(z.object({ fromSceneId: z.string(), toSceneId: z.string(), type: z.string(), durationSeconds: z.number().min(0) })),
  audio: z.object({
    voice: z.array(z.object({ sectionId: z.string(), assetId: z.string().nullable(), assetStatus: z.string().nullable(), ...Span })),
    music: z.object({ status: z.enum(['NOT_SELECTED', 'SELECTED']), note: z.string() }),
  }),
  captions: z.array(z.object({ ...Span, text: z.string() })),
  textOverlays: z.array(z.object({ ...Span, text: z.string(), position: z.string() })),
  effects: z.array(z.string()),
  exportSettings: z.object({
    container: z.string(),
    videoCodec: z.string(),
    audioCodec: z.string(),
    width: z.number().int(),
    height: z.number().int(),
    fps: z.number().int(),
    bitrateMbps: z.number(),
  }),
  render: z.object({ assetId: z.string().nullable(), status: z.string(), reason: z.string().nullable() }),
});
export type EditPlan = z.infer<typeof EditPlanSchema>;

// ---------------------------------------------------------------------------
// QA
// ---------------------------------------------------------------------------

export const QACategory = z.enum(['IDENTITY', 'PERSONALITY', 'BRAND', 'CONTENT', 'VISUAL', 'SAFETY', 'TECHNICAL']);
export type QACategory = z.infer<typeof QACategory>;

export const QACheckSchema = z.object({
  id: z.string(),
  category: QACategory,
  name: z.string(),
  result: z.enum(['PASSED', 'FAILED', 'WARNING', 'NOT_VERIFIABLE', 'NOT_APPLICABLE']),
  severity: z.enum(['BLOCKING', 'MAJOR', 'MINOR']),
  method: z.enum(['DETERMINISTIC', 'MODEL', 'HUMAN_REVIEW']),
  detail: z.string(),
  /** A NOT_VERIFIABLE/FAILED result with this flag prevents human approval. */
  blocksApproval: z.boolean(),
});
export type QACheck = z.infer<typeof QACheckSchema>;

export const QAReportSchema = z.object({
  status: QAStatus,
  scores: z.record(QACategory, z.number().min(0).max(1).nullable()),
  scoreLabel: z.string(),
  passedChecks: z.array(QACheckSchema),
  failedChecks: z.array(QACheckSchema),
  warnings: z.array(QACheckSchema),
  requiredFixes: z.array(z.string()),
  recommendedAction: z.enum(['HUMAN_APPROVAL', 'HUMAN_REVIEW', 'REVISE', 'RESOLVE_BLOCKERS']),
  modelReview: z.object({ available: z.boolean(), provider: z.string().nullable(), model: z.string().nullable(), summary: z.string() }),
  identityVersion: z.number().int(),
  visualIdentityVersion: z.number().int(),
  evaluatedAt: z.string(),
});
export type QAReport = z.infer<typeof QAReportSchema>;

/** What the QA model returns (subjective, model-judged checks only). */
export const QA_MODEL_CHECKS = [
  ['personality.tone', 'PERSONALITY', 'Tone matches Jovi'],
  ['personality.dialogue', 'PERSONALITY', 'Dialogue sounds like Jovi'],
  ['personality.behavior', 'PERSONALITY', 'Behaviour consistent with personality'],
  ['brand.voice', 'BRAND', 'Jovi voice (never an AI writing a caption)'],
  ['brand.audience_fit', 'BRAND', 'Audience fit'],
  ['content.hook', 'CONTENT', 'Hook strength (first 1–3 seconds)'],
  ['content.narrative', 'CONTENT', 'Narrative coherence'],
  ['content.pacing', 'CONTENT', 'Pacing'],
  ['content.originality', 'CONTENT', 'Originality vs generic influencer templates'],
] as const;

export const QAModelReviewSchema = z.object({
  reviews: z
    .array(
      z.object({
        checkId: z.enum(QA_MODEL_CHECKS.map((c) => c[0]) as [string, ...string[]]),
        score: z.coerce.number().int().min(1).max(5),
        note: z.string().max(400).default(''),
      }),
    )
    .min(1),
  summary: z.string().max(800),
});
export type QAModelReview = z.infer<typeof QAModelReviewSchema>;
