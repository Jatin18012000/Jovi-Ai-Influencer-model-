import { z } from 'zod';

export const StrategyContentSchema = z.object({
  approach: z.string(),
  approachDescription: z.string(),
  corePillars: z.array(z.string()).min(1),
  supportingPillars: z.array(z.string()),
  formatPriorities: z.array(z.object({ format: z.string(), priority: z.number().int(), role: z.string() })),
  cadence: z.object({ guideline: z.string(), enforcement: z.enum(['GUIDELINE', 'TARGET']) }),
  contentMix: z.object({
    original: z.number().min(0).max(1),
    trend: z.number().min(0).max(1),
    enforcement: z.enum(['GUIDELINE', 'TARGET']),
    note: z.string(),
  }),
  contentPhilosophy: z.array(z.string()),
  guidelines: z.array(z.string()),
});

export type StrategyContent = z.infer<typeof StrategyContentSchema>;
