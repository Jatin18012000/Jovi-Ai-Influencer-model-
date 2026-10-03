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
  check(content: string, option: EvaluableOption, knownPillars: readonly string[]): RuleCheck;
}

/**
 * Only content that would actually be *published or performed* is scanned.
 * `risks`, `originalityNote` and similar meta fields describe safeguards
 * ("keep it non-explicit", "never reveal her address") and must never be
 * treated as violations.
 */
const CONTENT_FIELDS = ['title', 'hook', 'concept', 'structure', 'audienceValue', 'caption', 'script', 'onScreenText'] as const;

export function contentText(option: EvaluableOption): string {
  const record = option as Record<string, unknown>;
  return CONTENT_FIELDS.map((field) => record[field])
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

/** Negation / safeguard cues in the same sentence before a match ("never", "avoid", "no", "non-"…). */
const NEGATION_BEFORE =
  /\b(no|not|non|never|avoid(s|ed|ing)?|without|don'?t|doesn'?t|do not|does not|must not|mustn'?t|won'?t|shouldn'?t|refus(e|es|ing)|instead of|rather than|free of|zero)\b|non-\s*$/i;
/** Safeguard cues right after a privacy mention ("… stays private"). */
const PRIVATE_AFTER = /^[^.!?;\n]{0,40}\b(private|secret|hidden|off[- ]camera|a mystery|undisclosed|confidential)\b/i;

/**
 * Returns the first match of `pattern` in `text` that is not negated or
 * framed as a safeguard within its sentence, or null.
 */
export function findViolation(text: string, pattern: RegExp, options: { privacySuffix?: boolean } = {}): string | null {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (const match of text.matchAll(global)) {
    const index = match.index ?? 0;
    const before = text.slice(Math.max(0, index - 80), index);
    const sentenceStart = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf(';'), before.lastIndexOf('\n'));
    const prefix = before.slice(sentenceStart + 1);
    if (NEGATION_BEFORE.test(prefix)) continue;
    if (options.privacySuffix && PRIVATE_AFTER.test(text.slice(index + match[0].length))) continue;
    return match[0];
  }
  return null;
}

/**
 * Claims (or implications) that Jovi is human. Heuristic: catches common
 * phrasings and paraphrases ("I am a human", "a real flesh-and-blood woman",
 * "I'm not artificial", "living, breathing person", "100% real"); it cannot
 * prove absence. Negated / safeguard phrasing is skipped by findViolation.
 */
const SUBJECT = "(?:i'?m|i am|she'?s|she is|jovi is|jovi's|as)";
export const HUMAN_CLAIM = new RegExp(
  [
    `\\b${SUBJECT}\\s+(?:an?\\s+)?(?:(?:real|actual|genuine|living|breathing|flesh[- ]and[- ]blood|human)[\\s,-]+){1,4}(?:person|human|girl|woman|being|lady|individual)\\b`,
    `\\b${SUBJECT}\\s+(?:an?\\s+)?human\\b`,
    "\\b(?:i'?m|i am|she'?s|she is|jovi is|jovi's)\\s+(?:not|never|no)\\s+(?:an?\\s+)?(?:ai|a\\.i\\.|artificial|bot|robot|virtual(?!\\s+assistant)|computer|program|machine|algorithm|digital|synthetic)\\b",
    "\\b(?:i'?m|i am|she'?s|she is|jovi is)\\s+(?:100%|totally|completely|fully|actually|really)\\s+(?:real|human)\\b",
    '\\bnot an ai\\b',
  ].join('|'),
  'i',
);
export const PRIVACY = [
  /\b(my|her) (home )?address\b/i,
  /\bwhere (i|she) (actually )?lives?\b/i,
  /\b(my|her) (mum|mom|dad|father|mother|brother|sister|parents|family) (is|are|lives?|works?)\b/i,
  /\b(my|her) (boyfriend|girlfriend|partner|husband|ex)\b/i,
  /\b(my|her) (salary|bank balance|net worth|income|savings)\b/i,
];
export const EXPLICIT = /(?<!non-)\b(nude|nudity|explicit|nsfw|onlyfans|x-rated|porn)\b/i;
export const CLICHES = [
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
    check: (content) => {
      const hit = findViolation(content, HUMAN_CLAIM);
      return hit
        ? { rule: 'AI_TRANSPARENCY', outcome: 'FAIL', detail: `Content implies Jovi is human ("${hit}"); she is openly AI.` }
        : { rule: 'AI_TRANSPARENCY', outcome: 'PASS', detail: 'No false claim of being human.' };
    },
  },
  {
    rule: 'PRIVACY_BOUNDARIES',
    check: (content) => {
      const hit = PRIVACY.map((re) => findViolation(content, re, { privacySuffix: true })).find((m) => m !== null);
      return hit
        ? { rule: 'PRIVACY_BOUNDARIES', outcome: 'FAIL', detail: `Content exposes a private area ("${hit}").` }
        : { rule: 'PRIVACY_BOUNDARIES', outcome: 'PASS', detail: 'No private family/location/relationship/finance details.' };
    },
  },
  {
    rule: 'PLATFORM_SAFETY',
    check: (content) => {
      const hit = findViolation(content, EXPLICIT);
      return hit
        ? { rule: 'PLATFORM_SAFETY', outcome: 'FAIL', detail: `Explicit content ("${hit}") is outside platform and brand guidelines.` }
        : { rule: 'PLATFORM_SAFETY', outcome: 'PASS', detail: 'No explicit content markers.' };
    },
  },
  {
    rule: 'VOICE_CLICHES',
    check: (content) => {
      const lower = content.toLowerCase();
      const found = CLICHES.filter((c) => lower.includes(c));
      return found.length
        ? { rule: 'VOICE_CLICHES', outcome: 'WARN', detail: `Generic/cliché phrasing: ${found.join(', ')}.` }
        : { rule: 'VOICE_CLICHES', outcome: 'PASS', detail: 'No known cliché phrasing.' };
    },
  },
  {
    rule: 'PILLAR_ALIGNMENT',
    check: (_content, option, knownPillars) => {
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
    check: (_content, option) =>
      option.personalityTraits && option.personalityTraits.length > 0
        ? { rule: 'PERSONALITY_PRESENT', outcome: 'PASS', detail: `Expresses: ${option.personalityTraits.slice(0, 4).join(', ')}.` }
        : { rule: 'PERSONALITY_PRESENT', outcome: 'WARN', detail: 'No explicit personality traits — risk of generic content.' },
  },
];

export function runRuleChecks(option: EvaluableOption, knownPillars: readonly string[]): RuleCheck[] {
  const content = contentText(option);
  return RULES.map((r) => r.check(content, option, knownPillars));
}

export function isBlocked(checks: readonly RuleCheck[]): boolean {
  return checks.some((c) => c.outcome === 'FAIL');
}
