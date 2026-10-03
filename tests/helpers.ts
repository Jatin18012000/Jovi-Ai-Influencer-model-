import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { ALL_SCOPES, type ApiScope } from '../src/core/auth/api-credentials.js';
import { createJoviCore, type JoviCore } from '../src/core/bootstrap.js';
import { loadConfig } from '../src/core/config/config.js';
import { mockExecutiveProposal, MockProvider } from '../src/models/providers/mock-provider.js';
import type { AnyMediaProvider } from '../src/media/types.js';
import type { GenerateRequest, ModelProvider } from '../src/models/types.js';

export const TEST_GOAL = 'Create an Instagram Reel concept for Jovi that introduces her personality to a new audience.';

/**
 * Builds a fully wired Jovi Core on an in-memory SQLite database with mocked
 * providers. No network, no API keys, no local model.
 */
export async function createTestCore(
  options: { providers?: ModelProvider[]; env?: Record<string, string>; mediaProviders?: AnyMediaProvider[] } = {},
): Promise<JoviCore> {
  const config = loadConfig({
    DATABASE_URL: ':memory:',
    JOVI_LOG_LEVEL: 'silent',
    JOVI_JOB_BACKOFF_MS: '0',
    JOVI_PROVIDER_STATUS_TTL_MS: '0',
    LM_STUDIO_ENABLED: 'false',
    ...options.env,
  });
  return createJoviCore({
    config,
    providers: options.providers ?? [new MockProvider()],
    sleep: async () => {},
    ...(options.mediaProviders ? { mediaProviders: options.mediaProviders } : {}),
  });
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
  core.productions.saveArtifact(productionId, 'SAFETY_REVIEW', { verdict: 'ALLOW', reasons: [] }, null, core.events.scope('cor_test-clearance'));
}
