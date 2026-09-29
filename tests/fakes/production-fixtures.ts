import { INITIAL_VISUAL_IDENTITY } from '../../src/core/identity/visual-identity.js';
import { mockPlanning, mockProduction } from '../../src/models/providers/mock-creative.js';
import { MockProvider } from '../../src/models/providers/mock-provider.js';
import type { GenerateRequest } from '../../src/models/types.js';

/** Shared fixtures for production pipeline tests (canned text; not real inference). */

export const DIRECT_IDEA = {
  id: 'direct-1',
  title: 'Coffee critic minute',
  format: 'REEL',
  pillar: 'Lifestyle & Everyday Life',
  hook: 'Rating this flat white like it owes me money.',
  concept: 'Jovi reviews one London flat white in fifteen seconds.',
};

/** Voice durations per section of the canned script (s1 3s, s2 8s, s3 4s). */
export const VOICE_DURATIONS = { s1: 3, s2: 8, s3: 4 };

export const LOCKED_PROFILE = {
  ...INITIAL_VISUAL_IDENTITY,
  face: 'oval face, soft jaw',
  hair: 'long dark-brown waves',
  eyes: 'hazel',
  skin: 'warm olive',
  beautyMark: 'small mark above left lip',
  body: 'slim, 170cm',
  signatureStyle: 'camel trench, gold hoops',
};

/** A LOCAL (non-simulation) text-model test double built on the canned creative responses; counts calls per task type. */
export function countingLocalModel(): { model: MockProvider; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const model = new MockProvider({
    id: 'local-double',
    kind: 'LOCAL',
    model: 'local-double-model',
    responder: (r: GenerateRequest) => {
      calls[r.task.type] = (calls[r.task.type] ?? 0) + 1;
      const canned = r.task.type.startsWith('planning.') ? mockPlanning(r.task.type, r.context.prompt) : mockProduction(r.task.type, r.context.prompt);
      if (canned === null) throw new Error(`no canned response for ${r.task.type}`);
      return JSON.stringify(canned);
    },
  });
  return { model, calls };
}
