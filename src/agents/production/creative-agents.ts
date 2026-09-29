import { z } from 'zod';
import { InvalidModelOutputError } from '../../core/errors.js';
import { identityPromptVariables, renderIdentityBrief } from '../../core/identity/identity-prompt.js';
import type { JoviIdentity } from '../../core/identity/identity-schema.js';
import { renderCharacterLock, type ActiveVisualIdentity } from '../../core/identity/visual-identity.js';
import type { PromptLibrary } from '../../core/prompts/prompt-library.js';
import { escapeData } from '../../core/orchestrator/context-engine.js';
import { parseModelJson } from '../../models/json-output.js';
import type { RoutingTier } from '../../types/enums.js';
import type { Agent, AgentDefinition, AgentRunContext } from '../agent.js';
import { assertIdentityPreserved } from './identity-guard.js';
import {
  ProductionContextSchema,
  ProductionIdeaSchema,
  ScriptSchema,
  StoryboardSchema,
  VisualPromptDraftSchema,
  VisualPromptsSchema,
  type Script,
  type Storyboard,
  type VisualPrompts,
} from './production-schemas.js';

const TEXT_TOOLS = ['identity.read', 'strategy.read', 'knowledge.read', 'production.read', 'production.write', 'model.generate'] as const;
const textAgent = (name: string, description: string, capabilities: string[], tier: RoutingTier): AgentDefinition => ({
  name,
  version: '0.1.0',
  description,
  capabilities,
  allowedTools: [...TEXT_TOOLS],
  permissionLevel: 'LEVEL_2_MODIFY',
  modelRequirements: { defaultTier: tier, privacy: 'STANDARD', latency: 'STANDARD', structuredOutput: true },
  costClass: 'MEDIUM',
  riskLevel: 'MEDIUM',
});

export const SCRIPT_AGENT_DEFINITION = textAgent('script', 'Writes a structured, voice-true production script from a Phase 7 idea.', ['scriptwriting', 'dialogue', 'on-screen-text'], 'HIGH');
export const STORYBOARD_AGENT_DEFINITION = textAgent('storyboard', 'Turns a script into a continuity-safe, scene-by-scene storyboard.', ['storyboarding', 'shot-design', 'continuity'], 'NORMAL');
export const VISUAL_PROMPT_AGENT_DEFINITION = textAgent('visual-prompt', 'Converts storyboard scenes into identity-locked image and video generation prompts.', ['prompt-engineering', 'visual-consistency'], 'NORMAL');

/** Safety negatives appended to every visual prompt (never model-controlled). */
export const STANDARD_NEGATIVES =
  'real person likeness, celebrity, lookalike, minor, childlike features, nudity, explicit content, watermark, logo, text artifacts, distorted face, inconsistent face, extra fingers, deformed hands';

export interface CreativeContext {
  identity: JoviIdentity;
  identityVersion: number;
  visual: ActiveVisualIdentity;
}

/**
 * Shared behaviour for text-producing creative agents: read identity through
 * the ToolKit, route generation through the Model Router (never a fixed
 * provider), validate with Zod + the identity guard, persist via ToolKit.
 */
abstract class CreativeTextAgent<I extends { productionId: string; privacy?: string }, O> implements Agent<I, O, CreativeContext> {
  abstract readonly definition: AgentDefinition;
  abstract readonly inputSchema: z.ZodType<I>;
  abstract readonly outputSchema: z.ZodType<O>;
  protected abstract readonly role: string;
  protected abstract readonly taskType: string;
  protected abstract readonly artifactKind: 'SCRIPT' | 'STORYBOARD' | 'VISUAL_PROMPTS';

  constructor(protected readonly prompts: PromptLibrary) {}

  async loadContext(_input: I, ctx: AgentRunContext): Promise<CreativeContext> {
    const identity = ctx.tools.identity.getActive();
    return { identity: identity.profile, identityVersion: identity.version, visual: ctx.tools.identity.getVisual() };
  }

  summarizeContext(context: CreativeContext): Record<string, unknown> {
    return { identityVersion: context.identityVersion, visualIdentityVersion: context.visual.version, visualIdentityStatus: context.visual.status };
  }

  protected abstract userPrompt(input: I, context: CreativeContext, ctx: AgentRunContext): string;
  protected abstract parse(text: string, input: I, context: CreativeContext): O;

  async execute(input: I, context: CreativeContext, ctx: AgentRunContext): Promise<O> {
    const tier = this.definition.modelRequirements.defaultTier;
    const privacy = (input.privacy as 'STANDARD' | 'SENSITIVE' | 'LOCAL_ONLY' | undefined) ?? 'STANDARD';
    const routed = await ctx.tools.models.generate(
      {
        task: { type: this.taskType, description: this.definition.description },
        context: {
          system: this.prompts.render('production/creative-system', { ...identityPromptVariables(context.identity), role: this.role }),
          prompt: this.userPrompt(input, context, ctx),
        },
        requirements: { json: true, temperature: 0.6, maxOutputTokens: 6000 },
      },
      { taskType: this.taskType, complexity: tier, quality: tier, privacy, costClass: 'MEDIUM', latency: 'STANDARD' },
      this.taskType,
      (text) => this.parse(text, input, context),
    );
    return routed.parsed;
  }

  persist(output: O, input: I, ctx: AgentRunContext): void {
    ctx.tools.production.saveArtifact(input.productionId, this.artifactKind, output);
  }

  protected identityBlock(context: CreativeContext): string {
    return escapeData(renderIdentityBrief(context.identity));
  }

  protected visualBlock(context: CreativeContext): string {
    const v = context.visual;
    const anchors = Object.entries(v.profile)
      .filter(([k]) => ['face', 'hair', 'eyes', 'skin', 'beautyMark', 'body', 'signatureStyle'].includes(k))
      .map(([k, val]) => `${k}: ${val ?? 'NOT LOCKED — do not invent'}`);
    return escapeData(
      [`Visual identity v${v.version} (${v.status}). Apparent age ${v.profile.apparentAge}; original virtual character; must not resemble real people.`, `Aesthetic: ${v.profile.aesthetic}`, ...anchors, `Safety: ${v.profile.platformSafety}`].join('\n'),
    );
  }
}

const withPrivacy = { privacy: z.enum(['STANDARD', 'SENSITIVE', 'LOCAL_ONLY']).optional() };

// ---------------------------------------------------------------------------
// Script Agent
// ---------------------------------------------------------------------------

export const ScriptAgentInputSchema = z.object({
  productionId: z.string().min(1),
  idea: ProductionIdeaSchema,
  productionContext: ProductionContextSchema,
  ...withPrivacy,
});
export type ScriptAgentInput = z.infer<typeof ScriptAgentInputSchema>;

export class ScriptAgent extends CreativeTextAgent<ScriptAgentInput, Script> {
  readonly definition = SCRIPT_AGENT_DEFINITION;
  readonly inputSchema = ScriptAgentInputSchema;
  readonly outputSchema = ScriptSchema;
  protected readonly role = 'Script Agent';
  protected readonly taskType = 'production.script';
  protected readonly artifactKind = 'SCRIPT' as const;

  protected userPrompt(input: ScriptAgentInput, context: CreativeContext, ctx: AgentRunContext): string {
    const voice = ctx.tools.knowledge
      .search('voice guide golden rule never sound like', 2, 900)
      .map((k) => `${k.heading}: ${k.excerpt}`)
      .join('\n');
    return this.prompts.render('production/script', {
      identity: this.identityBlock(context),
      idea_json: escapeData(JSON.stringify(input.idea, null, 2)),
      context_json: escapeData(JSON.stringify(input.productionContext, null, 2)),
      voice_reference: escapeData(voice),
      creator_name: context.identity.creatorName,
      community_name: context.identity.communityName,
    });
  }

  protected parse(text: string, _input: ScriptAgentInput, context: CreativeContext): Script {
    const script = parseModelJson(ScriptSchema, text);
    assertIdentityPreserved(
      [script.hook, script.cta, ...script.sections.flatMap((s) => [...s.dialogue.map((d) => d.line), ...s.onScreenText])],
      context.identity,
    );
    return script;
  }
}

// ---------------------------------------------------------------------------
// Storyboard Agent
// ---------------------------------------------------------------------------

export const StoryboardAgentInputSchema = z.object({
  productionId: z.string().min(1),
  idea: ProductionIdeaSchema,
  script: ScriptSchema,
  aspectRatio: z.enum(['9:16', '4:5', '1:1', '16:9']).default('9:16'),
  ...withPrivacy,
});
export type StoryboardAgentInput = z.infer<typeof StoryboardAgentInputSchema>;

export class StoryboardAgent extends CreativeTextAgent<StoryboardAgentInput, Storyboard> {
  readonly definition = STORYBOARD_AGENT_DEFINITION;
  readonly inputSchema = StoryboardAgentInputSchema;
  readonly outputSchema = StoryboardSchema;
  protected readonly role = 'Storyboard Agent';
  protected readonly taskType = 'production.storyboard';
  protected readonly artifactKind = 'STORYBOARD' as const;

  protected userPrompt(input: StoryboardAgentInput, context: CreativeContext): string {
    return this.prompts.render('production/storyboard', {
      identity: this.identityBlock(context),
      visual_identity: this.visualBlock(context),
      idea_json: escapeData(JSON.stringify(input.idea, null, 2)),
      script_json: escapeData(JSON.stringify(input.script, null, 2)),
      aspect_ratio: input.aspectRatio,
    });
  }

  protected parse(text: string, input: StoryboardAgentInput, context: CreativeContext): Storyboard {
    const board = parseModelJson(StoryboardSchema, text);
    // The requested aspect ratio is a production decision, not a model choice.
    const storyboard: Storyboard = { ...board, aspectRatio: input.aspectRatio };
    const known = new Set(input.script.sections.map((s) => s.sectionId));
    const orphan = storyboard.scenes.find((s) => !known.has(s.sectionId));
    if (orphan) throw new InvalidModelOutputError(`scene ${orphan.sceneId} references unknown script section ${orphan.sectionId}`);
    assertIdentityPreserved(
      storyboard.scenes.flatMap((s) => [s.joviAppearance, s.action, s.subject, ...s.onScreenText]),
      context.identity,
      { likeness: true },
    );
    return storyboard;
  }
}

// ---------------------------------------------------------------------------
// Visual Prompt Agent
// ---------------------------------------------------------------------------

export const VisualPromptAgentInputSchema = z.object({
  productionId: z.string().min(1),
  storyboard: StoryboardSchema,
  ...withPrivacy,
});
export type VisualPromptAgentInput = z.infer<typeof VisualPromptAgentInputSchema>;

export class VisualPromptAgent extends CreativeTextAgent<VisualPromptAgentInput, VisualPrompts> {
  readonly definition = VISUAL_PROMPT_AGENT_DEFINITION;
  readonly inputSchema = VisualPromptAgentInputSchema;
  readonly outputSchema = VisualPromptsSchema;
  protected readonly role = 'Visual Prompt Agent';
  protected readonly taskType = 'production.visual_prompts';
  protected readonly artifactKind = 'VISUAL_PROMPTS' as const;

  protected userPrompt(input: VisualPromptAgentInput, context: CreativeContext): string {
    return this.prompts.render('production/visual-prompts', {
      visual_identity: this.visualBlock(context),
      storyboard_json: escapeData(JSON.stringify(input.storyboard, null, 2)),
      creator_name: context.identity.creatorName,
    });
  }

  /**
   * The model writes scene descriptions; identity, safety, aspect ratio and
   * duration are then imposed structurally from the active visual identity and
   * the storyboard — the model cannot override them.
   */
  protected parse(text: string, input: VisualPromptAgentInput, context: CreativeContext): VisualPrompts {
    const draft = parseModelJson(VisualPromptDraftSchema, text);
    assertIdentityPreserved(
      draft.prompts.flatMap((p) => [p.imagePrompt, p.videoPrompt]),
      context.identity,
      { likeness: true },
    );
    const characterLock = renderCharacterLock(context.visual, context.identity.creatorName);
    const byScene = new Map(draft.prompts.map((p) => [p.sceneId, p]));
    const missing = input.storyboard.scenes.filter((s) => !byScene.has(s.sceneId)).map((s) => s.sceneId);
    if (missing.length) {
      throw new InvalidModelOutputError(`missing prompts for scenes: ${missing.join(', ')}`);
    }
    return {
      globalStyle: draft.globalStyle,
      visualIdentityVersion: context.visual.version,
      prompts: input.storyboard.scenes.map((scene) => {
        const p = byScene.get(scene.sceneId)!;
        const lock = scene.featuresJovi ? `${characterLock} ` : '';
        return {
          sceneId: scene.sceneId,
          imagePrompt: `${lock}${p.imagePrompt} Global style: ${draft.globalStyle}`,
          videoPrompt: `${lock}${p.videoPrompt}`,
          negativePrompt: [p.negativePrompt, STANDARD_NEGATIVES].filter(Boolean).join(', '),
          characterConsistency: scene.featuresJovi ? characterLock : 'Scene does not feature Jovi.',
          environmentConsistency: p.environmentConsistency,
          wardrobeConsistency: p.wardrobeConsistency,
          cameraSpecification: p.cameraSpecification,
          lightingSpecification: p.lightingSpecification,
          aspectRatio: input.storyboard.aspectRatio,
          targetDurationSeconds: scene.durationSeconds,
          featuresJovi: scene.featuresJovi,
        };
      }),
    };
  }
}
