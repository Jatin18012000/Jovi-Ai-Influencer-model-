import { createJoviCore } from '../../src/core/bootstrap.js';
import { loadConfig, redactConfig } from '../../src/core/config/config.js';
import { loadEnvFile } from '../../src/core/config/load-env.js';
import { ALL_SCOPES } from '../../src/core/auth/api-credentials.js';
import { assertSafeBind } from './security.js';
import { buildApiServer } from './server.js';

/** Jovi Core API entry point: `npm run start:dev` (tsx) or `npm start` (compiled). */
async function main(): Promise<void> {
  const envFile = loadEnvFile();
  const config = loadConfig();
  // Refuse unauthenticated network exposure before opening the database or any port.
  const bindWarning = assertSafeBind(config.api);

  const core = await createJoviCore({ config });
  const app = buildApiServer(core);

  core.logger.info(
    { config: redactConfig(config), envFile: { loaded: envFile.loaded, variables: envFile.applied }, seed: core.seedReport, jobRecovery: core.jobRecovery },
    'jovi core initialised',
  );
  if (bindWarning) core.logger.warn(bindWarning);

  // Authentication is mandatory (R-01). On first run, create an owner credential
  // and show its token exactly once; only its SHA-256 hash is stored.
  if (!core.credentials.hasUsableCredential()) {
    const { token } = core.credentials.create('owner', ALL_SCOPES, 'bootstrap:first-run');
    process.stderr.write(
      [
        '',
        '================================================================================',
        ' Jovi API: no credential existed, so an OWNER credential was created.',
        ` Token (shown ONCE, scopes ${ALL_SCOPES.join(',')}):`,
        '',
        `   ${token}`,
        '',
        ' Use it as:  Authorization: Bearer <token>',
        ' Store it in a password manager. Create narrower credentials for automation:',
        '   npm run jovi -- --api-token create --name n8n --scopes read,operate',
        ' Revoke with: npm run jovi -- --api-token revoke --name owner',
        '================================================================================',
        '',
      ].join('\n'),
    );
    core.logger.warn({ credential: 'owner' }, 'created first-run owner API credential (token printed once to stderr)');
  }
  const statuses = await core.providers.statusesFresh(true);
  for (const s of statuses) {
    core.logger.info({ provider: s.provider, available: s.available, model: s.selectedModel, reason: s.reason, details: s.details }, 'provider status');
  }
  if (!statuses.some((s) => s.available)) {
    core.logger.warn('no model provider available: configure a cloud API key or start LM Studio with a model loaded');
  }

  if (config.jobs.workerEnabled) core.worker.start();

  const shutdown = async (signal: string) => {
    core.logger.info({ signal }, 'shutting down');
    await app.close();
    await core.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.api.host, port: config.api.port });
}

main().catch((error: unknown) => {
  console.error('Failed to start Jovi Core API:', error instanceof Error ? error.message : error);
  process.exit(1);
});
