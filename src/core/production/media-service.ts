import type { Logger } from '../config/logger.js';
import { errorMessage, isRetryable, serializeError } from '../errors.js';
import type { CorrelationScope } from '../events/event-bus.js';
import type { MediaInspector } from '../../media/media-inspector.js';
import type { MediaProviderRegistry } from '../../media/media-provider-registry.js';
import type { MediaStore } from '../../media/media-store.js';
import type {
  AnyMediaProvider,
  AspectRatio,
  ImageGenerationRequest,
  MediaGenerationResult,
  MediaPreferences,
  MediaRequirements,
  RenderRequest,
  VideoGenerationRequest,
  VoiceGenerationRequest,
} from '../../media/types.js';
import type { MediaKind, PrivacyRequirement } from '../../types/enums.js';
import type { AssetService, MediaAsset } from './asset-service.js';

type Payload<R> = Omit<R, 'assetId' | 'productionId'>;

export interface MediaJob<R> {
  productionId: string;
  sceneId: string | null;
  aspectRatio: AspectRatio | null;
  sourceAssetIds?: string[];
  /** Hard requirements beyond the aspect ratio (duration, language, privacy). */
  requirements?: Omit<MediaRequirements, 'aspectRatio'>;
  /** Soft preferences used to order capable providers. */
  preferences?: MediaPreferences;
  request: Payload<R>;
}

interface Attempt {
  provider: string;
  attempts: number;
  error: string;
}

/**
 * The only code path that calls media providers. For each requested asset it
 * drives the lifecycle REQUESTED → QUEUED → GENERATING → COMPLETED/FAILED
 * (or BLOCKED when no capable provider is available, SIMULATED in simulation).
 *
 * Provider choice is capability-based (MediaProviderRegistry.candidates).
 * Each candidate gets up to `maxAttempts` tries for retryable errors; when a
 * candidate fails the next capable one is tried (MEDIA_PROVIDER_FALLBACK).
 *
 * "No fake success" is structural: an asset becomes COMPLETED only if a real
 * (non-MOCK) provider returned an https URL or a file inside the media store
 * that the MediaInspector verifies as media of the right kind. The measured
 * duration/dimensions replace whatever the provider claimed.
 */
export class MediaService {
  constructor(
    private readonly registry: MediaProviderRegistry,
    private readonly assets: AssetService,
    private readonly store: MediaStore,
    private readonly inspector: MediaInspector,
    private readonly logger: Logger,
    private readonly maxAttempts: number,
  ) {}

  generateImage(job: MediaJob<ImageGenerationRequest>, scope: CorrelationScope) {
    return this.generate('IMAGE', job, scope, (p, request) => (p as Extract<AnyMediaProvider, { mediaKind: 'IMAGE' }>).generateImage(request as ImageGenerationRequest));
  }

  generateVideo(job: MediaJob<VideoGenerationRequest>, scope: CorrelationScope) {
    return this.generate('VIDEO', job, scope, (p, request) => {
      const provider = p as Extract<AnyMediaProvider, { mediaKind: 'VIDEO' }>;
      const video = request as VideoGenerationRequest;
      // Source images only go to providers that can animate them.
      return provider.generateVideo(provider.capabilities().imageToVideo ? video : { ...video, sourceImages: [] });
    });
  }

  generateVoice(job: MediaJob<VoiceGenerationRequest>, scope: CorrelationScope) {
    return this.generate('VOICE', job, scope, (p, request) => (p as Extract<AnyMediaProvider, { mediaKind: 'VOICE' }>).synthesizeSpeech(request as VoiceGenerationRequest));
  }

  renderEdit(job: MediaJob<RenderRequest>, scope: CorrelationScope) {
    return this.generate('RENDER', job, scope, (p, request) => (p as Extract<AnyMediaProvider, { mediaKind: 'RENDER' }>).renderEdit(request as RenderRequest));
  }

  /** Whether the primary video provider for this request animates source images (drives pipeline ordering). */
  async videoNeedsSourceImages(aspectRatio: AspectRatio, privacy?: PrivacyRequirement): Promise<boolean> {
    const { provider } = await this.registry.select('VIDEO', { aspectRatio, ...(privacy ? { privacy } : {}) }, { imageToVideo: true });
    return provider?.capabilities().imageToVideo ?? false;
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
    const requirements: MediaRequirements = { ...(job.requirements ?? {}), ...(job.aspectRatio ? { aspectRatio: job.aspectRatio } : {}) };
    const selection = await this.registry.candidates(kind, requirements, job.preferences ?? {});
    const [primary] = selection.candidates;
    if (!primary) {
      // A missing provider never becomes a fake asset: the asset is BLOCKED with the reason.
      return this.assets.transition(asset.id, 'BLOCKED', { statusReason: selection.reason, metadata: { excluded: selection.excluded } }, scope);
    }

    asset = this.assets.transition(asset.id, 'QUEUED', this.providerFields(primary, job.request), scope);
    asset = this.assets.transition(asset.id, 'GENERATING', {}, scope);

    const history: Attempt[] = [];
    let lastError: unknown;
    for (const [index, provider] of selection.candidates.entries()) {
      if (index > 0) {
        asset = this.assets.annotate(asset.id, this.providerFields(provider, job.request));
        scope.emit('MEDIA_PROVIDER_FALLBACK', 'production.media', asset.id, {
          productionId: job.productionId,
          kind,
          from: selection.candidates[index - 1]!.id,
          to: provider.id,
          reason: history.at(-1)?.error ?? null,
        });
      }
      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        try {
          const result = await call(provider, { ...(job.request as object), assetId: asset.id, productionId: job.productionId });
          const outcome = await this.finish(asset, provider, result, attempt, history, scope);
          if (outcome.done) return outcome.asset;
          lastError = new Error(outcome.error);
          history.push({ provider: provider.id, attempts: attempt, error: outcome.error });
          break; // unverifiable output: try the next provider rather than the same one again
        } catch (error) {
          lastError = error;
          this.logger.warn({ assetId: asset.id, provider: provider.id, attempt, err: errorMessage(error) }, 'media generation attempt failed');
          if (!isRetryable(error) || attempt === this.maxAttempts) {
            history.push({ provider: provider.id, attempts: attempt, error: errorMessage(error) });
            break;
          }
        }
      }
    }
    return this.assets.transition(
      asset.id,
      'FAILED',
      {
        statusReason: history.map((h) => `${h.provider}: ${h.error}`).join('; ') || errorMessage(lastError),
        attempts: history.reduce((n, h) => n + h.attempts, 0),
        metadata: { error: serializeError(lastError), providerAttempts: history },
      },
      scope,
    );
  }

  private providerFields(provider: AnyMediaProvider, request: unknown) {
    return { provider: provider.id, providerKind: provider.kind, model: provider.supportedModels()[0] ?? null, cost: provider.estimateCost(request) };
  }

  private async finish(
    asset: MediaAsset,
    provider: AnyMediaProvider,
    result: MediaGenerationResult,
    attempts: number,
    history: Attempt[],
    scope: CorrelationScope,
  ): Promise<{ done: true; asset: MediaAsset } | { done: false; error: string }> {
    const totalAttempts = history.reduce((n, h) => n + h.attempts, 0) + attempts;
    const common = {
      model: result.model,
      mimeType: result.mimeType,
      width: result.width ?? null,
      height: result.height ?? null,
      durationSeconds: result.durationSeconds ?? null,
      providerJobId: result.providerJobId ?? null,
      cost: result.cost,
      attempts: totalAttempts,
    };
    if (provider.kind === 'MOCK' || result.status === 'SIMULATED') {
      const asSimulated = { ...common, metadata: { ...result.metadata, providerAttempts: history }, simulated: true, location: result.location, statusReason: 'simulation: no real media generated' };
      return { done: true, asset: this.assets.transition(asset.id, 'SIMULATED', asSimulated, scope) };
    }

    if (/^https:\/\//.test(result.location)) {
      const remote = { ...common, location: result.location, statusReason: null, metadata: { ...result.metadata, verification: 'REMOTE_URL_NOT_INSPECTED', providerAttempts: history } };
      return { done: true, asset: this.assets.transition(asset.id, 'COMPLETED', remote, scope) };
    }
    if (!this.store.holdsFile(result.location)) {
      return { done: false, error: `provider ${provider.id} reported success but no verifiable output exists at ${result.location}` };
    }
    const inspection = await this.inspector.inspect(result.location, asset.kind as MediaKind);
    if (!inspection.ok) {
      return { done: false, error: `provider ${provider.id} output failed verification: ${inspection.reason}` };
    }
    const measured = {
      ...common,
      // Measured values win over provider claims.
      durationSeconds: inspection.durationSeconds ?? common.durationSeconds,
      width: inspection.width ?? common.width,
      height: inspection.height ?? common.height,
      location: result.location,
      statusReason: null,
      metadata: { ...result.metadata, inspection, providerAttempts: history },
    };
    return { done: true, asset: this.assets.transition(asset.id, 'COMPLETED', measured, scope) };
  }
}
