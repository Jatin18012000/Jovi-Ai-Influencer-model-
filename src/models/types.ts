import type { ExecutionCostType, ProviderKind } from '../types/enums.js';

/** What the model is being asked to do (used for routing, logging and mocks). */
export interface GenerationTask {
  /** Machine-readable task type, e.g. `executive.proposal`, `evaluation.options`. */
  type: string;
  description?: string;
}

/** The prompt material. Providers map this onto their own message formats. */
export interface GenerationContext {
  system: string;
  prompt: string;
}

export interface GenerationRequirements {
  /** Specific model to use; defaults to the provider's selected model. */
  model?: string;
  /** Ask the provider for a JSON object response when supported. */
  json?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface GenerateRequest {
  task: GenerationTask;
  context: GenerationContext;
  requirements: GenerationRequirements;
}

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface CostEstimate {
  /** Estimated provider API charge in USD; 0 for local; null when unknown. */
  estimatedApiCost: number | null;
  executionCostType: ExecutionCostType;
  currency: 'USD';
  basis: string;
}

export interface GenerateResult {
  provider: string;
  model: string;
  /** Where inference ran: CLOUD API, LOCAL runtime (LM Studio) or MOCK simulation. */
  executionType: ProviderKind;
  output: string;
  usage: TokenUsage;
  latencyMs: number;
  cost: CostEstimate;
  metadata: Record<string, unknown>;
}

export interface ModelDescriptor {
  provider: string;
  model: string;
  kind: ProviderKind;
  isDefault: boolean;
  capabilities: string[];
  /** Whether the model is loaded in memory (local runtimes); null when unknown. */
  loaded?: boolean | null;
}

export interface ProviderStatus {
  provider: string;
  kind: ProviderKind;
  available: boolean;
  reason: string;
  /** Model the provider will use by default when available. */
  selectedModel: string | null;
  models: ModelDescriptor[];
  checkedAt: string;
  /** Provider-specific discovery details (e.g. LM Studio reachability and loaded models). */
  details?: Record<string, unknown>;
}

/**
 * Generic model provider contract. Agents never talk to a provider directly —
 * they go through the Model Router, which picks a provider from requirements.
 */
export interface ModelProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  /** Must never throw: unavailable providers report `available: false`. */
  checkAvailability(): Promise<ProviderStatus>;
  generate(request: GenerateRequest): Promise<GenerateResult>;
}
