import { destination as pinoDestination, pino, stdTimeFunctions, type Logger } from 'pino';

export type { Logger } from 'pino';

/**
 * Structured JSON logger. Any field that could carry a credential is redacted
 * before it reaches the log stream.
 */
export const REDACTED_PATHS = [
  'apiKey',
  '*.apiKey',
  '*.*.apiKey',
  'token',
  '*.token',
  'password',
  '*.password',
  'secret',
  '*.secret',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'headers["x-api-key"]',
  'headers["x-goog-api-key"]',
  'req.headers.authorization',
];

export function createLogger(level: string = 'info', name = 'jovi-core', destination: 'stdout' | 'stderr' = 'stdout'): Logger {
  return pino(
    {
      name,
      level,
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
      base: { service: name },
      timestamp: stdTimeFunctions.isoTime,
    },
    pinoDestination(destination === 'stderr' ? 2 : 1),
  );
}
