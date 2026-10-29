import { TransientError } from '../core/errors.js';
import type { Transport } from '../connectors/transport.js';
import type { Chaos } from './chaos.js';

/**
 * Client-side fault injection for vendors we can't make misbehave on demand (e.g. a real Jira Cloud
 * site). Wraps the real transport and, per the Chaos config:
 *   outage / errorRate  → synthetic 503 / 5xx without sending
 *   rateLimitRate       → synthetic 429 (Retry-After sometimes omitted, like real Jira)
 *   lostResponseRate    → the request IS sent and applied by the real vendor, then we throw as if
 *                         the connection dropped: the genuinely ambiguous case
 *   latencyMs           → extra delay
 * Webhook knobs don't apply here (real vendors deliver their own webhooks).
 */
export function chaosTransport(inner: Transport, chaos: Chaos, system: string, now: () => number = Date.now): Transport {
  return {
    async request(req) {
      const c = chaos.config;
      if (c.latencyMs > 0) await new Promise((r) => setTimeout(r, c.latencyMs * (0.5 + chaos.rng())));
      if (c.outage) {
        chaos.stats.outage++;
        return { status: 503, headers: {}, body: { error: 'chaos: outage (client-side)' } };
      }
      if (chaos.roll(c.rateLimitRate)) {
        chaos.stats.rateLimited++;
        const waitS = 1 + Math.floor(chaos.rng() * 3);
        const headers: Record<string, string> = { 'x-ratelimit-reset': new Date(now() + waitS * 1000).toISOString() };
        if (chaos.rng() < 0.7) headers['retry-after'] = String(waitS);
        return { status: 429, headers, body: { error: 'chaos: rate limited (client-side)' } };
      }
      if (chaos.roll(c.errorRate)) {
        chaos.stats.errors++;
        return { status: [500, 502, 503][Math.floor(chaos.rng() * 3)]!, headers: {}, body: { error: 'chaos: upstream error (client-side)' } };
      }
      const res = await inner.request(req);
      if (req.method !== 'GET' && res.status < 300 && chaos.roll(c.lostResponseRate)) {
        chaos.stats.lostResponses++;
        throw new TransientError(`${system}: connection reset after request was sent (chaos)`, system, true);
      }
      return res;
    },
  };
}
