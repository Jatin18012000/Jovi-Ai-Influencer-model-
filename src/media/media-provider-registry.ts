import { ValidationError, errorMessage } from '../core/errors.js';
import { nowIso } from '../core/ids.js';
import type { MediaKind } from '../types/enums.js';
import { capabilityMismatch, type AnyMediaProvider, type AspectRatio, type MediaPreferences, type MediaProviderStatus, type MediaRequirements } from './types.js';

export type ProviderOf<K extends MediaKind> = Extract<AnyMediaProvider, { mediaKind: K }>;

export interface MediaSelection<K extends MediaKind> {
  /** Usable providers in the order they should be tried (first = primary, rest = fallbacks). */
  candidates: Array<ProviderOf<K>>;
  statuses: MediaProviderStatus[];
  /** Registered providers that cannot serve this request, with the reason. */
  excluded: Array<{ provider: string; reason: string }>;
  /** Summary: why the first candidate was chosen, or why none can be used. */
  reason: string;
}

/**
 * Registry of media providers (image, video, voice, render).
 *
 * Selection is capability-based: a provider must be AVAILABLE and satisfy
 * the hard requirements (aspect ratio, duration, language, privacy). Capable
 * providers are ordered by the operator's preference list, then by soft
 * preferences (e.g. image-to-video), then LOCAL before CLOUD, then
 * registration order. Later candidates are fallbacks.
 *
 * Simulation isolation mirrors the model registry: MOCK media providers can
 * never be registered alongside real ones, so a missing or failing real
 * provider can never be silently replaced by a simulated asset.
 */
export class MediaProviderRegistry {
  private readonly providers: AnyMediaProvider[] = [];

  constructor(private readonly preference: string[] = []) {}

  register(provider: AnyMediaProvider): void {
    const mixes =
      (provider.kind === 'MOCK' && this.providers.some((p) => p.kind !== 'MOCK')) ||
      (provider.kind !== 'MOCK' && this.providers.some((p) => p.kind === 'MOCK'));
    if (mixes) {
      throw new ValidationError(`Refusing to register media provider ${provider.id}: simulated media providers cannot be combined with real ones.`);
    }
    if (this.providers.some((p) => p.id === provider.id)) throw new ValidationError(`Media provider ${provider.id} is already registered`);
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

  /** All usable providers for a request, in try order, plus why others were excluded. */
  async candidates<K extends MediaKind>(kind: K, requirements: MediaRequirements = {}, preferences: MediaPreferences = {}): Promise<MediaSelection<K>> {
    const registered = this.list(kind);
    const statuses = await this.statuses(kind);
    if (registered.length === 0) {
      return { candidates: [], statuses, excluded: [], reason: `PROVIDER_NOT_CONFIGURED: no ${kind.toLowerCase()} provider is registered` };
    }
    const excluded: MediaSelection<K>['excluded'] = [];
    const usable: Array<{ provider: ProviderOf<K>; index: number }> = [];
    for (const [index, provider] of registered.entries()) {
      const status = statuses[index];
      if (!status?.available) {
        excluded.push({ provider: provider.id, reason: `${status?.state ?? 'UNKNOWN'} — ${status?.reason ?? 'no status'}` });
        continue;
      }
      const mismatch = capabilityMismatch(provider.kind, provider.capabilities(), requirements);
      if (mismatch) {
        excluded.push({ provider: provider.id, reason: `INCAPABLE — ${mismatch}` });
        continue;
      }
      usable.push({ provider: provider as ProviderOf<K>, index });
    }
    const rank = (p: ProviderOf<K>) => {
      const pref = this.preference.indexOf(p.id);
      const caps = p.capabilities();
      const softMisses = (preferences.imageToVideo && !caps.imageToVideo ? 1 : 0) + (preferences.referenceImages && !caps.referenceImages ? 1 : 0);
      return [pref === -1 ? Number.MAX_SAFE_INTEGER : pref, softMisses, p.kind === 'LOCAL' ? 0 : 1];
    };
    usable.sort((a, b) => {
      const ra = rank(a.provider);
      const rb = rank(b.provider);
      for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
      return a.index - b.index;
    });
    const candidates = usable.map((u) => u.provider);
    const reason = candidates.length
      ? `${candidates[0]!.id} selected${candidates.length > 1 ? ` (fallbacks: ${candidates.slice(1).map((c) => c.id).join(', ')})` : ''}`
      : `NO_AVAILABLE_${kind}_PROVIDER: ${excluded.map((e) => `${e.provider}: ${e.reason}`).join('; ')}`;
    return { candidates, statuses, excluded, reason };
  }

  /** The primary candidate (or the reason none can be used). */
  async select<K extends MediaKind>(
    kind: K,
    requirementsOrAspect?: MediaRequirements | AspectRatio,
    preferences: MediaPreferences = {},
  ): Promise<{ provider: ProviderOf<K> | null; statuses: MediaProviderStatus[]; reason: string }> {
    const requirements = typeof requirementsOrAspect === 'string' ? { aspectRatio: requirementsOrAspect } : (requirementsOrAspect ?? {});
    const selection = await this.candidates(kind, requirements, preferences);
    return { provider: selection.candidates[0] ?? null, statuses: selection.statuses, reason: selection.reason };
  }
}
