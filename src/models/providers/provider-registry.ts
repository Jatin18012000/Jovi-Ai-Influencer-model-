import { eq, notInArray } from 'drizzle-orm';
import type { Logger } from '../../core/config/logger.js';
import { ValidationError, errorMessage } from '../../core/errors.js';
import { nowIso } from '../../core/ids.js';
import type { JoviDatabase } from '../../database/client.js';
import { models } from '../../database/schema.js';
import { PRICING_PER_MILLION } from '../pricing.js';
import type { ModelProvider, ProviderStatus } from '../types.js';

/**
 * Holds every configured provider, caches availability (short TTL) and keeps
 * the `models` table in sync so model availability is observable.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  private statuses = new Map<string, ProviderStatus>();
  private lastRefresh = 0;
  private inflight: Promise<ProviderStatus[]> | null = null;

  constructor(
    private readonly db: JoviDatabase,
    private readonly logger: Logger,
    private readonly ttlMs: number,
  ) {}

  /**
   * Simulation isolation: the MOCK provider can never be registered alongside
   * real providers, so it can never become a silent production fallback.
   */
  register(provider: ModelProvider): void {
    const existing = this.list();
    const mixesMock =
      (provider.kind === 'MOCK' && existing.some((p) => p.kind !== 'MOCK')) ||
      (provider.kind !== 'MOCK' && existing.some((p) => p.kind === 'MOCK'));
    if (mixesMock) {
      throw new ValidationError(
        `Refusing to register ${provider.id}: the MockProvider is simulation-only and cannot be combined with real providers.`,
      );
    }
    this.providers.set(provider.id, provider);
    this.lastRefresh = 0;
  }

  /** True when only simulated (MOCK) providers are registered. */
  isSimulation(): boolean {
    const all = this.list();
    return all.length > 0 && all.every((p) => p.kind === 'MOCK');
  }

  get(id: string): ModelProvider | undefined {
    return this.providers.get(id);
  }

  list(): ModelProvider[] {
    return [...this.providers.values()];
  }

  async statusesFresh(force = false): Promise<ProviderStatus[]> {
    if (!force && Date.now() - this.lastRefresh < this.ttlMs && this.statuses.size === this.providers.size) {
      return [...this.statuses.values()];
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async available(force = false): Promise<ProviderStatus[]> {
    return (await this.statusesFresh(force)).filter((s) => s.available);
  }

  /** Marks a provider unavailable until the next refresh (e.g. after a hard failure). */
  markUnavailable(id: string, reason: string): void {
    const status = this.statuses.get(id);
    if (status) this.statuses.set(id, { ...status, available: false, reason });
  }

  private async refresh(): Promise<ProviderStatus[]> {
    const results = await Promise.all(
      this.list().map(async (provider) => {
        try {
          return await provider.checkAvailability();
        } catch (error) {
          // checkAvailability must not throw, but a buggy adapter must not take the system down.
          return {
            provider: provider.id,
            kind: provider.kind,
            available: false,
            reason: `availability check failed: ${errorMessage(error)}`,
            selectedModel: null,
            models: [],
            checkedAt: nowIso(),
          } satisfies ProviderStatus;
        }
      }),
    );
    this.statuses = new Map(results.map((s) => [s.provider, s]));
    this.lastRefresh = Date.now();
    this.syncModelsTable(results);
    for (const s of results) {
      this.logger.debug({ provider: s.provider, available: s.available, model: s.selectedModel, reason: s.reason }, 'provider status');
    }
    return results;
  }

  private syncModelsTable(statuses: ProviderStatus[]): void {
    const now = nowIso();
    this.db.transaction((tx) => {
      // Providers that are no longer registered (e.g. removed runtimes) must not look available.
      const registered = statuses.map((s) => s.provider);
      tx.update(models)
        .set({ status: 'UNAVAILABLE', statusReason: 'provider not registered in this deployment', isDefault: false, lastCheckedAt: now, updatedAt: now })
        .where(registered.length ? notInArray(models.provider, registered) : undefined)
        .run();
      for (const status of statuses) {
        // Previously known models for this provider become unavailable unless re-reported.
        tx.update(models)
          .set({ status: 'UNAVAILABLE', statusReason: status.reason, isDefault: false, lastCheckedAt: now, updatedAt: now })
          .where(eq(models.provider, status.provider))
          .run();
        for (const m of status.models) {
          const id = `${m.provider}:${m.model}`;
          const row = {
            id,
            provider: m.provider,
            model: m.model,
            kind: m.kind,
            status: 'AVAILABLE' as const,
            statusReason: status.reason,
            isDefault: m.isDefault,
            capabilities: m.capabilities,
            pricing: PRICING_PER_MILLION[id] ?? null,
            lastCheckedAt: now,
            updatedAt: now,
          };
          tx.insert(models)
            .values({ ...row, createdAt: now })
            .onConflictDoUpdate({ target: models.id, set: row })
            .run();
        }
      }
    });
  }
}
