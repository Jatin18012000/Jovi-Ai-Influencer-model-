import { loadConfig } from '../../core/config/config.js';
import { openDatabase, runMigrations } from '../client.js';
import { seedDatabase } from '../seed.js';
import { loadEnvFile } from '../../core/config/load-env.js';

/** `npm run db:seed` — migrates, then idempotently loads the Phase 5 seed data. */
loadEnvFile();
const config = loadConfig();
const handle = openDatabase(config.database.url);
runMigrations(handle);
const report = seedDatabase(handle);
console.log(`Seeded ${handle.url}:`, report);
handle.close();
