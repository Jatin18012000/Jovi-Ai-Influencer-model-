import { chmodSync, existsSync, statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { ConflictError } from '../errors.js';
import { GENESIS_HASH, type EventBus } from '../events/event-bus.js';
import { newId, nowIso } from '../ids.js';

export interface RetentionResult {
  dryRun: boolean;
  events: { pruned: number; checkpoint: { sequence: number; hash: string } | null };
  agentRuns: number;
  modelRuns: number;
}

/**
 * Security remediation R-18: data-at-rest retention and backups.
 *
 * - Agent and model runs (prompts, outputs, tool calls) older than the run
 *   retention are deleted.
 * - Events are the audit log, kept forever by default. When an event
 *   retention is configured, the oldest events are pruned *after* the hash of
 *   the last pruned event is stored as a checkpoint, so the remaining chain
 *   still verifies, and the pruning itself is recorded as a chained
 *   RETENTION_APPLIED event.
 */
export class RetentionService {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly events: EventBus,
    private readonly policy: { eventDays: number; runDays: number },
  ) {}

  apply(options: { dryRun?: boolean; now?: Date } = {}): RetentionResult {
    const now = options.now ?? new Date();
    const dryRun = options.dryRun ?? false;
    const cutoff = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    const result: RetentionResult = { dryRun, events: { pruned: 0, checkpoint: null }, agentRuns: 0, modelRuns: 0 };

    if (this.policy.runDays > 0) {
      const before = cutoff(this.policy.runDays);
      const count = (sql: string) => (this.sqlite.prepare(sql).get(before) as { n: number }).n;
      result.modelRuns = count('SELECT count(*) AS n FROM model_runs WHERE created_at < ?');
      result.agentRuns = count("SELECT count(*) AS n FROM agent_runs WHERE started_at < ? AND status <> 'RUNNING'");
      if (!dryRun) {
        this.sqlite.prepare('DELETE FROM model_runs WHERE created_at < ?').run(before);
        this.sqlite.prepare("DELETE FROM agent_runs WHERE started_at < ? AND status <> 'RUNNING'").run(before);
      }
    }

    if (this.policy.eventDays > 0) {
      const before = cutoff(this.policy.eventDays);
      // Never prune the newest event: the chain head must stay in the table.
      const last = this.sqlite
        .prepare('SELECT sequence, hash FROM events WHERE timestamp < ? AND sequence < (SELECT max(sequence) FROM events) ORDER BY sequence DESC LIMIT 1')
        .get(before) as { sequence: number; hash: string | null } | undefined;
      if (last) {
        result.events.pruned = (this.sqlite.prepare('SELECT count(*) AS n FROM events WHERE sequence <= ?').get(last.sequence) as { n: number }).n;
        result.events.checkpoint = { sequence: last.sequence, hash: last.hash ?? GENESIS_HASH };
        if (!dryRun) {
          const checkpoint = result.events.checkpoint;
          this.sqlite.transaction(() => {
            this.sqlite
              .prepare('INSERT INTO audit_checkpoints (id, sequence, hash, pruned_events, pruned_before, created_at) VALUES (?, ?, ?, ?, ?, ?)')
              .run(newId('checkpoint'), checkpoint.sequence, checkpoint.hash, result.events.pruned, before, nowIso());
            this.sqlite.prepare('DELETE FROM events WHERE sequence <= ?').run(checkpoint.sequence);
          }).immediate();
        }
      }
    }

    if (!dryRun && (result.events.pruned || result.agentRuns || result.modelRuns)) {
      this.events.emit({ eventType: 'RETENTION_APPLIED', source: 'core.retention', payload: { ...result, policy: this.policy } });
    }
    return result;
  }

  /**
   * Online backup of the SQLite database (consistent snapshot while running).
   * The file is created with owner-only permissions and never overwritten.
   */
  async backup(destination: string): Promise<{ path: string; bytes: number }> {
    if (existsSync(destination)) throw new ConflictError(`backup destination already exists: ${destination}`);
    await this.sqlite.backup(destination);
    try {
      chmodSync(destination, 0o600);
    } catch {
      // best effort on filesystems without POSIX permissions
    }
    return { path: destination, bytes: statSync(destination).size };
  }
}
