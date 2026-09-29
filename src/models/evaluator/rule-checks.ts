import { z } from 'zod';

/** Loose option shape so the evaluator can assess any content option. */
export const EvaluableOptionSchema = z.looseObject({
  id: z.coerce.string().min(1),
  title: z.string().min(1),
  concept: z.string().min(1),
  pillar: z.string().optional(),
  format: z.string().optional(),
  hook: z.string().optional(),
  structure: z.array(z.string()).optional(),
  personalityTraits: z.array(z.string()).optional(),
});
export type EvaluableOption = z.infer<typeof EvaluableOptionSchema>;

export type RuleOutcome = 'PASS' | 'WARN' | 'FAIL';

export interface RuleCheck {
  rule: string;
  outcome: RuleOutcome;
  detail: string;
}

interface Rule {
  rule: string;
  /** FAIL blocks an option from selection. */
  check(text: string, option: EvaluableOption, knownPillars: readonly string[]): RuleCheck;
}

const HUMAN_CLAIM = /\b(i'?m|i am|as) (a )?(real|actual) (person|human|girl|woman)\b|\b(i'?m|i am) (not (an? )?(ai|bot|robot)|human)\b|\bnot an ai\b/i;
const PRIVACY = [
  /\b(my|her) (home )?address\b/i,
  /\bwhere (i|she) (actually )?lives?\b/i,
  /\b(my|her) (mum|mom|dad|father|mother|brother|sister|parents|family) (is|are|lives?|works?)\b/i,
  /\b(my|her) (boyfriend|girlfriend|partner|husband|ex)\b/i,
  /\b(my|her) (salary|bank balance|net worth|income|savings)\b/i,
];
const EXPLICIT = /\b(nude|nudity|explicit|nsfw|onlyfans|x-rated|porn)\b/i;
const CLICHES = [
  'rise and grind',
  'no days off',
  'living my best life',
  'embark on a journey',
  "in today's fast-paced world",
  'unlock your potential',
  'elevate your',
  "let's dive in",
  'game-changer',
  'game changer',
  'delve into',
  'tapestry',
  'unleash your',
  'hustle culture',
  'boss babe',
  'good vibes only',
];

const RULES: Rule[] = [
  {
    rule: 'AI_TRANSPARENCY',
    check: (text) =>
      HUMAN_CLAIM.test(text)
        ? { rule: 'AI_TRANSPARENCY', outcome: 'FAIL', detail: 'Content implies Jovi is human; she is openly AI.' }
        : { rule: 'AI_TRANSPARENCY', outcome: 'PASS', detail: 'No false claim of being human.' },
  },
  {
    rule: 'PRIVACY_BOUNDARIES',
    check: (text) => {
      const hit = PRIVACY.find((re) => re.test(text));
      return hit
        ? { rule: 'PRIVACY_BOUNDARIES', outcome: 'FAIL', detail: `Touches a private area (${hit.source}).` }
        : { rule: 'PRIVACY_BOUNDARIES', outcome: 'PASS', detail: 'No private family/location/relationship/finance details.' };
    },
  },
  {
    rule: 'PLATFORM_SAFETY',
    check: (text) =>
      EXPLICIT.test(text)
        ? { rule: 'PLATFORM_SAFETY', outcome: 'FAIL', detail: 'Explicit content is outside platform and brand guidelines.' }
        : { rule: 'PLATFORM_SAFETY', outcome: 'PASS', detail: 'No explicit content markers.' },
  },
  {
    rule: 'VOICE_CLICHES',
    check: (text) => {
      const lower = text.toLowerCase();
      const found = CLICHES.filter((c) => lower.includes(c));
      return found.length
        ? { rule: 'VOICE_CLICHES', outcome: 'WARN', detail: `Generic/cliché phrasing: ${found.join(', ')}.` }
        : { rule: 'VOICE_CLICHES', outcome: 'PASS', detail: 'No known cliché phrasing.' };
    },
  },
  {
    rule: 'PILLAR_ALIGNMENT',
    check: (_text, option, knownPillars) => {
      if (!option.pillar) return { rule: 'PILLAR_ALIGNMENT', outcome: 'WARN', detail: 'No content pillar declared.' };
      const p = option.pillar.toLowerCase();
      const match = knownPillars.find((k) => {
        const kl = k.toLowerCase();
        return kl === p || kl.includes(p) || p.includes(kl.split(' ')[0] ?? kl);
      });
      return match
        ? { rule: 'PILLAR_ALIGNMENT', outcome: 'PASS', detail: `Maps to pillar "${match}".` }
        : { rule: 'PILLAR_ALIGNMENT', outcome: 'WARN', detail: `Pillar "${option.pillar}" is not one of Jovi's pillars.` };
    },
  },
  {
    rule: 'PERSONALITY_PRESENT',
    check: (_text, option) =>
      option.personalityTraits && option.personalityTraits.length > 0
        ? { rule: 'PERSONALITY_PRESENT', outcome: 'PASS', detail: `Expresses: ${option.personalityTraits.slice(0, 4).join(', ')}.` }
        : { rule: 'PERSONALITY_PRESENT', outcome: 'WARN', detail: 'No explicit personality traits — risk of generic content.' },
  },
];

export function runRuleChecks(option: EvaluableOption, knownPillars: readonly string[]): RuleCheck[] {
  const text = JSON.stringify(option);
  return RULES.map((r) => r.check(text, option, knownPillars));
}

export function isBlocked(checks: readonly RuleCheck[]): boolean {
  return checks.some((c) => c.outcome === 'FAIL');
}
