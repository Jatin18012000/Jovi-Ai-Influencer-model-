import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { OllamaProvider } from '../../src/models/providers/ollama-provider.js';
import { createTestCore, TEST_GOAL } from '../helpers.js';

/**
 * Real local-model verification. Skipped unless explicitly enabled:
 *
 *   JOVI_OLLAMA_INTEGRATION=1 OLLAMA_MODEL=llama3.1:8b npm run test:ollama
 *
 * Requires a running Ollama with at least one installed chat model. Never pulls models.
 */
const enabled = process.env.JOVI_OLLAMA_INTEGRATION === '1';
const url = process.env.OLLAMA_URL ?? 'http://localhost:11434';

describe.skipIf(!enabled)('Ollama integration (real local model)', () => {
  let core: JoviCore;
  const provider = new OllamaProvider({ url, model: process.env.OLLAMA_MODEL, timeoutMs: 600_000 });

  beforeAll(async () => {
    core = await createTestCore({ providers: [provider], env: { JOVI_PROVIDER_TIMEOUT_MS: '600000' } });
  });
  afterAll(async () => core?.close());

  it('connects to Ollama and detects an installed model', async () => {
    const status = await provider.checkAvailability();
    expect(status.available, status.reason).toBe(true);
    expect(status.selectedModel).toBeTruthy();
  });

  it('runs a real Executive Agent request end to end', { timeout: 900_000 }, async () => {
    const result = await core.orchestrator.executeGoal({ goal: TEST_GOAL });
    expect(result.status, JSON.stringify(result.error)).toBe('COMPLETED');
    expect(result.modelsUsed[0]).toMatchObject({ provider: 'ollama', executionCostType: 'LOCAL_COMPUTE', estimatedApiCost: 0 });
    expect(result.options.length).toBeGreaterThanOrEqual(2);
    expect(result.selectedAction).not.toBeNull();
  });
});
