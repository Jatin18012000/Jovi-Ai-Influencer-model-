import type { AgentDefinition } from './agent.js';

/**
 * Phase 5 agent roadmap. These are *definitions only* in Phase 6: they are
 * registered as PLANNED so the architecture's boundaries are explicit, and
 * the Executive Agent can name them as owners of next actions.
 */
const planned = (d: Omit<AgentDefinition, 'version'>): AgentDefinition => ({ version: '0.0.0-planned', ...d });

const generation = { defaultTier: 'NORMAL', privacy: 'STANDARD', latency: 'STANDARD', structuredOutput: true } as const;

export const PLANNED_AGENTS: AgentDefinition[] = [
  planned({
    name: 'research',
    description: 'Researches topics, places, brands and audiences to ground ideas in facts.',
    capabilities: ['topic-research', 'fact-gathering'],
    allowedTools: ['memory.read', 'knowledge.read', 'model.generate'],
    permissionLevel: 'LEVEL_1_GENERATE',
    modelRequirements: generation,
    costClass: 'MEDIUM',
    riskLevel: 'LOW',
  }),
  planned({
    name: 'trends',
    description: 'Detects relevant trends and sounds and judges fit with Jovi.',
    capabilities: ['trend-detection', 'trend-fit-scoring'],
    allowedTools: ['memory.read', 'model.generate'],
    permissionLevel: 'LEVEL_1_GENERATE',
    modelRequirements: { ...generation, defaultTier: 'LOW' },
    costClass: 'LOW',
    riskLevel: 'LOW',
  }),
  planned({
    name: 'strategy',
    description: 'Proposes new strategy versions from performance and learning.',
    capabilities: ['strategy-proposal'],
    allowedTools: ['strategy.read', 'memory.read', 'decision.read', 'model.generate'],
    permissionLevel: 'LEVEL_1_GENERATE',
    modelRequirements: { ...generation, defaultTier: 'STRATEGIC' },
    costClass: 'HIGH',
    riskLevel: 'MEDIUM',
  }),
  planned({
    name: 'ideation',
    description: 'Generates wide pools of content ideas per pillar.',
    capabilities: ['idea-generation'],
    allowedTools: ['memory.read', 'knowledge.read', 'model.generate'],
    permissionLevel: 'LEVEL_1_GENERATE',
    modelRequirements: generation,
    costClass: 'MEDIUM',
    riskLevel: 'LOW',
  }),
  planned({
    name: 'script',
    description: "Writes scripts, captions and on-screen text in Jovi's voice.",
    capabilities: ['scriptwriting', 'captioning'],
    allowedTools: ['memory.read', 'knowledge.read', 'model.generate'],
    permissionLevel: 'LEVEL_1_GENERATE',
    modelRequirements: { ...generation, defaultTier: 'HIGH' },
    costClass: 'MEDIUM',
    riskLevel: 'MEDIUM',
  }),
  planned({
    name: 'visual',
    description: 'Plans shots and drives image/video generation (ComfyUI/Flow) within the visual bible.',
    capabilities: ['shot-planning', 'visual-generation'],
    allowedTools: ['knowledge.read', 'model.generate'],
    permissionLevel: 'LEVEL_3_EXECUTE',
    modelRequirements: generation,
    costClass: 'HIGH',
    riskLevel: 'MEDIUM',
  }),
  planned({
    name: 'qa',
    description: 'Checks content against voice, visual consistency, privacy and platform rules.',
    capabilities: ['brand-qa', 'safety-qa'],
    allowedTools: ['knowledge.read', 'model.evaluate'],
    permissionLevel: 'LEVEL_1_GENERATE',
    modelRequirements: { ...generation, defaultTier: 'HIGH' },
    costClass: 'MEDIUM',
    riskLevel: 'LOW',
  }),
  planned({
    name: 'publishing',
    description: 'Schedules and publishes approved content. Requires LEVEL_4 and human approval.',
    capabilities: ['scheduling', 'publishing'],
    allowedTools: ['social.publish', 'n8n.trigger'],
    permissionLevel: 'LEVEL_4_EXTERNAL_ACTION',
    modelRequirements: { ...generation, defaultTier: 'LOW' },
    costClass: 'LOW',
    riskLevel: 'HIGH',
  }),
  planned({
    name: 'analytics',
    description: 'Collects and interprets performance data.',
    capabilities: ['metrics-ingestion', 'performance-analysis'],
    allowedTools: ['memory.read', 'model.generate'],
    permissionLevel: 'LEVEL_1_GENERATE',
    modelRequirements: { ...generation, defaultTier: 'LOW' },
    costClass: 'LOW',
    riskLevel: 'LOW',
  }),
  planned({
    name: 'learning',
    description: 'Turns results into LEARNING memory and strategy recommendations.',
    capabilities: ['learning-extraction'],
    allowedTools: ['memory.read', 'memory.write', 'model.generate'],
    permissionLevel: 'LEVEL_2_MODIFY',
    modelRequirements: generation,
    costClass: 'MEDIUM',
    riskLevel: 'MEDIUM',
  }),
];
