import type { KnowledgeBase, KnowledgeMatch } from '../../memory/knowledge/knowledge-base.js';
import type { OperationalMemory } from '../../memory/operational/operational-memory.js';
import type { SemanticMemory } from '../../memory/semantic/semantic-memory.js';
import { truncate } from '../../memory/text.js';
import type { ProviderRegistry } from '../../models/providers/provider-registry.js';
import type { MemoryType } from '../../types/enums.js';
import type { DecisionService } from '../decisions/decision-service.js';
import type { JoviIdentity } from '../identity/identity-schema.js';
import type { IdentityService } from '../identity/identity-service.js';
import { nowIso } from '../ids.js';
import type { StrategyContent } from '../strategy/strategy-schema.js';
import type { StrategyService } from '../strategy/strategy-service.js';

export interface ContextLimits {
  memoryItems: number;
  knowledgeSections: number;
  recentDecisions: number;
  similarConcepts: number;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  memoryItems: 10,
  knowledgeSections: 4,
  recentDecisions: 5,
  similarConcepts: 3,
};

export interface ContextRequest {
  goal: string;
  task: { id: string | null; type: string };
  agent: { name: string; allowedTools: readonly string[]; permissionLevel: string };
  extraConstraints?: readonly string[];
  memoryTypes?: MemoryType[];
  limits?: Partial<ContextLimits>;
}

export interface JoviContext {
  task: { id: string | null; type: string; goal: string };
  identity: { version: number; profile: JoviIdentity };
  strategy: { version: number; name: string; objective: string; content: StrategyContent };
  audiencePhilosophy: {
    communityName: string;
    relationship: Array<{ trait: string; weight: number }>;
    contentPhilosophy: string[];
    followReason: string;
  };
  memory: Array<{ type: string; key: string; value: unknown; importance: number; confidence: number; relevance: number }>;
  knowledge: KnowledgeMatch[];
  recentDecisions: Array<{ id: string; objective: string; selected: string | null; createdAt: string }>;
  similarPastConcepts: Array<{ id: string; text: string; score: number }>;
  resources: {
    availableModels: string[];
    allowedTools: string[];
    permissionLevel: string;
    semanticMemory: string;
  };
  constraints: string[];
  meta: { assembledAt: string; estimatedTokens: number; counts: Record<string, number> };
}

/** Phase 6 standing constraints: the brain proposes; it does not act externally. */
export const BASE_CONSTRAINTS = [
  'Jovi is openly an AI / virtual creator. Never claim or imply she is human.',
  'Respect privacy boundaries: family, exact home locations, private relationships, personal finances and highly personal experiences stay private.',
  'Phase 6 is a controlled brain: propose and decide only. Publishing, messaging or any external action requires later human approval.',
  'Sensual confidence stays tasteful and platform-safe; no explicit content.',
  'Avoid generic influencer templates, corporate AI tone, forced Gen-Z slang and motivational clichés.',
  'Strategy numbers (cadence, mix) are starting guidelines, not rules.',
];

/**
 * Context Engine: assembles current task + identity + strategy + relevant
 * memory + relevant recent decisions + constraints into a structured object.
 * Retrieval is bounded by `limits`, so the model sees the relevant slice —
 * never the whole database.
 */
export class ContextEngine {
  constructor(
    private readonly deps: {
      identity: IdentityService;
      strategy: StrategyService;
      memory: OperationalMemory;
      knowledge: KnowledgeBase;
      semantic: SemanticMemory;
      decisions: DecisionService;
      providers: ProviderRegistry;
    },
  ) {}

  async build(request: ContextRequest): Promise<JoviContext> {
    const limits = { ...DEFAULT_CONTEXT_LIMITS, ...request.limits };
    const identity = this.deps.identity.getActive();
    const strategy = this.deps.strategy.getActive();

    const memory = this.deps.memory
      .search(request.goal, {
        limit: limits.memoryItems,
        ...(request.memoryTypes ? { types: request.memoryTypes } : {}),
      })
      .map((m) => ({
        type: m.type,
        key: m.key,
        value: m.value,
        importance: m.importance,
        confidence: m.confidence,
        relevance: Math.round(m.relevance * 100) / 100,
      }));

    const knowledge = this.deps.knowledge.search(request.goal, limits.knowledgeSections);
    const recentDecisions = this.deps.decisions.recent(limits.recentDecisions).map((d) => ({
      id: d.id,
      objective: truncate(d.objective, 200),
      selected: selectedTitle(d.selectedAction),
      createdAt: d.createdAt,
    }));
    const similarPastConcepts = (await this.deps.semantic.search(request.goal, limits.similarConcepts)).map((m) => ({
      id: m.id,
      text: truncate(m.text, 300),
      score: Math.round(m.score * 100) / 100,
    }));
    const available = await this.deps.providers.available();

    const context: JoviContext = {
      task: { id: request.task.id, type: request.task.type, goal: request.goal },
      identity: { version: identity.version, profile: identity.profile },
      strategy: { version: strategy.version, name: strategy.name, objective: strategy.objective, content: strategy.content },
      audiencePhilosophy: {
        communityName: identity.profile.communityName,
        relationship: identity.profile.audienceRelationship,
        contentPhilosophy: identity.profile.contentPhilosophy,
        followReason: identity.profile.followReason,
      },
      memory,
      knowledge,
      recentDecisions,
      similarPastConcepts,
      resources: {
        availableModels: available.map((s) => `${s.provider}:${s.selectedModel ?? 'n/a'}`),
        allowedTools: [...request.agent.allowedTools],
        permissionLevel: request.agent.permissionLevel,
        semanticMemory: this.deps.semantic.isVectorBacked ? this.deps.semantic.implementation : `${this.deps.semantic.implementation} (lexical, not vector)`,
      },
      constraints: [...BASE_CONSTRAINTS, ...(request.extraConstraints ?? [])],
      meta: { assembledAt: nowIso(), estimatedTokens: 0, counts: {} },
    };
    context.meta.counts = {
      memory: memory.length,
      knowledge: knowledge.length,
      recentDecisions: recentDecisions.length,
      similarPastConcepts: similarPastConcepts.length,
      constraints: context.constraints.length,
    };
    context.meta.estimatedTokens = Math.ceil(this.render(context).length / 4);
    return context;
  }

  /** Compact prompt rendering of the context. */
  render(context: JoviContext): string {
    const p = context.identity.profile;
    const s = context.strategy.content;
    const lines: string[] = [];
    lines.push(`## Identity (v${context.identity.version})`);
    lines.push(`${p.creatorName} (${p.name}), ${p.age}, from ${p.origin}; heritage: ${p.heritage}. ${p.identity}; ${p.creatorIdentity}.`);
    lines.push(`Personality: ${p.personality.join(', ')}.`);
    lines.push(`Voice mix: ${p.voice.mix.map((m) => `${Math.round(m.weight * 100)}% ${m.trait}`).join(', ')}.`);
    lines.push(`Voice principles: ${p.voice.principles.join(', ')}. Never sound like: ${p.voice.neverSoundLike.join(', ')}.`);
    lines.push(`Golden rule: ${p.voice.goldenRule}`);
    lines.push(`Transparency: ${p.transparency.statement} Must never claim to be human.`);
    lines.push(`Lifestyle balance: ${p.lifestyleBalance.join(' ')}`);

    lines.push('', `## Audience philosophy`);
    const ap = context.audiencePhilosophy;
    lines.push(`Community: ${ap.communityName}. Relationship: ${ap.relationship.map((r) => `${Math.round(r.weight * 100)}% ${r.trait}`).join(', ')}.`);
    lines.push(`Content philosophy: ${ap.contentPhilosophy.join(' → ')}. ${ap.followReason}`);

    lines.push('', `## Strategy (v${context.strategy.version}: ${context.strategy.name})`);
    lines.push(`Objective: ${context.strategy.objective}`);
    lines.push(`Approach: ${s.approach} — ${s.approachDescription}`);
    lines.push(`Core pillars: ${s.corePillars.join(', ')}. Supporting: ${s.supportingPillars.join(', ')}.`);
    lines.push(`Formats: ${s.formatPriorities.map((f) => `${f.format} (${f.role})`).join('; ')}.`);
    lines.push(`Cadence (guideline): ${s.cadence.guideline}. Mix (guideline): ${Math.round(s.contentMix.original * 100)}% original / ${Math.round(s.contentMix.trend * 100)}% trend — ${s.contentMix.note}`);
    for (const g of s.guidelines) lines.push(`- ${g}`);

    if (context.memory.length) {
      lines.push('', '## Relevant memory');
      for (const m of context.memory) lines.push(`- [${m.type}] ${m.key}: ${truncate(JSON.stringify(m.value), 320)}`);
    }
    if (context.knowledge.length) {
      lines.push('', '## Relevant knowledge excerpts');
      for (const k of context.knowledge) lines.push(`### ${k.document} › ${k.heading}`, k.excerpt);
    }
    if (context.recentDecisions.length) {
      lines.push('', '## Recent decisions (avoid repeating these concepts)');
      for (const d of context.recentDecisions) lines.push(`- ${d.createdAt.slice(0, 10)}: "${d.objective}" → ${d.selected ?? 'n/a'}`);
    }
    if (context.similarPastConcepts.length) {
      lines.push('', '## Similar past concepts');
      for (const c of context.similarPastConcepts) lines.push(`- ${c.text}`);
    }
    lines.push('', '## Constraints');
    for (const c of context.constraints) lines.push(`- ${c}`);
    return lines.join('\n');
  }

  /** Small summary persisted with agent runs (auditable without duplicating the whole context). */
  static summarize(context: JoviContext): Record<string, unknown> {
    return {
      identityVersion: context.identity.version,
      strategyVersion: context.strategy.version,
      memoryKeys: context.memory.map((m) => `${m.type}:${m.key}`),
      knowledgeSections: context.knowledge.map((k) => `${k.document}#${k.heading}`),
      recentDecisionIds: context.recentDecisions.map((d) => d.id),
      similarConceptIds: context.similarPastConcepts.map((c) => c.id),
      availableModels: context.resources.availableModels,
      constraints: context.constraints.length,
      estimatedTokens: context.meta.estimatedTokens,
    };
  }
}

function selectedTitle(selectedAction: unknown): string | null {
  if (selectedAction && typeof selectedAction === 'object' && 'title' in selectedAction) {
    const title = (selectedAction as { title?: unknown }).title;
    return typeof title === 'string' ? title : null;
  }
  return null;
}
