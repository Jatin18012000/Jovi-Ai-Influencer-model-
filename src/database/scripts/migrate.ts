import { loadConfig } from '../../core/config/config.js';
import { openDatabase, runMigrations } from '../client.js';
import { loadEnvFile } from '../../core/config/load-env.js';

/** `npm run db:migrate` — applies pending SQL migrations. */
loadEnvFile();
const config = loadConfig();
const handle = openDatabase(config.database.url);
runMigrations(handle);
console.log(`Migrations applied to ${handle.url}`);
handle.close();
