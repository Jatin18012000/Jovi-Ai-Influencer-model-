import type { JoviConfig } from '../../core/config/config.js';
import type { ModelProvider } from '../types.js';
import { AnthropicProvider, GeminiProvider, OpenAIProvider } from './cloud-providers.js';
import { MockProvider } from './mock-provider.js';
import { OllamaProvider } from './ollama-provider.js';

/**
 * Builds the provider set from configuration. Cloud providers are always
 * registered so their status is visible (they report `unavailable` without a
 * key). The mock provider is only registered when explicitly enabled.
 */
export function createProvidersFromConfig(config: JoviConfig): ModelProvider[] {
  const { providers: p } = config;
  const list: ModelProvider[] = [
    new AnthropicProvider({ ...p.anthropic, timeoutMs: p.timeoutMs }),
    new OpenAIProvider({ ...p.openai, timeoutMs: p.timeoutMs }),
    new GeminiProvider({ ...p.gemini, timeoutMs: p.timeoutMs }),
  ];
  if (p.ollama.enabled) list.push(new OllamaProvider({ url: p.ollama.url, model: p.ollama.model, timeoutMs: p.timeoutMs }));
  if (p.mock.enabled) list.push(new MockProvider());
  return list;
}

export { AnthropicProvider, GeminiProvider, MockProvider, OllamaProvider, OpenAIProvider };
