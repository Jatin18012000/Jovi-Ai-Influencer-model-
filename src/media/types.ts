import { z } from 'zod';
import type { MediaKind, ProviderKind } from '../types/enums.js';
import type { CostEstimate } from '../models/types.js';

export const AspectRatio = z.enum(['9:16', '4:5', '1:1', '16:9']);
export type AspectRatio = z.infer<typeof AspectRatio>;

/** Standard output sizes (width × height) per aspect ratio. */
export const ASPECT_RATIO_SIZES: Record<AspectRatio, { width: number; height: number }> = {
  '9:16': { width: 768, height: 1344 },
  '4:5': { width: 896, height: 1120 },
  '1:1': { width: 1024, height: 1024 },
  '16:9': { width: 1344, height: 768 },
};

/**
 * Why a media provider can or cannot be used right now. Anything other than
 * AVAILABLE means no asset may be generated — the asset becomes BLOCKED.
 */
export type MediaProviderState = 'AVAILABLE' | 'NOT_CONFIGURED' | 'UNREACHABLE' | 'MISCONFIGURED' | 'NOT_INTEGRATED';

export interface MediaProviderStatus {
  provider: string;
  kind: ProviderKind;
  mediaKind: MediaKind;
  available: boolean;
  state: MediaProviderState;
  reason: string;
  models: string[];
  checkedAt: string;
  details?: Record<string, unknown>;
}

/**
 * Result of a real provider call. `location` must point at the produced
 * output (a local file inside the media directory, or a provider URL).
 * MediaService verifies local files exist before marking an asset COMPLETED.
 */
export interface MediaGenerationResult {
  provider: string;
  model: string;
  /** SIMULATED only from simulation providers; real providers return COMPLETED. */
  status: 'COMPLETED' | 'SIMULATED';
  location: string;
  mimeType: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  providerJobId?: string;
  cost: CostEstimate;
  metadata: Record<string, unknown>;
}

export interface MediaProviderBase {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly mediaKind: MediaKind;
  /** Must never throw: unavailable providers report a non-AVAILABLE state. */
  inspectAvailability(): Promise<MediaProviderStatus>;
  supportedModels(): string[];
  supportedAspectRatios(): AspectRatio[];
  estimateCost(request: unknown): CostEstimate;
}

export interface ImageGenerationRequest {
  assetId: string;
  productionId: string;
  sceneId: string;
  prompt: string;
  negativePrompt: string;
  aspectRatio: AspectRatio;
  referenceImages: string[];
  seed?: number;
}

export interface ImageGenerationProvider extends MediaProviderBase {
  readonly mediaKind: 'IMAGE';
  generateImage(request: ImageGenerationRequest): Promise<MediaGenerationResult>;
}

export interface VideoGenerationRequest {
  assetId: string;
  productionId: string;
  sceneId: string;
  prompt: string;
  negativePrompt: string;
  aspectRatio: AspectRatio;
  durationSeconds: number;
  /** Completed image assets (locations) to condition on, when supported. */
  sourceImages: Array<{ assetId: string; location: string }>;
}

export interface VideoGenerationProvider extends MediaProviderBase {
  readonly mediaKind: 'VIDEO';
  /** True when the provider animates source images (identity consistency via image conditioning). */
  readonly supportsImageToVideo: boolean;
  generateVideo(request: VideoGenerationRequest): Promise<MediaGenerationResult>;
}

export interface VoiceGenerationRequest {
  assetId: string;
  productionId: string;
  sceneId: string;
  text: string;
  voiceProfile: VoiceProfile;
  language: string;
  emotion: string;
  pacing: 'slow' | 'natural' | 'fast';
}

export interface VoiceProfile {
  name: string;
  description: string;
  /** Provider-specific voice id once a human has approved one; null = not selected. */
  providerVoiceId: string | null;
}

export interface VoiceGenerationProvider extends MediaProviderBase {
  readonly mediaKind: 'VOICE';
  synthesizeSpeech(request: VoiceGenerationRequest): Promise<MediaGenerationResult>;
}

export interface RenderRequest {
  assetId: string;
  productionId: string;
  editPlan: unknown;
  inputs: Array<{ assetId: string; kind: MediaKind; location: string }>;
}

export interface EditingRenderProvider extends MediaProviderBase {
  readonly mediaKind: 'RENDER';
  renderEdit(request: RenderRequest): Promise<MediaGenerationResult>;
}

export type AnyMediaProvider = ImageGenerationProvider | VideoGenerationProvider | VoiceGenerationProvider | EditingRenderProvider;
