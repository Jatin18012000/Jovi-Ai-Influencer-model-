import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaKind } from '../types/enums.js';
import { runProcess } from './process-runner.js';

export type MediaFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'mp4' | 'mov' | 'webm' | 'wav' | 'aiff' | 'mp3' | 'ogg' | 'm4a';

/** Container formats acceptable for each asset kind. */
export const FORMATS_BY_KIND: Record<MediaKind, MediaFormat[]> = {
  IMAGE: ['png', 'jpeg', 'webp', 'gif'],
  VIDEO: ['mp4', 'mov', 'webm', 'gif'],
  VOICE: ['wav', 'aiff', 'mp3', 'ogg', 'm4a'],
  RENDER: ['mp4', 'mov', 'webm'],
};

export interface MediaInspection {
  ok: boolean;
  format: MediaFormat | null;
  bytes: number;
  sha256: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  /** How duration/dimensions were obtained. */
  method: 'SIGNATURE' | 'FFPROBE';
  reason: string;
}

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 1024 * 1024;

// Re-audit R2-06: inspection never follows a symlink at the final path component.
const READ_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

function readRange(fd: number, start: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const read = readSync(fd, buffer, 0, length, start);
  return buffer.subarray(0, read);
}

function sha256(fd: number, size: number): string {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(1024 * 1024);
  let position = 0;
  while (position < size) {
    const read = readSync(fd, chunk, 0, chunk.length, position);
    if (read <= 0) break;
    hash.update(chunk.subarray(0, read));
    position += read;
  }
  return hash.digest('hex');
}

/**
 * Re-audit N-06 (residual): ffprobe reads a private copy (0700 directory,
 * 0600 file) of the bytes Jovi already verified through its descriptor, so
 * the probed file is the hashed file and no path can be swapped underneath.
 */
function privateCopy(fd: number, size: number, extension: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'jovi-probe-'));
  const path = join(dir, `input${extension}`);
  try {
    const out = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      const chunk = Buffer.alloc(1024 * 1024);
      let position = 0;
      while (position < size) {
        const read = readSync(fd, chunk, 0, chunk.length, position);
        if (read <= 0) break;
        writeSync(out, chunk, 0, read);
        position += read;
      }
    } finally {
      closeSync(out);
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Identifies a media container from its leading bytes (magic numbers). */
export function sniffFormat(head: Buffer): MediaFormat | null {
  const ascii = (start: number, end: number) => head.subarray(start, end).toString('latin1');
  if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(8, 12))) return 'aiff';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand.startsWith('M4A')) return 'm4a';
    if (brand === 'qt  ') return 'mov';
    return 'mp4';
  }
  if (ascii(0, 3) === 'ID3') return 'mp3';
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return 'mp3';
  return null;
}

/** WAV duration from the fmt/data chunks. */
function wavDuration(head: Buffer): number | null {
  let offset = 12;
  let byteRate: number | null = null;
  while (offset + 8 <= head.length) {
    const id = head.subarray(offset, offset + 4).toString('latin1');
    const size = head.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 16 <= head.length) byteRate = head.readUInt32LE(offset + 16);
    if (id === 'data') return byteRate ? Math.round((size / byteRate) * 1000) / 1000 : null;
    offset += 8 + size + (size % 2);
  }
  return null;
}

/** MP4/MOV duration from the `mvhd` box (searched in the head and tail of the file). */
function mp4Duration(buffers: Buffer[]): number | null {
  for (const buffer of buffers) {
    const at = buffer.indexOf('mvhd', 0, 'latin1');
    if (at < 0 || at + 28 > buffer.length) continue;
    const version = buffer[at + 4];
    if (version === 1 && at + 36 <= buffer.length) {
      const timescale = buffer.readUInt32BE(at + 24);
      const duration = Number(buffer.readBigUInt64BE(at + 28));
      return timescale ? Math.round((duration / timescale) * 1000) / 1000 : null;
    }
    const timescale = buffer.readUInt32BE(at + 16);
    const duration = buffer.readUInt32BE(at + 20);
    return timescale ? Math.round((duration / timescale) * 1000) / 1000 : null;
  }
  return null;
}

/** CBR MP3 duration estimate from the first frame's bitrate. */
function mp3Duration(head: Buffer, size: number): number | null {
  let offset = 0;
  if (head.subarray(0, 3).toString('latin1') === 'ID3' && head.length >= 10) {
    offset = 10 + (((head[6]! & 0x7f) << 21) | ((head[7]! & 0x7f) << 14) | ((head[8]! & 0x7f) << 7) | (head[9]! & 0x7f));
  }
  if (offset + 4 > head.length || head[offset] !== 0xff || (head[offset + 1]! & 0xe0) !== 0xe0) return null;
  const versionBits = (head[offset + 1]! >> 3) & 0x03;
  const bitrateIndex = head[offset + 2]! >> 4;
  const mpeg1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const mpeg2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  const kbps = (versionBits === 3 ? mpeg1 : mpeg2)[bitrateIndex] ?? 0;
  return kbps ? Math.round((((size - offset) * 8) / (kbps * 1000)) * 1000) / 1000 : null;
}

/**
 * Verifies that a provider's output file really is media of the expected kind
 * (not an error page, empty file or wrong container) and measures what it can.
 * With an ffprobe binary configured, duration and dimensions come from
 * ffprobe; otherwise from container headers where the format allows.
 */
export class MediaInspector {
  constructor(private readonly options: { ffprobePath?: string | undefined; timeoutMs?: number } = {}) {}

  async inspect(path: string, kind: MediaKind): Promise<MediaInspection> {
    const base = { sha256: null, durationSeconds: null, width: null, height: null, method: 'SIGNATURE' as const };
    // One descriptor (no symlink at the last component) for every measurement: sniffing, hashing and probing see the same bytes.
    let fd: number;
    try {
      fd = openSync(path, READ_NOFOLLOW);
    } catch {
      return { ...base, ok: false, format: null, bytes: 0, reason: 'output file does not exist' };
    }
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) return { ...base, ok: false, format: null, bytes: 0, reason: 'output is not a regular file' };
      if (info.nlink !== 1) return { ...base, ok: false, format: null, bytes: info.size, reason: 'output is hard-linked; refusing a file that may live outside the media store' };
      const size = info.size;
      if (size === 0) return { ...base, ok: false, format: null, bytes: 0, reason: 'output file is empty' };
      const head = readRange(fd, 0, Math.min(size, HEAD_BYTES));
      const format = sniffFormat(head);
      if (!format) return { ...base, ok: false, format: null, bytes: size, reason: 'output is not a recognised media container' };
      if (!FORMATS_BY_KIND[kind].includes(format)) {
        return { ...base, ok: false, format, bytes: size, reason: `${format} output is not valid for a ${kind} asset` };
      }

      const probed = this.options.ffprobePath ? await this.ffprobe(fd, size, format) : null;
      let durationSeconds = probed?.durationSeconds ?? null;
      let width = probed?.width ?? null;
      let height = probed?.height ?? null;
      if (!probed) {
        if (format === 'png' && head.length >= 24) {
          width = head.readUInt32BE(16);
          height = head.readUInt32BE(20);
        }
        if (format === 'wav') durationSeconds = wavDuration(head);
        if (format === 'mp3') durationSeconds = mp3Duration(head, size);
        if (format === 'mp4' || format === 'mov' || format === 'm4a') {
          const tail = size > HEAD_BYTES ? readRange(fd, Math.max(0, size - TAIL_BYTES), Math.min(size, TAIL_BYTES)) : Buffer.alloc(0);
          durationSeconds = mp4Duration([head, tail]);
        }
      }
      return {
        ok: true,
        format,
        bytes: size,
        sha256: sha256(fd, size),
        durationSeconds,
        width,
        height,
        method: probed ? 'FFPROBE' : 'SIGNATURE',
        reason: 'verified media output',
      };
    } finally {
      closeSync(fd);
    }
  }

  private async ffprobe(fd: number, size: number, format: MediaFormat): Promise<{ durationSeconds: number | null; width: number | null; height: number | null } | null> {
    let copy: { path: string; cleanup: () => void } | null = null;
    try {
      copy = privateCopy(fd, size, `.${format}`);
      const path = copy.path;
      const result = await runProcess(
        'ffprobe',
        this.options.ffprobePath!,
        ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', '--', path],
        { timeoutMs: this.options.timeoutMs ?? 30_000 },
      );
      if (result.code !== 0) return null;
      const data = JSON.parse(result.stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
      const video = data.streams?.find((s) => s.codec_type === 'video');
      const duration = data.format?.duration ? Number(data.format.duration) : NaN;
      return {
        durationSeconds: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : null,
        width: video?.width ?? null,
        height: video?.height ?? null,
      };
    } catch {
      return null;
    } finally {
      copy?.cleanup();
    }
  }
}
