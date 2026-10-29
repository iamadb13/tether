import type { Clock } from '../core/clock.js';
import {
  CircuitOpenError,
  NotFoundError,
  PermanentError,
  RateLimitedError,
  TransientError,
} from '../core/errors.js';
import type { Metrics } from '../observability/metrics.js';
import { CircuitBreaker, RateGate } from './resilience.js';
import type { HttpRequest, HttpResponse, Transport } from './transport.js';

export interface ApiClientOptions {
  system: 'workfront' | 'jira';
  transport: Transport;
  clock: Clock;
  metrics: Metrics;
  defaultHeaders: Record<string, string>;
  ratePerSec?: number;
  burst?: number;
  /** Small waits for the token bucket are slept inline; larger ones defer the job instead. */
  maxInlineWaitMs?: number;
}

/**
 * One place where an HTTP outcome becomes a typed error. Connectors never look at status codes
 * for flow control — they get data back or one of the errors from core/errors.ts.
 */
export class ApiClient {
  readonly breaker: CircuitBreaker;
  readonly gate: RateGate;

  constructor(private readonly o: ApiClientOptions) {
    const gauge = { closed: 0, half_open: 1, open: 2 } as const;
    this.breaker = new CircuitBreaker(o.clock, 5, 5_000, 60_000, (s) => o.metrics.circuitState.set({ system: o.system }, gauge[s]));
    o.metrics.circuitState.set({ system: o.system }, 0);
    this.gate = new RateGate(o.clock, o.ratePerSec ?? Infinity, o.burst ?? 10);
  }

  async send<T = unknown>(op: string, req: HttpRequest): Promise<T> {
    const { system, clock, metrics } = this.o;
    const retryAt = this.breaker.check();
    if (retryAt) throw new CircuitOpenError(system, retryAt);

    const wait = this.gate.take();
    if (wait > 0) {
      if (wait > (this.o.maxInlineWaitMs ?? 0)) {
        this.breaker.neutral();
        throw new RateLimitedError(`${system}: client-side rate limit`, system, wait);
      }
      await new Promise((r) => setTimeout(r, wait));
    }

    const started = performance.now();
    let res: HttpResponse;
    try {
      res = await this.o.transport.request({ ...req, headers: { ...this.o.defaultHeaders, ...req.headers } });
    } catch (e) {
      metrics.httpRequests.inc({ system, op, status: 'network' });
      this.breaker.failure();
      throw e instanceof TransientError ? e : new TransientError(String(e), system, req.method !== 'GET');
    } finally {
      metrics.httpDuration.observe({ system, op }, (performance.now() - started) / 1000);
    }
    metrics.httpRequests.inc({ system, op, status: String(res.status) });

    const s = res.status;
    if (s >= 200 && s < 300) {
      this.breaker.success();
      return res.body as T;
    }
    const detail = `${system} ${req.method} ${req.path} → ${s} ${summarise(res.body)}`;
    if (s === 429) {
      this.breaker.neutral();
      const ms = retryAfterMs(res.headers, clock.now());
      this.gate.pause(ms);
      throw new RateLimitedError(detail, system, ms);
    }
    if (s >= 500 || s === 408) {
      this.breaker.failure();
      // A 502/504 on a write may still have been committed upstream.
      throw new TransientError(detail, system, req.method !== 'GET' && (s === 502 || s === 504));
    }
    this.breaker.neutral();
    if (s === 404) throw new NotFoundError(detail, system);
    throw new PermanentError(detail, system);
  }
}

/** Retry-After (seconds or HTTP date) → X-RateLimit-Reset (ISO) → conservative default. */
export function retryAfterMs(headers: Record<string, string>, now: number): number {
  const ra = headers['retry-after'];
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const at = Date.parse(ra);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const reset = headers['x-ratelimit-reset'];
  if (reset) {
    const at = Date.parse(reset);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  return 5_000;
}

function summarise(body: unknown): string {
  const s = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}
