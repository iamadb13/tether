import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import { seededRng } from '../src/core/rng.js';
import { retryAfterMs } from '../src/connectors/http.js';
import { CircuitBreaker, RateGate } from '../src/connectors/resilience.js';
import { backoffMs } from '../src/engine/worker.js';
import { Store } from '../src/store/db.js';

describe('durable queue', () => {
  it('coalesces many events for the same item into one job', () => {
    const s = new Store();
    for (let i = 0; i < 50; i++) s.enqueue('wf:1', 'webhook', 1000 + i);
    expect(s.jobs()).toHaveLength(1);
  });

  it('an event arriving while the job runs marks it dirty so it runs once more', () => {
    const s = new Store();
    s.enqueue('wf:1', 'webhook', 1000);
    const job = s.claim(1000, 60_000)!;
    s.enqueue('wf:1', 'webhook', 1001); // arrives mid-sync
    s.completeJob(job.id, 1002);
    expect(s.jobs()).toHaveLength(1); // re-armed, not deleted
    const again = s.claim(1002, 60_000)!;
    s.completeJob(again.id, 1003);
    expect(s.jobs()).toHaveLength(0);
  });

  it('a job leased by a crashed worker becomes claimable after the lease expires', () => {
    const s = new Store();
    s.enqueue('wf:1', 'webhook', 1000);
    expect(s.claim(1000, 30_000)).not.toBeNull();
    expect(s.claim(20_000, 30_000)).toBeNull(); // still leased
    expect(s.claim(31_001, 30_000)?.entity).toBe('wf:1'); // lease expired → reclaimed
  });

  it('webhook delivery ids are accepted once', () => {
    const s = new Store();
    expect(s.markDelivery('jira:abc', 'jira', 1)).toBe(true);
    expect(s.markDelivery('jira:abc', 'jira', 2)).toBe(false);
  });

  it('state survives a process restart (file-backed)', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = `${mkdtempSync(`${tmpdir()}/tether-`)}/t.db`;
    const a = new Store(path);
    a.enqueue('wf:9', 'webhook', 1);
    a.claim(1, 60_000); // leased by the process that is about to "crash"
    a.close();
    const b = new Store(path);
    b.releaseAllLeases();
    expect(b.claim(2, 60_000)?.entity).toBe('wf:9');
  });
});

describe('backoff', () => {
  it('grows exponentially, is jittered, and is capped', () => {
    const rng = seededRng(1);
    const o = { baseDelayMs: 1000, maxDelayMs: 60_000 };
    const d = Array.from({ length: 10 }, (_, a) => backoffMs(a, o, rng));
    expect(d[0]).toBeGreaterThanOrEqual(500);
    expect(d[0]).toBeLessThanOrEqual(1000);
    expect(d[5]).toBeGreaterThanOrEqual(16_000);
    expect(Math.max(...d)).toBeLessThanOrEqual(60_000);
  });
});

describe('Retry-After handling (Jira sometimes omits it)', () => {
  const now = Date.parse('2026-10-25T10:00:00Z');
  it('uses seconds', () => expect(retryAfterMs({ 'retry-after': '3' }, now)).toBe(3000));
  it('uses an HTTP date', () => expect(retryAfterMs({ 'retry-after': 'Sun, 25 Oct 2026 10:00:07 GMT' }, now)).toBe(7000));
  it('falls back to X-RateLimit-Reset', () => expect(retryAfterMs({ 'x-ratelimit-reset': '2026-10-25T10:00:02Z' }, now)).toBe(2000));
  it('falls back to a conservative default', () => expect(retryAfterMs({}, now)).toBe(5000));
});

describe('circuit breaker', () => {
  it('opens after consecutive failures, half-opens after cool-down, closes on success', () => {
    const clock = new ManualClock();
    const b = new CircuitBreaker(clock, 3, 5_000);
    for (let i = 0; i < 3; i++) b.failure();
    expect(b.state).toBe('open');
    expect(b.check()).toBeGreaterThan(clock.now());
    clock.advance(5_001);
    expect(b.check()).toBe(0); // probe allowed
    expect(b.state).toBe('half_open');
    expect(b.check()).toBeGreaterThan(0); // only one probe at a time
    b.success();
    expect(b.state).toBe('closed');
  });

  it('a failed probe re-opens with a longer cool-down', () => {
    const clock = new ManualClock();
    const b = new CircuitBreaker(clock, 1, 1_000);
    b.failure();
    clock.advance(1_001);
    b.check();
    b.failure();
    expect(b.check() - clock.now()).toBe(2_000);
  });
});

describe('client-side rate gate', () => {
  it('allows a burst, then paces at the configured rate, and honours vendor pauses', () => {
    const clock = new ManualClock();
    const g = new RateGate(clock, 2, 2);
    expect(g.take()).toBe(0);
    expect(g.take()).toBe(0);
    expect(g.take()).toBe(500);
    clock.advance(500);
    expect(g.take()).toBe(0);
    g.pause(3_000);
    expect(g.take()).toBe(3_000);
  });
});
