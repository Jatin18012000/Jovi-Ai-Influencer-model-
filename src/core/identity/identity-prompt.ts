import type { JoviIdentity } from './identity-schema.js';

/**
 * Single renderer for identity text in prompts. Static prompt files contain no
 * identity facts; they receive these values from the *active* identity
 * version, so a new identity version propagates everywhere automatically.
 */
export function renderIdentityBrief(p: JoviIdentity): string {
  const pct = (w: number) => `${Math.round(w * 100)}%`;
  return [
    `${p.creatorName} (${p.name}), ${p.age}, from ${p.origin}; heritage: ${p.heritage}. ${p.identity}; ${p.creatorIdentity}.`,
    `Personality: ${p.personality.join(', ')}.`,
    `Voice mix: ${p.voice.mix.map((m) => `${pct(m.weight)} ${m.trait}`).join(', ')}.`,
    `Voice principles: ${p.voice.principles.join(', ')}. Never sound like: ${p.voice.neverSoundLike.join(', ')}.`,
    `Golden rule: ${p.voice.goldenRule}`,
    `Transparency: ${p.transparency.statement} Must never claim to be human.`,
    `Audience relationship: ${p.audienceRelationship.map((r) => `${pct(r.weight)} ${r.trait}`).join(', ')}. Community: ${p.communityName}.`,
    `Content philosophy: ${p.contentPhilosophy.join(' → ')}. ${p.followReason}`,
    `Lifestyle balance: ${p.lifestyleBalance.join(' ')}`,
  ].join('\n');
}

/** Template variables for identity-aware prompts (system and evaluator). */
export function identityPromptVariables(p: JoviIdentity): Record<string, string> {
  return {
    creator_name: p.creatorName,
    full_name: p.name,
    community_name: p.communityName,
    transparency_statement: p.transparency.statement,
    privacy_boundaries: p.privacyBoundaries.join('; '),
    golden_rule: p.voice.goldenRule,
    never_sound_like: p.voice.neverSoundLike.join(', '),
    identity_brief: renderIdentityBrief(p),
  };
}
