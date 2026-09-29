import { ValidationError, errorMessage } from '../core/errors.js';
import { nowIso } from '../core/ids.js';
import type { MediaKind } from '../types/enums.js';
import type { AnyMediaProvider, AspectRatio, MediaProviderStatus } from './types.js';

/**
 * Registry of media providers (image, video, voice, render).
 *
 * Simulation isolation mirrors the model registry: MOCK media providers can
 * never be registered alongside real ones, so a missing or failing real
 * provider can never be silently replaced by a simulated asset.
 */
export class MediaProviderRegistry {
  private readonly providers: AnyMediaProvider[] = [];

  register(provider: AnyMediaProvider): void {
    const mixes =
      (provider.kind === 'MOCK' && this.providers.some((p) => p.kind !== 'MOCK')) ||
      (provider.kind !== 'MOCK' && this.providers.some((p) => p.kind === 'MOCK'));
    if (mixes) {
      throw new ValidationError(`Refusing to register media provider ${provider.id}: simulated media providers cannot be combined with real ones.`);
    }
    this.providers.push(provider);
  }

  list(kind?: MediaKind): AnyMediaProvider[] {
    return kind ? this.providers.filter((p) => p.mediaKind === kind) : [...this.providers];
  }

  isSimulation(): boolean {
    return this.providers.length > 0 && this.providers.every((p) => p.kind === 'MOCK');
  }

  async statuses(kind?: MediaKind): Promise<MediaProviderStatus[]> {
    return Promise.all(
      this.list(kind).map(async (p) => {
        try {
          return await p.inspectAvailability();
        } catch (error) {
          return {
            provider: p.id,
            kind: p.kind,
            mediaKind: p.mediaKind,
            available: false,
            state: 'MISCONFIGURED' as const,
            reason: `availability check failed: ${errorMessage(error)}`,
            models: [],
            checkedAt: nowIso(),
          };
        }
      }),
    );
  }

  /**
   * First available provider of `kind` supporting the aspect ratio, or the
   * reasons none can be used. Never falls back across kinds or to simulation.
   */
  async select<K extends MediaKind>(
    kind: K,
    aspectRatio?: AspectRatio,
  ): Promise<{ provider: Extract<AnyMediaProvider, { mediaKind: K }> | null; statuses: MediaProviderStatus[]; reason: string }> {
    const candidates = this.list(kind);
    const statuses = await this.statuses(kind);
    if (candidates.length === 0) {
      return { provider: null, statuses, reason: `PROVIDER_NOT_CONFIGURED: no ${kind.toLowerCase()} provider is registered` };
    }
    for (const [index, provider] of candidates.entries()) {
      const status = statuses[index];
      if (!status?.available) continue;
      if (aspectRatio && !provider.supportedAspectRatios().includes(aspectRatio)) continue;
      return { provider: provider as Extract<AnyMediaProvider, { mediaKind: K }>, statuses, reason: status.reason };
    }
    const reasons = statuses.map((s) => `${s.provider}: ${s.state} — ${s.reason}`).join('; ');
    return { provider: null, statuses, reason: `NO_AVAILABLE_${kind}_PROVIDER: ${reasons}` };
  }
}
