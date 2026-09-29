import type { JoviDatabase } from '../database/client.js';
import { agents } from '../database/schema.js';
import { nowIso } from '../core/ids.js';
import type { AgentDefinition, AnyAgent } from './agent.js';

export interface RegisteredAgent {
  definition: AgentDefinition;
  status: 'ACTIVE' | 'PLANNED';
}

/**
 * Registry of agents. Active agents are executable; planned agents are the
 * Phase 5 roadmap (definitions only) so the system can describe — and the
 * Executive can hand work to — capabilities that arrive in later phases.
 */
export class AgentRegistry {
  private readonly active = new Map<string, AnyAgent>();
  private readonly planned = new Map<string, AgentDefinition>();

  register(agent: AnyAgent): void {
    this.active.set(agent.definition.name, agent);
    this.planned.delete(agent.definition.name);
  }

  registerPlanned(definition: AgentDefinition): void {
    if (!this.active.has(definition.name)) this.planned.set(definition.name, definition);
  }

  get(name: string): AnyAgent | undefined {
    return this.active.get(name);
  }

  list(): RegisteredAgent[] {
    return [
      ...[...this.active.values()].map((a) => ({ definition: a.definition, status: 'ACTIVE' as const })),
      ...[...this.planned.values()].map((d) => ({ definition: d, status: 'PLANNED' as const })),
    ];
  }

  syncToDatabase(db: JoviDatabase): void {
    const now = nowIso();
    db.transaction((tx) => {
      for (const { definition: d, status } of this.list()) {
        const row = {
          name: d.name,
          version: d.version,
          description: d.description,
          status,
          capabilities: [...d.capabilities],
          allowedTools: [...d.allowedTools],
          permissionLevel: d.permissionLevel,
          modelRequirements: d.modelRequirements,
          costClass: d.costClass,
          riskLevel: d.riskLevel,
          updatedAt: now,
        };
        tx.insert(agents)
          .values({ id: d.name, ...row, createdAt: now })
          .onConflictDoUpdate({ target: agents.id, set: row })
          .run();
      }
    });
  }
}
