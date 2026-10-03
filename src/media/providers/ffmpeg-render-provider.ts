import { z } from 'zod';
import { ProviderError } from '../../core/errors.js';
import { nowIso } from '../../core/ids.js';
import { LOCAL_COMPUTE_COST } from '../../models/pricing.js';
import type { MediaStore } from '../media-store.js';
import { runProcess } from '../process-runner.js';
import type { AspectRatio, EditingRenderProvider, MediaCapabilities, MediaGenerationResult, MediaProviderStatus, RenderRequest } from '../types.js';

const PROVIDER = 'ffmpeg-render';

/** The parts of an edit plan the renderer needs (validated independently of the agent schema). */
const Span = { start: z.number().min(0), end: z.number().min(0) };
export const RenderPlanSchema = z.object({
  aspectRatio: z.string(),
  totalDurationSeconds: z.number().positive().max(600),
  clips: z.array(z.object({ sceneId: z.string(), source: z.enum(['VIDEO', 'IMAGE', 'MISSING']), assetId: z.string().nullable(), ...Span })).min(1),
  audio: z.object({ voice: z.array(z.object({ sectionId: z.string(), assetId: z.string().nullable(), ...Span })) }),
  captions: z.array(z.object({ ...Span, text: z.string() })),
  exportSettings: z.object({ width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096), fps: z.number().int().min(1).max(60), bitrateMbps: z.number().positive().max(100) }),
});
export type RenderPlan = z.infer<typeof RenderPlanSchema>;

export interface RenderCommand {
  args: string[];
  durationSeconds: number;
  width: number;
  height: number;
  /** Clips rendered as black because no completed visual exists (reported, never hidden). */
  placeholderScenes: string[];
}

const secs = (n: number) => (Math.round(n * 1000) / 1000).toString();

function srtTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/** SubRip captions from the edit plan (muxed as a soft subtitle track; no fonts needed). */
export function buildSrt(captions: RenderPlan['captions']): string {
  return captions
    .filter((c) => c.end > c.start && c.text.trim())
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text.replace(/\r?\n/g, ' ').trim()}\n`)
    .join('\n');
}

/**
 * Pure builder for the ffmpeg argument list. Every input path must already be
 * validated (inside the media store); nothing from model text becomes a flag.
 */
export function buildRenderCommand(plan: RenderPlan, inputs: Map<string, string>, outputPath: string, srtPath: string | null): RenderCommand {
  const { width: W, height: H, fps, bitrateMbps } = plan.exportSettings;
  const total = plan.totalDurationSeconds;
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  const filters: string[] = [];
  const placeholderScenes: string[] = [];
  let index = 0;

  const videoLabels = plan.clips.map((clip, i) => {
    const duration = Math.max(0.04, clip.end - clip.start);
    const location = clip.assetId ? inputs.get(clip.assetId) : undefined;
    if (clip.source === 'VIDEO' && location) args.push('-i', location);
    else if (clip.source === 'IMAGE' && location) args.push('-loop', '1', '-t', secs(duration), '-i', location);
    else {
      placeholderScenes.push(clip.sceneId);
      args.push('-f', 'lavfi', '-t', secs(duration), '-i', `color=c=black:s=${W}x${H}:r=${fps}`);
    }
    filters.push(
      `[${index}:v]tpad=stop_mode=clone:stop_duration=${secs(duration)},trim=duration=${secs(duration)},setpts=PTS-STARTPTS,` +
        `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p[v${i}]`,
    );
    index += 1;
    return `[v${i}]`;
  });
  filters.push(`${videoLabels.join('')}concat=n=${videoLabels.length}:v=1:a=0[vout]`);

  const voiced = plan.audio.voice.filter((v) => v.assetId && inputs.has(v.assetId));
  if (voiced.length === 0) {
    args.push('-f', 'lavfi', '-t', secs(total), '-i', 'anullsrc=r=48000:cl=stereo');
    filters.push(`[${index}:a]atrim=duration=${secs(total)}[aout]`);
    index += 1;
  } else {
    const labels = voiced.map((v, j) => {
      args.push('-i', inputs.get(v.assetId!)!);
      const delay = Math.round(v.start * 1000);
      filters.push(`[${index}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${delay}|${delay}[a${j}]`);
      index += 1;
      return `[a${j}]`;
    });
    const mixed = labels.length > 1 ? `${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0[amix];[amix]` : labels[0]!;
    filters.push(`${mixed}apad,atrim=duration=${secs(total)}[aout]`);
  }

  let subtitleIndex: number | null = null;
  if (srtPath) {
    args.push('-i', srtPath);
    subtitleIndex = index;
    index += 1;
  }

  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]');
  if (subtitleIndex !== null) args.push('-map', `${subtitleIndex}:s`, '-c:s', 'mov_text');
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', String(fps), '-b:v', `${bitrateMbps}M`,
    '-c:a', 'aac', '-b:a', '192k', '-t', secs(total), '-movflags', '+faststart', outputPath,
  );
  return { args, durationSeconds: total, width: W, height: H, placeholderScenes };
}

/**
 * Real editing/render engine: renders an edit plan to MP4 with a local ffmpeg
 * binary (operator-configured via JOVI_FFMPEG_PATH). Clips are scaled/padded
 * to the export size, stills are held for their slot, voice is placed at its
 * timeline position, captions are muxed as a soft subtitle track. Scenes
 * without a completed visual render as black and are listed in metadata.
 */
export class FFmpegRenderProvider implements EditingRenderProvider {
  readonly id = PROVIDER;
  readonly kind = 'LOCAL' as const;
  readonly mediaKind = 'RENDER' as const;
  private cached: { at: number; status: MediaProviderStatus } | null = null;

  constructor(
    private readonly options: { ffmpegPath: string | undefined; timeoutMs: number; statusTtlMs?: number },
    private readonly store: MediaStore,
  ) {}

  supportedModels(): string[] {
    return ['ffmpeg:libx264+aac'];
  }

  capabilities(): MediaCapabilities {
    return { aspectRatios: ['9:16', '4:5', '1:1', '16:9'] as AspectRatio[], maxDurationSeconds: 600, imageToVideo: false, referenceImages: false, languages: null, outputFormats: ['.mp4'] };
  }

  estimateCost() {
    return LOCAL_COMPUTE_COST;
  }

  async inspectAvailability(): Promise<MediaProviderStatus> {
    const ttl = this.options.statusTtlMs ?? 30_000;
    if (this.cached && Date.now() - this.cached.at < ttl) return this.cached.status;
    const base = { provider: this.id, kind: this.kind, mediaKind: this.mediaKind, models: this.supportedModels(), checkedAt: nowIso() };
    let status: MediaProviderStatus;
    if (!this.options.ffmpegPath) {
      status = { ...base, available: false, state: 'NOT_CONFIGURED', reason: 'JOVI_FFMPEG_PATH not set' };
    } else {
      try {
        const version = await runProcess(this.id, this.options.ffmpegPath, ['-hide_banner', '-version'], { timeoutMs: 10_000 });
        const encoders = await runProcess(this.id, this.options.ffmpegPath, ['-hide_banner', '-encoders'], { timeoutMs: 10_000 });
        const missing = ['libx264', 'aac', 'mov_text'].filter((e) => !new RegExp(`\\s${e}\\s`).test(encoders.stdout));
        const versionLine = version.stdout.split('\n')[0] ?? '';
        status =
          version.code !== 0
            ? { ...base, available: false, state: 'MISCONFIGURED', reason: `ffmpeg exited with code ${version.code}` }
            : missing.length
              ? { ...base, available: false, state: 'MISCONFIGURED', reason: `ffmpeg lacks encoders: ${missing.join(', ')}` }
              : { ...base, available: true, state: 'AVAILABLE', reason: versionLine, details: { version: versionLine } };
      } catch (error) {
        status = { ...base, available: false, state: 'UNREACHABLE', reason: `ffmpeg not runnable at ${this.options.ffmpegPath}: ${(error as Error).message}` };
      }
    }
    this.cached = { at: Date.now(), status };
    return status;
  }

  async renderEdit(request: RenderRequest): Promise<MediaGenerationResult> {
    if (!this.options.ffmpegPath) throw new ProviderError(this.id, 'JOVI_FFMPEG_PATH not set', { retryable: false });
    const parsed = RenderPlanSchema.safeParse(request.editPlan);
    if (!parsed.success) throw new ProviderError(this.id, `edit plan is not renderable: ${parsed.error.issues[0]?.message ?? 'invalid'}`, { retryable: false });
    const locations = new Map<string, string>();
    for (const input of request.inputs) {
      if (!this.store.holdsFile(input.location)) throw new ProviderError(this.id, `input ${input.assetId} is not a file inside the media store`, { retryable: false });
      locations.set(input.assetId, input.location);
    }
    // Re-audit R2-06: ffmpeg reads private copies made through verified descriptors, never the
    // checked paths themselves (a parent directory could be swapped between check and open).
    let staged: ReturnType<MediaStore['stageInputs']>;
    try {
      staged = this.store.stageInputs(locations);
    } catch (error) {
      throw new ProviderError(this.id, `inputs could not be staged safely: ${(error as Error).message}`, { retryable: false });
    }
    const srt = buildSrt(parsed.data.captions);
    const srtPath = srt ? this.store.writeSidecar(request.productionId, request.assetId, '.srt', srt) : null;
    const output = this.store.prepare(request.productionId, request.assetId, '.mp4');
    const command = buildRenderCommand(parsed.data, staged.paths, output, srtPath);
    const started = Date.now();
    let result: Awaited<ReturnType<typeof runProcess>>;
    try {
      result = await runProcess(this.id, this.options.ffmpegPath, command.args, { timeoutMs: this.options.timeoutMs });
    } finally {
      staged.cleanup();
    }
    if (result.code !== 0) {
      throw new ProviderError(this.id, `ffmpeg exited with code ${result.code}: ${result.stderr.replace(/\s+/g, ' ').slice(-400)}`, { retryable: false });
    }
    return {
      provider: this.id,
      model: 'ffmpeg:libx264+aac',
      status: 'COMPLETED',
      location: output,
      mimeType: 'video/mp4',
      width: command.width,
      height: command.height,
      durationSeconds: command.durationSeconds,
      cost: LOCAL_COMPUTE_COST,
      metadata: { placeholderScenes: command.placeholderScenes, captions: srtPath, renderMs: Date.now() - started },
    };
  }
}
