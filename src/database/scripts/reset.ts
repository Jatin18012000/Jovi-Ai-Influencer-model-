import { existsSync, rmSync } from 'node:fs';
import { loadConfig } from '../../core/config/config.js';
import { openDatabase, resolveDatabasePath, runMigrations } from '../client.js';
import { seedDatabase } from '../seed.js';
import { VisualIdentityService } from '../../core/identity/visual-identity.js';
import { loadEnvFile } from '../../core/config/load-env.js';

/** `npm run db:reset` — deletes the local SQLite database and recreates it (development only). */
loadEnvFile();
const config = loadConfig();
if (config.env === 'production') {
  console.error('Refusing to reset the database when NODE_ENV=production.');
  process.exit(1);
}
const path = resolveDatabasePath(config.database.url);
if (path !== ':memory:') {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    if (existsSync(path + suffix)) rmSync(path + suffix);
  }
}
const handle = openDatabase(config.database.url);
runMigrations(handle);
console.log(`Reset ${handle.url}:`, { ...seedDatabase(handle), visualIdentity: new VisualIdentityService(handle.db).seed() ? 'created' : 'exists' });
handle.close();
