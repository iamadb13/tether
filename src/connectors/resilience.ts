import type { Clock } from '../core/clock.js';

/**
 * Per-downstream circuit breaker.
 *
 *  closed    → requests flow; consecutive transient failures are counted
 *  open      → requests are refused locally until `openUntil` (jobs are deferred, not failed)
 *  half_open → one probe is allowed; success closes, failure re-opens with a longer cool-down
 *
 * Why: during a vendor outage, hammering it wastes rate-limit budget and turns every queued job
 * into a "failed attempt", pushing healthy work into the dead-letter queue. Deferring instead
 * means the backlog drains by itself when the vendor recovers.
 */
export type BreakerState = 'closed' | 'open' | 'half_open';

export class CircuitBreaker {
  state: BreakerState = 'closed';
  private failures = 0;
  private openUntil = 0;
  private trips = 0;
  private probeInFlight = false;

  constructor(
    private readonly clock: Clock,
    private readonly threshold = 5,
    private readonly baseCooldownMs = 5_000,
    private readonly maxCooldownMs = 60_000,
    private readonly onChange?: (s: BreakerState) => void,
  ) {}

  /** Returns 0 if the call may proceed, else the epoch ms when it may be retried. */
  check(): number {
    if (this.state === 'open') {
      if (this.clock.now() < this.openUntil) return this.openUntil;
      this.transition('half_open');
    }
    if (this.state === 'half_open') {
      if (this.probeInFlight) return this.clock.now() + 500;
      this.probeInFlight = true;
    }
    return 0;
  }

  success(): void {
    this.probeInFlight = false;
    this.failures = 0;
    this.trips = 0;
    if (this.state !== 'closed') this.transition('closed');
  }

  failure(): void {
    this.probeInFlight = false;
    this.failures++;
    if (this.state === 'half_open' || this.failures >= this.threshold) {
      this.trips++;
      const cooldown = Math.min(this.baseCooldownMs * 2 ** (this.trips - 1), this.maxCooldownMs);
      this.openUntil = this.clock.now() + cooldown;
      this.failures = 0;
      this.transition('open');
    }
  }

  /** A response that proves the service is up but says nothing about health (e.g. 4xx, 429). */
  neutral(): void {
    this.probeInFlight = false;
    if (this.state === 'half_open') this.success();
  }

  private transition(s: BreakerState): void {
    this.state = s;
    this.onChange?.(s);
  }
}

/**
 * Token bucket for *proactive* client-side rate limiting (stay under the vendor's quota instead
 * of discovering it via 429s) plus a *reactive* pause when the vendor says Retry-After.
 */
export class RateGate {
  private tokens: number;
  private last: number;
  private pausedUntil = 0;

  constructor(
    private readonly clock: Clock,
    private readonly ratePerSec: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
    this.last = clock.now();
  }

  /** Returns 0 if a request may be sent now, else how many ms to wait. */
  take(): number {
    const now = this.clock.now();
    if (now < this.pausedUntil) return this.pausedUntil - now;
    if (!Number.isFinite(this.ratePerSec)) return 0;
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
  }

  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + ms);
  }
}
