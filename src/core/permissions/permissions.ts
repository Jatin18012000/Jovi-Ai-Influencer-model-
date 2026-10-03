import { PermissionLevel } from '../../types/enums.js';
import { PermissionDeniedError } from '../errors.js';

export const PERMISSION_ORDER: readonly PermissionLevel[] = PermissionLevel.options;

export const PERMISSION_DESCRIPTIONS: Record<PermissionLevel, string> = {
  LEVEL_0_READ: 'Read identity, strategy, memory, knowledge and history.',
  LEVEL_1_GENERATE: 'Call models to generate proposals, text and evaluations.',
  LEVEL_2_MODIFY: "Write to Jovi's own operational state (decisions, memory).",
  LEVEL_3_EXECUTE: 'Create and run internal tasks/jobs.',
  LEVEL_4_EXTERNAL_ACTION: 'Act outside the system (publish, message, trigger n8n). Not granted in Phase 6.',
  LEVEL_5_INFRASTRUCTURE: 'Modify infrastructure, credentials, shell or filesystem. Never granted to agents.',
};

export function permissionRank(level: PermissionLevel): number {
  return PERMISSION_ORDER.indexOf(level);
}

export function atLeast(granted: PermissionLevel, required: PermissionLevel): boolean {
  return permissionRank(granted) >= permissionRank(required);
}

export function minLevel(a: PermissionLevel, b: PermissionLevel): PermissionLevel {
  return permissionRank(a) <= permissionRank(b) ? a : b;
}

export function maxLevel(a: PermissionLevel, b: PermissionLevel): PermissionLevel {
  return permissionRank(a) >= permissionRank(b) ? a : b;
}

/**
 * Tools are the only way an agent touches the world. Each tool declares the
 * permission level it requires. There is deliberately no shell, filesystem or
 * credential tool: model output can never be executed as a command.
 */
export const TOOL_REGISTRY = {
  'identity.read': { level: 'LEVEL_0_READ', description: 'Read the active Jovi identity.' },
  'strategy.read': { level: 'LEVEL_0_READ', description: 'Read the active strategy version.' },
  'memory.read': { level: 'LEVEL_0_READ', description: 'Read operational memory.' },
  'knowledge.read': { level: 'LEVEL_0_READ', description: 'Read the Markdown knowledge base.' },
  'decision.read': { level: 'LEVEL_0_READ', description: 'Read past decisions.' },
  'agent.read': { level: 'LEVEL_0_READ', description: 'Read the agent directory (names, permission levels).' },
  'model.generate': { level: 'LEVEL_1_GENERATE', description: 'Generate via the Model Router.' },
  'model.evaluate': { level: 'LEVEL_1_GENERATE', description: 'Evaluate options via the Evaluator.' },
  'decision.write': { level: 'LEVEL_2_MODIFY', description: 'Persist decisions.' },
  'memory.write': { level: 'LEVEL_2_MODIFY', description: 'Persist operational memory.' },
  'production.read': { level: 'LEVEL_0_READ', description: 'Read creative production artifacts and asset records.' },
  // R-10: artifact writes are scoped per kind, so an agent can only persist the artifact it owns
  // (e.g. only the QA agent can write a QA_REPORT, which sets qaStatus).
  'production.write:SCRIPT': { level: 'LEVEL_2_MODIFY', description: 'Persist the production script.' },
  'production.write:STORYBOARD': { level: 'LEVEL_2_MODIFY', description: 'Persist the production storyboard.' },
  'production.write:VISUAL_PROMPTS': { level: 'LEVEL_2_MODIFY', description: 'Persist identity-locked visual prompts.' },
  'production.write:SAFETY_REVIEW': { level: 'LEVEL_2_MODIFY', description: 'Persist the pre-generation safety review.' },
  'production.write:EDIT_PLAN': { level: 'LEVEL_2_MODIFY', description: 'Persist the edit decision list.' },
  'production.write:QA_REPORT': { level: 'LEVEL_2_MODIFY', description: 'Persist the QA report (sets the QA status).' },
  'task.create': { level: 'LEVEL_3_EXECUTE', description: 'Create internal follow-up tasks.' },
  'media.image.generate': { level: 'LEVEL_3_EXECUTE', description: 'Request image generation from a registered image provider.' },
  'media.video.generate': { level: 'LEVEL_3_EXECUTE', description: 'Request video generation from a registered video provider.' },
  'media.voice.generate': { level: 'LEVEL_3_EXECUTE', description: 'Request speech synthesis from a registered voice provider.' },
  'media.edit.render': { level: 'LEVEL_3_EXECUTE', description: 'Request a render of an edit plan from a registered editing engine.' },
  'social.publish': { level: 'LEVEL_4_EXTERNAL_ACTION', description: 'Publish to social platforms (future).' },
  'n8n.trigger': { level: 'LEVEL_4_EXTERNAL_ACTION', description: 'Trigger external automation (future).' },
  'infrastructure.modify': { level: 'LEVEL_5_INFRASTRUCTURE', description: 'Modify infrastructure (never for agents).' },
} as const satisfies Record<string, { level: PermissionLevel; description: string }>;

export type ToolName = keyof typeof TOOL_REGISTRY;

export function isToolName(value: string): value is ToolName {
  return Object.hasOwn(TOOL_REGISTRY, value);
}

/**
 * Per-agent permission guard. Effective level = min(agent grant, deployment
 * ceiling). A tool must be both on the agent's allow-list and within level.
 */
export class PermissionGuard {
  readonly effectiveLevel: PermissionLevel;

  constructor(
    readonly agentName: string,
    grantedLevel: PermissionLevel,
    private readonly allowedTools: readonly ToolName[],
    ceiling: PermissionLevel,
  ) {
    this.effectiveLevel = minLevel(grantedLevel, ceiling);
  }

  can(tool: ToolName): boolean {
    return this.allowedTools.includes(tool) && atLeast(this.effectiveLevel, TOOL_REGISTRY[tool].level);
  }

  assert(tool: ToolName): void {
    if (!this.allowedTools.includes(tool)) {
      throw new PermissionDeniedError(`Agent ${this.agentName} is not allowed to use tool ${tool}`, { tool });
    }
    const required = TOOL_REGISTRY[tool].level;
    if (!atLeast(this.effectiveLevel, required)) {
      throw new PermissionDeniedError(`Agent ${this.agentName} lacks ${required} for tool ${tool}`, {
        tool,
        required,
        effective: this.effectiveLevel,
      });
    }
  }

  /**
   * Classifies a free-text proposed action by the permission level its text
   * implies. This is a floor, not the verdict: see `requiredLevelForAction`,
   * which also applies the owning agent's declared level.
   */
  static classifyAction(action: string): PermissionLevel {
    const text = action.toLowerCase();
    if (/\b(deploy|infrastructure|server|credential|api key|shell|terminal|delete (the )?database)\b/.test(text)) {
      return 'LEVEL_5_INFRASTRUCTURE';
    }
    // R-16: destructive and filesystem operations. Content words that collide with
    // creator language ("drop a reel", "reel format", "killing it") only count in their technical form.
    if (
      /(^|[\s;&|`(])(sudo|rm|rmdir|mkfs|dd|shred|chmod|chown|killall|pkill)(\s|$)/.test(text) ||
      /\b(delete|deleting|deleted|wipe|wiping|wiped|erase|erasing|truncate|purge|destroy|overwrite)\b/.test(text) ||
      /\b(re-?format|format(ting)? (the |a |my )?(disk|drive|hard drive|volume|partition))\b/.test(text) ||
      /\bdrop (the )?(table|database|schema|collection|index)\b/.test(text) ||
      /\b(file ?system|kill -9|shut ?down|reboot)\b/.test(text)
    ) {
      return 'LEVEL_5_INFRASTRUCTURE';
    }
    const external =
      /\b(publish|post(ing|ed)?|upload|go(ing)? live|schedul(e|ing)|send|email|e-mail|dm|message|reply|comment|tag|share|launch ads?|boost|promot(e|ion)|pitch|contact|outreach|collab request)\b/.test(
        text,
      ) || /\b(instagram|tiktok|youtube|threads|facebook|twitter|x\.com|snapchat|linkedin|pinterest)\b/.test(text);
    if (external) {
      return 'LEVEL_4_EXTERNAL_ACTION';
    }
    if (/\b(generate|render|create (the )?(image|video|visual)|produce|film|shoot)\b/.test(text)) {
      return 'LEVEL_3_EXECUTE';
    }
    return 'LEVEL_1_GENERATE';
  }
}

/**
 * Level a proposed next action requires: the higher of what its text implies
 * and the declared permission level of the agent that would perform it. An
 * action owned by the publishing agent is external no matter how it is worded.
 */
export function requiredLevelForAction(action: string, owningAgentLevel: PermissionLevel | null): PermissionLevel {
  const textual = PermissionGuard.classifyAction(action);
  return owningAgentLevel ? maxLevel(textual, owningAgentLevel) : textual;
}
