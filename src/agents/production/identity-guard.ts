import { InvalidModelOutputError } from '../../core/errors.js';
import type { JoviIdentity } from '../../core/identity/identity-schema.js';
import { EXPLICIT, HUMAN_CLAIM, findViolation } from '../../models/evaluator/rule-checks.js';

/**
 * Structural identity preservation for creative output. Applied inside the
 * model parse step, so a violating output is rejected (then repaired or
 * routed elsewhere) before it can be persisted — prompts alone are not trusted.
 *
 * These checks are HEURISTIC: they catch common phrasings and paraphrases but
 * cannot prove compliance. The pre-generation safety gate (safety-review)
 * adds an independent model-graded review before any media is generated.
 */

/** Numbers as digits or English words (e.g. "19", "nineteen", "twenty-five"). */
const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUMBER = `(\\d{1,2}|(?:${Object.keys(TENS).join('|')})(?:[- ](?:${UNITS.slice(1, 10).join('|')}))?|${UNITS.slice(1).sort((a, b) => b.length - a.length).join('|')})`;

/** Parses a NUMBER match ("16", "sixteen", "twenty-five"). */
export function parseNumber(token: string): number | null {
  const t = token.toLowerCase().trim();
  if (/^\d+$/.test(t)) return Number(t);
  const [tens, unit] = t.split(/[- ]/);
  if (tens && tens in TENS) return TENS[tens]! + (unit ? UNITS.indexOf(unit) : 0);
  const i = UNITS.indexOf(t);
  return i >= 0 ? i : null;
}

/** "I'm 19", "she is nineteen", "aged 16", "turning seventeen". */
const AGE_CLAIM = new RegExp(`\\b(?:i'?m|i am|she'?s|she is|jovi is|jovi,?|aged?|turning|turned)\\s+${NUMBER}\\b(?:\\s*(?:years?[- ]old|years? young|y\\/?o))?`, 'gi');
/** "a 16 year old girl", "17-year-old version of me" — an age attached to a person, without a subject. */
const PERSON_AGE = new RegExp(
  `\\b${NUMBER}[- ]?(?:years?|yrs?)[- ]old\\b(?:[\\s,-]+[a-z']+){0,2}?[\\s,-]+(?:girls?|boys?|kids?|child(?:ren)?|teens?|teenagers?|students?|daughters?|sons?|models?|wom[ae]n|person|people|influencers?|versions?|selves|self|me|her|she|jovi)\\b`,
  'gi',
);
/** Minor and youth descriptors, including school context. */
const MINOR_DESCRIPTOR =
  /\b(teens?|teen(?:age|ager|agers)|tween(?:s|age|ager|agers)?|pre-?teens?|school-?girls?|school ?uniforms?|under-?age|minors|minor(?=\s*(?:[.,;!?)]|$))|child(?:like|ish|hood photo)?|children|kids?|little girls?|young girls?|high[- ]school(?:ers?)?|middle[- ]school(?:ers?)?|primary school|elementary school|juvenile|adolescen(?:t|ts|ce)|jailbait|barely legal|loli\w*)\b/i;
/** Origin claims; the place must be capitalised (a proper noun). */
const ORIGIN_CLAIM =
  /\b(?:(?:[Ii]'?m|[Ii] am|[Ss]he'?s|[Ss]he is|[Jj]ovi is)\s+(?:originally\s+)?from|[Bb]orn(?:\s+and\s+(?:raised|bred))?\s+in|[Gg]rew\s+up\s+in|[Rr]aised\s+in|[Hh]ometown(?:\s+is)?)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)/g;
/** Generic country synonyms (data, not identity facts). */
const PLACE_SYNONYMS: Record<string, string[]> = {
  uk: ['united kingdom', 'britain', 'great britain', 'england'],
  us: ['usa', 'united states', 'america'],
};

/** Places consistent with the active identity's origin (e.g. "London, UK" → london, uk, britain, …). */
function allowedPlaces(origin: string): string[] {
  const parts = origin
    .toLowerCase()
    .split(/[,/]/)
    .map((p) => p.trim())
    .filter(Boolean);
  return [origin.toLowerCase(), ...parts, ...parts.flatMap((p) => PLACE_SYNONYMS[p] ?? [])];
}

/** Real-person likeness / impersonation markers (in positive prompts or content). */
export const LIKENESS = /\b(looks? like|look-?alike|resembl\w*|doppelg[aä]nger|in the (?:style|likeness) of|impersonat\w*|deepfake|face ?swap|celebrity)\b/i;

export interface IdentityViolation {
  rule: 'AI_TRANSPARENCY' | 'AGE' | 'ORIGIN' | 'MINOR_DEPICTION' | 'REAL_PERSON_LIKENESS' | 'EXPLICIT';
  match: string;
}

export function findIdentityViolations(texts: readonly string[], identity: JoviIdentity, options: { likeness?: boolean } = {}): IdentityViolation[] {
  const joined = texts.filter(Boolean).join('\n');
  const violations: IdentityViolation[] = [];

  const human = findViolation(joined, HUMAN_CLAIM);
  if (human) violations.push({ rule: 'AI_TRANSPARENCY', match: human });

  for (const m of joined.matchAll(AGE_CLAIM)) {
    const age = parseNumber(m[1] ?? '');
    if (age !== null && age !== identity.age && age >= 5) violations.push({ rule: age < 21 ? 'MINOR_DEPICTION' : 'AGE', match: m[0] });
  }
  for (const m of joined.matchAll(PERSON_AGE)) {
    const age = parseNumber(m[1] ?? '');
    if (age !== null && age < 21) violations.push({ rule: 'MINOR_DEPICTION', match: m[0] });
  }

  const minor = findViolation(joined, MINOR_DESCRIPTOR);
  if (minor) violations.push({ rule: 'MINOR_DEPICTION', match: minor });

  // Derived from the active identity version (no hard-coded origin facts).
  const allowed = allowedPlaces(identity.origin);
  for (const m of joined.matchAll(ORIGIN_CLAIM)) {
    const place = (m[1] ?? '').toLowerCase();
    if (!allowed.some((o) => o === place || o.startsWith(`${place} `) || o.endsWith(` ${place}`))) violations.push({ rule: 'ORIGIN', match: m[0] });
  }

  const explicit = findViolation(joined, EXPLICIT);
  if (explicit) violations.push({ rule: 'EXPLICIT', match: explicit });

  if (options.likeness) {
    const likeness = findViolation(joined, LIKENESS);
    if (likeness) violations.push({ rule: 'REAL_PERSON_LIKENESS', match: likeness });
  }
  return violations;
}

/**
 * R-11: checks for human-entered visual identity anchors (face, hair, body,
 * style, aesthetic…). Real-person likeness, minor descriptors, ages under 21
 * and explicit content are refused. Negated phrasing ("not resembling any
 * real person", "never explicit") is allowed. Heuristic, like the rest.
 */
export function findAppearanceViolations(texts: readonly string[]): IdentityViolation[] {
  const joined = texts.filter(Boolean).join('\n');
  const violations: IdentityViolation[] = [];
  const likeness = findViolation(joined, LIKENESS);
  if (likeness) violations.push({ rule: 'REAL_PERSON_LIKENESS', match: likeness });
  const minor = findViolation(joined, MINOR_DESCRIPTOR);
  if (minor) violations.push({ rule: 'MINOR_DEPICTION', match: minor });
  for (const pattern of [AGE_CLAIM, PERSON_AGE]) {
    for (const m of joined.matchAll(pattern)) {
      const age = parseNumber(m[1] ?? '');
      if (age !== null && age >= 5 && age < 21) violations.push({ rule: 'MINOR_DEPICTION', match: m[0] });
    }
  }
  const explicit = findViolation(joined, EXPLICIT);
  if (explicit) violations.push({ rule: 'EXPLICIT', match: explicit });
  return violations;
}

/** Throws (→ router repair/fallback) when creative text contradicts Jovi's immutable identity. */
export function assertIdentityPreserved(texts: readonly string[], identity: JoviIdentity, options: { likeness?: boolean } = {}): void {
  const violations = findIdentityViolations(texts, identity, options);
  if (violations.length) {
    throw new InvalidModelOutputError(
      `output contradicts Jovi's immutable identity: ${violations.map((v) => `${v.rule} ("${v.match}")`).join('; ')}. ` +
        `Jovi is ${identity.age}, from ${identity.origin}, openly AI, an original fictional character; fix these without changing her identity.`,
    );
  }
}
