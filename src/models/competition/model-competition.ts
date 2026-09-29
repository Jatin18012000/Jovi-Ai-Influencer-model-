import type { ProviderStatus } from '../types.js';

export interface CompetitionAvailability {
  available: boolean;
  distinctModels: string[];
  reason: string;
}

/**
 * Model competition (several models generating for the same task, judged by an
 * independent evaluator) is a later-phase capability. Phase 6 only reports
 * whether it *could* run: it needs at least two distinct real models.
 */
export function assessCompetition(statuses: readonly ProviderStatus[]): CompetitionAvailability {
  const distinctModels = statuses
    .filter((s) => s.available && s.selectedModel && s.kind !== 'MOCK')
    .map((s) => `${s.provider}:${s.selectedModel}`);
  const available = distinctModels.length >= 2;
  return {
    available,
    distinctModels,
    reason: available
      ? `${distinctModels.length} distinct real models available: generator and evaluator can differ`
      : 'model competition unavailable: fewer than two distinct real models available',
  };
}
