import { randomUUID } from 'node:crypto';
import { ProviderError } from '../../core/errors.js';
import { getJson, postJson } from '../../models/providers/http.js';

const PROVIDER = 'comfyui';

export interface ComfyUIOutputFile {
  filename: string;
  subfolder: string;
  type: string;
}

export interface ComfyUIHistoryEntry {
  outputs: Record<string, Record<string, unknown>>;
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
}

/**
 * Client for a ComfyUI server's HTTP API:
 *   GET  /system_stats           availability + devices
 *   POST /prompt                 queue an API-format workflow → prompt_id
 *   GET  /history/{prompt_id}    completion status + output files
 *   GET  /view?filename&subfolder&type   download an output file
 * It only talks to the configured ComfyUI URL and never installs models.
 */
export class ComfyUIClient {
  private readonly baseUrl: string;
  readonly clientId = `jovi-${randomUUID()}`;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async systemStats(timeoutMs = 3_000): Promise<{ devices: Array<{ name?: string; type?: string }> }> {
    const data = (await getJson(PROVIDER, `${this.baseUrl}/system_stats`, {}, timeoutMs)) as { devices?: Array<{ name?: string; type?: string }> };
    return { devices: data.devices ?? [] };
  }

  async queuePrompt(workflow: Record<string, unknown>, timeoutMs = 30_000): Promise<string> {
    const data = (await postJson(PROVIDER, `${this.baseUrl}/prompt`, { prompt: workflow, client_id: this.clientId }, {}, timeoutMs)) as {
      prompt_id?: string;
      node_errors?: Record<string, unknown>;
    };
    if (data.node_errors && Object.keys(data.node_errors).length > 0) {
      throw new ProviderError(PROVIDER, `workflow rejected: ${JSON.stringify(data.node_errors).slice(0, 300)}`, { retryable: false });
    }
    if (!data.prompt_id) throw new ProviderError(PROVIDER, 'no prompt_id returned', { retryable: true });
    return data.prompt_id;
  }

  async history(promptId: string, timeoutMs = 10_000): Promise<ComfyUIHistoryEntry | undefined> {
    const data = (await getJson(PROVIDER, `${this.baseUrl}/history/${encodeURIComponent(promptId)}`, {}, timeoutMs)) as Record<string, ComfyUIHistoryEntry>;
    return data[promptId];
  }

  /** Polls history until the prompt completes, errors, or the timeout elapses. */
  async waitForCompletion(promptId: string, timeoutMs: number, pollMs = 1_000): Promise<ComfyUIHistoryEntry> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const entry = await this.history(promptId);
      if (entry) {
        if (entry.status?.status_str === 'error') {
          throw new ProviderError(PROVIDER, `execution error: ${JSON.stringify(entry.status.messages ?? []).slice(0, 300)}`, { retryable: false });
        }
        if (entry.status?.completed || Object.keys(entry.outputs ?? {}).length > 0) return entry;
      }
      if (Date.now() >= deadline) throw new ProviderError(PROVIDER, `generation did not finish within ${timeoutMs}ms`, { retryable: true });
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async download(file: ComfyUIOutputFile, timeoutMs = 60_000): Promise<Buffer> {
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/view?${query.toString()}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new ProviderError(PROVIDER, `download failed: ${(error as Error).message}`, { retryable: true, cause: error });
    }
    if (!response.ok) throw new ProviderError(PROVIDER, `download HTTP ${response.status}`, { retryable: response.status >= 500, status: response.status });
    return Buffer.from(await response.arrayBuffer());
  }
}

/** Output files from any node (images, gifs, videos, audio). */
export function outputFiles(entry: ComfyUIHistoryEntry): ComfyUIOutputFile[] {
  const files: ComfyUIOutputFile[] = [];
  for (const node of Object.values(entry.outputs ?? {})) {
    for (const key of ['images', 'gifs', 'videos', 'audio']) {
      const list = node[key];
      if (Array.isArray(list)) {
        for (const f of list as Array<Partial<ComfyUIOutputFile>>) {
          if (f.filename) files.push({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output' });
        }
      }
    }
  }
  return files;
}

/**
 * Fills `{{PLACEHOLDER}}` tokens in an API-format workflow. A string that is
 * exactly one placeholder takes the raw value (so numbers stay numbers).
 */
export function fillWorkflow(template: unknown, values: Record<string, string | number>): unknown {
  if (typeof template === 'string') {
    const exact = /^\{\{([A-Z_]+)\}\}$/.exec(template);
    if (exact?.[1] && exact[1] in values) return values[exact[1]];
    return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key: string) => (key in values ? String(values[key]) : m));
  }
  if (Array.isArray(template)) return template.map((v) => fillWorkflow(v, values));
  if (template && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, fillWorkflow(v, values)]));
  }
  return template;
}
