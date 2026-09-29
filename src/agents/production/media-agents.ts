import { z } from 'zod';
import type { MediaAsset } from '../../core/production/asset-service.js';
import { ASPECT_RATIO_SIZES, AspectRatio, type VoiceProfile } from '../../media/types.js';
import type { MediaKind } from '../../types/enums.js';
import type { Agent, AgentDefinition, AgentRunContext } from '../agent.js';
import { EditPlanSchema, MediaAgentOutputSchema, ScriptSchema, StoryboardSchema, VisualPromptSceneSchema, type EditPlan, type MediaAgentOutput } from './production-schemas.js';

const mediaAgent = (name: string, description: string, tool: 'media.image.generate' | 'media.video.generate' | 'media.voice.generate', capabilities: string[]): AgentDefinition => ({
  name,
  version: '0.1.0',
  description,
  capabilities,
  // Media agents can read identity and production state and request ONE media kind. Nothing else.
  allowedTools: ['identity.read', 'production.read', tool],
  permissionLevel: 'LEVEL_3_EXECUTE',
  modelRequirements: { defaultTier: 'LOW', privacy: 'STANDARD', latency: 'BATCH', structuredOutput: false },
  costClass: 'HIGH',
  riskLevel: 'MEDIUM',
});

export const IMAGE_AGENT_DEFINITION = mediaAgent('image-generation', 'Requests identity-locked scene images from the registered image provider (e.g. ComfyUI).', 'media.image.generate', ['image-generation']);
export const VIDEO_AGENT_DEFINITION = mediaAgent('video-generation', 'Requests scene videos from the registered video provider, conditioned on scene images when supported.', 'media.video.generate', ['video-generation']);
export const VOICE_AGENT_DEFINITION = mediaAgent('voice', "Requests speech for Jovi's script lines from the registered voice provider.", 'media.voice.generate', ['speech-synthesis']);

export const EDITING_AGENT_DEFINITION: AgentDefinition = {
  name: 'editing',
  version: '0.1.0',
  description: 'Builds a structured edit decision list from storyboard, script and real asset states; requests a render when an editing engine exists.',
  capabilities: ['edit-planning', 'captioning', 'render-request'],
  allowedTools: ['production.read', 'production.write', 'media.edit.render'],
  permissionLevel: 'LEVEL_3_EXECUTE',
  modelRequirements: { defaultTier: 'LOW', privacy: 'STANDARD', latency: 'BATCH', structuredOutput: false },
  costClass: 'LOW',
  riskLevel: 'LOW',
};

function summarize(kind: MediaKind, assets: MediaAsset[]): MediaAgentOutput {
  const counts: Record<string, number> = {};
  for (const a of assets) counts[a.status] = (counts[a.status] ?? 0) + 1;
  return {
    kind,
    assets: assets.map((a) => ({ assetId: a.id, kind: a.kind as MediaKind, sceneId: a.sceneId, status: a.status as MediaAgentOutput['assets'][number]['status'], provider: a.provider, reason: a.statusReason })),
    counts,
  };
}

/** Media agents need no LLM context; they act on validated upstream artifacts. */
type NoContext = null;
abstract class MediaAgent<I> implements Agent<I, MediaAgentOutput, NoContext> {
  abstract readonly definition: AgentDefinition;
  abstract readonly inputSchema: z.ZodType<I>;
  readonly outputSchema = MediaAgentOutputSchema;
  async loadContext(): Promise<NoContext> {
    return null;
  }
  abstract execute(input: I, context: NoContext, ctx: AgentRunContext): Promise<MediaAgentOutput>;
}

// ---------------------------------------------------------------------------
// Image Generation Agent
// ---------------------------------------------------------------------------

export const ImageAgentInputSchema = z.object({
  productionId: z.string().min(1),
  prompts: z.array(VisualPromptSceneSchema).min(1),
});
export type ImageAgentInput = z.infer<typeof ImageAgentInputSchema>;

export class ImageGenerationAgent extends MediaAgent<ImageAgentInput> {
  readonly definition = IMAGE_AGENT_DEFINITION;
  readonly inputSchema = ImageAgentInputSchema;

  async execute(input: ImageAgentInput, _c: NoContext, ctx: AgentRunContext): Promise<MediaAgentOutput> {
    const visual = ctx.tools.identity.getVisual();
    const assets: MediaAsset[] = [];
    // Sequential per scene: local GPUs render one job at a time, and order keeps continuity reviewable.
    for (const p of input.prompts) {
      assets.push(
        await ctx.tools.media.generateImage({
          productionId: input.productionId,
          sceneId: p.sceneId,
          aspectRatio: p.aspectRatio,
          request: { sceneId: p.sceneId, prompt: p.imagePrompt, negativePrompt: p.negativePrompt, aspectRatio: p.aspectRatio, referenceImages: p.featuresJovi ? visual.profile.referenceImages : [] },
        }),
      );
    }
    return summarize('IMAGE', assets);
  }
}

// ---------------------------------------------------------------------------
// Video Generation Agent
// ---------------------------------------------------------------------------

export const VideoAgentInputSchema = z.object({
  productionId: z.string().min(1),
  prompts: z.array(VisualPromptSceneSchema).min(1),
  /** When true, each scene's COMPLETED image is used as the conditioning source. */
  useSourceImages: z.boolean().default(false),
});
export type VideoAgentInput = z.infer<typeof VideoAgentInputSchema>;

export class VideoGenerationAgent extends MediaAgent<VideoAgentInput> {
  readonly definition = VIDEO_AGENT_DEFINITION;
  readonly inputSchema = VideoAgentInputSchema;

  async execute(input: VideoAgentInput, _c: NoContext, ctx: AgentRunContext): Promise<MediaAgentOutput> {
    const images = input.useSourceImages ? ctx.tools.production.listAssets(input.productionId, 'IMAGE') : [];
    const assets: MediaAsset[] = [];
    for (const p of input.prompts) {
      // Only real, completed images may condition a video; simulated/blocked ones are never passed on.
      const sources = images.filter((a) => a.sceneId === p.sceneId && a.status === 'COMPLETED' && a.location);
      assets.push(
        await ctx.tools.media.generateVideo({
          productionId: input.productionId,
          sceneId: p.sceneId,
          aspectRatio: p.aspectRatio,
          sourceAssetIds: sources.map((s) => s.id),
          request: {
            sceneId: p.sceneId,
            prompt: p.videoPrompt,
            negativePrompt: p.negativePrompt,
            aspectRatio: p.aspectRatio,
            durationSeconds: p.targetDurationSeconds,
            sourceImages: sources.map((s) => ({ assetId: s.id, location: s.location as string })),
          },
        }),
      );
    }
    return summarize('VIDEO', assets);
  }
}

// ---------------------------------------------------------------------------
// Voice Agent
// ---------------------------------------------------------------------------

export const VoiceAgentInputSchema = z.object({
  productionId: z.string().min(1),
  script: ScriptSchema,
});
export type VoiceAgentInput = z.infer<typeof VoiceAgentInputSchema>;

export class VoiceAgent extends MediaAgent<VoiceAgentInput> {
  readonly definition = VOICE_AGENT_DEFINITION;
  readonly inputSchema = VoiceAgentInputSchema;

  async execute(input: VoiceAgentInput, _c: NoContext, ctx: AgentRunContext): Promise<MediaAgentOutput> {
    const identity = ctx.tools.identity.getActive().profile;
    const profile: VoiceProfile = {
      name: identity.creatorName,
      description: `${identity.voice.mix.map((m) => `${Math.round(m.weight * 100)}% ${m.trait}`).join(', ')}; ${identity.voice.principles.join(', ')}. From ${identity.origin}.`,
      // No voice has been selected/approved for Jovi yet — providers must use an approved voice id.
      providerVoiceId: null,
    };
    const assets: MediaAsset[] = [];
    for (const section of input.script.sections) {
      const lines = section.dialogue.filter((d) => d.speaker === 'JOVI');
      if (!lines.length) continue;
      const first = lines[0]!;
      assets.push(
        await ctx.tools.media.generateVoice({
          productionId: input.productionId,
          sceneId: section.sectionId,
          aspectRatio: null,
          request: {
            sceneId: section.sectionId,
            text: lines.map((l) => l.line).join(' '),
            voiceProfile: profile,
            language: input.script.language,
            emotion: first.emotion,
            pacing: first.pacing,
          },
        }),
      );
    }
    return summarize('VOICE', assets);
  }
}

// ---------------------------------------------------------------------------
// Editing Agent
// ---------------------------------------------------------------------------

export const EditingAgentInputSchema = z.object({
  productionId: z.string().min(1),
  script: ScriptSchema,
  storyboard: StoryboardSchema,
});
export type EditingAgentInput = z.infer<typeof EditingAgentInputSchema>;

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Deterministic edit decision list. It references assets by id and records
 * their real status, so a missing clip is visible as MISSING rather than
 * silently papered over. A render is requested from an editing engine; with
 * none registered the RENDER asset is BLOCKED — no final video is claimed.
 */
export class EditingAgent implements Agent<EditingAgentInput, EditPlan, null> {
  readonly definition = EDITING_AGENT_DEFINITION;
  readonly inputSchema = EditingAgentInputSchema;
  readonly outputSchema = EditPlanSchema;

  async loadContext(): Promise<null> {
    return null;
  }

  async execute(input: EditingAgentInput, _c: null, ctx: AgentRunContext): Promise<EditPlan> {
    const assets = ctx.tools.production.listAssets(input.productionId);
    const aspectRatio = AspectRatio.parse(input.storyboard.aspectRatio);
    const size = aspectRatio === '9:16' ? { width: 1080, height: 1920 } : { width: ASPECT_RATIO_SIZES[aspectRatio].width, height: ASPECT_RATIO_SIZES[aspectRatio].height };

    let t = 0;
    const timeline = input.storyboard.scenes.map((scene) => {
      const span = { sceneId: scene.sceneId, start: round(t), end: round(t + scene.durationSeconds) };
      t += scene.durationSeconds;
      return span;
    });
    const total = round(t);
    const usable = (a: MediaAsset) => a.status === 'COMPLETED' || a.status === 'SIMULATED';

    const clips = input.storyboard.scenes.map((scene, i) => {
      const span = timeline[i]!;
      const video = assets.find((a) => a.kind === 'VIDEO' && a.sceneId === scene.sceneId && usable(a));
      const image = assets.find((a) => a.kind === 'IMAGE' && a.sceneId === scene.sceneId && usable(a));
      const pick = video ?? image;
      const anyAttempt = assets.find((a) => (a.kind === 'VIDEO' || a.kind === 'IMAGE') && a.sceneId === scene.sceneId);
      return {
        clipId: `clip-${i + 1}`,
        sceneId: scene.sceneId,
        source: video ? ('VIDEO' as const) : image ? ('IMAGE' as const) : ('MISSING' as const),
        assetId: pick?.id ?? null,
        assetStatus: pick?.status ?? anyAttempt?.status ?? null,
        start: span.start,
        end: span.end,
        motion: !video && image ? 'slow push-in (Ken Burns) on still' : null,
      };
    });

    const transitions = input.storyboard.scenes.slice(1).map((scene, i) => ({
      fromSceneId: input.storyboard.scenes[i]!.sceneId,
      toSceneId: scene.sceneId,
      type: input.storyboard.scenes[i]!.transition,
      durationSeconds: /cut/i.test(input.storyboard.scenes[i]!.transition) ? 0 : 0.3,
    }));

    // Voice + captions follow script sections, placed at their first storyboard scene.
    const sectionStart = (sectionId: string) => timeline[input.storyboard.scenes.findIndex((s) => s.sectionId === sectionId)]?.start ?? 0;
    let cursor = 0;
    const captions: EditPlan['captions'] = [];
    const voice: EditPlan['audio']['voice'] = [];
    for (const section of input.script.sections) {
      const start = Math.max(cursor, sectionStart(section.sectionId));
      const end = round(start + section.durationSeconds);
      cursor = end;
      const lines = section.dialogue.map((d) => d.line);
      if (lines.length) captions.push({ start: round(start), end, text: lines.join(' ') });
      const asset = assets.find((a) => a.kind === 'VOICE' && a.sceneId === section.sectionId);
      if (section.dialogue.some((d) => d.speaker === 'JOVI')) {
        voice.push({ sectionId: section.sectionId, assetId: asset?.id ?? null, assetStatus: asset?.status ?? null, start: round(start), end });
      }
    }

    const textOverlays = input.storyboard.scenes.flatMap((scene, i) =>
      scene.onScreenText.filter(Boolean).map((text) => ({ start: timeline[i]!.start, end: timeline[i]!.end, text, position: 'upper-third (safe zone)' })),
    );

    const plan: Omit<EditPlan, 'render'> = {
      aspectRatio,
      totalDurationSeconds: total,
      timeline,
      clips,
      transitions,
      audio: { voice, music: { status: 'NOT_SELECTED', note: 'No licensed music selected; a human must choose a cleared track.' } },
      captions,
      textOverlays,
      effects: ['colour grade to storyboard lighting notes', 'burned-in captions', 'safe-zone text layout'],
      exportSettings: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', width: size.width, height: size.height, fps: 30, bitrateMbps: 12 },
    };

    const inputs = assets
      .filter((a) => a.status === 'COMPLETED' && a.location)
      .map((a) => ({ assetId: a.id, kind: a.kind as MediaKind, location: a.location as string }));
    const render = await ctx.tools.media.renderEdit({
      productionId: input.productionId,
      sceneId: null,
      aspectRatio,
      sourceAssetIds: inputs.map((i) => i.assetId),
      request: { editPlan: plan, inputs },
    });
    return { ...plan, render: { assetId: render.id, status: render.status, reason: render.statusReason } };
  }

  persist(output: EditPlan, input: EditingAgentInput, ctx: AgentRunContext): void {
    ctx.tools.production.saveArtifact(input.productionId, 'EDIT_PLAN', output);
  }
}
