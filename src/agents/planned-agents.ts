import type { AgentDefinition } from './agent.js';

/**
 * Remaining roadmap agents (definitions only). Research/trends/strategy/
 * ideation (Phase 7) and script/storyboard/visual-prompt/image/video/voice/
 * editing/qa (Phase 8) are ACTIVE and registered by their pipelines.
 * Publishing stays PLANNED: it is LEVEL_4 and above the deployment ceiling.
 */
const planned = (d: Omit<AgentDefinition, 'version'>): AgentDefinition => ({ version: '0.0.0-planned', ...d });

const generation = { defaultTier: 'NORMAL', privacy: 'STANDARD', latency: 'STANDARD', structuredOutput: true } as const;

export const PLANNED_AGENTS: AgentDefinition[] = [
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
