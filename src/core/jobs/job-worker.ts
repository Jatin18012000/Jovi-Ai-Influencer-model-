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
    private readonly staleLockMs: number,
    /** R-05: periodic housekeeping (superseded-media GC), run at start and then every `maintenanceMs`. */
    private readonly maintenance: (() => void) | null = null,
    private readonly maintenanceMs = 24 * 3_600_000,
  ) {}

  private lastRecovery = 0;
  private lastMaintenance = 0;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
    this.logger.info({ pollMs: this.pollMs, staleLockMs: this.staleLockMs }, 'job worker started');
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
      // Periodic crash recovery, so abandoned jobs are resumed without a restart.
      if (Date.now() - this.lastRecovery >= Math.min(this.staleLockMs, 60_000)) {
        this.lastRecovery = Date.now();
        await this.jobs.recoverStale(this.staleLockMs);
      }
      if (this.maintenance && Date.now() - this.lastMaintenance >= this.maintenanceMs) {
        this.lastMaintenance = Date.now();
        try {
          this.maintenance();
        } catch (error) {
          this.logger.error({ err: errorMessage(error) }, 'worker maintenance failed');
        }
      }
      worked = (await this.jobs.processNext()) !== null;
    } catch (error) {
      this.logger.error({ err: errorMessage(error) }, 'worker tick failed');
    } finally {
      this.busy = false;
    }
    this.schedule(worked ? 0 : this.pollMs);
  }
}
