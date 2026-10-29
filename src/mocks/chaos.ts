import type { FastifyInstance } from 'fastify';
import { seededRng, type Rng } from '../core/rng.js';
import { LOST_RESPONSE_HEADER } from '../core/vendor.js';

/**
 * Fault injection for the mock SaaS APIs. Every knob maps to a failure mode observed in the
 * real Workfront / Jira APIs (see docs/research.md):
 *
 *  errorRate         – 500/502/503 before the request is processed (safe to retry)
 *  rateLimitRate     – 429; `Retry-After` is sometimes *omitted* (documented Jira behaviour),
 *                      in which case only `X-RateLimit-Reset` is sent
 *  lostResponseRate  – the write IS applied but the client never sees the response
 *                      (the nastiest case: ambiguous outcome, naive retries create duplicates)
 *  outage            – every API call returns 503 (drives the circuit breaker)
 *  webhookDropRate   – webhook silently never delivered (Jira gives up after retries)
 *  webhookDupRate    – webhook delivered twice with the same delivery id
 *  webhookReorder    – a batch of pending webhooks is delivered in random order
 */
export interface ChaosConfig {
  errorRate: number;
  rateLimitRate: number;
  lostResponseRate: number;
  outage: boolean;
  latencyMs: number;
  webhookDropRate: number;
  webhookDupRate: number;
  webhookReorder: boolean;
}

export const CALM: ChaosConfig = {
  errorRate: 0,
  rateLimitRate: 0,
  lostResponseRate: 0,
  outage: false,
  latencyMs: 0,
  webhookDropRate: 0,
  webhookDupRate: 0,
  webhookReorder: false,
};


/** Deterministic, targeted fault: "the next N requests matching this fail with `status`". */
export interface ScriptedFault {
  method: string;
  path: RegExp;
  status: number | 'lost-response';
  times: number;
}

export class Chaos {
  config: ChaosConfig;
  readonly script: ScriptedFault[] = [];
  readonly stats = { errors: 0, rateLimited: 0, lostResponses: 0, outage: 0, webhooksDropped: 0, webhooksDuplicated: 0 };
  readonly rng: Rng;

  constructor(seed = 1, config: Partial<ChaosConfig> = {}) {
    this.rng = seededRng(seed);
    this.config = { ...CALM, ...config };
  }

  failNext(method: string, path: RegExp, status: ScriptedFault['status'], times = 1): void {
    this.script.push({ method, path, status, times });
  }

  private takeScripted(method: string, url: string, phase: 'before' | 'after'): ScriptedFault | null {
    const f = this.script.find(
      (x) => x.times > 0 && x.method === method && x.path.test(url) && (x.status === 'lost-response') === (phase === 'after'),
    );
    if (f) f.times--;
    return f ?? null;
  }

  set(patch: Partial<ChaosConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  roll(p: number): boolean {
    return p > 0 && this.rng() < p;
  }

  /** Installs the request-level fault hooks on every route under `apiPrefix`. */
  install(app: FastifyInstance, apiPrefix: string, now: () => number): void {
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith(apiPrefix)) return;
      const scripted = this.takeScripted(req.method, req.url, 'before');
      if (scripted) return reply.code(scripted.status as number).send({ error: `chaos: scripted ${scripted.status}` });
      const c = this.config;
      if (c.latencyMs > 0) await new Promise((r) => setTimeout(r, c.latencyMs * (0.5 + this.rng())));
      if (c.outage) {
        this.stats.outage++;
        return reply.code(503).send({ error: 'Service Unavailable (chaos: outage)' });
      }
      if (this.roll(c.rateLimitRate)) {
        this.stats.rateLimited++;
        const waitS = 1 + Math.floor(this.rng() * 3);
        if (this.rng() < 0.7) reply.header('Retry-After', String(waitS));
        reply.header('X-RateLimit-Reset', new Date(now() + waitS * 1000).toISOString());
        return reply.code(429).send({ error: 'Too Many Requests (chaos)' });
      }
      if (this.roll(c.errorRate)) {
        this.stats.errors++;
        return reply.code([500, 502, 503][Math.floor(this.rng() * 3)]!).send({ error: 'chaos: upstream error' });
      }
    });
    app.addHook('onSend', async (req, reply, payload) => {
      if (!req.url.startsWith(apiPrefix) || req.method === 'GET') return payload;
      if (reply.statusCode < 300 && (this.takeScripted(req.method, req.url, 'after') || this.roll(this.config.lostResponseRate))) {
        this.stats.lostResponses++;
        reply.header(LOST_RESPONSE_HEADER, '1');
      }
      return payload;
    });
  }
}

/**
 * Outgoing webhook queue for a mock system. Models at-least-once, unordered delivery with
 * vendor-style retries; events that keep failing are eventually abandoned, exactly like the
 * real systems do — which is why the glue service cannot rely on webhooks alone.
 */
export interface OutgoingWebhook {
  deliveryId: string;
  body: unknown;
  attempts: number;
}

export type WebhookSender = (hook: OutgoingWebhook) => Promise<number>;

export class WebhookEmitter {
  private queue: OutgoingWebhook[] = [];
  private seq = 0;
  sender: WebhookSender | null = null;
  /** Observability tap (used by the replay recorder). */
  onOutcome?: (outcome: 'delivered' | 'dropped' | 'duplicated' | 'failed' | 'abandoned', hook: OutgoingWebhook) => void;
  delivered = 0;
  abandoned = 0;

  constructor(
    private readonly chaos: Chaos,
    private readonly prefix: string,
    private readonly maxAttempts = 5,
  ) {}

  emit(body: unknown): void {
    if (!this.sender) return; // no subscription configured
    this.queue.push({ deliveryId: `${this.prefix}-${++this.seq}`, body, attempts: 0 });
  }

  get pending(): number {
    return this.queue.length;
  }

  async flush(): Promise<void> {
    if (!this.sender || this.queue.length === 0) return;
    let batch = this.queue;
    this.queue = [];
    if (this.chaos.config.webhookReorder) batch = shuffle(batch, this.chaos.rng);
    for (const hook of batch) {
      if (this.chaos.roll(this.chaos.config.webhookDropRate)) {
        this.chaos.stats.webhooksDropped++;
        this.onOutcome?.('dropped', hook);
        continue;
      }
      const copies = this.chaos.roll(this.chaos.config.webhookDupRate) ? 2 : 1;
      if (copies === 2) {
        this.chaos.stats.webhooksDuplicated++;
        this.onOutcome?.('duplicated', hook);
      }
      for (let i = 0; i < copies; i++) {
        hook.attempts++;
        let status = 0;
        try {
          status = await this.sender(hook);
        } catch {
          status = 0;
        }
        if (status >= 200 && status < 300) {
          this.delivered++;
          this.onOutcome?.('delivered', hook);
        } else if (i === 0) {
          if (hook.attempts < this.maxAttempts) {
            this.queue.push(hook);
            this.onOutcome?.('failed', hook);
          } else {
            this.abandoned++;
            this.onOutcome?.('abandoned', hook);
          }
          break;
        }
      }
    }
  }
}

function shuffle<T>(xs: T[], rng: Rng): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
