import { chmodSync, existsSync, mkdirSync } from 'node:fs';
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
  const dir = path === ':memory:' ? null : dirname(path);
  const createdDir = dir !== null && !existsSync(dir);
  if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const sqlite = new Database(path);
  if (dir) restrictPermissions(path, dir, createdDir);
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

/**
 * R-18: the database holds goals, outputs and credentials hashes in plaintext.
 * The file (and its WAL/SHM side files) is owner-only (0600). Its directory is
 * made owner-only (0700) when Jovi created it or it is the default `data/`
 * directory — never an arbitrary pre-existing directory such as /tmp.
 */
function restrictPermissions(path: string, dir: string, createdDir: boolean): void {
  try {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
    if (createdDir || dir === resolveFromRoot('data')) chmodSync(dir, 0o700);
  } catch {
    // Filesystems without POSIX permissions (e.g. some mounts) are left as they are.
  }
}

export const MIGRATIONS_FOLDER = fromRoot('src', 'database', 'migrations');

export function runMigrations(handle: DatabaseHandle): void {
  migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
}
