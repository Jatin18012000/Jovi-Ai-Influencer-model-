import { spawn } from 'node:child_process';
import { ProviderError } from '../core/errors.js';

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs an operator-configured media binary (ffmpeg, ffprobe, macOS `say`).
 *
 * Governance: this is NOT an agent tool. Only media provider adapters call
 * it; the binary path comes from operator configuration, arguments are built
 * by code from validated paths/values (never from model text as a command),
 * `shell` is always false, stdin carries free text, and a timeout kills the
 * process. Output is size-capped.
 */
export function runProcess(
  provider: string,
  binary: string,
  args: string[],
  options: { timeoutMs: number; stdin?: string; maxOutputBytes?: number } = { timeoutMs: 60_000 },
): Promise<ProcessResult> {
  const cap = options.maxOutputBytes ?? 256 * 1024;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      reject(new ProviderError(provider, `cannot start ${binary}: ${(error as Error).message}`, { retryable: false, cause: error }));
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < cap) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < cap) stderr += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const missing = error.code === 'ENOENT';
      reject(new ProviderError(provider, missing ? `${binary} not found` : `${binary} failed to start: ${error.message}`, { retryable: false, code: missing ? 'BINARY_NOT_FOUND' : 'PROCESS_ERROR', cause: error }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new ProviderError(provider, `${binary} timed out after ${options.timeoutMs}ms`, { retryable: true, code: 'PROCESS_TIMEOUT' }));
        return;
      }
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}
