import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, ProviderUnavailableError } from '../../src/core/errors.js';
import { estimateCloudCost } from '../../src/models/pricing.js';
import { AnthropicProvider, GeminiProvider, OpenAIProvider } from '../../src/models/providers/cloud-providers.js';
import { MockProvider } from '../../src/models/providers/mock-provider.js';
import type { GenerateRequest, ModelProvider } from '../../src/models/types.js';

const request: GenerateRequest = {
  task: { type: 'test.task' },
  context: { system: 'You are Jovi.', prompt: 'Say hi as JSON.' },
  requirements: { json: true, maxOutputTokens: 100, temperature: 0.5 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('Provider contract', () => {
  const providers: ModelProvider[] = [
    new AnthropicProvider({ apiKey: undefined, model: 'm', baseUrl: 'http://x', timeoutMs: 1000 }),
    new OpenAIProvider({ apiKey: undefined, model: 'm', baseUrl: 'http://x', timeoutMs: 1000 }),
    new GeminiProvider({ apiKey: undefined, model: 'm', baseUrl: 'http://x', timeoutMs: 1000 }),
  ];

  it.each(providers.map((p) => [p.id, p] as const))('%s reports unavailable without a key and never crashes', async (_id, provider) => {
    const status = await provider.checkAvailability();
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/not configured/);
    expect(status.selectedModel).toBeNull();
    await expect(provider.generate(request)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('mock provider returns the structured result shape', async () => {
    const mock = new MockProvider({ responder: () => '{"hello":"world"}' });
    const result = await mock.generate(request);
    expect(result).toMatchObject({
      provider: 'mock',
      model: 'jovi-mock-v1',
      output: '{"hello":"world"}',
      usage: { inputTokens: null, outputTokens: null },
      cost: { estimatedApiCost: 0, executionCostType: 'NONE' },
      metadata: { mock: true },
    });
    expect(typeof result.latencyMs).toBe('number');
  });
});

describe('Cloud adapters (HTTP mapped, no real calls)', () => {
  it('Anthropic maps request/response, usage and cost', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: 'msg_1', content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 1000, output_tokens: 500 }, stop_reason: 'end_turn' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new AnthropicProvider({ apiKey: 'sk-test-secret', model: 'claude-sonnet-5-5', baseUrl: 'https://api.anthropic.com', timeoutMs: 1000 });
    const result = await provider.generate(request);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test-secret');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', system: 'You are Jovi.', max_tokens: 100 });
    expect(result.output).toBe('{"ok":true}');
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 500 });
    expect(result.cost.executionCostType).toBe('API');
    expect(result.cost.estimatedApiCost).toBeCloseTo((1000 * 3 + 500 * 15) / 1_000_000);
  });

  it('OpenAI requests JSON mode and maps usage', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAIProvider({ apiKey: 'sk-openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', timeoutMs: 1000 });
    const result = await provider.generate(request);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.parse(String(init?.body))).toMatchObject({ response_format: { type: 'json_object' } });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('Gemini uses header auth (key never in the URL)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: '{"b":2}' }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GeminiProvider({ apiKey: 'gm-secret', model: 'gemini-2.5-flash', baseUrl: 'https://g.test/v1beta', timeoutMs: 1000 });
    const result = await provider.generate(request);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://g.test/v1beta/models/gemini-2.5-flash:generateContent');
    expect(url).not.toContain('gm-secret');
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('gm-secret');
    expect(result.output).toBe('{"b":2}');
  });

  it('classifies HTTP errors as retryable or permanent and never leaks the key', async () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-very-secret', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', timeoutMs: 1000 });

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'rate limited' }, 429)));
    const rateLimited = await provider.generate(request).catch((e: unknown) => e);
    expect(rateLimited).toBeInstanceOf(ProviderError);
    expect((rateLimited as ProviderError).retryable).toBe(true);

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'invalid key' }, 401)));
    const unauthorized = await provider.generate(request).catch((e: unknown) => e);
    expect((unauthorized as ProviderError).retryable).toBe(false);
    expect((unauthorized as Error).message).not.toContain('sk-very-secret');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    const network = await provider.generate(request).catch((e: unknown) => e);
    expect((network as ProviderError).retryable).toBe(true);
  });

  it('reports unknown pricing as null instead of inventing a number', () => {
    expect(estimateCloudCost('openai', 'some-future-model', { inputTokens: 10, outputTokens: 10 }).estimatedApiCost).toBeNull();
  });
});
