import { createJoviCore } from '../../src/core/bootstrap.js';

/**
 * Standalone job worker (`npm run worker`). Processes asynchronous goals
 * (POST /api/jovi/goal with "mode": "async") from the shared SQLite queue.
 * Use this when the API runs with JOVI_WORKER_ENABLED=false.
 */
async function main(): Promise<void> {
  const core = await createJoviCore();
  core.worker.start();
  const shutdown = async () => {
    await core.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  console.error('Jovi worker failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
