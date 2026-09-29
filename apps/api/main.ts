import { createJoviCore } from '../../src/core/bootstrap.js';
import { loadConfig, redactConfig } from '../../src/core/config/config.js';
import { loadEnvFile } from '../../src/core/config/load-env.js';
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
