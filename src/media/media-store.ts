import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { ValidationError } from '../core/errors.js';
import { resolveFromRoot } from '../core/config/paths.js';

const SAFE_ID = /^[a-z]{2,5}_[0-9a-f-]{8,64}$/;
const SAFE_EXT = /^\.(png|jpe?g|webp|gif|mp4|webm|mov|wav|aiff?|mp3|ogg|m4a|json|srt)$/i;

/**
 * The only place media bytes are written. Paths are derived from validated
 * ids and confined to the configured media directory — no caller (agent or
 * provider) can choose an arbitrary filesystem path.
 */
export class MediaStore {
  readonly root: string;
  /** Human-supplied reference images (e.g. Jovi's approved reference sheet). Read-only for providers. */
  readonly referenceRoot: string;

  constructor(root: string, referenceRoot = 'data/references') {
    this.root = resolve(resolveFromRoot(root));
    this.referenceRoot = resolve(resolveFromRoot(referenceRoot));
  }

  pathFor(productionId: string, assetId: string, extension: string): string {
    if (!SAFE_ID.test(productionId) || !SAFE_ID.test(assetId)) throw new ValidationError('invalid production/asset id for media path');
    const ext = extension.startsWith('.') ? extension : `.${extension}`;
    if (!SAFE_EXT.test(ext)) throw new ValidationError(`unsupported media extension ${ext}`);
    return join(this.root, productionId, `${assetId}${ext.toLowerCase()}`);
  }

  /** Output path for an external process (ffmpeg, say) to write to; creates the directory. */
  prepare(productionId: string, assetId: string, extension: string): string {
    const path = this.pathFor(productionId, assetId, extension);
    mkdirSync(dirname(path), { recursive: true });
    return path;
  }

  write(productionId: string, assetId: string, extension: string, bytes: Buffer): string {
    const path = this.pathFor(productionId, assetId, extension);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return path;
  }

  /** True when `location` is a non-empty file inside the media root. */
  holdsFile(location: string): boolean {
    return MediaStore.isFileWithin(this.root, location);
  }

  /** True when `path` is a non-empty file inside the media root or the reference directory. */
  isReadableInput(path: string): boolean {
    return MediaStore.isFileWithin(this.root, path) || MediaStore.isFileWithin(this.referenceRoot, resolveFromRoot(path));
  }

  /** R-05: bytes used under the media root (regular files only; symlinks are not followed). */
  usageBytes(): number {
    let total = 0;
    const walk = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const path = join(dir, name);
        const info = lstatSync(path);
        if (info.isDirectory()) walk(path);
        else if (info.isFile()) total += info.size;
      }
    };
    walk(this.root);
    return total;
  }

  /**
   * R-05 garbage collection: deletes an asset file and its same-named sidecars
   * (.srt/.json). Only regular files inside the media root are touched;
   * symlinks and anything outside the root are refused. Returns bytes freed.
   */
  remove(location: string): number {
    const path = resolve(location);
    if (!path.startsWith(this.root + sep)) throw new ValidationError('refusing to delete a file outside the media directory');
    const stem = basename(path, extname(path));
    let freed = 0;
    for (const candidate of [path, join(dirname(path), `${stem}.srt`), join(dirname(path), `${stem}.json`)]) {
      if (!existsSync(candidate)) continue;
      const info = lstatSync(candidate);
      if (!info.isFile()) continue;
      unlinkSync(candidate);
      freed += info.size;
    }
    return freed;
  }

  /** Writes a small sidecar file (e.g. captions) next to an asset. */
  writeSidecar(productionId: string, assetId: string, extension: '.srt' | '.json', content: string): string {
    return this.write(productionId, assetId, extension, Buffer.from(content, 'utf8'));
  }

  private static isFileWithin(root: string, location: string): boolean {
    const path = resolve(location);
    if (!path.startsWith(root + sep)) return false;
    return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
  }

  static extensionOf(filename: string, fallback: string): string {
    return extname(filename) || fallback;
  }
}
