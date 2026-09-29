import { ProviderUnavailableError, errorMessage } from '../../core/errors.js';
import { nowIso } from '../../core/ids.js';
import { OllamaClient, type OllamaModelInfo } from '../../integrations/ollama/ollama-client.js';
import { LOCAL_COMPUTE_COST } from '../pricing.js';
import type { GenerateRequest, GenerateResult, ModelProvider, ProviderStatus } from '../types.js';

/**
 * Local Ollama provider. Detects installed models at runtime and never
 * assumes a specific model exists. Cost is reported as LOCAL_COMPUTE.
 */
export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama';
  readonly kind = 'LOCAL' as const;
  private readonly client: OllamaClient;
  private selectedModel: string | null = null;

  constructor(
    private readonly options: { url: string; model: string | undefined; timeoutMs: number },
    client?: OllamaClient,
  ) {
    this.client = client ?? new OllamaClient(options.url);
  }

  async checkAvailability(): Promise<ProviderStatus> {
    const base = { provider: this.id, kind: this.kind, checkedAt: nowIso() };
    let installed: OllamaModelInfo[];
    try {
      installed = await this.client.listModels();
    } catch (error) {
      this.selectedModel = null;
      return { ...base, available: false, reason: `Ollama not reachable at ${this.options.url}: ${errorMessage(error)}`, selectedModel: null, models: [] };
    }

    // Embedding-only models cannot serve chat generation.
    const chatModels = installed.filter((m) => !/embed/i.test(m.name));
    if (chatModels.length === 0) {
      this.selectedModel = null;
      return {
        ...base,
        available: false,
        reason:
          installed.length === 0
            ? 'Ollama is running but no models are installed. Install one explicitly, e.g. `ollama pull llama3.1:8b`.'
            : 'Ollama is running but only embedding models are installed.',
        selectedModel: null,
        models: [],
      };
    }

    const configured = this.options.model;
    const match = configured ? chatModels.find((m) => m.name === configured || m.name === `${configured}:latest`) : undefined;
    const chosen = match ?? chatModels[0]!;
    this.selectedModel = chosen.name;

    const reason = configured
      ? match
        ? `using configured OLLAMA_MODEL=${chosen.name}`
        : `OLLAMA_MODEL=${configured} is not installed; using installed model ${chosen.name}`
      : `OLLAMA_MODEL not set; using first installed model ${chosen.name}`;

    return {
      ...base,
      available: true,
      reason,
      selectedModel: chosen.name,
      models: chatModels.map((m) => ({
        provider: this.id,
        model: m.name,
        kind: this.kind,
        isDefault: m.name === chosen.name,
        capabilities: ['chat', 'json'],
      })),
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const model = request.requirements.model ?? this.selectedModel ?? (await this.checkAvailability()).selectedModel;
    if (!model) throw new ProviderUnavailableError(this.id, 'no installed Ollama model');

    const started = Date.now();
    const response = await this.client.chat({
      model,
      system: request.context.system,
      prompt: request.context.prompt,
      json: request.requirements.json ?? false,
      ...(request.requirements.temperature !== undefined ? { temperature: request.requirements.temperature } : {}),
      ...(request.requirements.maxOutputTokens !== undefined ? { maxOutputTokens: request.requirements.maxOutputTokens } : {}),
      timeoutMs: request.requirements.timeoutMs ?? this.options.timeoutMs,
    });

    return {
      provider: this.id,
      model: response.model,
      output: response.content,
      usage: { inputTokens: response.promptEvalCount, outputTokens: response.evalCount },
      latencyMs: Date.now() - started,
      cost: LOCAL_COMPUTE_COST,
      metadata: { totalDurationNs: response.totalDurationNs },
    };
  }
}
