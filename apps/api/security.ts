import { isIP } from 'node:net';
import type { JoviConfig } from '../../src/core/config/config.js';
import { RateLimitedError } from '../../src/core/errors.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host.toLowerCase())) return true;
  return isIP(host) === 4 && host.startsWith('127.');
}

/**
 * Binding beyond loopback is refused unless explicitly allowed
 * (JOVI_ALLOW_NETWORK_BIND, e.g. inside a container whose published port is
 * loopback-only). Authentication is mandatory either way; this guard keeps
 * plain-HTTP bearer tokens off the network by default.
 */
export function assertSafeBind(config: JoviConfig['api']): string | null {
  if (isLoopbackHost(config.host)) return null;
  if (config.allowNetworkBind) {
    return `API bound to ${config.host} (JOVI_ALLOW_NETWORK_BIND=true). Authentication is enforced, but traffic is plain HTTP: keep the published port loopback-only or put a TLS proxy in front.`;
  }
  throw new Error(
    `Refusing to start: HOST=${config.host} is reachable from the network. Bind HOST=127.0.0.1, or set JOVI_ALLOW_NETWORK_BIND=true (containers / behind a TLS proxy).`,
  );
}

/** Hostname of a Host header value without the port ("[::1]:3000" → "::1"). */
export function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : null;
  }
  const colon = value.lastIndexOf(':');
  return colon > -1 && value.indexOf(':') === colon ? value.slice(0, colon) : value;
}

/**
 * DNS-rebinding and cross-site defence: the Host header must name an allowed
 * host, and a browser Origin (when present) must be an allowed host or an
 * explicitly allowed origin. Returns a refusal reason, or null when allowed.
 */
export function checkHostAndOrigin(
  headers: { host?: string | undefined; origin?: string | undefined },
  allowedHosts: readonly string[],
  allowedOrigins: readonly string[],
): string | null {
  const host = hostnameOf(headers.host);
  if (!host || !allowedHosts.includes(host)) return `host "${headers.host ?? ''}" is not allowed`;
  const origin = headers.origin;
  if (origin === undefined) return null;
  if (allowedOrigins.includes(origin.replace(/\/+$/, '').toLowerCase())) return null;
  try {
    const url = new URL(origin);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && allowedHosts.includes(url.hostname.toLowerCase().replace(/^\[|\]$/g, ''))) return null;
  } catch {
    // "null" and malformed origins fall through to refusal.
  }
  return `origin "${origin}" is not allowed`;
}

/**
 * Guards expensive endpoints (goals, planning, productions, evaluation): a per-client
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
