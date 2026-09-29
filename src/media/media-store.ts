import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { ValidationError } from '../core/errors.js';
import { resolveFromRoot } from '../core/config/paths.js';

const SAFE_ID = /^[a-z]{2,5}_[0-9a-f-]{8,64}$/;
const SAFE_EXT = /^\.(png|jpe?g|webp|gif|mp4|webm|mov|wav|mp3|ogg|m4a|json)$/i;

/**
 * The only place media bytes are written. Paths are derived from validated
 * ids and confined to the configured media directory — no caller (agent or
 * provider) can choose an arbitrary filesystem path.
 */
export class MediaStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(resolveFromRoot(root));
  }

  pathFor(productionId: string, assetId: string, extension: string): string {
    if (!SAFE_ID.test(productionId) || !SAFE_ID.test(assetId)) throw new ValidationError('invalid production/asset id for media path');
    const ext = extension.startsWith('.') ? extension : `.${extension}`;
    if (!SAFE_EXT.test(ext)) throw new ValidationError(`unsupported media extension ${ext}`);
    return join(this.root, productionId, `${assetId}${ext.toLowerCase()}`);
  }

  write(productionId: string, assetId: string, extension: string, bytes: Buffer): string {
    const path = this.pathFor(productionId, assetId, extension);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return path;
  }

  /** True when `location` is a non-empty file inside the media root. */
  holdsFile(location: string): boolean {
    const path = resolve(location);
    if (!path.startsWith(this.root + sep)) return false;
    return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
  }

  static extensionOf(filename: string, fallback: string): string {
    return extname(filename) || fallback;
  }
}
