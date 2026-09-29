import { ProviderUnavailableError } from '../../core/errors.js';
import { nowIso } from '../../core/ids.js';
import type { CostEstimate } from '../../models/types.js';
import type { AspectRatio, MediaGenerationResult, MediaProviderStatus, VideoGenerationProvider } from '../types.js';

const UNKNOWN_COST: CostEstimate = { estimatedApiCost: null, executionCostType: 'UNKNOWN', currency: 'USD', basis: 'provider not integrated' };

/**
 * Google Flow adapter slot. Flow is used through Google's web application;
 * this build has no executable, supported API integration for it, so the
 * adapter always reports NOT_INTEGRATED and refuses to generate. It exists so
 * routing, status reporting and a future real adapter share one contract.
 */
export class GoogleFlowVideoProvider implements VideoGenerationProvider {
  readonly id = 'google-flow';
  readonly kind = 'CLOUD' as const;
  readonly mediaKind = 'VIDEO' as const;
  readonly supportsImageToVideo = true;

  async inspectAvailability(): Promise<MediaProviderStatus> {
    return {
      provider: this.id,
      kind: this.kind,
      mediaKind: this.mediaKind,
      available: false,
      state: 'NOT_INTEGRATED',
      reason: 'Google Flow has no executable API integration in this build; videos made in Flow are not produced by Jovi Core.',
      models: [],
      checkedAt: nowIso(),
    };
  }

  supportedModels(): string[] {
    return [];
  }

  supportedAspectRatios(): AspectRatio[] {
    return ['9:16', '16:9'];
  }

  estimateCost(): CostEstimate {
    return UNKNOWN_COST;
  }

  async generateVideo(): Promise<MediaGenerationResult> {
    throw new ProviderUnavailableError(this.id, 'Google Flow is not integrated');
  }
}
