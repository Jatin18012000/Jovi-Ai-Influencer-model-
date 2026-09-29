/**
 * Error taxonomy for Jovi Core.
 *
 * `retryable` drives the job system: temporary failures (network, rate limits,
 * provider outages) are retried; permanent failures (validation, permission)
 * fail fast.
 */
export class JoviError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    message: string,
    options: { code: string; retryable?: boolean; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class ValidationError extends JoviError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: 'VALIDATION_ERROR', retryable: false, ...(details ? { details } : {}) });
  }
}

export class NotFoundError extends JoviError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, { code: 'NOT_FOUND', retryable: false, details: { entity, id } });
  }
}

export class ConflictError extends JoviError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: 'CONFLICT', retryable: false, ...(details ? { details } : {}) });
  }
}

export class RateLimitedError extends JoviError {
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(message, { code: 'RATE_LIMITED', retryable: true, details: { retryAfterSeconds } });
  }
}

export class PermissionDeniedError extends JoviError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: 'PERMISSION_DENIED', retryable: false, ...(details ? { details } : {}) });
  }
}

export class ProviderError extends JoviError {
  readonly provider: string;

  constructor(
    provider: string,
    message: string,
    options: { retryable: boolean; status?: number; cause?: unknown; code?: string },
  ) {
    super(`[${provider}] ${message}`, {
      code: options.code ?? 'PROVIDER_ERROR',
      retryable: options.retryable,
      details: { provider, ...(options.status !== undefined ? { status: options.status } : {}) },
      cause: options.cause,
    });
    this.provider = provider;
  }
}

export class ProviderUnavailableError extends ProviderError {
  constructor(provider: string, reason: string) {
    super(provider, `provider unavailable: ${reason}`, { retryable: false, code: 'PROVIDER_UNAVAILABLE' });
  }
}

export class InvalidModelOutputError extends JoviError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: 'INVALID_MODEL_OUTPUT', retryable: true, ...(details ? { details } : {}) });
  }
}

export class NoModelAvailableError extends JoviError {
  /** Retryable by default: a provider may come back (e.g. the LM Studio server restarting). */
  constructor(message: string, details?: Record<string, unknown>, retryable = true) {
    super(message, { code: 'NO_MODEL_AVAILABLE', retryable, ...(details ? { details } : {}) });
  }
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof JoviError) return error.retryable;
  // Unknown errors are treated as permanent: retrying unknown bugs hides them.
  return false;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof JoviError) {
    return { name: error.name, code: error.code, message: error.message, retryable: error.retryable, details: error.details };
  }
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { message: String(error) };
}
