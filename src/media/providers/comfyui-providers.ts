import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { ProviderError, errorMessage } from '../../core/errors.js';
import { resolveFromRoot } from '../../core/config/paths.js';
import { nowIso } from '../../core/ids.js';
import { ComfyUIClient, fillWorkflow, outputFiles } from '../../integrations/comfyui/comfyui-client.js';
import { LOCAL_COMPUTE_COST } from '../../models/pricing.js';
import type { MediaKind } from '../../types/enums.js';
import { MediaStore } from '../media-store.js';
import {
  ASPECT_RATIO_SIZES,
  type AspectRatio,
  type ImageGenerationProvider,
  type ImageGenerationRequest,
  type MediaGenerationResult,
  type MediaProviderStatus,
  type VideoGenerationProvider,
  type VideoGenerationRequest,
} from '../types.js';

export interface ComfyUIOptions {
  /** e.g. http://127.0.0.1:8188 — unset means "not configured". */
  url: string | undefined;
  /** Path to an API-format workflow JSON containing {{POSITIVE_PROMPT}} etc. */
  workflowPath: string | undefined;
  timeoutMs: number;
  pollMs?: number;
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/**
 * Runs a user-supplied ComfyUI workflow (API format) for one asset:
 * fill placeholders → POST /prompt → poll /history → download output via
 * /view into the media store. The workflow — and therefore the checkpoint,
 * LoRAs and sampler — is the operator's choice; nothing is hard-coded here.
 *
 * Placeholders: {{POSITIVE_PROMPT}} {{NEGATIVE_PROMPT}} {{WIDTH}} {{HEIGHT}}
 * {{SEED}} {{FILENAME_PREFIX}} and, for video, {{DURATION_SECONDS}} {{FRAMES}}.
 */
abstract class ComfyUIWorkflowProvider {
  abstract readonly id: string;
  readonly kind = 'LOCAL' as const;
  abstract readonly mediaKind: MediaKind;
  protected readonly client: ComfyUIClient | null;

  constructor(
    protected readonly options: ComfyUIOptions,
    protected readonly store: MediaStore,
  ) {
    this.client = options.url ? new ComfyUIClient(options.url) : null;
  }

  supportedAspectRatios(): AspectRatio[] {
    return ['9:16', '4:5', '1:1', '16:9'];
  }

  supportedModels(): string[] {
    return this.options.workflowPath ? [`workflow:${basename(this.options.workflowPath)}`] : [];
  }

  estimateCost() {
    return LOCAL_COMPUTE_COST;
  }

  async inspectAvailability(): Promise<MediaProviderStatus> {
    const base = { provider: this.id, kind: this.kind, mediaKind: this.mediaKind, models: this.supportedModels(), checkedAt: nowIso() };
    if (!this.client) return { ...base, available: false, state: 'NOT_CONFIGURED', reason: 'COMFYUI_URL not set' };
    const workflow = this.loadWorkflow();
    if ('error' in workflow) return { ...base, available: false, state: 'MISCONFIGURED', reason: workflow.error };
    try {
      const stats = await this.client.systemStats();
      return {
        ...base,
        available: true,
        state: 'AVAILABLE',
        reason: `ComfyUI reachable at ${this.options.url}`,
        details: { devices: stats.devices.map((d) => d.name ?? d.type ?? 'device') },
      };
    } catch (error) {
      return { ...base, available: false, state: 'UNREACHABLE', reason: `ComfyUI not reachable at ${this.options.url}: ${errorMessage(error)}` };
    }
  }

  protected loadWorkflow(): { workflow: Record<string, unknown> } | { error: string } {
    const configured = this.options.workflowPath;
    if (!configured) return { error: `${this.workflowVariable()} not set (path to an API-format ComfyUI workflow JSON)` };
    const path = resolveFromRoot(configured);
    if (!existsSync(path)) return { error: `workflow file not found: ${configured}` };
    try {
      const text = readFileSync(path, 'utf8');
      if (!text.includes('{{POSITIVE_PROMPT}}')) return { error: `workflow ${configured} has no {{POSITIVE_PROMPT}} placeholder` };
      return { workflow: JSON.parse(text) as Record<string, unknown> };
    } catch (error) {
      return { error: `workflow ${configured} is not valid JSON: ${errorMessage(error)}` };
    }
  }

  protected abstract workflowVariable(): string;

  protected async run(
    productionId: string,
    assetId: string,
    values: Record<string, string | number>,
    fallbackExt: string,
  ): Promise<MediaGenerationResult> {
    if (!this.client) throw new ProviderError(this.id, 'COMFYUI_URL not set', { retryable: false });
    const loaded = this.loadWorkflow();
    if ('error' in loaded) throw new ProviderError(this.id, loaded.error, { retryable: false });
    const started = Date.now();
    const promptId = await this.client.queuePrompt(fillWorkflow(loaded.workflow, values) as Record<string, unknown>);
    const entry = await this.client.waitForCompletion(promptId, this.options.timeoutMs, this.options.pollMs);
    const [file] = outputFiles(entry);
    if (!file) throw new ProviderError(this.id, `workflow finished without an output file (prompt ${promptId})`, { retryable: false });
    const bytes = await this.client.download(file);
    const ext = MediaStore.extensionOf(file.filename, fallbackExt);
    const location = this.store.write(productionId, assetId, ext, bytes);
    return {
      provider: this.id,
      model: this.supportedModels()[0] ?? 'workflow',
      status: 'COMPLETED',
      location,
      mimeType: MIME[ext.toLowerCase()] ?? 'application/octet-stream',
      providerJobId: promptId,
      cost: LOCAL_COMPUTE_COST,
      metadata: { comfyFile: file, bytes: bytes.length, generationMs: Date.now() - started },
    };
  }
}

export class ComfyUIImageProvider extends ComfyUIWorkflowProvider implements ImageGenerationProvider {
  readonly id = 'comfyui-image';
  readonly mediaKind = 'IMAGE' as const;

  protected workflowVariable(): string {
    return 'COMFYUI_IMAGE_WORKFLOW';
  }

  async generateImage(request: ImageGenerationRequest): Promise<MediaGenerationResult> {
    const size = ASPECT_RATIO_SIZES[request.aspectRatio];
    const result = await this.run(
      request.productionId,
      request.assetId,
      {
        POSITIVE_PROMPT: request.prompt,
        NEGATIVE_PROMPT: request.negativePrompt,
        WIDTH: size.width,
        HEIGHT: size.height,
        SEED: request.seed ?? Math.floor(Math.random() * 2 ** 31),
        FILENAME_PREFIX: `jovi_${request.assetId}`,
      },
      '.png',
    );
    return { ...result, width: size.width, height: size.height };
  }
}

export class ComfyUIVideoProvider extends ComfyUIWorkflowProvider implements VideoGenerationProvider {
  readonly id = 'comfyui-video';
  readonly mediaKind = 'VIDEO' as const;
  /** Text-to-video workflows only in this build (source-image upload not implemented). */
  readonly supportsImageToVideo = false;

  protected workflowVariable(): string {
    return 'COMFYUI_VIDEO_WORKFLOW';
  }

  async generateVideo(request: VideoGenerationRequest): Promise<MediaGenerationResult> {
    const size = ASPECT_RATIO_SIZES[request.aspectRatio];
    const fps = 16;
    const result = await this.run(
      request.productionId,
      request.assetId,
      {
        POSITIVE_PROMPT: request.prompt,
        NEGATIVE_PROMPT: request.negativePrompt,
        WIDTH: size.width,
        HEIGHT: size.height,
        SEED: Math.floor(Math.random() * 2 ** 31),
        FILENAME_PREFIX: `jovi_${request.assetId}`,
        DURATION_SECONDS: request.durationSeconds,
        FRAMES: Math.max(1, Math.round(request.durationSeconds * fps)),
      },
      '.mp4',
    );
    return { ...result, width: size.width, height: size.height, durationSeconds: request.durationSeconds };
  }
}
