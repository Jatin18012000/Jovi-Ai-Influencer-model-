import { ProviderError, ProviderUnavailableError, errorMessage } from '../../core/errors.js';
import { nowIso } from '../../core/ids.js';
import { LMStudioClient, isChatModel, type LMStudioModelListing } from '../../integrations/lmstudio/lmstudio-client.js';
import { LOCAL_COMPUTE_COST } from '../pricing.js';
import type { GenerateRequest, GenerateResult, ModelProvider, ProviderStatus } from '../types.js';

export interface LMStudioProviderOptions {
  /** OpenAI-compatible base URL, e.g. http://localhost:1234/v1 */
  url: string;
  /** Model id to use. Unset = the first loaded chat model. */
  model: string | undefined;
  apiKey?: string | undefined;
  /** Local inference is slow on laptops; default is generous (see config). */
  timeoutMs: number;
}

export interface LMStudioDiscovery {
  url: string;
  reachable: boolean;
  apiMode: LMStudioModelListing['apiMode'] | null;
  modelsAvailable: string[];
  /** Loaded chat models; null when the API cannot report load state. */
  loadedModels: string[] | null;
  selectedModel: string | null;
  /** Whether the selected model is loaded; null when unknown. */
  loaded: boolean | null;
}

/**
 * LM Studio — Jovi's only local-model runtime.
 *
 * Unavailable (never an exception) when the server is not running, no chat
 * model exists, the configured model is missing, or the chosen model is not
 * loaded. Models are never downloaded or loaded automatically.
 */
export class LMStudioProvider implements ModelProvider {
  readonly id = 'lmstudio';
  readonly kind = 'LOCAL' as const;
  private readonly client: LMStudioClient;
  private selectedModel: string | null = null;

  constructor(private readonly options: LMStudioProviderOptions) {
    this.client = new LMStudioClient(options.url, options.apiKey);
  }

  async checkAvailability(): Promise<ProviderStatus> {
    const discovery: LMStudioDiscovery = {
      url: this.options.url,
      reachable: false,
      apiMode: null,
      modelsAvailable: [],
      loadedModels: null,
      selectedModel: null,
      loaded: null,
    };
    const unavailable = (reason: string): ProviderStatus => {
      this.selectedModel = null;
      return { provider: this.id, kind: this.kind, available: false, reason, selectedModel: null, models: [], checkedAt: nowIso(), details: { ...discovery } };
    };

    let listing: LMStudioModelListing;
    try {
      listing = await this.client.listModels();
    } catch (error) {
      return unavailable(
        `LM Studio not reachable at ${this.options.url} (${errorMessage(error)}). ` +
          'Start the local server in LM Studio (Developer → Start Server, or `lms server start`).',
      );
    }

    discovery.reachable = true;
    discovery.apiMode = listing.apiMode;
    const chat = listing.models.filter(isChatModel);
    discovery.modelsAvailable = chat.map((m) => m.id);
    const loadKnown = listing.apiMode !== 'openai-compatible';
    discovery.loadedModels = loadKnown ? chat.filter((m) => m.loaded).map((m) => m.id) : null;

    if (chat.length === 0) {
      return unavailable('LM Studio is running but no chat model is available. Download a model in LM Studio, then load it.');
    }

    const configured = this.options.model;
    let chosen: (typeof chat)[number] | undefined;
    if (configured) {
      chosen = chat.find((m) => m.id === configured);
      if (!chosen) {
        return unavailable(`LM_STUDIO_MODEL=${configured} is not available in LM Studio. Available: ${discovery.modelsAvailable.join(', ')}.`);
      }
      if (chosen.loaded === false) {
        return unavailable(`LM_STUDIO_MODEL=${configured} is downloaded but not loaded. Load it in LM Studio (or \`lms load ${configured}\`).`);
      }
    } else if (loadKnown) {
      chosen = chat.find((m) => m.loaded);
      if (!chosen) {
        return unavailable(
          `No model is loaded in LM Studio (${chat.length} downloaded: ${discovery.modelsAvailable.slice(0, 5).join(', ')}). ` +
            'Load one in LM Studio (or `lms load <model>`), optionally pinning it with LM_STUDIO_MODEL.',
        );
      }
    } else {
      // OpenAI-compatible listing cannot report load state; the first listed model is used.
      chosen = chat[0];
    }
    if (!chosen) return unavailable('No usable LM Studio model.');

    this.selectedModel = chosen.id;
    discovery.selectedModel = chosen.id;
    discovery.loaded = chosen.loaded;
    const reason = configured
      ? `using configured LM_STUDIO_MODEL=${chosen.id}`
      : loadKnown
        ? `using loaded model ${chosen.id}`
        : `using ${chosen.id} (load state unknown via OpenAI-compatible API; LM Studio may load it on first request)`;

    return {
      provider: this.id,
      kind: this.kind,
      available: true,
      reason,
      selectedModel: chosen.id,
      models: chat.map((m) => ({
        provider: this.id,
        model: m.id,
        kind: this.kind,
        isDefault: m.id === chosen.id,
        capabilities: ['chat'],
        loaded: m.loaded,
      })),
      checkedAt: nowIso(),
      details: { ...discovery },
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const model = request.requirements.model ?? this.selectedModel ?? (await this.checkAvailability()).selectedModel;
    if (!model) throw new ProviderUnavailableError(this.id, 'no usable LM Studio model (server not running or no model loaded)');

    const started = Date.now();
    // No `response_format`: LM Studio only accepts json_schema there, so JSON is
    // requested in the prompt and enforced by Zod validation + one repair pass.
    const response = await this.client.chat({
      model,
      system: request.context.system,
      prompt: request.context.prompt,
      ...(request.requirements.temperature !== undefined ? { temperature: request.requirements.temperature } : {}),
      ...(request.requirements.maxOutputTokens !== undefined ? { maxOutputTokens: request.requirements.maxOutputTokens } : {}),
      timeoutMs: request.requirements.timeoutMs ?? this.options.timeoutMs,
    });
    if (!response.content) throw new ProviderError(this.id, 'empty response from LM Studio', { retryable: true });

    return {
      provider: this.id,
      model: response.model,
      executionType: 'LOCAL',
      output: response.content,
      usage: { inputTokens: response.promptTokens, outputTokens: response.completionTokens },
      latencyMs: Date.now() - started,
      cost: LOCAL_COMPUTE_COST,
      metadata: {
        finishReason: response.finishReason,
        responseId: response.responseId,
        reasoningStripped: response.reasoningStripped,
      },
    };
  }
}
