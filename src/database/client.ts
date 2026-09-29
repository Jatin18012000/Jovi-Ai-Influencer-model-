import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fromRoot, resolveFromRoot } from '../core/config/paths.js';
import * as schema from './schema.js';

export type JoviDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  db: JoviDatabase;
  sqlite: Database.Database;
  url: string;
  close(): void;
}

/**
 * Accepts `:memory:`, a plain path (`data/jovi.db`), or a `file:` URL.
 * Relative paths resolve against the project root, never the caller's cwd.
 */
export function resolveDatabasePath(url: string): string {
  if (url === ':memory:') return url;
  const path = url.startsWith('file:') ? url.slice('file:'.length) : url;
  return resolveFromRoot(path);
}

export function openDatabase(url: string): DatabaseHandle {
  const path = resolveDatabasePath(url);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });
  return {
    db,
    sqlite,
    url: path,
    close: () => sqlite.close(),
  };
}

export const MIGRATIONS_FOLDER = fromRoot('src', 'database', 'migrations');

export function runMigrations(handle: DatabaseHandle): void {
  migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
}
