import { ProviderError } from '../../core/errors.js';

/** R-15: maximum bytes accepted from a provider response, by content. */
export const BYTE_CAPS = {
  json: 10 * 1024 * 1024,
  errorBody: 64 * 1024,
  image: 20 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
} as const;

/**
 * R-15: reads a response body as a stream and stops once `maxBytes` is
 * exceeded (the stream is cancelled), so a misbehaving or compromised
 * provider cannot exhaust memory. A declared Content-Length above the cap is
 * refused before reading.
 */
export async function readBodyCapped(response: Response, maxBytes: number, provider: string): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderError(provider, `response too large: ${declared} bytes (limit ${maxBytes})`, { retryable: false, code: 'RESPONSE_TOO_LARGE' });
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderError(provider, `response exceeded ${maxBytes} bytes`, { retryable: false, code: 'RESPONSE_TOO_LARGE' });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Reads a (truncated) error body for diagnostics without buffering more than BYTE_CAPS.errorBody. */
export async function readErrorSnippet(response: Response): Promise<string> {
  try {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < BYTE_CAPS.errorBody) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    await reader.cancel().catch(() => undefined);
    return Buffer.concat(chunks).subarray(0, BYTE_CAPS.errorBody).toString('utf8').replace(/\s+/g, ' ').slice(0, 300);
  } catch {
    return '';
  }
}

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

  if (!response.ok) {
    // 408/409/429 and 5xx are temporary; other 4xx (bad key, bad request) are permanent.
    const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
    throw new ProviderError(provider, `HTTP ${response.status}: ${await readErrorSnippet(response)}`, { retryable, status: response.status });
  }
  const text = (await readBodyCapped(response, BYTE_CAPS.json, provider)).toString('utf8');
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
