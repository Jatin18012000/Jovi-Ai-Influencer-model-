import { ProviderError } from '../../core/errors.js';
import { getJson, postJson } from '../../models/providers/http.js';

const PROVIDER = 'lmstudio';

/** Which LM Studio API answered model discovery. */
export type LMStudioApiMode = 'native-v1' | 'native-v0' | 'openai-compatible';

export interface LMStudioModelInfo {
  id: string;
  /** `llm`, `vlm`, `embedding(s)` or `unknown` (OpenAI-compatible listing has no type). */
  type: string;
  /** true/false from the native APIs; null when the API cannot tell (OpenAI-compatible listing). */
  loaded: boolean | null;
}

export interface LMStudioModelListing {
  apiMode: LMStudioApiMode;
  models: LMStudioModelInfo[];
}

export interface LMStudioChatResponse {
  content: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  finishReason: string | null;
  responseId: string | null;
  reasoningStripped: boolean;
}

/**
 * Client for LM Studio's local server.
 *
 * Discovery prefers the native REST APIs because they report whether a model
 * is actually *loaded* (LM Studio ≥ 0.4: `GET /api/v1/models`; older:
 * `GET /api/v0/models`), then falls back to the OpenAI-compatible
 * `GET /v1/models`, which lists models but cannot say whether they are loaded.
 * Generation uses the OpenAI-compatible `POST /v1/chat/completions`.
 *
 * This client never downloads or loads models.
 */
export class LMStudioClient {
  private readonly baseUrl: string;
  private readonly rootUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiKey?: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    // Native APIs live at the server root, not under the OpenAI-compatible /v1 prefix.
    this.rootUrl = this.baseUrl.replace(/\/v1$/, '');
  }

  async listModels(timeoutMs = 3_000): Promise<LMStudioModelListing> {
    const headers = this.headers();
    const attempts: Array<() => Promise<LMStudioModelListing>> = [
      async () => ({ apiMode: 'native-v1', models: parseNativeV1(await getJson(PROVIDER, `${this.rootUrl}/api/v1/models`, headers, timeoutMs)) }),
      async () => ({ apiMode: 'native-v0', models: parseNativeV0(await getJson(PROVIDER, `${this.rootUrl}/api/v0/models`, headers, timeoutMs)) }),
      async () => ({ apiMode: 'openai-compatible', models: parseOpenAI(await getJson(PROVIDER, `${this.baseUrl}/models`, headers, timeoutMs)) }),
    ];
    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        return await attempt();
      } catch (error) {
        lastError = error;
        // Unreachable server: no point trying the other endpoints.
        if (error instanceof ProviderError && error.details?.status === undefined) throw error;
      }
    }
    throw lastError;
  }

  async chat(input: {
    model: string;
    system: string;
    prompt: string;
    temperature?: number;
    maxOutputTokens?: number;
    timeoutMs: number;
  }): Promise<LMStudioChatResponse> {
    const data = (await postJson(
      PROVIDER,
      `${this.baseUrl}/chat/completions`,
      {
        model: input.model,
        stream: false,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.prompt },
        ],
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.maxOutputTokens !== undefined ? { max_tokens: input.maxOutputTokens } : {}),
      },
      this.headers(),
      input.timeoutMs,
    )) as {
      id?: string;
      model?: string;
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = data.choices?.[0]?.message?.content ?? '';
    // Reasoning models emit <think>…</think>. Jovi never keeps hidden chain-of-thought.
    const content = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    return {
      content,
      model: data.model ?? input.model,
      promptTokens: data.usage?.prompt_tokens ?? null,
      completionTokens: data.usage?.completion_tokens ?? null,
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      responseId: data.id ?? null,
      reasoningStripped: content.length !== raw.trim().length,
    };
  }

  private headers(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }
}

function parseNativeV1(data: unknown): LMStudioModelInfo[] {
  const models = (data as { models?: unknown }).models;
  if (!Array.isArray(models)) throw new ProviderError(PROVIDER, 'unexpected /api/v1/models response', { retryable: false, status: 0 });
  return models
    .map((m: { key?: string; type?: string; loaded_instances?: Array<{ id?: string }> }) => {
      const instances = Array.isArray(m.loaded_instances) ? m.loaded_instances : [];
      // A loaded instance id is what chat completions accept; fall back to the model key.
      const id = instances[0]?.id ?? m.key ?? '';
      return { id, type: m.type ?? 'unknown', loaded: instances.length > 0 };
    })
    .filter((m) => m.id.length > 0);
}

function parseNativeV0(data: unknown): LMStudioModelInfo[] {
  const models = (data as { data?: unknown }).data;
  if (!Array.isArray(models)) throw new ProviderError(PROVIDER, 'unexpected /api/v0/models response', { retryable: false, status: 0 });
  return models
    .map((m: { id?: string; type?: string; state?: string }) => ({ id: m.id ?? '', type: m.type ?? 'unknown', loaded: m.state === 'loaded' }))
    .filter((m) => m.id.length > 0);
}

function parseOpenAI(data: unknown): LMStudioModelInfo[] {
  const models = (data as { data?: unknown }).data;
  if (!Array.isArray(models)) throw new ProviderError(PROVIDER, 'unexpected /v1/models response', { retryable: false, status: 0 });
  return models
    .map((m: { id?: string }) => ({ id: m.id ?? '', type: 'unknown', loaded: null }))
    .filter((m) => m.id.length > 0);
}

/** Embedding models cannot serve chat generation. */
export function isChatModel(model: LMStudioModelInfo): boolean {
  return !/^embedding/i.test(model.type) && !/embed/i.test(model.id);
}
