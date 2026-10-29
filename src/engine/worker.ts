import type { Clock } from '../core/clock.js';
import { CircuitOpenError, NotYetError, RateLimitedError, TransientError } from '../core/errors.js';
import type { Rng } from '../core/rng.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { JobRow, Store } from '../store/db.js';
import type { Syncer } from './syncer.js';

export interface WorkerOptions {
  concurrency: number;
  leaseMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_WORKER: WorkerOptions = {
  concurrency: 4,
  leaseMs: 60_000,
  maxAttempts: 8,
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
};

/** Exponential backoff with "equal jitter": half deterministic, half random, never below base/2. */
export function backoffMs(attempt: number, o: Pick<WorkerOptions, 'baseDelayMs' | 'maxDelayMs'>, rng: Rng): number {
  const cap = Math.min(o.maxDelayMs, o.baseDelayMs * 2 ** attempt);
  return Math.round(cap / 2 + rng() * (cap / 2));
}

/**
 * Pulls jobs from the durable queue and runs them through the syncer.
 *
 * Retry policy by error class:
 *   CircuitOpen / RateLimited / NotYet → reschedule when the downstream says; attempt NOT counted
 *   Transient                  → exponential backoff; after maxAttempts → dead-letter
 *   anything else              → dead-letter immediately (retrying a 400 just burns quota)
 */
export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private running = 0;
  private stopped = false;

  constructor(
    private readonly store: Store,
    private readonly syncer: Syncer,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly rng: Rng,
    readonly opts: WorkerOptions = DEFAULT_WORKER,
  ) {}

  /** Runs ready jobs until none are left (or `maxJobs` reached). Returns how many were processed. */
  async drain(maxJobs = Infinity): Promise<number> {
    let processed = 0;
    const lane = async () => {
      while (processed < maxJobs && !this.stopped) {
        const job = this.store.claim(this.clock.now(), this.opts.leaseMs);
        if (!job) return;
        processed++;
        await this.process(job);
      }
    };
    await Promise.all(Array.from({ length: this.opts.concurrency }, lane));
    this.refreshGauges();
    return processed;
  }

  async process(job: JobRow): Promise<void> {
    const wfId = job.entity.replace(/^wf:/, '');
    this.running++;
    try {
      const res = await this.syncer.sync(wfId, job.trigger);
      if (job.trigger === 'reconcile' && (res.outcome === 'applied' || res.outcome === 'created')) {
        this.metrics.reconcilerRepairs.inc();
        this.logger.warn({ wfId, outcome: res.outcome }, 'reconciler repaired drift — a webhook was probably missed');
      }
      this.store.completeJob(job.id, this.clock.now());
      this.metrics.jobAttempts.inc({ result: 'ok' });
    } catch (e) {
      this.handleFailure(job, e);
    } finally {
      this.running--;
    }
  }

  private handleFailure(job: JobRow, e: unknown): void {
    const now = this.clock.now();
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const log = this.logger.child({ entity: job.entity, attempt: job.attempts + 1 });

    if (e instanceof CircuitOpenError) {
      this.store.retryJob(job.id, e.retryAt, msg, false);
      this.metrics.jobAttempts.inc({ result: 'deferred' });
      return;
    }
    if (e instanceof RateLimitedError || e instanceof NotYetError) {
      const at = now + e.retryAfterMs + Math.round(this.rng() * 250);
      this.store.retryJob(job.id, at, msg, false);
      this.metrics.jobAttempts.inc({ result: 'deferred' });
      log.info({ retryInMs: at - now, reason: e.message }, 'deferring');
      return;
    }
    if (e instanceof TransientError && job.attempts + 1 < this.opts.maxAttempts) {
      const delay = backoffMs(job.attempts, this.opts, this.rng);
      this.store.retryJob(job.id, now + delay, msg, true);
      this.metrics.jobAttempts.inc({ result: 'retry' });
      log.info({ retryInMs: delay, ambiguous: e.ambiguous, error: msg }, 'transient failure, will retry');
      return;
    }
    this.store.deadLetter(job, msg, now);
    this.metrics.jobAttempts.inc({ result: 'dead' });
    log.error({ error: msg }, 'job dead-lettered');
  }

  refreshGauges(): void {
    const s = this.store.queueStats(this.clock.now());
    this.metrics.queueDepth.set(s.depth);
    this.metrics.queueOldestAge.set(s.oldestAgeMs / 1000);
    this.metrics.deadLetters.set(s.dead);
    this.metrics.openConflicts.set(this.store.conflicts().length);
  }

  start(pollMs = 250): void {
    this.stopped = false;
    this.store.releaseAllLeases();
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.drain();
      } catch (e) {
        this.logger.error({ err: e }, 'worker loop error');
      }
      if (!this.stopped) this.timer = setTimeout(tick, pollMs);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running > 0) await new Promise((r) => setTimeout(r, 20));
  }
}
