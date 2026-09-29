import { ProviderError, ProviderUnavailableError } from '../../core/errors.js';
import { nowIso } from '../../core/ids.js';
import { estimateCloudCost } from '../pricing.js';
import type { GenerateRequest, GenerateResult, ModelProvider, ProviderStatus, TokenUsage } from '../types.js';
import { postJson } from './http.js';

export interface CloudProviderOptions {
  apiKey: string | undefined;
  model: string;
  baseUrl: string;
  timeoutMs: number;
}

/**
 * Shared behaviour for API-key based providers. A missing key means the
 * provider reports `unavailable` — it never crashes the application.
 * Availability is key-presence only: no network call (and no spend) is made
 * until a generation is actually routed to the provider.
 */
abstract class CloudProvider implements ModelProvider {
  abstract readonly id: string;
  readonly kind = 'CLOUD' as const;
  protected abstract readonly keyEnvVar: string;

  constructor(protected readonly options: CloudProviderOptions) {}

  async checkAvailability(): Promise<ProviderStatus> {
    const base = { provider: this.id, kind: this.kind, checkedAt: nowIso() };
    if (!this.options.apiKey) {
      return { ...base, available: false, reason: `${this.keyEnvVar} not configured`, selectedModel: null, models: [] };
    }
    return {
      ...base,
      available: true,
      reason: `${this.keyEnvVar} configured; model ${this.options.model}`,
      selectedModel: this.options.model,
      models: [{ provider: this.id, model: this.options.model, kind: this.kind, isDefault: true, capabilities: ['chat', 'json'] }],
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const apiKey = this.options.apiKey;
    if (!apiKey) throw new ProviderUnavailableError(this.id, `${this.keyEnvVar} not configured`);
    const model = request.requirements.model ?? this.options.model;
    const timeoutMs = request.requirements.timeoutMs ?? this.options.timeoutMs;
    const started = Date.now();
    const { output, usage, metadata } = await this.call(apiKey, model, request, timeoutMs);
    if (!output.trim()) throw new ProviderError(this.id, 'empty response', { retryable: true });
    return {
      provider: this.id,
      model,
      executionType: 'CLOUD',
      output,
      usage,
      latencyMs: Date.now() - started,
      cost: estimateCloudCost(this.id, model, usage),
      metadata,
    };
  }

  protected abstract call(
    apiKey: string,
    model: string,
    request: GenerateRequest,
    timeoutMs: number,
  ): Promise<{ output: string; usage: TokenUsage; metadata: Record<string, unknown> }>;

  protected url(path: string): string {
    return `${this.options.baseUrl.replace(/\/+$/, '')}${path}`;
  }
}

export class AnthropicProvider extends CloudProvider {
  readonly id = 'anthropic';
  protected readonly keyEnvVar = 'ANTHROPIC_API_KEY';

  protected async call(apiKey: string, model: string, request: GenerateRequest, timeoutMs: number) {
    const data = (await postJson(
      this.id,
      this.url('/v1/messages'),
      {
        model,
        max_tokens: request.requirements.maxOutputTokens ?? 4096,
        system: request.context.system,
        messages: [{ role: 'user', content: request.context.prompt }],
        ...(request.requirements.temperature !== undefined ? { temperature: request.requirements.temperature } : {}),
      },
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      timeoutMs,
    )) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string;
      id?: string;
    };
    const output = (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return {
      output,
      usage: { inputTokens: data.usage?.input_tokens ?? null, outputTokens: data.usage?.output_tokens ?? null },
      metadata: { stopReason: data.stop_reason ?? null, responseId: data.id ?? null },
    };
  }
}

export class OpenAIProvider extends CloudProvider {
  readonly id = 'openai';
  protected readonly keyEnvVar = 'OPENAI_API_KEY';

  protected async call(apiKey: string, model: string, request: GenerateRequest, timeoutMs: number) {
    const data = (await postJson(
      this.id,
      this.url('/chat/completions'),
      {
        model,
        messages: [
          { role: 'system', content: request.context.system },
          { role: 'user', content: request.context.prompt },
        ],
        ...(request.requirements.json ? { response_format: { type: 'json_object' } } : {}),
        ...(request.requirements.maxOutputTokens !== undefined ? { max_completion_tokens: request.requirements.maxOutputTokens } : {}),
        ...(request.requirements.temperature !== undefined ? { temperature: request.requirements.temperature } : {}),
      },
      { authorization: `Bearer ${apiKey}` },
      timeoutMs,
    )) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      id?: string;
    };
    return {
      output: data.choices?.[0]?.message?.content ?? '',
      usage: { inputTokens: data.usage?.prompt_tokens ?? null, outputTokens: data.usage?.completion_tokens ?? null },
      metadata: { finishReason: data.choices?.[0]?.finish_reason ?? null, responseId: data.id ?? null },
    };
  }
}

export class GeminiProvider extends CloudProvider {
  readonly id = 'gemini';
  protected readonly keyEnvVar = 'GEMINI_API_KEY';

  protected async call(apiKey: string, model: string, request: GenerateRequest, timeoutMs: number) {
    const data = (await postJson(
      this.id,
      this.url(`/models/${encodeURIComponent(model)}:generateContent`),
      {
        systemInstruction: { parts: [{ text: request.context.system }] },
        contents: [{ role: 'user', parts: [{ text: request.context.prompt }] }],
        generationConfig: {
          ...(request.requirements.json ? { responseMimeType: 'application/json' } : {}),
          ...(request.requirements.maxOutputTokens !== undefined ? { maxOutputTokens: request.requirements.maxOutputTokens } : {}),
          ...(request.requirements.temperature !== undefined ? { temperature: request.requirements.temperature } : {}),
        },
      },
      // Header auth keeps the key out of URLs (and therefore out of access logs).
      { 'x-goog-api-key': apiKey },
      timeoutMs,
    )) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const candidate = data.candidates?.[0];
    return {
      output: (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join(''),
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? null,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? null,
      },
      metadata: { finishReason: candidate?.finishReason ?? null },
    };
  }
}
