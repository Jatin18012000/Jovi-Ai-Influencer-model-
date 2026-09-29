import { nowIso } from '../../core/ids.js';
import { MOCK_COST } from '../../models/pricing.js';
import type { MediaKind } from '../../types/enums.js';
import {
  ASPECT_RATIO_SIZES,
  type AspectRatio,
  type EditingRenderProvider,
  type ImageGenerationProvider,
  type ImageGenerationRequest,
  type MediaCapabilities,
  type MediaGenerationResult,
  type MediaProviderStatus,
  type RenderRequest,
  type VideoGenerationProvider,
  type VideoGenerationRequest,
  type VoiceGenerationProvider,
  type VoiceGenerationRequest,
} from '../types.js';

/**
 * SIMULATION ONLY. These providers perform no generation and write no files.
 * They return status SIMULATED with a `simulation://` location, so the asset
 * lifecycle marks them SIMULATED (never COMPLETED) and QA blocks approval.
 * The media registry refuses to mix them with real providers.
 */
abstract class SimulatedMediaProvider {
  readonly kind = 'MOCK' as const;
  abstract readonly id: string;
  abstract readonly mediaKind: MediaKind;

  async inspectAvailability(): Promise<MediaProviderStatus> {
    return {
      provider: this.id,
      kind: this.kind,
      mediaKind: this.mediaKind,
      available: true,
      state: 'AVAILABLE',
      reason: 'SIMULATION: no real media is generated',
      models: ['simulation'],
      checkedAt: nowIso(),
    };
  }

  supportedModels(): string[] {
    return ['simulation'];
  }

  /** Same capability contract as real providers; simulation claims no limits. */
  capabilities(): MediaCapabilities {
    return {
      aspectRatios: ['9:16', '4:5', '1:1', '16:9'] as AspectRatio[],
      maxDurationSeconds: null,
      imageToVideo: this.mediaKind === 'VIDEO',
      referenceImages: this.mediaKind === 'IMAGE',
      languages: null,
      outputFormats: [],
    };
  }

  estimateCost() {
    return MOCK_COST;
  }

  protected simulate(assetId: string, extra: Partial<MediaGenerationResult> = {}): MediaGenerationResult {
    return {
      provider: this.id,
      model: 'simulation',
      status: 'SIMULATED',
      location: `simulation://${this.mediaKind.toLowerCase()}/${assetId}`,
      mimeType: 'application/x-simulated',
      cost: MOCK_COST,
      metadata: { simulated: true },
      ...extra,
    };
  }
}

export class SimulatedImageProvider extends SimulatedMediaProvider implements ImageGenerationProvider {
  readonly id = 'simulated-image';
  readonly mediaKind = 'IMAGE' as const;
  async generateImage(request: ImageGenerationRequest) {
    return this.simulate(request.assetId, ASPECT_RATIO_SIZES[request.aspectRatio]);
  }
}

export class SimulatedVideoProvider extends SimulatedMediaProvider implements VideoGenerationProvider {
  readonly id = 'simulated-video';
  readonly mediaKind = 'VIDEO' as const;
  async generateVideo(request: VideoGenerationRequest) {
    return this.simulate(request.assetId, { ...ASPECT_RATIO_SIZES[request.aspectRatio], durationSeconds: request.durationSeconds });
  }
}

export class SimulatedVoiceProvider extends SimulatedMediaProvider implements VoiceGenerationProvider {
  readonly id = 'simulated-voice';
  readonly mediaKind = 'VOICE' as const;
  async synthesizeSpeech(request: VoiceGenerationRequest) {
    // ~2.6 words per second, a natural speaking pace.
    const words = request.text.split(/\s+/).filter(Boolean).length;
    return this.simulate(request.assetId, { durationSeconds: Math.max(1, Math.round((words / 2.6) * 10) / 10) });
  }
}

export class SimulatedRenderProvider extends SimulatedMediaProvider implements EditingRenderProvider {
  readonly id = 'simulated-render';
  readonly mediaKind = 'RENDER' as const;
  async renderEdit(request: RenderRequest) {
    return this.simulate(request.assetId);
  }
}
