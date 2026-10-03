import { z } from 'zod';
import type { MediaKind, PrivacyRequirement, ProviderKind } from '../types/enums.js';
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

/**
 * What a provider can do. Simulated, fake and real providers all declare the
 * same structure, and the registry matches requests against it — no provider
 * is selected by name inside agents or the pipeline.
 */
export interface MediaCapabilities {
  aspectRatios: AspectRatio[];
  /** Longest single output in seconds (video/voice/render); null = no stated limit. */
  maxDurationSeconds: number | null;
  /** Video: animates a source image (identity conditioning). */
  imageToVideo: boolean;
  /** Image: accepts reference images of Jovi (identity conditioning). */
  referenceImages: boolean;
  /** Voice: BCP-47 language prefixes supported (e.g. "en"); null = any. */
  languages: string[] | null;
  /** File extensions the provider produces (e.g. ".png", ".wav"). */
  outputFormats: string[];
}

/** Hard requirements a provider must meet for one asset request. */
export interface MediaRequirements {
  aspectRatio?: AspectRatio;
  durationSeconds?: number;
  language?: string;
  /** LOCAL_ONLY excludes CLOUD providers (same rule as the model router). */
  privacy?: PrivacyRequirement;
  /** R-05: set when cloud providers must not be used (e.g. the daily cloud budget is spent). */
  cloudBlockedReason?: string;
}

/** Soft preferences: capable providers that satisfy them are tried first. */
export interface MediaPreferences {
  imageToVideo?: boolean;
  referenceImages?: boolean;
}

/** Returns why a provider cannot serve the requirements, or null if it can. */
export function capabilityMismatch(kind: ProviderKind, caps: MediaCapabilities, req: MediaRequirements): string | null {
  if (req.privacy === 'LOCAL_ONLY' && kind === 'CLOUD') return 'privacy LOCAL_ONLY excludes cloud providers';
  if (req.cloudBlockedReason && kind === 'CLOUD') return req.cloudBlockedReason;
  if (req.aspectRatio && !caps.aspectRatios.includes(req.aspectRatio)) return `aspect ratio ${req.aspectRatio} not supported`;
  if (req.durationSeconds !== undefined && caps.maxDurationSeconds !== null && req.durationSeconds > caps.maxDurationSeconds) {
    return `duration ${req.durationSeconds}s exceeds provider maximum ${caps.maxDurationSeconds}s`;
  }
  if (req.language && caps.languages && !caps.languages.some((l) => req.language!.toLowerCase().startsWith(l.toLowerCase()))) {
    return `language ${req.language} not supported`;
  }
  return null;
}

export interface MediaProviderBase {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly mediaKind: MediaKind;
  /** Must never throw: unavailable providers report a non-AVAILABLE state. */
  inspectAvailability(): Promise<MediaProviderStatus>;
  supportedModels(): string[];
  capabilities(): MediaCapabilities;
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
