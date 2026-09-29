import { and, desc, eq, gt, isNull, lte, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { CorrelationScope, EventBus } from '../../core/events/event-bus.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { newId, nowIso } from '../../core/ids.js';
import type { JoviDatabase } from '../../database/client.js';
import { memoryItems } from '../../database/schema.js';
import { MemoryType } from '../../types/enums.js';
import { overlapScore, tokenize } from '../text.js';

export const MemoryInputSchema = z.object({
  type: MemoryType,
  key: z.string().min(1).max(200),
  value: z.unknown().refine((v) => v !== undefined, 'value is required'),
  importance: z.number().min(0).max(1).default(0.5),
  confidence: z.number().min(0).max(1).default(0.8),
  source: z.string().min(1).max(100),
  tags: z.array(z.string().max(50)).max(30).default([]),
  expiresAt: z.iso.datetime().nullable().optional(),
});

export type MemoryInput = z.input<typeof MemoryInputSchema>;

/**
 * Memory-poisoning defence. Memory arriving from outside the system (the API)
 * is untrusted: it may only use low-authority types, is always tagged with
 * source `api`, has capped importance/confidence, and can never overwrite
 * memory written by the seed or by agents.
 */
export const EXTERNAL_MEMORY_SOURCE = 'api';
export const EXTERNAL_WRITABLE_TYPES = ['FACT', 'PREFERENCE', 'LEARNING', 'AUDIENCE', 'CONTENT', 'EXPERIMENT', 'TEMPORARY'] as const;
export const EXTERNAL_LIMITS = { maxImportance: 0.7, maxConfidence: 0.8, maxValueBytes: 4096 } as const;

export const ExternalMemoryInputSchema = z.object({
  type: z.enum(EXTERNAL_WRITABLE_TYPES, {
    error: `type must be one of ${EXTERNAL_WRITABLE_TYPES.join(', ')} (IDENTITY, STRATEGY and DECISION cannot be written externally)`,
  }),
  key: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,199}$/i, 'key may contain letters, digits, . _ : - (max 200)'),
  value: z.unknown().refine((v) => v !== undefined, 'value is required'),
  importance: z.number().min(0).max(1).default(0.5),
  confidence: z.number().min(0).max(1).default(0.6),
  tags: z.array(z.string().max(50)).max(20).default([]),
  expiresAt: z.iso.datetime().nullable().optional(),
});
export type ExternalMemoryInput = z.input<typeof ExternalMemoryInputSchema>;

/** Trusted = written by the seed or by an agent through the ToolKit. Everything else is untrusted data. */
export function isTrustedSource(source: string): boolean {
  return source.startsWith('seed:') || source.startsWith('agent:');
}

export interface MemoryItem {
  id: string;
  type: MemoryType;
  key: string;
  value: unknown;
  importance: number;
  confidence: number;
  source: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface MemoryQuery {
  type?: MemoryType;
  types?: MemoryType[];
  key?: string;
  minImportance?: number;
  includeExpired?: boolean;
  limit?: number;
}

export interface ScoredMemory extends MemoryItem {
  relevance: number;
  score: number;
}

const SOURCE = 'memory.operational';

/**
 * Operational memory (SQLite). Items are unique per (type, key); writing an
 * existing key updates it and emits MEMORY_UPDATED rather than duplicating.
 */
export class OperationalMemory {
  constructor(
    private readonly db: JoviDatabase,
    private readonly bus: EventBus,
  ) {}

  upsert(input: MemoryInput, scope?: CorrelationScope): { item: MemoryItem; created: boolean } {
    const data = MemoryInputSchema.parse(input);
    const now = nowIso();
    const existing = this.db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.type, data.type), eq(memoryItems.key, data.key)))
      .get();

    if (existing) {
      this.db
        .update(memoryItems)
        .set({
          value: data.value,
          importance: data.importance,
          confidence: data.confidence,
          source: data.source,
          tags: data.tags,
          expiresAt: data.expiresAt ?? null,
          updatedAt: now,
        })
        .where(eq(memoryItems.id, existing.id))
        .run();
      const item = this.get(existing.id);
      this.emit(scope, 'MEMORY_UPDATED', item);
      return { item, created: false };
    }

    const row = {
      id: newId('memory'),
      type: data.type,
      key: data.key,
      value: data.value,
      importance: data.importance,
      confidence: data.confidence,
      source: data.source,
      tags: data.tags,
      createdAt: now,
      updatedAt: now,
      expiresAt: data.expiresAt ?? null,
    };
    this.db.insert(memoryItems).values(row).run();
    const item = this.get(row.id);
    this.emit(scope, 'MEMORY_CREATED', item);
    return { item, created: true };
  }

  /** Untrusted write path (API). See EXTERNAL_* policy above. */
  writeExternal(input: ExternalMemoryInput, scope?: CorrelationScope): { item: MemoryItem; created: boolean } {
    const data = ExternalMemoryInputSchema.parse(input);
    const bytes = Buffer.byteLength(JSON.stringify(data.value) ?? '', 'utf8');
    if (bytes > EXTERNAL_LIMITS.maxValueBytes) {
      throw new ValidationError(`memory value is ${bytes} bytes; external limit is ${EXTERNAL_LIMITS.maxValueBytes}`);
    }
    const existing = this.findByKey(data.type, data.key);
    if (existing && existing.source !== EXTERNAL_MEMORY_SOURCE) {
      throw new ConflictError(`memory ${data.type}:${data.key} is owned by ${existing.source} and cannot be overwritten externally`);
    }
    return this.upsert(
      {
        ...data,
        source: EXTERNAL_MEMORY_SOURCE,
        importance: Math.min(data.importance, EXTERNAL_LIMITS.maxImportance),
        confidence: Math.min(data.confidence, EXTERNAL_LIMITS.maxConfidence),
      },
      scope,
    );
  }

  get(id: string): MemoryItem {
    const row = this.db.select().from(memoryItems).where(eq(memoryItems.id, id)).get();
    if (!row) throw new NotFoundError('MemoryItem', id);
    return this.toModel(row);
  }

  findByKey(type: MemoryType, key: string): MemoryItem | undefined {
    const row = this.db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.type, type), eq(memoryItems.key, key)))
      .get();
    return row ? this.toModel(row) : undefined;
  }

  list(query: MemoryQuery = {}): MemoryItem[] {
    const conditions: SQL[] = [];
    if (query.type) conditions.push(eq(memoryItems.type, query.type));
    if (query.types?.length) {
      const typeConditions = query.types.map((t) => eq(memoryItems.type, t));
      const combined = or(...typeConditions);
      if (combined) conditions.push(combined);
    }
    if (query.key) conditions.push(eq(memoryItems.key, query.key));
    if (query.minImportance !== undefined) conditions.push(gt(memoryItems.importance, query.minImportance - 1e-9));
    if (!query.includeExpired) {
      const notExpired = or(isNull(memoryItems.expiresAt), gt(memoryItems.expiresAt, nowIso()));
      if (notExpired) conditions.push(notExpired);
    }
    return this.db
      .select()
      .from(memoryItems)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(memoryItems.importance), desc(memoryItems.updatedAt))
      .limit(Math.min(query.limit ?? 100, 1000))
      .all()
      .map((r) => this.toModel(r));
  }

  /**
   * Relevance-ranked retrieval: blends keyword overlap with stored importance
   * and confidence. Intentionally simple; semantic retrieval is a separate layer.
   */
  search(text: string, query: MemoryQuery & { limit?: number } = {}): ScoredMemory[] {
    const queryTokens = tokenize(text);
    const candidates = this.list({ ...query, limit: 500 });
    const scored = candidates.map((item) => {
      const docTokens = tokenize(`${item.key} ${item.tags.join(' ')} ${JSON.stringify(item.value)}`);
      const relevance = overlapScore(queryTokens, docTokens);
      const score = 0.55 * relevance + 0.35 * item.importance + 0.1 * item.confidence;
      return { ...item, relevance, score };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, query.limit ?? 10);
  }

  /** Removes expired TEMPORARY-style items. Returns the number deleted. */
  purgeExpired(): number {
    return this.db.delete(memoryItems).where(lte(memoryItems.expiresAt, nowIso())).run().changes;
  }

  private emit(scope: CorrelationScope | undefined, type: 'MEMORY_CREATED' | 'MEMORY_UPDATED', item: MemoryItem): void {
    const payload = { type: item.type, key: item.key, importance: item.importance, source: item.source };
    if (scope) scope.emit(type, SOURCE, item.id, payload);
    else this.bus.emit({ eventType: type, source: SOURCE, entityId: item.id, payload });
  }

  private toModel(row: typeof memoryItems.$inferSelect): MemoryItem {
    return {
      id: row.id,
      type: MemoryType.parse(row.type),
      key: row.key,
      value: row.value,
      importance: row.importance,
      confidence: row.confidence,
      source: row.source,
      tags: row.tags,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      expiresAt: row.expiresAt,
    };
  }
}
