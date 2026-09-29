import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | undefined;

/**
 * Resolves the project root (the directory containing package.json) by walking
 * up from this module. Works both from `src/` (tsx) and `dist/src/` (compiled),
 * so prompts, knowledge and migrations resolve identically in dev and prod.
 */
export function projectRoot(): string {
  if (cachedRoot) return cachedRoot;
  if (process.env.JOVI_ROOT) {
    cachedRoot = resolve(process.env.JOVI_ROOT);
    return cachedRoot;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'prompts'))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedRoot = process.cwd();
  return cachedRoot;
}

export function fromRoot(...segments: string[]): string {
  return join(projectRoot(), ...segments);
}

export function resolveFromRoot(path: string): string {
  return isAbsolute(path) ? path : join(projectRoot(), path);
}
