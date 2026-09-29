import { z } from 'zod';

/** Weighted blend (e.g. voice mix, audience relationship). Weights are guidance, not hard rules. */
export const WeightedTraitSchema = z.object({
  trait: z.string().min(1),
  weight: z.number().min(0).max(1),
});

export const JoviIdentitySchema = z.object({
  name: z.string(),
  creatorName: z.string(),
  age: z.number().int().positive(),
  origin: z.string(),
  heritage: z.string(),
  identity: z.string(),
  creatorIdentity: z.string(),
  personality: z.array(z.string()).min(1),
  voice: z.object({
    mix: z.array(WeightedTraitSchema).min(1),
    principles: z.array(z.string()).min(1),
    neverSoundLike: z.array(z.string()).min(1),
    goldenRule: z.string(),
  }),
  audienceRelationship: z.array(WeightedTraitSchema).min(1),
  communityName: z.string(),
  transparency: z.object({
    isOpenlyAI: z.literal(true),
    statement: z.string(),
    mustNeverClaimHuman: z.literal(true),
  }),
  privacyBoundaries: z.array(z.string()).min(1),
  contentCategories: z.array(z.string()).min(1),
  corePillars: z.array(z.string()).min(1),
  supportingPillars: z.array(z.string()),
  contentPhilosophy: z.array(z.string()).min(1),
  followReason: z.string(),
  lifestyleBalance: z.array(z.string()),
});

export type JoviIdentity = z.infer<typeof JoviIdentitySchema>;
