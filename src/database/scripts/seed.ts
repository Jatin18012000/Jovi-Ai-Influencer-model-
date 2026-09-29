import { loadConfig } from '../../core/config/config.js';
import { openDatabase, runMigrations } from '../client.js';
import { seedDatabase } from '../seed.js';
import { VisualIdentityService } from '../../core/identity/visual-identity.js';
import { loadEnvFile } from '../../core/config/load-env.js';

/** `npm run db:seed` — migrates, then idempotently loads the Phase 5 seed data. */
loadEnvFile();
const config = loadConfig();
const handle = openDatabase(config.database.url);
runMigrations(handle);
const report = { ...seedDatabase(handle), visualIdentity: new VisualIdentityService(handle.db).seed() ? 'created' : 'exists' };
console.log(`Seeded ${handle.url}:`, report);
handle.close();
