import { and, asc, eq, lt } from 'drizzle-orm';
import type { JoviDatabase } from '../../database/client.js';
import { mediaAssets } from '../../database/schema.js';
import type { AssetStatus, EventType, MediaKind } from '../../types/enums.js';
import { NotFoundError, ValidationError } from '../errors.js';
import type { CorrelationScope } from '../events/event-bus.js';
import { newId, nowIso } from '../ids.js';

export type MediaAsset = typeof mediaAssets.$inferSelect;

const SOURCE = 'production.assets';

/** Asset lifecycle. COMPLETED is reachable only from GENERATING (a real provider call). */
export const ASSET_TRANSITIONS: Record<AssetStatus, AssetStatus[]> = {
  REQUESTED: ['QUEUED', 'BLOCKED', 'FAILED', 'REJECTED'],
  QUEUED: ['GENERATING', 'BLOCKED', 'FAILED', 'REJECTED'],
  GENERATING: ['COMPLETED', 'SIMULATED', 'FAILED'],
  COMPLETED: ['REJECTED', 'SUPERSEDED'],
  SIMULATED: ['REJECTED', 'SUPERSEDED'],
  FAILED: ['REJECTED', 'SUPERSEDED'],
  BLOCKED: ['REJECTED', 'SUPERSEDED'],
  REJECTED: [],
  SUPERSEDED: [],
};

/** Assets that no longer count toward a production (audit trail only). */
export const INACTIVE_ASSET_STATUSES: readonly AssetStatus[] = ['REJECTED', 'SUPERSEDED'];

const REQUESTED_EVENT: Record<MediaKind, EventType> = {
  IMAGE: 'IMAGE_GENERATION_REQUESTED',
  VIDEO: 'VIDEO_GENERATION_REQUESTED',
  VOICE: 'VOICE_GENERATION_REQUESTED',
  RENDER: 'RENDER_GENERATION_REQUESTED',
};
const GENERATED_EVENT: Record<MediaKind, EventType> = {
  IMAGE: 'IMAGE_GENERATED',
  VIDEO: 'VIDEO_GENERATED',
  VOICE: 'VOICE_GENERATED',
  RENDER: 'RENDER_GENERATED',
};

export interface AssetCreateInput {
  productionId: string;
  kind: MediaKind;
  sceneId: string | null;
  request: unknown;
  sourceAssetIds?: string[];
  aspectRatio?: string | null;
}

/**
 * Persists media assets and enforces their lifecycle. A prompt is not an
 * asset: an asset reaches COMPLETED only with a provider and a location, set
 * by MediaService after a provider call succeeded and its output was verified.
 */
export class AssetService {
  constructor(private readonly db: JoviDatabase) {}

  create(input: AssetCreateInput, scope: CorrelationScope): MediaAsset {
    const now = nowIso();
    const row = {
      id: newId('asset'),
      productionId: input.productionId,
      kind: input.kind,
      sceneId: input.sceneId,
      status: 'REQUESTED' as const,
      statusReason: null,
      provider: null,
      providerKind: null,
      model: null,
      request: input.request ?? {},
      sourceAssetIds: input.sourceAssetIds ?? [],
      location: null,
      mimeType: null,
      durationSeconds: null,
      width: null,
      height: null,
      aspectRatio: input.aspectRatio ?? null,
      providerJobId: null,
      attempts: 0,
      cost: null,
      simulated: false,
      metadata: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(mediaAssets).values(row).run();
    scope.emit(REQUESTED_EVENT[input.kind], SOURCE, row.id, { productionId: row.productionId, sceneId: row.sceneId, kind: row.kind });
    return this.get(row.id);
  }

  transition(id: string, to: AssetStatus, fields: Partial<MediaAsset>, scope: CorrelationScope): MediaAsset {
    const asset = this.get(id);
    const from = asset.status as AssetStatus;
    if (!ASSET_TRANSITIONS[from].includes(to)) {
      throw new ValidationError(`Invalid asset transition ${from} -> ${to}`, { assetId: id });
    }
    const next = { ...asset, ...fields };
    if (to === 'COMPLETED' && (!next.provider || !next.location || next.simulated)) {
      throw new ValidationError('An asset can only be COMPLETED with a real provider and a verified output location', { assetId: id });
    }
    this.db
      .update(mediaAssets)
      .set({ ...fields, status: to, updatedAt: nowIso() })
      .where(eq(mediaAssets.id, id))
      .run();

    const payload = { productionId: asset.productionId, sceneId: asset.sceneId, kind: asset.kind, from, to, provider: next.provider, reason: next.statusReason };
    if (to === 'COMPLETED') scope.emit(GENERATED_EVENT[asset.kind as MediaKind], SOURCE, id, { ...payload, location: next.location });
    else if (to === 'SIMULATED') scope.emit('ASSET_SIMULATED', SOURCE, id, payload);
    else if (to === 'FAILED') scope.emit('ASSET_GENERATION_FAILED', SOURCE, id, payload);
    else if (to === 'BLOCKED') scope.emit('ASSET_BLOCKED', SOURCE, id, payload);
    else if (to === 'REJECTED') scope.emit('ASSET_REJECTED', SOURCE, id, payload);
    else if (to === 'SUPERSEDED') scope.emit('ASSET_SUPERSEDED', SOURCE, id, payload);
    return this.get(id);
  }

  /**
   * Updates bookkeeping fields of an asset that is still GENERATING (e.g. the
   * provider changed after a fallback). Never changes status or location.
   */
  annotate(id: string, fields: Pick<Partial<MediaAsset>, 'provider' | 'providerKind' | 'model' | 'cost' | 'attempts' | 'metadata' | 'statusReason'>): MediaAsset {
    const asset = this.get(id);
    if (asset.status !== 'GENERATING') throw new ValidationError(`Asset ${id} is ${asset.status}; only GENERATING assets can be annotated`);
    this.db
      .update(mediaAssets)
      .set({ ...fields, updatedAt: nowIso() })
      .where(eq(mediaAssets.id, id))
      .run();
    return this.get(id);
  }

  get(id: string): MediaAsset {
    const row = this.db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).get();
    if (!row) throw new NotFoundError('MediaAsset', id);
    return row;
  }

  list(productionId: string, kind?: MediaKind): MediaAsset[] {
    const rows = this.db.select().from(mediaAssets).where(eq(mediaAssets.productionId, productionId)).orderBy(asc(mediaAssets.createdAt)).all();
    return kind ? rows.filter((r) => r.kind === kind) : rows;
  }

  /** Assets in a status whose last change is older than `updatedBefore` (oldest first). */
  listByStatus(status: AssetStatus, updatedBefore: string): MediaAsset[] {
    return this.db
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.status, status), lt(mediaAssets.updatedAt, updatedBefore)))
      .orderBy(asc(mediaAssets.updatedAt))
      .all();
  }

  /** Records that an inactive asset's file was garbage-collected (status and location kept for audit). */
  recordPurge(id: string, purgedBytes: number): MediaAsset {
    const asset = this.get(id);
    if (!INACTIVE_ASSET_STATUSES.includes(asset.status as AssetStatus)) throw new ValidationError(`Asset ${id} is ${asset.status}; only inactive assets can be purged`);
    const metadata = { ...((asset.metadata as Record<string, unknown> | null) ?? {}), purgedAt: nowIso(), purgedBytes };
    this.db.update(mediaAssets).set({ metadata }).where(eq(mediaAssets.id, id)).run();
    return this.get(id);
  }

  /** Assets that still count (not rejected or superseded). */
  listActive(productionId: string, kind?: MediaKind): MediaAsset[] {
    return this.list(productionId, kind).filter((a) => !INACTIVE_ASSET_STATUSES.includes(a.status as AssetStatus));
  }
}
