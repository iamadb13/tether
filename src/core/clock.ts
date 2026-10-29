/**
 * All time flows through a Clock so the engine can be driven by a virtual clock
 * in simulation tests (deterministic backoff, leases, circuit breakers).
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class ManualClock implements Clock {
  constructor(private t = Date.UTC(2026, 9, 26, 9, 0, 0)) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(t: number): void {
    this.t = Math.max(this.t, t);
  }
}
