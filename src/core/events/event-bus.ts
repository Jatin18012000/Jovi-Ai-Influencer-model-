import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { EventType } from '../../types/enums.js';
import type { Logger } from '../config/logger.js';
import { PermissionDeniedError } from '../errors.js';
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

/**
 * Security remediation R-08. Events that attest a human decision or a
 * security-relevant change. Only services holding the bus's attestation
 * capability (handed out once, at bootstrap) may emit them; agents, routes
 * and other components cannot forge them through the generic emit path.
 */
export const PROTECTED_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'PRODUCTION_APPROVED',
  'PRODUCTION_REJECTED',
  'VISUAL_IDENTITY_VERSION_CREATED',
  'API_CREDENTIAL_CREATED',
  'API_CREDENTIAL_REVOKED',
  'SAFETY_CALIBRATION_RECORDED',
]);

/** Opaque capability that authorises emitting PROTECTED_EVENT_TYPES. */
export interface EventAttestation {
  readonly __brand: 'EventAttestation';
}

/** Hash of the (virtual) event before the first chained one. */
export const GENESIS_HASH = '0'.repeat(64);

interface ChainRow {
  id: string;
  event_type: string;
  timestamp: string;
  source: string;
  entity_id: string | null;
  payload: string;
  schema_version: number;
  correlation_id: string | null;
  causation_id: string | null;
  sequence: number;
  prev_hash: string | null;
  hash: string | null;
}

/** sha256(prevHash ‖ canonical row). The payload is hashed exactly as stored. */
export function eventHash(prevHash: string, row: Omit<ChainRow, 'prev_hash' | 'hash'>): string {
  const canonical = JSON.stringify([
    row.id,
    row.event_type,
    row.timestamp,
    row.source,
    row.entity_id,
    row.payload,
    row.schema_version,
    row.correlation_id,
    row.causation_id,
    row.sequence,
  ]);
  return createHash('sha256').update(prevHash).update('\n').update(canonical).digest('hex');
}

export interface ChainVerification {
  ok: boolean;
  /** Chained events checked. */
  checked: number;
  /** Events written before the hash chain existed (a contiguous prefix; not verifiable). */
  legacyUnchained: number;
  head: { sequence: number; hash: string } | null;
  firstBreak: { sequence: number; eventId: string; reason: string } | null;
}

export interface EmitInput {
  eventType: EventType;
  source: string;
  entityId?: string | null;
  payload?: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
  /** Required for PROTECTED_EVENT_TYPES. */
  attestation?: EventAttestation;
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
  private readonly append: Database.Transaction<(row: Omit<ChainRow, 'sequence' | 'prev_hash' | 'hash'>) => number>;
  // Re-audit N-10: ECMAScript private fields — unreachable at runtime, unlike TypeScript `private`.
  readonly #attestation: EventAttestation = Object.freeze({}) as EventAttestation;
  #attestationIssued = false;

  constructor(
    private readonly sqlite: Database.Database,
    private readonly logger: Logger,
  ) {
    const last = sqlite.prepare('SELECT sequence, hash FROM events ORDER BY sequence DESC LIMIT 1');
    // After retention pruned every event, the chain continues from the latest checkpoint (R-18).
    const checkpoint = sqlite.prepare('SELECT sequence, hash FROM audit_checkpoints ORDER BY sequence DESC LIMIT 1');
    const insert = sqlite.prepare(`
      INSERT INTO events (id, event_type, timestamp, source, entity_id, payload, schema_version, correlation_id, causation_id, sequence, prev_hash, hash)
      VALUES (@id, @event_type, @timestamp, @source, @entity_id, @payload, @schema_version, @correlation_id, @causation_id, @sequence, @prev_hash, @hash)
    `);
    // Sequence and chain link are computed inside one write transaction, so
    // concurrent writers (API + worker processes) serialise and never fork the chain.
    this.append = sqlite.transaction((row) => {
      const previous = (last.get() ?? checkpoint.get()) as { sequence: number; hash: string | null } | undefined;
      const sequence = (previous?.sequence ?? 0) + 1;
      const prevHash = previous?.hash ?? GENESIS_HASH;
      insert.run({ ...row, sequence, prev_hash: prevHash, hash: eventHash(prevHash, { ...row, sequence }) });
      return sequence;
    });
  }

  /**
   * The capability for PROTECTED_EVENT_TYPES. Issued exactly once — bootstrap
   * hands it to the owning services; a second request is refused.
   */
  issueAttestation(): EventAttestation {
    if (this.#attestationIssued) throw new PermissionDeniedError('the event attestation capability has already been issued');
    this.#attestationIssued = true;
    return this.#attestation;
  }

  emit(input: EmitInput): JoviEvent {
    if (PROTECTED_EVENT_TYPES.has(input.eventType) && input.attestation !== this.#attestation) {
      this.logger.warn({ security: 'PROTECTED_EVENT_REFUSED', eventType: input.eventType, source: input.source }, 'protected event refused');
      throw new PermissionDeniedError(`${input.eventType} events can only be emitted by the service that owns them`);
    }
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
    const sequence = this.append.immediate({
      id: base.eventId,
      event_type: base.eventType,
      timestamp: base.timestamp,
      source: base.source,
      entity_id: base.entityId,
      payload: JSON.stringify(base.payload),
      schema_version: base.schemaVersion,
      correlation_id: base.correlationId,
      causation_id: base.causationId,
    });
    const event: JoviEvent = { ...base, sequence };

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

  /** Latest retention checkpoint (R-18): the last pruned event's sequence and hash. */
  latestCheckpoint(): { sequence: number; hash: string } | null {
    return (this.sqlite.prepare('SELECT sequence, hash FROM audit_checkpoints ORDER BY sequence DESC LIMIT 1').get() as { sequence: number; hash: string } | undefined) ?? null;
  }

  /**
   * Verifies the whole hash chain (R-08). Detects edited, deleted, reordered or
   * inserted rows. After retention pruning (R-18) verification starts from the
   * latest checkpoint instead of the genesis hash.
   */
  verifyChain(): ChainVerification {
    let checked = 0;
    let legacyUnchained = 0;
    const checkpoint = this.latestCheckpoint();
    let expectedPrev: string | null = checkpoint && checkpoint.hash !== GENESIS_HASH ? checkpoint.hash : null;
    let head: ChainVerification['head'] = null;
    let lastSequence = checkpoint?.sequence ?? 0;
    const fail = (row: ChainRow, reason: string): ChainVerification => ({ ok: false, checked, legacyUnchained, head, firstBreak: { sequence: row.sequence, eventId: row.id, reason } });
    for (const row of this.sqlite.prepare('SELECT * FROM events ORDER BY sequence ASC').iterate() as IterableIterator<ChainRow>) {
      if (row.sequence !== lastSequence + 1) return fail(row, `sequence gap: expected ${lastSequence + 1}`);
      lastSequence = row.sequence;
      if (row.hash === null) {
        if (expectedPrev !== null) return fail(row, 'hash removed from a chained event');
        legacyUnchained += 1;
        continue;
      }
      const prev: string = expectedPrev ?? GENESIS_HASH;
      if (row.prev_hash !== prev) return fail(row, 'link to the previous event does not match');
      if (eventHash(prev, row) !== row.hash) return fail(row, 'content does not match its hash');
      expectedPrev = row.hash;
      checked += 1;
      head = { sequence: row.sequence, hash: row.hash };
    }
    // Re-audit R2-03: a checkpoint is only trusted when a later, chain-verified RETENTION_APPLIED
    // event records the same {sequence, hash}. A forged checkpoint would need a forged event,
    // which changes the head (detected by external anchoring).
    if (checkpoint && !this.checkpointVouched(checkpoint)) {
      return {
        ok: false,
        checked,
        legacyUnchained,
        head,
        firstBreak: { sequence: checkpoint.sequence, eventId: 'audit_checkpoint', reason: 'retention checkpoint has no matching chained RETENTION_APPLIED event' },
      };
    }
    return { ok: true, checked, legacyUnchained, head, firstBreak: null };
  }

  private checkpointVouched(checkpoint: { sequence: number; hash: string }): boolean {
    const rows = this.sqlite
      .prepare("SELECT payload FROM events WHERE event_type = 'RETENTION_APPLIED' AND sequence > ? AND hash IS NOT NULL")
      .all(checkpoint.sequence) as Array<{ payload: string }>;
    return rows.some((r) => {
      try {
        const cp = (JSON.parse(r.payload) as { events?: { checkpoint?: { sequence?: number; hash?: string } } }).events?.checkpoint;
        return cp?.sequence === checkpoint.sequence && cp.hash === checkpoint.hash;
      } catch {
        return false;
      }
    });
  }

  /** Verifies one event's hash and its link to the preceding event (cheap; used by the publishing gate). */
  verifyEvent(eventId: string): { ok: boolean; reason: string | null } {
    const row = this.sqlite.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as ChainRow | undefined;
    if (!row) return { ok: false, reason: 'event not found' };
    if (row.hash === null || row.prev_hash === null) return { ok: false, reason: 'event is not hash-chained' };
    const previous = this.sqlite.prepare('SELECT hash FROM events WHERE sequence = ?').get(row.sequence - 1) as { hash: string | null } | undefined;
    const checkpoint = this.latestCheckpoint();
    const expectedPrev = previous ? previous.hash : checkpoint && checkpoint.sequence === row.sequence - 1 ? checkpoint.hash : GENESIS_HASH;
    if (row.prev_hash !== (expectedPrev ?? GENESIS_HASH)) return { ok: false, reason: 'link to the previous event does not match' };
    if (eventHash(row.prev_hash, row) !== row.hash) return { ok: false, reason: 'content does not match its hash' };
    return { ok: true, reason: null };
  }

  /**
   * Gate C: externally recorded heads (`JOVI_AUDIT_ANCHORS`, `--expect-head`)
   * must still be in the chain with the same hash. A rewritten log cannot
   * reproduce a hash recorded off the machine, so a mismatch or a missing
   * anchored event means the history was altered. An anchor at or before the
   * retention checkpoint is reported as PRUNED (only the checkpoint itself can
   * still be compared): re-anchor after applying event retention.
   */
  verifyAnchors(anchors: ReadonlyArray<{ sequence: number; hash: string }>): {
    ok: boolean;
    results: Array<{ sequence: number; status: 'MATCH' | 'MISMATCH' | 'MISSING' | 'PRUNED' }>;
  } {
    const checkpoint = this.latestCheckpoint();
    const results = anchors.map(({ sequence, hash }) => {
      const row = this.sqlite.prepare('SELECT hash FROM events WHERE sequence = ?').get(sequence) as { hash: string | null } | undefined;
      let status: 'MATCH' | 'MISMATCH' | 'MISSING' | 'PRUNED';
      if (row) status = row.hash === hash.toLowerCase() ? 'MATCH' : 'MISMATCH';
      else if (checkpoint && sequence <= checkpoint.sequence) status = sequence === checkpoint.sequence && checkpoint.hash !== hash.toLowerCase() ? 'MISMATCH' : 'PRUNED';
      else status = 'MISSING';
      return { sequence, status };
    });
    return { ok: results.every((r) => r.status === 'MATCH' || r.status === 'PRUNED'), results };
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

  emit(eventType: EventType, source: string, entityId: string | null, payload: Record<string, unknown> = {}, attestation?: EventAttestation): JoviEvent {
    const event = this.bus.emit({
      eventType,
      source,
      entityId,
      payload,
      correlationId: this.correlationId,
      causationId: this.lastEventId,
      ...(attestation ? { attestation } : {}),
    });
    this.lastEventId = event.eventId;
    return event;
  }

  get lastEvent(): string | null {
    return this.lastEventId;
  }
}
