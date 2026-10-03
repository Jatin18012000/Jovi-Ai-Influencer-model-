import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
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
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    return path;
  }

  write(productionId: string, assetId: string, extension: string, bytes: Buffer): string {
    const path = this.pathFor(productionId, assetId, extension);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: 0o600 });
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

  /**
   * R-09: reads a confined input file (media or reference directory) without
   * following symlinks. The path is checked, then opened with O_NOFOLLOW
   * where the platform supports it, and the opened descriptor is re-checked
   * (regular, non-empty file), so a swap after the check cannot redirect it.
   */
  readInput(path: string): Buffer {
    const candidates = [resolve(path), resolveFromRoot(path)];
    const target = candidates.find((p) => MediaStore.isFileWithin(this.root, p) || MediaStore.isFileWithin(this.referenceRoot, p));
    if (!target) throw new ValidationError(`refusing to read ${path}: not a regular file inside the media or reference directory`);
    const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size === 0) throw new ValidationError(`refusing to read ${path}: not a regular non-empty file`);
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
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

  /**
   * R-09: confinement is checked on the real filesystem, not lexically. The
   * file itself must not be a symlink, and its real path (all parent
   * directories resolved) must stay inside the real root, so a symlinked
   * file or directory inside data/ cannot point outside it.
   */
  private static isFileWithin(root: string, location: string): boolean {
    const path = resolve(location);
    if (!path.startsWith(root + sep)) return false;
    try {
      const entry = lstatSync(path);
      if (entry.isSymbolicLink() || !entry.isFile() || entry.size === 0) return false;
      return realpathSync(path).startsWith(realpathSync(root) + sep);
    } catch {
      return false;
    }
  }

  static extensionOf(filename: string, fallback: string): string {
    return extname(filename) || fallback;
  }
}
