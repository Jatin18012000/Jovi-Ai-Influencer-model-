import { isIP } from 'node:net';
import type { JoviConfig } from '../../src/core/config/config.js';
import { RateLimitedError } from '../../src/core/errors.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host.toLowerCase())) return true;
  return isIP(host) === 4 && host.startsWith('127.');
}

/**
 * Refuses to expose the API beyond this machine without authentication.
 * Returns a warning string when the escape hatch is used.
 */
export function assertSafeBind(config: JoviConfig['api']): string | null {
  if (isLoopbackHost(config.host) || config.token) return null;
  if (config.allowUnauthenticatedNetwork) {
    return `API bound to ${config.host} without JOVI_API_TOKEN (JOVI_ALLOW_UNAUTHENTICATED_NETWORK=true). Only safe if the published port is loopback-only.`;
  }
  throw new Error(
    `Refusing to start: HOST=${config.host} is reachable from the network but JOVI_API_TOKEN is not set. ` +
      'Set JOVI_API_TOKEN, bind HOST=127.0.0.1, or (containers with a loopback-only published port) set JOVI_ALLOW_UNAUTHENTICATED_NETWORK=true.',
  );
}

/**
 * Guards expensive endpoints (goal execution, evaluation): a per-client
 * sliding one-minute window plus a global concurrency cap. In-memory by
 * design — Jovi Core is a single-process modular monolith.
 */
export class ExpensiveCallLimiter {
  private readonly hits = new Map<string, number[]>();
  private active = 0;

  constructor(
    private readonly perMinute: number,
    private readonly maxConcurrent: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Throws RateLimitedError, or returns a release function that must be called when done. */
  acquire(clientKey: string): () => void {
    const now = this.now();
    const recent = (this.hits.get(clientKey) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.perMinute) {
      const retryAfter = Math.max(1, Math.ceil((60_000 - (now - (recent[0] ?? now))) / 1000));
      throw new RateLimitedError(`Rate limit exceeded: ${this.perMinute} expensive requests per minute`, retryAfter);
    }
    if (this.active >= this.maxConcurrent) {
      throw new RateLimitedError(`Too many goals in progress (max ${this.maxConcurrent} concurrent)`, 5);
    }
    recent.push(now);
    this.hits.set(clientKey, recent);
    this.active += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active -= 1;
      }
    };
  }
}
