import { eq } from 'drizzle-orm';
import { newId, nowIso } from '../core/ids.js';
import type { DatabaseHandle } from './client.js';
import { identityVersions, joviIdentity, memoryItems, strategyVersions } from './schema.js';
import { APPROVED_JOVI_IDENTITY, JOVI_IDENTITY_ID } from './seed/identity.js';
import { SEED_MEMORIES } from './seed/memories.js';
import { INITIAL_STRATEGY } from './seed/strategy.js';

export interface SeedReport {
  identity: 'created' | 'exists';
  strategy: 'created' | 'exists';
  memoriesCreated: number;
  memoriesExisting: number;
}

/**
 * Idempotent seed. Never overwrites existing rows: identity and strategy evolve
 * through versions and memory evolves through learning, so re-seeding must
 * not clobber that history.
 */
export function seedDatabase(handle: DatabaseHandle): SeedReport {
  const { db } = handle;
  return db.transaction((tx) => {
    const now = nowIso();
    let identity: SeedReport['identity'] = 'exists';
    if (!tx.select().from(joviIdentity).where(eq(joviIdentity.id, JOVI_IDENTITY_ID)).get()) {
      tx.insert(joviIdentity)
        .values({
          id: JOVI_IDENTITY_ID,
          name: APPROVED_JOVI_IDENTITY.name,
          creatorName: APPROVED_JOVI_IDENTITY.creatorName,
          activeVersion: 1,
          profile: APPROVED_JOVI_IDENTITY,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      tx.insert(identityVersions)
        .values({
          id: newId('identityVersion'),
          identityId: JOVI_IDENTITY_ID,
          version: 1,
          profile: APPROVED_JOVI_IDENTITY,
          changeSummary: 'Approved identity locked in Phase 5 specification.',
          approvedBy: 'phase-5-specification',
          createdAt: now,
        })
        .run();
      identity = 'created';
    }

    let strategy: SeedReport['strategy'] = 'exists';
    if (!tx.select().from(strategyVersions).get()) {
      tx.insert(strategyVersions)
        .values({
          id: newId('strategyVersion'),
          version: 1,
          name: INITIAL_STRATEGY.name,
          objective: INITIAL_STRATEGY.objective,
          status: 'ACTIVE',
          content: INITIAL_STRATEGY.content,
          rationale: INITIAL_STRATEGY.rationale,
          createdBy: 'phase-5-specification',
          createdAt: now,
          activatedAt: now,
        })
        .run();
      strategy = 'created';
    }

    let memoriesCreated = 0;
    for (const m of SEED_MEMORIES) {
      const result = tx
        .insert(memoryItems)
        .values({
          id: newId('memory'),
          type: m.type,
          key: m.key,
          value: m.value,
          importance: m.importance,
          confidence: m.confidence,
          source: 'seed:phase-5-specification',
          tags: m.tags,
          createdAt: now,
          updatedAt: now,
          expiresAt: null,
        })
        .onConflictDoNothing({ target: [memoryItems.type, memoryItems.key] })
        .run();
      memoriesCreated += result.changes;
    }

    return { identity, strategy, memoriesCreated, memoriesExisting: SEED_MEMORIES.length - memoriesCreated };
  });
}
