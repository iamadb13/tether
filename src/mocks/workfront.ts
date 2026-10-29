import Fastify, { type FastifyInstance } from 'fastify';
import type { Clock } from '../core/clock.js';
import { formatWfDate, type WfTask } from '../core/mapping.js';
import { JIRA_KEY_FIELD, SYNC_FLAG, WF_API } from '../core/vendor.js';
import { Chaos, WebhookEmitter } from './chaos.js';

export { JIRA_KEY_FIELD, SYNC_FLAG, WF_API };

/**
 * Mock Adobe Workfront. Modelled on the public REST API (v19.0-style paths, 3-letter status keys,
 * `DE:`-prefixed custom fields, the "…:000+0200" date format) and on Event Subscriptions
 * (CREATE/UPDATE/DELETE messages with newState/oldState, auth token header, retries).
 *
 * Two surfaces:
 *   /attask/api/v19.0/*  – the "real" API the glue service talks to (chaos applies here)
 *   /__mock/*            – demo/test controls: simulate a human editing in the UI, tune chaos
 */

export interface WfUser {
  ID: string;
  name: string;
  emailAddr: string;
}

export interface WorkfrontMockOptions {
  clock: Clock;
  chaos?: Chaos;
  apiKey?: string;
  timeZone?: string;
  pageSize?: number;
  /** Makes task IDs unique per run (e.g. "k3x9-"), so demo runs against a real Jira never collide. */
  idPrefix?: string;
}

export class WorkfrontMock {
  readonly tasks = new Map<string, WfTask>();
  readonly users: WfUser[] = [
    { ID: 'u-ana', name: 'Ana Popescu', emailAddr: 'ana@brand.example' },
    { ID: 'u-ben', name: 'Ben Okafor', emailAddr: 'ben@brand.example' },
    { ID: 'u-chen', name: 'Chen Wei', emailAddr: 'chen@brand.example' },
    { ID: 'u-dana', name: 'Dana Ruiz', emailAddr: 'dana@brand.example' }, // only exists in Workfront
  ];
  readonly chaos: Chaos;
  readonly webhooks: WebhookEmitter;
  readonly app: FastifyInstance;
  private seq = 0;
  readonly apiCalls = { reads: 0, writes: 0 };
  /** Observability tap: called after every change to a task (used by the replay recorder). */
  onChange?: (id: string) => void;

  constructor(private readonly opts: WorkfrontMockOptions) {
    this.chaos = opts.chaos ?? new Chaos(11);
    this.webhooks = new WebhookEmitter(this.chaos, 'wf');
    this.app = this.buildApp();
  }

  private now = () => this.opts.clock.now();
  private stamp = () => formatWfDate(this.now(), this.opts.timeZone ?? 'Europe/Bucharest');

  // ---------- "Human in the Workfront UI" operations (no chaos) ----------

  createTask(input: Partial<WfTask> & { name: string }, syncToJira = true): WfTask {
    const t: WfTask = {
      ID: `wf-${this.opts.idPrefix ?? ''}${(++this.seq).toString().padStart(4, '0')}`,
      description: null,
      status: 'NEW',
      plannedCompletionDate: null,
      priority: 2,
      assignedToID: null,
      projectID: 'proj-launch-q4',
      ...input,
      lastUpdateDate: this.stamp(),
      parameterValues: { [SYNC_FLAG]: syncToJira ? 'Yes' : 'No', ...(input.parameterValues ?? {}) },
    };
    this.tasks.set(t.ID, t);
    this.emit('CREATE', t, null);
    return t;
  }

  editTask(id: string, patch: Partial<WfTask>): WfTask {
    const old = this.tasks.get(id);
    if (!old) throw new Error(`no task ${id}`);
    const next: WfTask = {
      ...old,
      ...patch,
      parameterValues: { ...old.parameterValues, ...(patch.parameterValues ?? {}) },
      lastUpdateDate: this.stamp(),
    };
    this.tasks.set(id, next);
    this.emit('UPDATE', next, old);
    return next;
  }

  deleteTask(id: string): void {
    const old = this.tasks.get(id);
    if (!old) return;
    this.tasks.delete(id);
    this.emit('DELETE', null, old);
  }

  private emit(eventType: string, newState: WfTask | null, oldState: WfTask | null): void {
    this.onChange?.((newState ?? oldState)!.ID);
    this.webhooks.emit({
      eventType,
      subscriptionId: 'sub-tether-task',
      eventTime: this.now(),
      newState: newState ? { ...newState, objCode: 'TASK' } : null,
      oldState: oldState ? { ...oldState, objCode: 'TASK' } : null,
    });
  }

  // ---------- HTTP surface ----------

  private buildApp(): FastifyInstance {
    const app = Fastify({ logger: false });
    this.chaos.install(app, WF_API, this.now);
    const apiKey = this.opts.apiKey ?? 'wf-demo-key';
    const pageSize = this.opts.pageSize ?? 50;

    app.addHook('onRequest', async (req, reply) => {
      if (req.url.startsWith(WF_API) && req.headers.apikey !== apiKey) {
        return reply.code(401).send({ error: { class: 'NotAuthenticated', message: 'invalid apiKey' } });
      }
    });
    app.addHook('onRequest', async (req) => {
      if (!req.url.startsWith(WF_API)) return;
      if (req.method === 'GET') this.apiCalls.reads++;
      else this.apiCalls.writes++;
    });

    const notFound = (id: string) => ({ error: { class: 'NotFound', message: `TASK ${id} not found` } });

    app.get<{ Querystring: Record<string, string> }>(`${WF_API}/task/search`, async (req) => {
      const q = req.query;
      const since = q.lastUpdateDate && q.lastUpdateDate_Mod === 'gte' ? parseLoose(q.lastUpdateDate) : -Infinity;
      const flag = q[SYNC_FLAG];
      const first = Number(q.$$FIRST ?? 0);
      const limit = Math.min(Number(q.$$LIMIT ?? pageSize), pageSize);
      const all = [...this.tasks.values()]
        .filter((t) => parseLoose(t.lastUpdateDate) >= since)
        .filter((t) => !flag || t.parameterValues[SYNC_FLAG] === flag)
        .sort((a, b) => parseLoose(a.lastUpdateDate) - parseLoose(b.lastUpdateDate) || a.ID.localeCompare(b.ID));
      return { data: all.slice(first, first + limit) };
    });

    app.get<{ Params: { id: string } }>(`${WF_API}/task/:id`, async (req, reply) => {
      const t = this.tasks.get(req.params.id);
      return t ? { data: t } : reply.code(404).send(notFound(req.params.id));
    });

    app.put<{ Params: { id: string }; Body: Partial<WfTask> }>(`${WF_API}/task/:id`, async (req, reply) => {
      if (!this.tasks.has(req.params.id)) return reply.code(404).send(notFound(req.params.id));
      const body = req.body ?? {};
      if (body.status && !['NEW', 'INP', 'RVW', 'CPL'].includes(body.status)) {
        return reply.code(422).send({ error: { class: 'InvalidStatus', message: `bad status ${body.status}` } });
      }
      if (body.assignedToID && !this.users.some((u) => u.ID === body.assignedToID)) {
        return reply.code(422).send({ error: { class: 'NotFound', message: `USER ${body.assignedToID} not found` } });
      }
      return { data: this.editTask(req.params.id, body) };
    });

    app.get<{ Params: { id: string } }>(`${WF_API}/user/:id`, async (req, reply) => {
      const u = this.users.find((x) => x.ID === req.params.id);
      return u ? { data: u } : reply.code(404).send({ error: { class: 'NotFound', message: 'USER not found' } });
    });

    app.get<{ Querystring: { emailAddr?: string } }>(`${WF_API}/user/search`, async (req) => ({
      data: this.users.filter((u) => u.emailAddr.toLowerCase() === req.query.emailAddr?.toLowerCase()),
    }));

    // ---------- demo/test controls ----------
    app.get('/__mock/tasks', async () => ({ data: [...this.tasks.values()] }));
    app.post<{ Body: Partial<WfTask> & { name: string; syncToJira?: boolean } }>('/__mock/tasks', async (req) => {
      const { syncToJira = true, ...rest } = req.body;
      return { data: this.createTask(rest, syncToJira) };
    });
    app.patch<{ Params: { id: string }; Body: Partial<WfTask> }>('/__mock/tasks/:id', async (req) => ({
      data: this.editTask(req.params.id, req.body),
    }));
    app.delete<{ Params: { id: string } }>('/__mock/tasks/:id', async (req) => {
      this.deleteTask(req.params.id);
      return { ok: true };
    });
    app.get('/__mock/chaos', async () => ({ config: this.chaos.config, stats: this.chaos.stats, webhooks: this.webhookStats() }));
    app.put<{ Body: Partial<Chaos['config']> }>('/__mock/chaos', async (req) => {
      this.chaos.set(req.body);
      return { config: this.chaos.config };
    });
    app.get('/__mock/users', async () => ({ data: this.users }));
    return app;
  }

  webhookStats() {
    return { pending: this.webhooks.pending, delivered: this.webhooks.delivered, abandoned: this.webhooks.abandoned };
  }
}

function parseLoose(s: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}):(\d{3})([+-]\d{2})(\d{2})$/.exec(s);
  return m ? Date.parse(`${m[1]}.${m[2]}${m[3]}:${m[4]}`) : Date.parse(s);
}
