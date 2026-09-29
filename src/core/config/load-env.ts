import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fromRoot } from './paths.js';

export interface EnvFileResult {
  path: string;
  loaded: boolean;
  /** Variables applied from the file (never their values — they may be secrets). */
  applied: string[];
}

/**
 * Loads `.env` from the project root into `env`. Variables already present in
 * the real environment always win, so shell exports and CI secrets override
 * the file. Called by entry points (API, CLI, worker, db scripts) only — tests
 * build their configuration explicitly and never read `.env`.
 */
export function loadEnvFile(path: string = fromRoot('.env'), env: NodeJS.ProcessEnv = process.env): EnvFileResult {
  if (!existsSync(path)) return { path, loaded: false, applied: [] };
  const parsed = parseEnv(readFileSync(path, 'utf8')) as Record<string, string>;
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) {
      env[key] = value;
      applied.push(key);
    }
  }
  return { path, loaded: true, applied };
}
