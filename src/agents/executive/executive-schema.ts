import { z } from 'zod';
import { PermissionLevel, PrivacyRequirement, ProviderKind, RoutingTier } from '../../types/enums.js';

/**
 * Executive Agent contracts.
 *
 * `ExecutiveProposalSchema` validates raw model output. It normalises common
 * model quirks (case, "0.8" strings, 0–100 confidence, string next actions)
 * but never invents content: missing substance fails validation.
 */

const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase().replace(/[\s-]+/g, '_') : v);

const Confidence = z.preprocess((v) => {
  const n = typeof v === 'string' ? Number.parseFloat(v) : v;
  if (typeof n === 'number' && n > 1 && n <= 100) return n / 100;
  return n;
}, z.number().min(0).max(1));

export const ContentFormat = z.preprocess((v) => {
  const s = upper(v);
  if (typeof s !== 'string') return s;
  if (s.includes('REEL') || s.includes('SHORT') || s.includes('VIDEO')) return 'REEL';
  if (s.includes('STOR')) return 'STORY';
  if (s.includes('CAROUSEL')) return 'CAROUSEL';
  if (s.includes('PHOTO') || s.includes('POST') || s.includes('IMAGE')) return 'PHOTO';
  return 'OTHER';
}, z.enum(['REEL', 'STORY', 'CAROUSEL', 'PHOTO', 'OTHER']));

export const ContentOptionSchema = z.object({
  id: z.coerce.string().min(1).max(40),
  title: z.string().min(3).max(160),
  format: ContentFormat,
  pillar: z.string().min(2).max(80),
  hook: z.string().min(3).max(400),
  concept: z.string().min(20).max(2000),
  structure: z.array(z.string().min(1)).min(1).max(12),
  personalityTraits: z.array(z.string()).max(10).default([]),
  audienceValue: z.string().min(3).max(600),
  originalityNote: z.string().max(600).default(''),
  risks: z.array(z.string()).max(10).default([]),
  estimatedEffort: z.preprocess(upper, z.enum(['LOW', 'MEDIUM', 'HIGH'])).default('MEDIUM'),
});
export type ContentOption = z.infer<typeof ContentOptionSchema>;

const NextActionInput = z.union([
  z.string().min(3).transform((action) => ({ action, agent: 'executive' })),
  z.object({
    action: z.string().min(3).max(400),
    agent: z.string().min(1).max(40).default('executive'),
  }),
]);

export const ExecutiveProposalSchema = z
  .object({
    objective: z.string().min(3).max(600),
    interpretation: z.string().min(10).max(1500),
    priorities: z.array(z.string().min(2)).min(1).max(8),
    contentDirection: z.string().min(10).max(1500),
    options: z.array(ContentOptionSchema).min(2).max(5),
    recommendedOptionId: z.coerce.string(),
    rationaleSummary: z.string().min(10).max(1500),
    confidence: Confidence,
    nextActions: z.array(NextActionInput).min(1).max(8),
  })
  .superRefine((value, ctx) => {
    const ids = value.options.map((o) => o.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'option ids must be unique' });
    }
    if (!ids.includes(value.recommendedOptionId)) {
      ctx.addIssue({ code: 'custom', path: ['recommendedOptionId'], message: `must reference one of the option ids (${ids.join(', ')})` });
    }
  });
export type ExecutiveProposal = z.infer<typeof ExecutiveProposalSchema>;

/** JSON shape shown to models. Kept hand-written so it reads like an example, not a spec dump. */
export const EXECUTIVE_PROPOSAL_SHAPE = `{
  "objective": "string — the goal restated as a concrete creator objective",
  "interpretation": "string — what success means for Jovi here (1–3 sentences)",
  "priorities": ["string", "... (1–8)"],
  "contentDirection": "string — the creative direction in Jovi's terms",
  "options": [
    {
      "id": "A",
      "title": "string",
      "format": "REEL | STORY | CAROUSEL | PHOTO",
      "pillar": "one of Jovi's content pillars",
      "hook": "string — the first 1–3 seconds",
      "concept": "string — what happens and why it is unmistakably Jovi",
      "structure": ["beat 1", "beat 2", "..."],
      "personalityTraits": ["trait", "..."],
      "audienceValue": "string — why a new viewer cares",
      "originalityNote": "string — what makes it not a generic influencer idea",
      "risks": ["string"],
      "estimatedEffort": "LOW | MEDIUM | HIGH"
    }
  ],
  "recommendedOptionId": "id of the option you recommend",
  "rationaleSummary": "string — concise, auditable reason for the recommendation (no step-by-step reasoning)",
  "confidence": 0.0,
  "nextActions": [{ "action": "string", "agent": "script | visual | qa | publishing | research | strategy | executive" }]
}`;

// ---------------------------------------------------------------------------
// Agent input / output
// ---------------------------------------------------------------------------

export const ExecutiveInputSchema = z.object({
  goal: z.string().trim().min(5, 'goal must be at least 5 characters').max(2000),
  /** Optional override of the routing tier; otherwise derived from the goal. */
  tier: RoutingTier.optional(),
  /** LOCAL_ONLY keeps generation and evaluation on LM Studio. */
  privacy: PrivacyRequirement.optional(),
  constraints: z.array(z.string().max(300)).max(10).default([]),
});
export type ExecutiveInput = z.infer<typeof ExecutiveInputSchema>;

export const NextActionSchema = z.object({
  action: z.string(),
  agent: z.string(),
  requiredPermission: PermissionLevel,
  status: z.enum(['PROPOSED', 'REQUIRES_APPROVAL']),
  note: z.string().optional(),
});
export type NextAction = z.infer<typeof NextActionSchema>;

export const ModelUsageSchema = z.object({
  purpose: z.string(),
  /** CLOUD API, LOCAL (LM Studio) or MOCK (simulation). */
  executionType: ProviderKind,
  provider: z.string(),
  model: z.string(),
  routingCategory: z.string(),
  routingReason: z.string(),
  fallbackUsed: z.boolean(),
  attempts: z.number().int(),
  latencyMs: z.number(),
  estimatedApiCost: z.number().nullable(),
  executionCostType: z.string(),
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

export const ExecutiveDecisionSchema = z.object({
  decisionId: z.string(),
  objective: z.string(),
  interpretation: z.string(),
  priorities: z.array(z.string()),
  contentDirection: z.string(),
  options: z.array(ContentOptionSchema),
  selectedOption: ContentOptionSchema,
  selection: z.object({
    method: z.enum(['PROPOSER_RECOMMENDATION', 'EVALUATOR_AGREEMENT', 'EVALUATOR_OVERRIDE', 'RULE_OVERRIDE']),
    proposerRecommendedOptionId: z.string(),
    evaluatorRecommendedOptionId: z.string().nullable(),
    note: z.string(),
  }),
  rationaleSummary: z.string(),
  confidence: z.number().min(0).max(1),
  nextActions: z.array(NextActionSchema),
  evaluationSummary: z.string(),
  modelsUsed: z.array(ModelUsageSchema),
});
export type ExecutiveDecision = z.infer<typeof ExecutiveDecisionSchema>;
