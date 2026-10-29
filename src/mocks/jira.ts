import { createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Clock } from '../core/clock.js';
import { formatJiraDate, parseJiraDate, textToAdf, zonedToInstant, type AdfNode, type JiraIssue } from '../core/mapping.js';
import { JIRA_API } from '../core/vendor.js';
import { Chaos, WebhookEmitter } from './chaos.js';

/**
 * Mock Jira Cloud (REST v3). Faithful to the parts that make integrations hard:
 *   - status cannot be set directly; it moves through workflow *transitions*
 *   - descriptions are Atlassian Document Format (ADF), not text
 *   - search is POST /rest/api/3/search/jql with cursor pagination (nextPageToken)
 *   - JQL date comparisons have minute granularity
 *   - webhooks carry X-Atlassian-Webhook-Identifier (stable across retries) and an HMAC signature
 */

export interface JiraUser {
  accountId: string;
  emailAddress: string;
  displayName: string;
}

/** Workflow: To Do → In Progress → In Review → Done, with "back" edges and Reopen. */
const WORKFLOW: Record<string, { id: string; name: string; to: string }[]> = {
  'To Do': [{ id: '11', name: 'Start progress', to: 'In Progress' }],
  'In Progress': [
    { id: '21', name: 'Request review', to: 'In Review' },
    { id: '31', name: 'Stop progress', to: 'To Do' },
  ],
  'In Review': [
    { id: '41', name: 'Approve', to: 'Done' },
    { id: '51', name: 'Request changes', to: 'In Progress' },
  ],
  Done: [{ id: '61', name: 'Reopen', to: 'To Do' }],
};

export interface JiraMockOptions {
  clock: Clock;
  chaos?: Chaos;
  projectKey?: string;
  webhookSecret?: string;
  auth?: string; // expected Authorization header
  pageSize?: number;
  /** Profile timezone of the API user: real Jira interprets JQL date literals in it. */
  userTimeZone?: string;
  /** Search only sees issues this long after they were created (real Jira's index is eventually consistent). */
  indexLagMs?: number;
}

export class JiraMock {
  readonly issues = new Map<string, JiraIssue>();
  private readonly createdAt = new Map<string, number>();
  readonly comments = new Map<string, { body: AdfNode; created: string }[]>();
  readonly users: JiraUser[] = [
    { accountId: '557058:ana', emailAddress: 'ana@brand.example', displayName: 'Ana Popescu' },
    { accountId: '557058:ben', emailAddress: 'ben@brand.example', displayName: 'Ben Okafor' },
    { accountId: '557058:chen', emailAddress: 'chen@brand.example', displayName: 'Chen Wei' },
    { accountId: '557058:eli', emailAddress: 'eli@brand.example', displayName: 'Eli Sandberg' }, // only in Jira
  ];
  readonly chaos: Chaos;
  readonly webhooks: WebhookEmitter;
  readonly app: FastifyInstance;
  readonly apiCalls = { reads: 0, writes: 0 };
  /** Observability tap: called after every change to an issue (used by the replay recorder). */
  onChange?: (key: string) => void;
  private seq = 0;
  readonly projectKey: string;

  constructor(private readonly opts: JiraMockOptions) {
    this.chaos = opts.chaos ?? new Chaos(22);
    this.projectKey = opts.projectKey ?? 'ENG';
    this.webhooks = new WebhookEmitter(this.chaos, 'jira');
    this.app = this.buildApp();
  }

  private now = () => this.opts.clock.now();

  // ---------- "Engineer in the Jira UI" operations (no chaos) ----------

  createIssue(fields: Partial<JiraIssue['fields']> & { summary: string }): JiraIssue {
    const key = `${this.projectKey}-${++this.seq}`;
    const issue: JiraIssue = {
      id: String(10000 + this.seq),
      key,
      fields: {
        description: null,
        status: { name: 'To Do' },
        duedate: null,
        priority: { name: 'Medium' },
        assignee: null,
        labels: [],
        ...fields,
        updated: formatJiraDate(this.now()),
      },
    };
    this.issues.set(key, issue);
    this.createdAt.set(key, this.now());
    this.emit('jira:issue_created', issue, []);
    return issue;
  }

  editIssue(key: string, fields: Partial<JiraIssue['fields']>): JiraIssue {
    const old = this.issues.get(key);
    if (!old) throw new Error(`no issue ${key}`);
    const next: JiraIssue = { ...old, fields: { ...old.fields, ...fields, updated: formatJiraDate(this.now()) } };
    this.issues.set(key, next);
    const changelog = Object.keys(fields).map((field) => ({ field, from: String(jsonish(old.fields, field)), to: String(jsonish(next.fields, field)) }));
    this.emit('jira:issue_updated', next, changelog);
    return next;
  }

  /** Human moving the card on the board — bypasses the workflow, like a Jira admin could. */
  setStatus(key: string, status: string): JiraIssue {
    return this.editIssue(key, { status: { name: status } });
  }

  deleteIssue(key: string): void {
    const old = this.issues.get(key);
    if (!old) return;
    this.issues.delete(key);
    this.emit('jira:issue_deleted', old, []);
  }

  private emit(webhookEvent: string, issue: JiraIssue, items: unknown[]): void {
    this.onChange?.(issue.key);
    this.webhooks.emit({ timestamp: this.now(), webhookEvent, issue, changelog: { items } });
  }

  sign(body: string): string {
    return 'sha256=' + createHmac('sha256', this.opts.webhookSecret ?? 'jira-demo-secret').update(body).digest('hex');
  }

  // ---------- HTTP surface ----------

  private buildApp(): FastifyInstance {
    const app = Fastify({ logger: false });
    this.chaos.install(app, JIRA_API, this.now);
    const auth = this.opts.auth ?? 'Basic ' + Buffer.from('tether@brand.example:jira-demo-token').toString('base64');
    const pageSize = this.opts.pageSize ?? 50;

    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith(JIRA_API)) return;
      if (req.headers.authorization !== auth) return reply.code(401).send({ errorMessages: ['Unauthorized'] });
      if (req.method === 'GET' || req.url.startsWith(`${JIRA_API}/search`)) this.apiCalls.reads++; // search is a POST but reads
      else this.apiCalls.writes++;
    });

    const missing = { errorMessages: ['Issue does not exist or you do not have permission to see it.'], errors: {} };

    app.get<{ Params: { key: string } }>(`${JIRA_API}/issue/:key`, async (req, reply) => {
      const i = this.issues.get(req.params.key);
      return i ?? reply.code(404).send(missing);
    });

    app.post<{ Body: { fields: Record<string, any> } }>(`${JIRA_API}/issue`, async (req, reply) => {
      const f = req.body?.fields ?? {};
      if (f.project?.key !== this.projectKey) return reply.code(400).send({ errors: { project: 'valid project is required' } });
      if (!f.summary) return reply.code(400).send({ errors: { summary: 'You must specify a summary of the issue.' } });
      const err = this.validateFields(f);
      if (err) return reply.code(400).send(err);
      const { project: _p, issuetype: _t, ...rest } = f;
      const issue = this.createIssue(rest as JiraIssue['fields']);
      return reply.code(201).send({ id: issue.id, key: issue.key, self: `${JIRA_API}/issue/${issue.id}` });
    });

    app.put<{ Params: { key: string }; Body: { fields?: Record<string, any> } }>(`${JIRA_API}/issue/:key`, async (req, reply) => {
      if (!this.issues.has(req.params.key)) return reply.code(404).send(missing);
      const f = { ...(req.body?.fields ?? {}) };
      // Jira's `update` verb form, e.g. { update: { labels: [{ add: 'x' }] } }
      const upd = (req.body as { update?: { labels?: { add?: string }[] } })?.update;
      if (upd?.labels) f.labels = [...this.issues.get(req.params.key)!.fields.labels, ...upd.labels.flatMap((l) => (l.add ? [l.add] : []))];
      if ('status' in f) return reply.code(400).send({ errors: { status: 'Field cannot be set. Use transitions.' } });
      const err = this.validateFields(f);
      if (err) return reply.code(400).send(err);
      this.editIssue(req.params.key, f);
      return reply.code(204).send();
    });

    app.delete<{ Params: { key: string } }>(`${JIRA_API}/issue/:key`, async (req, reply) => {
      if (!this.issues.has(req.params.key)) return reply.code(404).send(missing);
      this.deleteIssue(req.params.key);
      return reply.code(204).send();
    });

    app.get<{ Params: { key: string } }>(`${JIRA_API}/issue/:key/transitions`, async (req, reply) => {
      const i = this.issues.get(req.params.key);
      if (!i) return reply.code(404).send(missing);
      return { transitions: (WORKFLOW[i.fields.status.name] ?? []).map((t) => ({ id: t.id, name: t.name, to: { name: t.to } })) };
    });

    app.post<{ Params: { key: string }; Body: { transition?: { id?: string } } }>(
      `${JIRA_API}/issue/:key/transitions`,
      async (req, reply) => {
        const i = this.issues.get(req.params.key);
        if (!i) return reply.code(404).send(missing);
        const t = (WORKFLOW[i.fields.status.name] ?? []).find((x) => x.id === req.body?.transition?.id);
        if (!t) return reply.code(400).send({ errorMessages: [`Transition id '${req.body?.transition?.id}' is not valid for this issue.`] });
        this.editIssue(i.key, { status: { name: t.to } });
        return reply.code(204).send();
      },
    );

    app.post<{ Params: { key: string }; Body: { body: AdfNode } }>(`${JIRA_API}/issue/:key/comment`, async (req, reply) => {
      if (!this.issues.has(req.params.key)) return reply.code(404).send(missing);
      const list = this.comments.get(req.params.key) ?? [];
      list.push({ body: req.body.body, created: formatJiraDate(this.now()) });
      this.comments.set(req.params.key, list);
      return reply.code(201).send({ id: String(list.length) });
    });

    // ---- metadata used by `npm run preflight`
    const project = { id: '10000', key: this.projectKey, name: 'Engineering', style: 'classic', simplified: false };
    app.get<{ Params: { key: string } }>(`${JIRA_API}/project/:key`, async (req, reply) =>
      req.params.key === this.projectKey ? project : reply.code(404).send({ errorMessages: ['No project could be found with key.'] }),
    );
    app.get(`${JIRA_API}/issue/createmeta/:key/issuetypes`, async () => ({ issueTypes: [{ id: '10001', name: 'Task' }] }));
    app.get(`${JIRA_API}/issue/createmeta/:key/issuetypes/:id`, async () => ({
      fields: ['summary', 'description', 'labels', 'duedate', 'priority', 'assignee', 'issuetype', 'project'].map((fieldId) => ({ fieldId })),
    }));
    app.get(`${JIRA_API}/project/:key/statuses`, async () => [
      { name: 'Task', statuses: Object.keys(WORKFLOW).map((name) => ({ name })) },
    ]);
    app.get(`${JIRA_API}/priority/search`, async () => ({ values: ['Lowest', 'Low', 'Medium', 'High', 'Highest'].map((name) => ({ name })) }));

    app.get(`${JIRA_API}/myself`, async () => ({
      accountId: '557058:tether',
      emailAddress: 'tether@brand.example',
      displayName: 'Tether integration',
      timeZone: this.opts.userTimeZone ?? 'UTC',
    }));

    app.post<{ Body: { jql?: string; maxResults?: number; nextPageToken?: string; fields?: string[] } }>(`${JIRA_API}/search/jql`, async (req, reply) => {
      let pred: (i: JiraIssue) => boolean;
      try {
        pred = compileJql(req.body?.jql ?? '', this.opts.userTimeZone ?? 'UTC');
      } catch (e) {
        return reply.code(400).send({ errorMessages: [(e as Error).message] });
      }
      const start = Number(req.body?.nextPageToken ?? 0);
      const limit = Math.min(req.body?.maxResults ?? pageSize, pageSize);
      const lag = this.opts.indexLagMs ?? 0;
      const all = [...this.issues.values()]
        .filter((i) => this.now() - (this.createdAt.get(i.key) ?? 0) >= lag)
        .filter(pred)
        .sort((a, b) => parseJiraDate(a.fields.updated) - parseJiraDate(b.fields.updated) || a.key.localeCompare(b.key));
      // Like the real enhanced search: only ids/keys unless `fields` is requested.
      const want = req.body?.fields ?? [];
      const page = all.slice(start, start + limit).map((i) => ({
        id: i.id,
        key: i.key,
        fields: want.includes('*all') ? i.fields : Object.fromEntries(want.filter((f) => f in i.fields).map((f) => [f, (i.fields as Record<string, unknown>)[f]])),
      }));
      return { issues: page, ...(start + limit < all.length ? { nextPageToken: String(start + limit) } : {}) };
    });

    app.get<{ Querystring: { accountId?: string } }>(`${JIRA_API}/user`, async (req, reply) => {
      const u = this.users.find((x) => x.accountId === req.query.accountId);
      return u ?? reply.code(404).send({ errorMessages: ['User not found'] });
    });

    app.get<{ Querystring: { query?: string } }>(`${JIRA_API}/user/search`, async (req) =>
      this.users.filter((u) => u.emailAddress.toLowerCase() === req.query.query?.toLowerCase()),
    );

    // ---------- demo/test controls ----------
    app.get('/__mock/issues', async () => ({ data: [...this.issues.values()] }));
    app.patch<{ Params: { key: string }; Body: Partial<JiraIssue['fields']> & { description?: any } }>(
      '/__mock/issues/:key',
      async (req) => {
        const body = { ...req.body };
        if (typeof body.description === 'string') body.description = textToAdf(body.description);
        return { data: this.editIssue(req.params.key, body) };
      },
    );
    app.delete<{ Params: { key: string } }>('/__mock/issues/:key', async (req) => {
      this.deleteIssue(req.params.key);
      return { ok: true };
    });
    app.get('/__mock/chaos', async () => ({
      config: this.chaos.config,
      stats: this.chaos.stats,
      webhooks: { pending: this.webhooks.pending, delivered: this.webhooks.delivered, abandoned: this.webhooks.abandoned },
    }));
    app.put<{ Body: Partial<Chaos['config']> }>('/__mock/chaos', async (req) => {
      this.chaos.set(req.body);
      return { config: this.chaos.config };
    });
    return app;
  }

  private validateFields(f: Record<string, any>): object | null {
    if (f.priority && !['Lowest', 'Low', 'Medium', 'High', 'Highest'].includes(f.priority.name)) {
      return { errors: { priority: `Priority name '${f.priority.name}' is not valid` } };
    }
    if (f.assignee && !this.users.some((u) => u.accountId === f.assignee.accountId)) {
      return { errors: { assignee: `User '${f.assignee.accountId}' cannot be assigned issues.` } };
    }
    if (f.summary && String(f.summary).length > 255) return { errors: { summary: 'Summary must be less than 255 characters.' } };
    if (f.duedate && !/^\d{4}-\d{2}-\d{2}$/.test(f.duedate)) return { errors: { duedate: 'Invalid date format' } };
    return null;
  }
}

function jsonish(o: Record<string, any>, field: string): unknown {
  const v = o[field];
  return v && typeof v === 'object' ? (v.name ?? v.accountId ?? JSON.stringify(v)) : v;
}

/**
 * Tiny JQL subset: clauses joined by AND —
 *   labels = "x"      project = KEY      updated >= "yyyy/MM/dd HH:mm"
 * Like real Jira, the date comparison is at *minute* granularity (hence the reconciler's overlap window)
 * and date literals are read in the API user's profile timezone.
 */
export function compileJql(jql: string, timeZone = 'UTC'): (i: JiraIssue) => boolean {
  const clauses = jql
    .replace(/\s+ORDER BY.*$/i, '')
    .split(/\s+AND\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const preds = clauses.map((c): ((i: JiraIssue) => boolean) => {
    let m = /^labels\s*=\s*"?([\w-]+)"?$/i.exec(c);
    if (m) return (i) => i.fields.labels.includes(m![1]!);
    m = /^project\s*=\s*"?(\w+)"?$/i.exec(c);
    if (m) return (i) => i.key.startsWith(`${m![1]}-`);
    m = /^updated\s*>=\s*"(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})"$/i.exec(c);
    if (m) {
      const t = zonedToInstant(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, timeZone);
      return (i) => Math.floor(parseJiraDate(i.fields.updated) / 60000) * 60000 >= t;
    }
    throw new Error(`Error in the JQL Query: unsupported clause '${c}'`);
  });
  return (i) => preds.every((p) => p(i));
}
