import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

/**
 * R-17: SHA-256 of a file, cached by (size, mtime, inode) so repeated checks of
 * an unchanged binary or workflow are cheap while any replacement is re-hashed.
 */
const cache = new Map<string, { key: string; hash: string }>();

export function sha256File(path: string): string {
  const info = statSync(path);
  const key = `${info.size}:${info.mtimeMs}:${info.ino}`;
  const hit = cache.get(path);
  if (hit && hit.key === key) return hit.hash;
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
  cache.set(path, { key, hash });
  return hash;
}

/** Null when `path` matches the pinned hash; otherwise the reason it does not. */
export function pinMismatch(path: string, expectedSha256: string): string | null {
  try {
    const actual = sha256File(path);
    return actual === expectedSha256.toLowerCase() ? null : `SHA-256 mismatch for ${path}: expected ${expectedSha256.toLowerCase()}, found ${actual}`;
  } catch (error) {
    return `cannot hash ${path}: ${(error as Error).message}`;
  }
}
