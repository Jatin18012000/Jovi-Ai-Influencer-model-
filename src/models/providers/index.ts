import type { JoviConfig } from '../../core/config/config.js';
import type { ModelProvider } from '../types.js';
import { AnthropicProvider, GeminiProvider, OpenAIProvider } from './cloud-providers.js';
import { LMStudioProvider } from './lmstudio-provider.js';
import { MockProvider } from './mock-provider.js';

/**
 * Builds the provider set from configuration.
 *
 * Production: Anthropic, OpenAI, Gemini (each reports `unavailable` without a
 * key) plus LM Studio, the only local runtime.
 * Simulation mode: ONLY the deterministic MockProvider — never mixed with real
 * providers (the registry enforces this as well).
 */
export function createProvidersFromConfig(config: JoviConfig): ModelProvider[] {
  const { providers: p } = config;
  if (p.simulation) return [new MockProvider()];
  const list: ModelProvider[] = [
    new AnthropicProvider({ ...p.anthropic, timeoutMs: p.timeoutMs }),
    new OpenAIProvider({ ...p.openai, timeoutMs: p.timeoutMs }),
    new GeminiProvider({ ...p.gemini, timeoutMs: p.timeoutMs }),
  ];
  if (p.lmstudio.enabled) {
    list.push(new LMStudioProvider({ url: p.lmstudio.url, model: p.lmstudio.model, apiKey: p.lmstudio.apiKey, timeoutMs: p.lmstudio.timeoutMs }));
  }
  return list;
}

export { AnthropicProvider, GeminiProvider, LMStudioProvider, MockProvider, OpenAIProvider };
