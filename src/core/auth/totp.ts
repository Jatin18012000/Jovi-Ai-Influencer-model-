import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Gate C (second factor for API approvals): RFC 6238 TOTP, SHA-1, 30-second
 * steps, 6 digits — the parameters every authenticator app supports. A code
 * is accepted for the current step ±1 (clock skew) and only once: a replayed
 * code, or one from a step not newer than the last accepted, is refused.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index === -1) throw new Error('invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret (base32), as recommended by RFC 4226. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function otpauthUri(secret: string, account: string, issuer = 'Jovi Creator OS'): string {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;

export class TotpVerifier {
  /** Replay guard: the newest step accepted per subject (e.g. production id). */
  private readonly lastAcceptedStep = new Map<string, number>();
  private failures: number[] = [];

  constructor(
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Null when `code` is valid and not yet used for `subject`; otherwise why it
   * was refused. Five wrong codes in 15 minutes lock approvals for 15 minutes.
   */
  verify(code: string | undefined, subject = ''): string | null {
    const nowMs = this.now();
    this.failures = this.failures.filter((t) => nowMs - t < LOCKOUT_MS);
    if (this.failures.length >= MAX_FAILURES) return 'too many invalid approval codes; approvals are locked for 15 minutes';
    const refusal = this.check(code, nowMs, subject);
    if (refusal) this.failures.push(nowMs);
    return refusal;
  }

  private check(code: string | undefined, nowMs: number, subject: string): string | null {
    if (!code || !/^\d{6}$/.test(code.trim())) return 'a 6-digit approval code is required';
    const current = Math.floor(nowMs / 1000 / STEP_SECONDS);
    const given = Buffer.from(code.trim());
    for (const step of [current - 1, current, current + 1]) {
      if (timingSafeEqual(given, Buffer.from(totpCode(this.secret, step)))) {
        if (step <= (this.lastAcceptedStep.get(subject) ?? -1)) return 'approval code already used; wait for the next code';
        this.lastAcceptedStep.set(subject, step);
        return null;
      }
    }
    return 'approval code is not valid';
  }
}
