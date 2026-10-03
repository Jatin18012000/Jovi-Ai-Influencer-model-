import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { ALL_SCOPES, type ApiScope } from '../src/core/auth/api-credentials.js';
import { totpCode } from '../src/core/auth/totp.js';
import { createJoviCore, type JoviCore } from '../src/core/bootstrap.js';
import { loadConfig } from '../src/core/config/config.js';
import { mockExecutiveProposal, MockProvider } from '../src/models/providers/mock-provider.js';
import type { AnyMediaProvider } from '../src/media/types.js';
import type { GenerateRequest, ModelProvider } from '../src/models/types.js';

/** Gate C test secret (base32, 160 bits) for API approvals; see `approvalCode`. */
export const TEST_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** The current second-factor header for an API approval. */
export function approvalCode(secret = TEST_TOTP_SECRET): { 'x-jovi-approval-code': string } {
  return { 'x-jovi-approval-code': totpCode(secret, Math.floor(Date.now() / 30_000)) };
}

export const TEST_GOAL = 'Create an Instagram Reel concept for Jovi that introduces her personality to a new audience.';

/**
 * Builds a fully wired Jovi Core on an in-memory SQLite database with mocked
 * providers. No network, no API keys, no local model.
 */
export async function createTestCore(
  options: {
    providers?: ModelProvider[];
    env?: Record<string, string>;
    mediaProviders?: AnyMediaProvider[];
    /** Record a passing safety-reviewer calibration for every registered test model (default true; see `calibrateReviewer`). */
    calibrateReviewers?: boolean;
  } = {},
): Promise<JoviCore> {
  const config = loadConfig({
    DATABASE_URL: ':memory:',
    JOVI_LOG_LEVEL: 'silent',
    JOVI_JOB_BACKOFF_MS: '0',
    JOVI_PROVIDER_STATUS_TTL_MS: '0',
    LM_STUDIO_ENABLED: 'false',
    JOVI_APPROVAL_TOTP_SECRET: TEST_TOTP_SECRET,
    ...options.env,
  });
  const core = await createJoviCore({
    config,
    providers: options.providers ?? [new MockProvider()],
    sleep: async () => {},
    ...(options.mediaProviders ? { mediaProviders: options.mediaProviders } : {}),
  });
  if (options.calibrateReviewers !== false) {
    for (const s of await core.providers.statusesFresh()) {
      if (s.kind !== 'MOCK' && s.selectedModel) await calibrateReviewer(core, s.provider, s.selectedModel);
    }
    await calibrateReviewer(core, TEST_REVIEWER.provider, TEST_REVIEWER.model);
  }
  return core;
}

/** The reviewer named by `clearForMedia` reviews. */
export const TEST_REVIEWER = { provider: 'test-reviewer', model: 'test-reviewer-model' } as const;

/**
 * Test fixture for the re-audit N-04 calibration gate: runs the REAL
 * calibration path (corpus, thresholds, protected chained event) with an
 * oracle reviewer that answers every corpus case by its label, so test-double
 * models count as measured reviewers. Pipeline tests are about the pipeline,
 * not model quality; the gate itself is tested with `calibrateReviewers: false`.
 */
export async function calibrateReviewer(core: JoviCore, provider: string, model: string): Promise<void> {
  const { corpus } = core.safetyCalibration.corpus();
  const labels = new Map(corpus.cases.map((c) => [c.text, c.expect]));
  const result = await core.safetyCalibration.calibrate(async ([text]) => ({ provider, model, blocked: labels.get(text ?? '') === 'BLOCK' }), 'test-fixture');
  if (!result.passed) throw new Error(`test calibration failed: ${result.failures.join('; ')}`);
}

/** Two independent mocks: a "cloud" generator and a "local" evaluator. */
export function competingMocks(): { cloud: MockProvider; local: MockProvider } {
  return {
    cloud: new MockProvider({ id: 'mock-cloud', kind: 'CLOUD', model: 'cloud-model' }),
    local: new MockProvider({ id: 'mock-local', kind: 'LOCAL', model: 'local-model' }),
  };
}

export function proposalJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...mockExecutiveProposal(TEST_GOAL), ...overrides });
}

export function taskTypeOf(request: GenerateRequest): string {
  return request.task.type;
}

/** Creates a scoped API credential and returns its Authorization header. */
export function bearer(core: JoviCore, scopes: readonly ApiScope[] = ALL_SCOPES, name = `test-${randomUUID().slice(0, 8)}`): { authorization: string } {
  const { token } = core.credentials.create(name, scopes, 'test');
  return { authorization: `Bearer ${token}` };
}

/** `app.inject` with a credential attached (explicit headers win). */
export function authedInject(app: FastifyInstance, auth: { authorization: string }) {
  return (options: InjectOptions) => app.inject({ ...options, headers: { ...auth, ...(options.headers ?? {}) } });
}

/** Marks a synthetic test production as cleared by the pre-generation safety gate (R-02). */
export function clearForMedia(core: JoviCore, productionId: string): void {
  core.productions.saveArtifact(
    productionId,
    'SAFETY_REVIEW',
    { verdict: 'ALLOW', reasons: [], model: { available: true, ...TEST_REVIEWER } },
    null,
    core.events.scope('cor_test-clearance'),
  );
}
