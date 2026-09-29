import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QAReport, Script, Storyboard, VisualPrompts } from '../../src/agents/production/production-schemas.js';
import { createJoviCore, type JoviCore } from '../../src/core/bootstrap.js';
import { loadConfig } from '../../src/core/config/config.js';
import { loadEnvFile } from '../../src/core/config/load-env.js';
import { LMStudioProvider } from '../../src/models/providers/lmstudio-provider.js';

/**
 * REAL LM Studio test for the Phase 8 TEXT agents (script, storyboard, visual
 * prompts, QA review). Skipped unless explicitly enabled:
 *
 *   npm run test:production:real
 *
 * Requires LM Studio's local server with a chat model LOADED (tested target:
 * google/gemma-4-12b-qat). Uses ONLY LMStudioProvider — no mock, no cloud.
 * Media providers come from configuration: unless COMFYUI_URL and a workflow
 * are set, every media asset is BLOCKED, and the test asserts exactly that
 * rather than pretending media was generated.
 */
const enabled = process.env.JOVI_LMSTUDIO_REAL === '1';

const IDEA = {
  id: 'real-1',
  title: 'Two Truths and a Glitch',
  format: 'REEL',
  pillar: 'Entertainment & Personality',
  hook: 'Three facts about me. One of them is a glitch. Go.',
  concept: 'Jovi rapid-fires three facts about herself; the glitch is the one that reveals she is AI. Viewers guess in the comments.',
};

describe.skipIf(!enabled)('LM Studio — real Phase 8 text agents', () => {
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

  it('writes script, storyboard, visual prompts and a QA review on the local model', { timeout: 3_600_000 }, async () => {
    const identityBefore = JSON.stringify(core.identity.getActive());
    const media = await core.mediaProviders.statuses();
    console.log('Media providers:', JSON.stringify(media.map((m) => ({ provider: m.provider, state: m.state, reason: m.reason }))));

    const result = await core.production.start({ idea: IDEA, privacy: 'LOCAL_ONLY' });
    const id = result.productionId!;
    const script = core.productions.latestArtifact<Script>(id, 'SCRIPT');
    const storyboard = core.productions.latestArtifact<Storyboard>(id, 'STORYBOARD');
    const prompts = core.productions.latestArtifact<VisualPrompts>(id, 'VISUAL_PROMPTS');
    const qa = core.productions.latestArtifact<QAReport>(id, 'QA_REPORT');
    console.log(
      JSON.stringify(
        {
          status: result.status,
          productionStatus: result.productionStatus,
          qaStatus: result.qaStatus,
          simulated: result.simulated,
          scriptHook: script?.hook,
          scenes: storyboard?.scenes.length,
          firstImagePrompt: prompts?.prompts[0]?.imagePrompt.slice(0, 400),
          qaModelReview: qa?.modelReview,
          assets: result.assets.map((a) => `${a.kind}:${a.status}:${a.reason ?? ''}`.slice(0, 160)),
          requiredFixes: qa?.requiredFixes,
          error: result.error,
        },
        null,
        2,
      ),
    );

    expect(result.status, JSON.stringify(result.error)).toBe('COMPLETED');
    expect(result.simulated).toBe(false);
    expect(result.artifacts).toMatchObject({ script: true, storyboard: true, visualPrompts: true, editPlan: true, qaReport: true });
    expect(qa?.modelReview).toMatchObject({ available: true, provider: 'lmstudio' });
    expect(['AWAITING_HUMAN_APPROVAL', 'BLOCKED']).toContain(result.productionStatus);
    // No media is claimed without an available provider and a verified output.
    for (const a of core.assets.list(id)) {
      if (a.status === 'COMPLETED') expect(core.mediaStore.holdsFile(a.location!) || /^https:\/\//.test(a.location!)).toBe(true);
      expect(a.status).not.toBe('SIMULATED');
    }
    expect(result.publishingGate?.autonomousPublishingAllowed).toBe(false);
    expect(JSON.stringify(core.identity.getActive())).toBe(identityBefore);
  });
});
