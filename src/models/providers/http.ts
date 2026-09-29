import { ProviderError } from '../../core/errors.js';

/**
 * fetch wrapper with timeout and error classification. Never includes request
 * headers (which carry API keys) in errors or logs.
 */
export async function postJson(
  provider: string,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  return requestJson(provider, url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, timeoutMs);
}

export async function getJson(provider: string, url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  return requestJson(provider, url, { method: 'GET', headers }, timeoutMs);
}

async function requestJson(provider: string, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new ProviderError(provider, timedOut ? `request timed out after ${timeoutMs}ms` : `network error: ${describe(error)}`, {
      retryable: true,
      cause: error,
    });
  }

  const text = await response.text();
  if (!response.ok) {
    // 408/409/429 and 5xx are temporary; other 4xx (bad key, bad request) are permanent.
    const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
    throw new ProviderError(provider, `HTTP ${response.status}: ${safeSnippet(text)}`, { retryable, status: response.status });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ProviderError(provider, `invalid JSON response: ${safeSnippet(text)}`, { retryable: true, cause: error });
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
  }
  return String(error);
}

/** Truncates provider error bodies; they can be long and occasionally echo inputs. */
function safeSnippet(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 300);
}
