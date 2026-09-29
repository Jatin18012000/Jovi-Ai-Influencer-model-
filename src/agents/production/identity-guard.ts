import { InvalidModelOutputError } from '../../core/errors.js';
import type { JoviIdentity } from '../../core/identity/identity-schema.js';
import { EXPLICIT, HUMAN_CLAIM, findViolation } from '../../models/evaluator/rule-checks.js';

/**
 * Structural identity preservation for creative output. Applied inside the
 * model parse step, so a violating output is rejected (then repaired or
 * routed elsewhere) before it can be persisted — prompts alone are not trusted.
 */

const AGE_CLAIM = /\b(?:i'?m|i am|she'?s|she is|jovi is|jovi,?|aged?)\s+(\d{1,2})\b(?:\s*(?:years?[- ]old|y\/?o))?/gi;
const MINOR_DESCRIPTOR = /\b(teen(?:age|ager)?|schoolgirl|underage|minor|child(?:like)?|little girl|high[- ]school(?:er)?)\b/i;
/** Case-insensitive subject, but the place must be capitalised (a proper noun). */
const ORIGIN_CLAIM = /\b(?:[Ii]'?m|[Ii] am|[Ss]he'?s|[Ss]he is|[Jj]ovi is)\s+from\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)/g;
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
    const age = Number(m[1]);
    if (age && age !== identity.age && age >= 5) violations.push({ rule: 'AGE', match: m[0] });
  }

  const minor = findViolation(joined, MINOR_DESCRIPTOR);
  if (minor) violations.push({ rule: 'MINOR_DEPICTION', match: minor });

  const home = identity.origin.toLowerCase();
  const allowedOrigins = [home, 'london', 'the uk', 'uk', 'england', 'britain', 'the united kingdom'];
  for (const m of joined.matchAll(ORIGIN_CLAIM)) {
    const place = (m[1] ?? '').toLowerCase();
    if (!allowedOrigins.some((o) => o.includes(place) || place.includes(o.replace('the ', '')))) violations.push({ rule: 'ORIGIN', match: m[0] });
  }

  const explicit = findViolation(joined, EXPLICIT);
  if (explicit) violations.push({ rule: 'EXPLICIT', match: explicit });

  if (options.likeness) {
    const likeness = findViolation(joined, LIKENESS);
    if (likeness) violations.push({ rule: 'REAL_PERSON_LIKENESS', match: likeness });
  }
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
