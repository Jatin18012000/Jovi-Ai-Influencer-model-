import type { Logger } from '../config/logger.js';
import { errorMessage, isRetryable, serializeError } from '../errors.js';
import type { CorrelationScope } from '../events/event-bus.js';
import type { MediaProviderRegistry } from '../../media/media-provider-registry.js';
import type { MediaStore } from '../../media/media-store.js';
import type {
  AnyMediaProvider,
  AspectRatio,
  ImageGenerationRequest,
  MediaGenerationResult,
  RenderRequest,
  VideoGenerationRequest,
  VoiceGenerationRequest,
} from '../../media/types.js';
import type { MediaKind } from '../../types/enums.js';
import type { AssetService, MediaAsset } from './asset-service.js';

type Payload<R> = Omit<R, 'assetId' | 'productionId'>;

export interface MediaJob<R> {
  productionId: string;
  sceneId: string | null;
  aspectRatio: AspectRatio | null;
  sourceAssetIds?: string[];
  request: Payload<R>;
}

/**
 * The only code path that calls media providers. For each requested asset it
 * drives the lifecycle REQUESTED → QUEUED → GENERATING → COMPLETED/FAILED
 * (or BLOCKED when no provider is available, SIMULATED in simulation mode).
 *
 * "No fake success" is structural: an asset becomes COMPLETED only if a real
 * (non-MOCK) provider returned a result whose output file exists inside the
 * media store (or is a provider https URL).
 */
export class MediaService {
  constructor(
    private readonly registry: MediaProviderRegistry,
    private readonly assets: AssetService,
    private readonly store: MediaStore,
    private readonly logger: Logger,
    private readonly maxAttempts: number,
  ) {}

  generateImage(job: MediaJob<ImageGenerationRequest>, scope: CorrelationScope) {
    return this.generate('IMAGE', job, scope, (p, request) => (p as Extract<AnyMediaProvider, { mediaKind: 'IMAGE' }>).generateImage(request as ImageGenerationRequest));
  }

  generateVideo(job: MediaJob<VideoGenerationRequest>, scope: CorrelationScope) {
    return this.generate('VIDEO', job, scope, (p, request) => (p as Extract<AnyMediaProvider, { mediaKind: 'VIDEO' }>).generateVideo(request as VideoGenerationRequest));
  }

  generateVoice(job: MediaJob<VoiceGenerationRequest>, scope: CorrelationScope) {
    return this.generate('VOICE', job, scope, (p, request) => (p as Extract<AnyMediaProvider, { mediaKind: 'VOICE' }>).synthesizeSpeech(request as VoiceGenerationRequest));
  }

  renderEdit(job: MediaJob<RenderRequest>, scope: CorrelationScope) {
    return this.generate('RENDER', job, scope, (p, request) => (p as Extract<AnyMediaProvider, { mediaKind: 'RENDER' }>).renderEdit(request as RenderRequest));
  }

  /** Whether the selected video provider animates source images (drives pipeline ordering). */
  async videoNeedsSourceImages(aspectRatio: AspectRatio): Promise<boolean> {
    const { provider } = await this.registry.select('VIDEO', aspectRatio);
    return provider?.supportsImageToVideo ?? false;
  }

  private async generate(
    kind: MediaKind,
    job: MediaJob<unknown>,
    scope: CorrelationScope,
    call: (provider: AnyMediaProvider, request: unknown) => Promise<MediaGenerationResult>,
  ): Promise<MediaAsset> {
    let asset = this.assets.create(
      { productionId: job.productionId, kind, sceneId: job.sceneId, request: job.request, aspectRatio: job.aspectRatio, ...(job.sourceAssetIds ? { sourceAssetIds: job.sourceAssetIds } : {}) },
      scope,
    );
    const { provider, reason } = await this.registry.select(kind, job.aspectRatio ?? undefined);
    if (!provider) {
      // A missing provider never becomes a fake asset: the asset is BLOCKED with the reason.
      return this.assets.transition(asset.id, 'BLOCKED', { statusReason: reason }, scope);
    }

    asset = this.assets.transition(
      asset.id,
      'QUEUED',
      { provider: provider.id, providerKind: provider.kind, model: provider.supportedModels()[0] ?? null, cost: provider.estimateCost(job.request) },
      scope,
    );
    asset = this.assets.transition(asset.id, 'GENERATING', {}, scope);

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const result = await call(provider, { ...(job.request as object), assetId: asset.id, productionId: job.productionId });
        return this.finish(asset, provider, result, attempt, scope);
      } catch (error) {
        lastError = error;
        this.logger.warn({ assetId: asset.id, provider: provider.id, attempt, err: errorMessage(error) }, 'media generation attempt failed');
        if (!isRetryable(error)) break;
      }
    }
    return this.assets.transition(
      asset.id,
      'FAILED',
      { statusReason: errorMessage(lastError), attempts: this.maxAttempts, metadata: { error: serializeError(lastError) } },
      scope,
    );
  }

  private finish(asset: MediaAsset, provider: AnyMediaProvider, result: MediaGenerationResult, attempts: number, scope: CorrelationScope): MediaAsset {
    const common = {
      model: result.model,
      mimeType: result.mimeType,
      width: result.width ?? null,
      height: result.height ?? null,
      durationSeconds: result.durationSeconds ?? null,
      providerJobId: result.providerJobId ?? null,
      cost: result.cost,
      attempts,
      metadata: result.metadata,
    };
    if (provider.kind === 'MOCK' || result.status === 'SIMULATED') {
      return this.assets.transition(asset.id, 'SIMULATED', { ...common, simulated: true, location: result.location, statusReason: 'simulation: no real media generated' }, scope);
    }
    const verifiable = this.store.holdsFile(result.location) || /^https:\/\//.test(result.location);
    if (!verifiable) {
      return this.assets.transition(
        asset.id,
        'FAILED',
        { ...common, statusReason: `provider ${provider.id} reported success but no verifiable output exists at ${result.location}` },
        scope,
      );
    }
    return this.assets.transition(asset.id, 'COMPLETED', { ...common, location: result.location, statusReason: null }, scope);
  }
}
