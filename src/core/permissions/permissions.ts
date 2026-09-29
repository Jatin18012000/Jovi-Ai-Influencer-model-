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
  'model.generate': { level: 'LEVEL_1_GENERATE', description: 'Generate via the Model Router.' },
  'model.evaluate': { level: 'LEVEL_1_GENERATE', description: 'Evaluate options via the Evaluator.' },
  'decision.write': { level: 'LEVEL_2_MODIFY', description: 'Persist decisions.' },
  'memory.write': { level: 'LEVEL_2_MODIFY', description: 'Persist operational memory.' },
  'task.create': { level: 'LEVEL_3_EXECUTE', description: 'Create internal follow-up tasks.' },
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

  /** Classifies a free-text proposed action by the permission level it would need. */
  static classifyAction(action: string): PermissionLevel {
    const text = action.toLowerCase();
    if (/\b(deploy|infrastructure|server|credential|api key|shell|terminal|delete (the )?database)\b/.test(text)) {
      return 'LEVEL_5_INFRASTRUCTURE';
    }
    if (/\b(publish|post(ing)? (it|to|on)|upload|go live|schedule (the )?post|send (a )?(dm|message|email)|dm |reply to|comment on|launch ads?|boost)\b/.test(text)) {
      return 'LEVEL_4_EXTERNAL_ACTION';
    }
    if (/\b(generate|render|create (the )?(image|video|visual)|produce|film|shoot)\b/.test(text)) {
      return 'LEVEL_3_EXECUTE';
    }
    return 'LEVEL_1_GENERATE';
  }
}
