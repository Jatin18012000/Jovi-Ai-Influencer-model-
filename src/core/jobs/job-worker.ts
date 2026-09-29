import type { Logger } from '../config/logger.js';
import { errorMessage } from '../errors.js';
import type { JobQueue } from './job-queue.js';

/**
 * Polling worker for asynchronous jobs. Runs in-process (API server) or as a
 * standalone process (`npm run worker`). Processes one job at a time.
 */
export class JobWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private busy = false;

  constructor(
    private readonly jobs: JobQueue,
    private readonly logger: Logger,
    private readonly pollMs: number,
    private readonly staleLockMs = 15 * 60_000,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const recovered = this.jobs.recoverStale(this.staleLockMs);
    if (recovered) this.logger.warn({ recovered }, 'recovered stale jobs');
    this.schedule(0);
    this.logger.info({ pollMs: this.pollMs }, 'job worker started');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.busy) await new Promise((r) => setTimeout(r, 25));
  }

  /** Drains all due jobs once (useful for tests and one-shot CLI runs). */
  async drain(): Promise<number> {
    let processed = 0;
    while (await this.jobs.processNext()) processed += 1;
    return processed;
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    this.busy = true;
    let worked = false;
    try {
      worked = (await this.jobs.processNext()) !== null;
    } catch (error) {
      this.logger.error({ err: errorMessage(error) }, 'worker tick failed');
    } finally {
      this.busy = false;
    }
    this.schedule(worked ? 0 : this.pollMs);
  }
}
