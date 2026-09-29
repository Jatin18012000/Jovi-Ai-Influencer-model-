import { afterEach, describe, expect, it } from 'vitest';
import { ProviderError, ProviderUnavailableError } from '../../src/core/errors.js';
import { LMStudioProvider } from '../../src/models/providers/lmstudio-provider.js';
import type { GenerateRequest } from '../../src/models/types.js';
import { closedPortUrl, startFakeLMStudio } from '../fakes/fake-lmstudio.js';

type Fake = Awaited<ReturnType<typeof startFakeLMStudio>>;

const request: GenerateRequest = {
  task: { type: 'test.task' },
  context: { system: 'You are Jovi.', prompt: 'Reply with JSON.' },
  requirements: { json: true, maxOutputTokens: 300, temperature: 0.4 },
};

const provider = (url: string, model?: string, extra: { apiKey?: string; timeoutMs?: number } = {}) =>
  new LMStudioProvider({ url, model, apiKey: extra.apiKey, timeoutMs: extra.timeoutMs ?? 5_000 });

let fake: Fake | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe('LMStudioProvider — availability & model discovery', () => {
  it('1. reports unavailable (never throws) when LM Studio is not running', async () => {
    const lm = provider(await closedPortUrl());
    const status = await lm.checkAvailability();
    expect(status).toMatchObject({ provider: 'lmstudio', kind: 'LOCAL', available: false, selectedModel: null });
    expect(status.reason).toMatch(/not reachable/);
    expect(status.reason).toMatch(/Start Server|lms server start/);
    expect(status.details).toMatchObject({ reachable: false, modelsAvailable: [], selectedModel: null });
    await expect(lm.generate(request)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('2. reachable but no chat model (none downloaded, or embeddings only) → unavailable', async () => {
    fake = await startFakeLMStudio({ models: [] });
    const none = await provider(fake.url).checkAvailability();
    expect(none.available).toBe(false);
    expect(none.reason).toMatch(/no chat model/);
    expect(none.details).toMatchObject({ reachable: true, apiMode: 'native-v1' });

    fake.setModels([{ id: 'text-embedding-nomic-embed-text-v1.5', type: 'embedding', loaded: true }]);
    const embedOnly = await provider(fake.url).checkAvailability();
    expect(embedOnly.available).toBe(false);
  });

  it('3. model downloaded but not loaded → unavailable with the exact remedy', async () => {
    fake = await startFakeLMStudio({ models: [{ id: 'qwen2.5-7b-instruct', loaded: false }] });
    const status = await provider(fake.url).checkAvailability();
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/No model is loaded/);
    expect(status.reason).toMatch(/lms load/);
    expect(status.details).toMatchObject({ reachable: true, modelsAvailable: ['qwen2.5-7b-instruct'], loadedModels: [], loaded: null });

    const pinned = await provider(fake.url, 'qwen2.5-7b-instruct').checkAvailability();
    expect(pinned.available).toBe(false);
    expect(pinned.reason).toMatch(/downloaded but not loaded/);
  });

  it('3b. configured LM_STUDIO_MODEL that does not exist → unavailable (no silent substitution)', async () => {
    fake = await startFakeLMStudio({ models: [{ id: 'llama-3.2-3b-instruct', loaded: true }] });
    const status = await provider(fake.url, 'missing-model').checkAvailability();
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/LM_STUDIO_MODEL=missing-model is not available/);
    expect(status.reason).toMatch(/llama-3.2-3b-instruct/);
  });

  it('4. model loaded → available, with discovery details (native v1 API)', async () => {
    fake = await startFakeLMStudio({
      models: [
        { id: 'deepseek-r1-distill', loaded: false },
        { id: 'qwen2.5-7b-instruct', loaded: true },
        { id: 'text-embedding-nomic', type: 'embedding', loaded: true },
      ],
    });
    const status = await provider(fake.url).checkAvailability();
    expect(status).toMatchObject({ available: true, selectedModel: 'qwen2.5-7b-instruct', kind: 'LOCAL' });
    expect(status.details).toEqual({
      url: fake.url,
      reachable: true,
      apiMode: 'native-v1',
      modelsAvailable: ['deepseek-r1-distill', 'qwen2.5-7b-instruct'],
      loadedModels: ['qwen2.5-7b-instruct'],
      selectedModel: 'qwen2.5-7b-instruct',
      loaded: true,
    });
    expect(status.models.map((m) => [m.model, m.loaded])).toEqual([
      ['deepseek-r1-distill', false],
      ['qwen2.5-7b-instruct', true],
    ]);
  });

  it('4b. falls back to the v0 native API, then to the OpenAI-compatible listing', async () => {
    fake = await startFakeLMStudio({ apiMode: 'native-v0', models: [{ id: 'mistral-7b', loaded: true }] });
    const v0 = await provider(fake.url, 'mistral-7b').checkAvailability();
    expect(v0).toMatchObject({ available: true, selectedModel: 'mistral-7b', details: { apiMode: 'native-v0', loaded: true } });
    await fake.close();

    fake = await startFakeLMStudio({ apiMode: 'openai-compatible', models: [{ id: 'mistral-7b' }] });
    const compat = await provider(fake.url).checkAvailability();
    expect(compat).toMatchObject({ available: true, selectedModel: 'mistral-7b', details: { apiMode: 'openai-compatible', loaded: null, loadedModels: null } });
    expect(compat.reason).toMatch(/load state unknown/);
  });
});

describe('LMStudioProvider — generation', () => {
  it('5 & 9. generates via /v1/chat/completions with structured usage, latency and LOCAL cost metadata', async () => {
    fake = await startFakeLMStudio({
      chat: (body) => ({
        json: {
          id: 'chatcmpl-1',
          model: body.model,
          choices: [{ message: { content: '<think>secret chain of thought</think>{"ok":true}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 30 },
        },
      }),
    });
    const lm = provider(fake.url, undefined, { apiKey: 'lm-local-token' });
    await lm.checkAvailability();
    const result = await lm.generate(request);

    expect(result).toMatchObject({
      provider: 'lmstudio',
      model: 'qwen2.5-7b-instruct',
      executionType: 'LOCAL',
      output: '{"ok":true}',
      usage: { inputTokens: 120, outputTokens: 30 },
      cost: { estimatedApiCost: 0, executionCostType: 'LOCAL_COMPUTE', currency: 'USD' },
      metadata: { finishReason: 'stop', responseId: 'chatcmpl-1', reasoningStripped: true },
    });
    expect(result.output).not.toContain('secret chain of thought');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const [sent] = fake.chatRequests();
    expect(sent).toMatchObject({ model: 'qwen2.5-7b-instruct', stream: false, max_tokens: 300, temperature: 0.4 });
    expect(sent?.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(sent).not.toHaveProperty('response_format'); // LM Studio only accepts json_schema there
    expect(fake.requests.find((r) => r.url === '/v1/chat/completions')?.headers.authorization).toBe('Bearer lm-local-token');
  });

  it('6. classifies HTTP failures: 5xx retryable, 4xx permanent, empty content retryable', async () => {
    fake = await startFakeLMStudio({ chat: () => ({ status: 500, json: { error: 'model crashed' } }) });
    const lm = provider(fake.url);
    await lm.checkAvailability();
    const serverError = await lm.generate(request).catch((e: unknown) => e);
    expect(serverError).toBeInstanceOf(ProviderError);
    expect((serverError as ProviderError).retryable).toBe(true);

    fake.setChat(() => ({ status: 400, json: { error: 'No models loaded' } }));
    const badRequest = await lm.generate(request).catch((e: unknown) => e);
    expect((badRequest as ProviderError).retryable).toBe(false);

    fake.setChat(() => ({ json: { choices: [{ message: { content: '<think>only reasoning</think>' } }] } }));
    const empty = await lm.generate(request).catch((e: unknown) => e);
    expect((empty as ProviderError).message).toMatch(/empty response/);
    expect((empty as ProviderError).retryable).toBe(true);
  });

  it('uses its own (local) timeout: a slow model is not cut off by a cloud-sized cap', async () => {
    fake = await startFakeLMStudio({ chat: (body) => ({ delayMs: 300, json: { model: body.model, choices: [{ message: { content: '{"ok":true}' } }] } }) });
    const patient = provider(fake.url, undefined, { timeoutMs: 2_000 });
    await patient.checkAvailability();
    expect((await patient.generate(request)).output).toBe('{"ok":true}');

    const impatient = provider(fake.url, undefined, { timeoutMs: 100 });
    await impatient.checkAvailability();
    const timeout = await impatient.generate(request).catch((e: unknown) => e);
    expect((timeout as ProviderError).message).toMatch(/timed out/);
    expect((timeout as ProviderError).retryable).toBe(true);
  });
});
