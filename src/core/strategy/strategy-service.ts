import { desc, eq } from 'drizzle-orm';
import type { JoviDatabase } from '../../database/client.js';
import { strategyVersions } from '../../database/schema.js';
import { NotFoundError } from '../errors.js';
import { newId, nowIso } from '../ids.js';
import { StrategyContentSchema, type StrategyContent } from './strategy-schema.js';

export interface StrategyVersion {
  id: string;
  version: number;
  name: string;
  objective: string;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  content: StrategyContent;
  rationale: string;
  createdBy: string;
  createdAt: string;
  activatedAt: string | null;
}

/**
 * Versioned strategy. Strategy is data, not code: new versions supersede old
 * ones so the Learning/Strategy agents can evolve it without redeploys.
 */
export class StrategyService {
  constructor(private readonly db: JoviDatabase) {}

  getActive(): StrategyVersion {
    const row = this.db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.status, 'ACTIVE'))
      .orderBy(desc(strategyVersions.version))
      .get();
    if (!row) throw new NotFoundError('StrategyVersion', 'ACTIVE');
    return this.toModel(row);
  }

  list(): StrategyVersion[] {
    return this.db.select().from(strategyVersions).orderBy(desc(strategyVersions.version)).all().map((r) => this.toModel(r));
  }

  /** Creates and activates a new version, archiving the previous active one. */
  createVersion(input: {
    name: string;
    objective: string;
    content: StrategyContent;
    rationale: string;
    createdBy: string;
  }): StrategyVersion {
    const content = StrategyContentSchema.parse(input.content);
    return this.db.transaction((tx) => {
      const latest = tx.select().from(strategyVersions).orderBy(desc(strategyVersions.version)).get();
      const version = (latest?.version ?? 0) + 1;
      tx.update(strategyVersions).set({ status: 'ARCHIVED' }).where(eq(strategyVersions.status, 'ACTIVE')).run();
      const now = nowIso();
      const row = {
        id: newId('strategyVersion'),
        version,
        name: input.name,
        objective: input.objective,
        status: 'ACTIVE' as const,
        content,
        rationale: input.rationale,
        createdBy: input.createdBy,
        createdAt: now,
        activatedAt: now,
      };
      tx.insert(strategyVersions).values(row).run();
      return this.toModel(row);
    });
  }

  private toModel(row: typeof strategyVersions.$inferSelect): StrategyVersion {
    return {
      id: row.id,
      version: row.version,
      name: row.name,
      objective: row.objective,
      status: row.status,
      content: StrategyContentSchema.parse(row.content),
      rationale: row.rationale,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      activatedAt: row.activatedAt,
    };
  }
}
