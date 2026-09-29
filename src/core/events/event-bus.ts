import type Database from 'better-sqlite3';
import { z } from 'zod';
import { EventType } from '../../types/enums.js';
import type { Logger } from '../config/logger.js';
import { newId, nowIso } from '../ids.js';

export const EVENT_SCHEMA_VERSION = 1;

export const JoviEventSchema = z.object({
  eventId: z.string(),
  eventType: EventType,
  timestamp: z.string(),
  source: z.string().min(1),
  entityId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  schemaVersion: z.number().int().positive(),
  correlationId: z.string().nullable(),
  causationId: z.string().nullable(),
  sequence: z.number().int().nonnegative(),
});

export type JoviEvent = z.infer<typeof JoviEventSchema>;

export interface EmitInput {
  eventType: EventType;
  source: string;
  entityId?: string | null;
  payload?: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
}

export type EventHandler = (event: JoviEvent) => void | Promise<void>;

export interface EventQuery {
  eventType?: EventType;
  correlationId?: string;
  entityId?: string;
  limit?: number;
  afterSequence?: number;
}

/**
 * Internal event bus.
 *
 * Every event is persisted to SQLite first (the durable audit log), then
 * dispatched to in-process subscribers. Subscriber failures are logged and
 * isolated: they never break the emitting workflow. Future integrations
 * (n8n webhooks, dashboards) subscribe here instead of coupling to agents.
 */
export class EventBus {
  private readonly handlers = new Map<EventType | '*', Set<EventHandler>>();
  private readonly insert: Database.Statement;

  constructor(
    private readonly sqlite: Database.Database,
    private readonly logger: Logger,
  ) {
    this.insert = sqlite.prepare(`
      INSERT INTO events (id, event_type, timestamp, source, entity_id, payload, schema_version, correlation_id, causation_id, sequence)
      VALUES (@id, @eventType, @timestamp, @source, @entityId, @payload, @schemaVersion, @correlationId, @causationId,
              (SELECT COALESCE(MAX(sequence), 0) + 1 FROM events))
      RETURNING sequence
    `);
  }

  emit(input: EmitInput): JoviEvent {
    const base = {
      eventId: newId('event'),
      eventType: EventType.parse(input.eventType),
      timestamp: nowIso(),
      source: input.source,
      entityId: input.entityId ?? null,
      payload: input.payload ?? {},
      schemaVersion: EVENT_SCHEMA_VERSION,
      correlationId: input.correlationId ?? null,
      causationId: input.causationId ?? null,
    };
    const row = this.insert.get({
      id: base.eventId,
      eventType: base.eventType,
      timestamp: base.timestamp,
      source: base.source,
      entityId: base.entityId,
      payload: JSON.stringify(base.payload),
      schemaVersion: base.schemaVersion,
      correlationId: base.correlationId,
      causationId: base.causationId,
    }) as { sequence: number };
    const event: JoviEvent = { ...base, sequence: row.sequence };

    this.logger.debug(
      { eventId: event.eventId, eventType: event.eventType, entityId: event.entityId, correlationId: event.correlationId },
      'event emitted',
    );
    this.dispatch(event);
    return event;
  }

  subscribe(eventType: EventType | '*', handler: EventHandler): () => void {
    let set = this.handlers.get(eventType);
    if (!set) {
      set = new Set();
      this.handlers.set(eventType, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  list(query: EventQuery = {}): JoviEvent[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (query.eventType) {
      clauses.push('event_type = @eventType');
      params.eventType = query.eventType;
    }
    if (query.correlationId) {
      clauses.push('correlation_id = @correlationId');
      params.correlationId = query.correlationId;
    }
    if (query.entityId) {
      clauses.push('entity_id = @entityId');
      params.entityId = query.entityId;
    }
    if (query.afterSequence !== undefined) {
      clauses.push('sequence > @afterSequence');
      params.afterSequence = query.afterSequence;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
    // Newest-first window, returned in chronological order.
    const rows = this.sqlite
      .prepare(`SELECT * FROM (SELECT * FROM events ${where} ORDER BY sequence DESC LIMIT @limit) ORDER BY sequence ASC`)
      .all(params) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      eventId: String(r.id),
      eventType: EventType.parse(r.event_type),
      timestamp: String(r.timestamp),
      source: String(r.source),
      entityId: (r.entity_id as string | null) ?? null,
      payload: JSON.parse(String(r.payload)) as Record<string, unknown>,
      schemaVersion: Number(r.schema_version),
      correlationId: (r.correlation_id as string | null) ?? null,
      causationId: (r.causation_id as string | null) ?? null,
      sequence: Number(r.sequence),
    }));
  }

  /** Latest event in a correlation, used to resume causation chains across processes. */
  lastEventId(correlationId: string): string | null {
    const row = this.sqlite
      .prepare('SELECT id FROM events WHERE correlation_id = ? ORDER BY sequence DESC LIMIT 1')
      .get(correlationId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Opens a causation-chained scope, continuing from the correlation's latest event. */
  scope(correlationId: string): CorrelationScope {
    return new CorrelationScope(this, correlationId, this.lastEventId(correlationId));
  }

  private dispatch(event: JoviEvent): void {
    const targets = [...(this.handlers.get(event.eventType) ?? []), ...(this.handlers.get('*') ?? [])];
    for (const handler of targets) {
      try {
        const result = handler(event);
        if (result instanceof Promise) {
          result.catch((error: unknown) => this.logger.error({ err: error, eventType: event.eventType }, 'event handler failed'));
        }
      } catch (error) {
        this.logger.error({ err: error, eventType: event.eventType }, 'event handler failed');
      }
    }
  }
}

/**
 * Tracks one workflow's correlation id and chains causation: each event emitted
 * through the scope is caused by the previous one, giving an auditable trail.
 */
export class CorrelationScope {
  private lastEventId: string | null;

  constructor(
    private readonly bus: EventBus,
    readonly correlationId: string,
    causationId: string | null = null,
  ) {
    this.lastEventId = causationId;
  }

  emit(eventType: EventType, source: string, entityId: string | null, payload: Record<string, unknown> = {}): JoviEvent {
    const event = this.bus.emit({
      eventType,
      source,
      entityId,
      payload,
      correlationId: this.correlationId,
      causationId: this.lastEventId,
    });
    this.lastEventId = event.eventId;
    return event;
  }

  get lastEvent(): string | null {
    return this.lastEventId;
  }
}
