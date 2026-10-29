import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from '../core/clock.js';
import { FIELDS } from '../core/model.js';
import type { Reconciler } from '../engine/reconciler.js';
import type { Syncer } from '../engine/syncer.js';
import type { Worker } from '../engine/worker.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { Store } from '../store/db.js';

export interface ApiDeps {
  store: Store;
  syncer: Syncer;
  worker: Worker;
  reconciler: Reconciler;
  metrics: Metrics;
  clock: Clock;
  logger: Logger;
  secrets: { workfrontToken: string; jiraSecret: string; adminToken: string };
  breakers: () => Record<string, string>;
  /** Extra data for the demo dashboard (mock URLs); absent in production. */
  demo?: { workfrontUrl: string; jiraUrl: string };
}

const WfEvent = z.object({
  eventType: z.enum(['CREATE', 'UPDATE', 'DELETE']),
  newState: z.object({ ID: z.string(), objCode: z.string().optional() }).passthrough().nullable().optional(),
  oldState: z.object({ ID: z.string() }).passthrough().nullable().optional(),
});

const JiraEvent = z.object({
  webhookEvent: z.string(),
  issue: z.object({ key: z.string(), fields: z.object({ labels: z.array(z.string()).optional() }).passthrough() }).passthrough(),
});

const MARKER = /^tether-(wf-[\w-]+)$/;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function buildApi(d: ApiDeps): FastifyInstance {
  // Per-request access logs are suppressed (webhook volume); the engine logs what matters per sync.
  const app = Fastify({ loggerInstance: d.logger.child({ component: 'http' }, { level: 'warn' }) as unknown as FastifyBaseLogger, bodyLimit: 1_048_576 });

  // Keep the raw body: Jira signs the exact bytes, so we must verify before parsing.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      (e as { statusCode?: number }).statusCode = 400;
      done(e as Error, undefined);
    }
  });

  // ------------------------------------------------------------------ webhooks
  //
  // Contract: authenticate, dedupe, enqueue, return 202 — in milliseconds. Workfront requires a
  // 2xx within 5 s or it starts retrying (and eventually disables the subscription), so no vendor
  // API call ever happens on this path.

  app.post('/webhooks/workfront', async (req, reply) => {
    if (!safeEqual(String(req.headers.authorization ?? ''), d.secrets.workfrontToken)) {
      d.metrics.webhooks.inc({ source: 'workfront', result: 'rejected' });
      return reply.code(401).send({ error: 'bad token' });
    }
    const ev = WfEvent.safeParse(req.body);
    if (!ev.success) {
      d.metrics.webhooks.inc({ source: 'workfront', result: 'ignored' });
      return reply.code(202).send({ ignored: 'unrecognised payload' });
    }
    const wfId = ev.data.newState?.ID ?? ev.data.oldState?.ID;
    const deliveryId = 'wf:' + createHash('sha256').update((req as FastifyRequest & { rawBody?: string }).rawBody ?? '').digest('hex');
    return accept(reply, 'workfront', deliveryId, wfId ?? null);
  });

  app.post('/webhooks/jira', async (req, reply) => {
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const expected = 'sha256=' + createHmac('sha256', d.secrets.jiraSecret).update(raw).digest('hex');
    if (!safeEqual(String(req.headers['x-hub-signature'] ?? ''), expected)) {
      d.metrics.webhooks.inc({ source: 'jira', result: 'rejected' });
      return reply.code(401).send({ error: 'bad signature' });
    }
    const ev = JiraEvent.safeParse(req.body);
    if (!ev.success) {
      d.metrics.webhooks.inc({ source: 'jira', result: 'ignored' });
      return reply.code(202).send({ ignored: 'unrecognised payload' });
    }
    const key = ev.data.issue.key;
    const wfId =
      d.store.linkByJira(key)?.wfId ?? (ev.data.issue.fields.labels ?? []).map((l) => MARKER.exec(l)?.[1]).find(Boolean) ?? null;
    const deliveryId = 'jira:' + String(req.headers['x-atlassian-webhook-identifier'] ?? createHash('sha256').update(raw).digest('hex'));
    return accept(reply, 'jira', deliveryId, wfId);
  });

  function accept(reply: FastifyReply, source: string, deliveryId: string, wfId: string | null) {
    const now = d.clock.now();
    if (!d.store.markDelivery(deliveryId, source, now)) {
      d.metrics.webhooks.inc({ source, result: 'duplicate' });
      return reply.code(202).send({ duplicate: true });
    }
    if (!wfId) {
      d.metrics.webhooks.inc({ source, result: 'ignored' }); // e.g. a Jira issue that isn't ours
      return reply.code(202).send({ ignored: 'not a synced item' });
    }
    d.store.enqueue(`wf:${wfId}`, 'webhook', now);
    d.metrics.webhooks.inc({ source, result: 'accepted' });
    return reply.code(202).send({ queued: wfId });
  }

  // ------------------------------------------------------------------ health & metrics

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/readyz', async (_req, reply) => {
    const breakers = d.breakers();
    const lastRun = Number(d.store.get('reconciler:last_run') ?? 0);
    const q = d.store.queueStats(d.clock.now());
    const body = { db: 'ok', breakers, queueDepth: q.depth, syncLagSeconds: q.oldestAgeMs / 1000, lastReconcileAt: lastRun || null };
    // Not ready if a vendor is hard down: lets the platform alert, while the queue keeps everything safe.
    return Object.values(breakers).includes('open') ? reply.code(503).send(body) : body;
  });

  app.get('/metrics', async (_req, reply) => {
    d.worker.refreshGauges();
    reply.header('content-type', d.metrics.registry.contentType);
    return d.metrics.registry.metrics();
  });

  // ------------------------------------------------------------------ admin / ops API

  app.register(async (admin) => {
    admin.addHook('onRequest', async (req, reply) => {
      const tok = String(req.headers.authorization ?? '').replace(/^Bearer /, '') || String((req.query as Record<string, string>).token ?? '');
      if (!safeEqual(tok, d.secrets.adminToken)) return reply.code(401).send({ error: 'admin token required' });
    });

    admin.get('/admin/state', async () => {
      const now = d.clock.now();
      const counters = async (m: { get(): Promise<{ values: { labels: Record<string, string | number>; value: number }[] }> }) =>
        (await m.get()).values.map((v) => ({ ...v.labels, value: v.value }));
      return {
        webhooks: await counters(d.metrics.webhooks),
        syncRuns: await counters(d.metrics.syncRuns),
        jobAttempts: await counters(d.metrics.jobAttempts),
        reconcilerRepairs: (await d.metrics.reconcilerRepairs.get()).values[0]?.value ?? 0,
        now,
        queue: d.store.queueStats(now),
        breakers: d.breakers(),
        links: d.store.links(),
        conflicts: d.store.conflicts(),
        deadLetters: d.store.deadLetters(),
        jobs: d.store.jobs(),
        audit: d.store.auditFor(undefined, 40),
        lastReconcileAt: Number(d.store.get('reconciler:last_run') ?? 0) || null,
        demo: d.demo ?? null,
      };
    });

    admin.get<{ Querystring: { wfId?: string } }>('/admin/audit', async (req) => d.store.auditFor(req.query.wfId, 500));

    admin.post<{ Params: { id: string }; Body: { choose: 'workfront' | 'jira' | 'value'; value?: unknown; by?: string } }>(
      '/admin/conflicts/:id/resolve',
      async (req, reply) => {
        const c = d.store.conflicts().find((x) => x.id === Number(req.params.id));
        if (!c) return reply.code(404).send({ error: 'no such open conflict' });
        const { choose, value, by = 'ops-ui' } = req.body ?? ({} as never);
        const chosen = choose === 'workfront' ? c.wfValue : choose === 'jira' ? c.jiraValue : value;
        if (!FIELDS.includes(c.field)) return reply.code(400).send({ error: 'bad field' });
        d.store.resolveConflict(c.id, chosen, by, d.clock.now());
        d.store.enqueue(`wf:${c.wfId}`, 'resolve', d.clock.now());
        d.logger.info({ conflictId: c.id, wfId: c.wfId, field: c.field, chosen, by }, 'conflict resolved by human');
        return { ok: true, field: c.field, value: chosen };
      },
    );

    admin.post<{ Params: { id: string } }>('/admin/dead-letters/:id/replay', async (req, reply) =>
      d.store.replayDeadLetter(Number(req.params.id), d.clock.now()) ? { ok: true } : reply.code(404).send({ error: 'not found' }),
    );

    admin.post('/admin/reconcile', async () => ({ enqueued: d.reconciler.fullScan() }));

    // Dry-run drift report: what *would* change if sync ran now. Writes nothing, anywhere.
    // Used on day one of a rollout to show the customer how far apart their systems already are.
    admin.get('/admin/drift', async () => {
      const report = [];
      for (const l of d.store.links('active')) {
        try {
          const r = await d.syncer.sync(l.wfId, 'drift', true);
          const p = r.plan;
          if (p && (!p.isNoop || p.conflicts.length)) {
            report.push({ wfId: l.wfId, jiraKey: l.jiraKey, toWorkfront: p.writeWorkfront, toJira: p.writeJira, conflicts: p.conflicts });
          }
        } catch (e) {
          report.push({ wfId: l.wfId, jiraKey: l.jiraKey, error: (e as Error).message });
        }
      }
      return { checked: d.store.links('active').length, drifted: report.length, report };
    });

    admin.post<{ Params: { wfId: string } }>('/admin/sync/:wfId', async (req) => {
      d.store.enqueue(`wf:${req.params.wfId}`, 'manual', d.clock.now());
      return { queued: req.params.wfId };
    });
  });

  // ------------------------------------------------------------------ ops dashboard (single static page)

  const html = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
  app.get('/', async (_req, reply) => reply.type('text/html').send(html));

  return app;
}
