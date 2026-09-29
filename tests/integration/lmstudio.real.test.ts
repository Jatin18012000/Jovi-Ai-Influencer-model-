import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJoviCore, type JoviCore } from '../../src/core/bootstrap.js';
import { loadConfig } from '../../src/core/config/config.js';
import { loadEnvFile } from '../../src/core/config/load-env.js';
import { LMStudioProvider } from '../../src/models/providers/lmstudio-provider.js';

/**
 * REAL LM Studio end-to-end test. Skipped unless explicitly enabled:
 *
 *   npm run test:lmstudio:real
 *
 * Requires LM Studio's local server running with a chat model LOADED.
 * Uses ONLY LMStudioProvider: no MockProvider, no cloud providers.
 * Reads LM_STUDIO_URL / LM_STUDIO_MODEL / LM_STUDIO_TIMEOUT_MS from the environment or .env.
 */
const enabled = process.env.JOVI_LMSTUDIO_REAL === '1';
const GOAL = 'Create an Instagram Reel concept that introduces Jovi to a new audience and makes viewers curious about who she is.';

describe.skipIf(!enabled)('LM Studio — real local model end to end', () => {
  let core: JoviCore;
  let provider: LMStudioProvider;

  beforeAll(async () => {
    loadEnvFile();
    const env = loadConfig(process.env).providers.lmstudio;
    provider = new LMStudioProvider({ url: env.url, model: env.model, apiKey: env.apiKey, timeoutMs: env.timeoutMs });
    const config = loadConfig({ ...process.env, DATABASE_URL: ':memory:', JOVI_LOG_LEVEL: process.env.JOVI_LOG_LEVEL ?? 'info', JOVI_SIMULATION_MODE: 'false' });
    core = await createJoviCore({ config, providers: [provider] });
  });
  afterAll(async () => core?.close());

  it('detects LM Studio and a loaded model', async () => {
    const status = await provider.checkAvailability();
    console.log('LM Studio discovery:', JSON.stringify(status.details, null, 2));
    expect(status.available, status.reason).toBe(true);
  });

  it('executes the Jovi goal on the local model', { timeout: 1_800_000 }, async () => {
    const result = await core.orchestrator.executeGoal({ goal: GOAL, privacy: 'LOCAL_ONLY' });
    console.log(JSON.stringify({ status: result.status, selectedAction: result.selectedAction, confidence: result.confidence, modelsUsed: result.modelsUsed, error: result.error }, null, 2));
    expect(result.status, JSON.stringify(result.error)).toBe('COMPLETED');
    expect(result.simulated).toBe(false);
    expect(result.modelsUsed[0]).toMatchObject({ provider: 'lmstudio', executionType: 'LOCAL', executionCostType: 'LOCAL_COMPUTE', estimatedApiCost: 0 });
    expect(result.options.length).toBeGreaterThanOrEqual(2);
    expect(result.decisionId).toMatch(/^dec_/);
    expect(core.jobs.get(result.jobId).status).toBe('COMPLETED');
    expect(result.eventsGenerated.map((e) => e.eventType)).toEqual(expect.arrayContaining(['DECISION_SELECTED', 'MEMORY_CREATED', 'TASK_COMPLETED']));
  });
});
