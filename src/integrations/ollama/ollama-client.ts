import { getJson, postJson } from '../../models/providers/http.js';

export interface OllamaModelInfo {
  name: string;
  size?: number;
  family?: string;
  parameterSize?: string;
}

export interface OllamaChatResponse {
  content: string;
  promptEvalCount: number | null;
  evalCount: number | null;
  totalDurationNs: number | null;
  model: string;
}

/**
 * Thin client for the local Ollama HTTP API. It never pulls models: model
 * downloads are an explicit operator action (`ollama pull <model>`).
 */
export class OllamaClient {
  constructor(private readonly baseUrl: string) {}

  async listModels(timeoutMs = 2_500): Promise<OllamaModelInfo[]> {
    const data = (await getJson('ollama', `${this.trimmed()}/api/tags`, {}, timeoutMs)) as {
      models?: Array<{ name?: string; model?: string; size?: number; details?: { family?: string; parameter_size?: string } }>;
    };
    return (data.models ?? [])
      .map((m) => ({
        name: m.name ?? m.model ?? '',
        ...(m.size !== undefined ? { size: m.size } : {}),
        ...(m.details?.family ? { family: m.details.family } : {}),
        ...(m.details?.parameter_size ? { parameterSize: m.details.parameter_size } : {}),
      }))
      .filter((m) => m.name.length > 0);
  }

  async chat(input: {
    model: string;
    system: string;
    prompt: string;
    json: boolean;
    temperature?: number;
    maxOutputTokens?: number;
    timeoutMs: number;
  }): Promise<OllamaChatResponse> {
    const body = {
      model: input.model,
      stream: false,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.prompt },
      ],
      ...(input.json ? { format: 'json' } : {}),
      options: {
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.maxOutputTokens !== undefined ? { num_predict: input.maxOutputTokens } : {}),
      },
    };
    const data = (await postJson('ollama', `${this.trimmed()}/api/chat`, body, {}, input.timeoutMs)) as {
      model?: string;
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
      total_duration?: number;
    };
    return {
      content: data.message?.content ?? '',
      promptEvalCount: data.prompt_eval_count ?? null,
      evalCount: data.eval_count ?? null,
      totalDurationNs: data.total_duration ?? null,
      model: data.model ?? input.model,
    };
  }

  private trimmed(): string {
    return this.baseUrl.replace(/\/+$/, '');
  }
}
