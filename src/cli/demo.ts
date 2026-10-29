/**
 * `npm run demo` — the whole world on your laptop, over real HTTP.
 *
 * Mock mode (default, no .env needed):
 *   :4001  mock Workfront   (REST API + event subscriptions)
 *   :4002  mock Jira Cloud  (REST v3 + signed webhooks)
 *   :4000  Tether           (webhooks, worker, reconciler, metrics, ops dashboard)
 *
 * Real-Jira mode (JIRA_BASE_URL in .env points at *.atlassian.net):
 *   Workfront stays mocked; Tether syncs with your real Jira Cloud site. Jira can't reach localhost,
 *   so Jira-side changes arrive via the reconciler's polling (proof that webhooks are only a hint).
 *   Chaos for Jira is injected client-side, inside Tether's own transport.
 *
 * State lives in ./data/demo.db (deleted on start).
 */
import { mkdirSync, rmSync } from 'node:fs';
import { buildTether } from '../app.js';
import { loadConfig, loadDotEnv } from '../config.js';
import { systemClock } from '../core/clock.js';
import { jiraToCanonical, wfToCanonical, CANONICAL_TO_JIRA_PRIORITY } from '../core/mapping.js';
import type { WorkItem } from '../core/model.js';
import { seededRng } from '../core/rng.js';
import { ApiClient } from '../connectors/http.js';
import { JiraConnector } from '../connectors/jira.js';
import { fetchTransport, type Transport } from '../connectors/transport.js';
import { CALM, Chaos, type ChaosConfig } from '../mocks/chaos.js';
import { chaosTransport } from '../mocks/chaos-transport.js';
import { JiraMock } from '../mocks/jira.js';
import { WorkfrontMock } from '../mocks/workfront.js';
import { createLogger } from '../observability/logger.js';
import { Metrics } from '../observability/metrics.js';
import { makeConflict, randomHumanEdit, seedDemoData, type JiraHuman, type People } from './demo-data.js';

const PRESETS: Record<string, Partial<ChaosConfig>> = {
  calm: CALM,
  flaky: { ...CALM, errorRate: 0.2, rateLimitRate: 0.1, lostResponseRate: 0.1, latencyMs: 60 },
  webhooks: { ...CALM, webhookDropRate: 0.6, webhookDupRate: 0.4, webhookReorder: true },
  apocalypse: { errorRate: 0.3, rateLimitRate: 0.15, lostResponseRate: 0.15, latencyMs: 80, webhookDropRate: 0.5, webhookDupRate: 0.4, webhookReorder: true, outage: false },
};

type Config = ReturnType<typeof loadConfig>;

/** Everything the demo needs from "the Jira side", whichever Jira that is. */
interface DemoJira {
  mode: 'mock' | 'real';
  transport: Transport;
  chaos: Chaos;
  human: JiraHuman;
  list(): Promise<{ key: string; labels: string[]; item: WorkItem | { error: string } }[]>;
  webhooks(): { pending: number; delivered: number; abandoned: number } | null;
  apiCalls(): { reads: number; writes: number } | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

async function main() {
  loadDotEnv();
  const dbDir = './data';
  mkdirSync(dbDir, { recursive: true });
  for (const f of ['demo.db', 'demo.db-wal', 'demo.db-shm']) rmSync(`${dbDir}/${f}`, { force: true });

  const realJira = process.env.DEMO_JIRA ? process.env.DEMO_JIRA === 'real' : /atlassian\.net/.test(process.env.JIRA_BASE_URL ?? '');
  const config = loadConfig({
    ...process.env,
    DB_PATH: `${dbDir}/demo.db`,
    // Real Jira can't push webhooks to localhost, so poll it briskly; the mock pushes webhooks.
    RECONCILE_INTERVAL_MS: process.env.RECONCILE_INTERVAL_MS ?? (realJira ? '3000' : '10000'),
    // Free Jira sites are small; stay well inside their rate limits.
    JIRA_RPS: process.env.JIRA_RPS ?? (realJira ? '5' : '10'),
  });
  const logger = createLogger(process.env.LOG_LEVEL ?? 'info');
  const clock = systemClock;
  const runId = Date.now().toString(36).slice(-4);

  // Workfront people: in real-Jira mode "you" are the one person who exists in both systems.
  const people: People = realJira
    ? { shared: ['u-me'], sharedEmails: [config.JIRA_EMAIL.toLowerCase()], wfOnly: 'u-dana' }
    : { shared: ['u-ana', 'u-ben', 'u-chen'], sharedEmails: ['ana@brand.example', 'ben@brand.example', 'chen@brand.example'], wfOnly: 'u-dana' };

  // Unique task IDs per run against a real site, so a rerun never adopts the previous run's issues.
  const wf = new WorkfrontMock({ clock, timeZone: config.TIMEZONE, idPrefix: realJira ? `${runId}-` : '' });
  if (realJira) {
    wf.users.splice(0, wf.users.length, { ID: 'u-me', name: 'You', emailAddr: config.JIRA_EMAIL.toLowerCase() }, { ID: 'u-dana', name: 'Dana Ruiz', emailAddr: 'dana@brand.example' });
  }

  const jira = realJira ? realJiraSide(config) : mockJiraSide(config);

  const tether = buildTether({
    config,
    clock,
    rng: seededRng(Date.now() & 0xffff),
    logger,
    workfrontTransport: fetchTransport(config.WORKFRONT_BASE_URL, 'workfront', config.HTTP_TIMEOUT_MS),
    jiraTransport: jira.transport,
    defaultMetrics: true,
    // Snappier recovery for a live demo; production keeps the 5-minute cap.
    worker: { maxDelayMs: 10_000 },
  });

  const tetherUrl = `http://127.0.0.1:${config.PORT}`;
  wf.webhooks.sender = async (hook) =>
    (
      await fetch(`${tetherUrl}/webhooks/workfront`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: config.WORKFRONT_WEBHOOK_TOKEN },
        body: JSON.stringify(hook.body),
      })
    ).status;
  const deliver = setInterval(() => void wf.webhooks.flush().catch(() => undefined), 300);

  // ---- demo-only routes the dashboard uses to show both worlds and to play "the users"
  const api = tether.api;
  api.get('/demo/world', async () => {
    const wfEmail = (id: string | null) => wf.users.find((u) => u.ID === id)?.emailAddr ?? null;
    const safe = <T>(f: () => T): T | { error: string } => {
      try {
        return f();
      } catch (e) {
        return { error: (e as Error).message };
      }
    };
    return {
      mode: jira.mode,
      jiraUrl: jira.mode === 'real' ? config.JIRA_BASE_URL : null,
      workfront: [...wf.tasks.values()].map((t) => ({
        id: t.ID,
        sync: t.parameterValues['DE:Sync to Jira'] === 'Yes',
        jiraKey: t.parameterValues['DE:Jira Key'] ?? null,
        item: safe(() => wfToCanonical(t, wfEmail(t.assignedToID), { timeZone: config.TIMEZONE })),
      })),
      jira: await jira.list(),
      chaos: {
        workfront: { config: wf.chaos.config, stats: wf.chaos.stats, webhooks: wf.webhookStats() },
        jira: { config: jira.chaos.config, stats: jira.chaos.stats, webhooks: jira.webhooks() },
      },
      apiCalls: { workfront: wf.apiCalls, jira: jira.apiCalls() },
    };
  });
  api.post<{ Body: { preset?: string; target?: 'both' | 'workfront' | 'jira'; patch?: Partial<ChaosConfig> } }>('/demo/chaos', async (req) => {
    const { preset, target = 'both', patch } = req.body ?? {};
    const cfg = preset ? PRESETS[preset] : patch;
    if (!cfg) return { error: 'unknown preset' };
    if (target !== 'jira') wf.chaos.set(preset ? { ...CALM, ...cfg } : cfg);
    if (target !== 'workfront') jira.chaos.set(preset ? { ...CALM, ...cfg } : cfg);
    logger.warn({ preset, target, patch }, 'chaos changed');
    return { workfront: wf.chaos.config, jira: jira.chaos.config };
  });
  api.post<{ Body: { count?: number } }>('/demo/edits', async (req) => {
    const done = [];
    for (let i = 0; i < (req.body?.count ?? 5); i++) done.push(await randomHumanEdit(wf, jira.human, people).catch((e) => `failed: ${(e as Error).message}`));
    return { done };
  });
  api.post('/demo/conflict', async () => makeConflict(wf, jira.human));
  api.post<{ Body: { name?: string } }>('/demo/task', async (req) => {
    const t = wf.createTask({
      name: req.body?.name || `New request ${new Date().toLocaleTimeString()}`,
      priority: 2,
      assignedToID: people.shared[0]!,
      plannedCompletionDate: '2026-12-01T17:00:00:000+0200',
    });
    return { id: t.ID };
  });

  await wf.app.listen({ port: 4001, host: '127.0.0.1' });
  await jira.start();
  await api.listen({ port: config.PORT, host: '127.0.0.1' });

  seedDemoData(wf, people);
  tether.worker.start(200);
  tether.reconciler.start(config.RECONCILE_INTERVAL_MS);

  const line = '─'.repeat(68);
  console.log(`\n${line}\n  Tether demo is running — ${jira.mode === 'real' ? `REAL Jira: ${config.JIRA_BASE_URL}` : 'mock Workfront + mock Jira'}\n${line}`);
  console.log(`  Ops dashboard   http://127.0.0.1:${config.PORT}/?token=${config.ADMIN_TOKEN}`);
  if (jira.mode === 'real') console.log(`  Jira board      ${config.JIRA_BASE_URL}/jira/software/projects/${config.JIRA_PROJECT_KEY}/boards`);
  console.log(`  Metrics         http://127.0.0.1:${config.PORT}/metrics`);
  console.log(`  Readiness       http://127.0.0.1:${config.PORT}/readyz`);
  console.log(`  Drift report    npm run drift`);
  console.log(`  Mock Workfront  http://127.0.0.1:4001/__mock/tasks`);
  if (jira.mode === 'mock') console.log(`  Mock Jira       http://127.0.0.1:4002/__mock/issues`);
  console.log(`${line}\n  Ctrl+C to stop. Structured logs follow.\n${line}\n`);

  const shutdown = async () => {
    clearInterval(deliver);
    tether.reconciler.stop();
    await tether.worker.stop();
    await Promise.allSettled([api.close(), wf.app.close(), jira.stop()]);
    tether.store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function mockJiraSide(config: Config): DemoJira {
  const jira = new JiraMock({ clock: systemClock, projectKey: config.JIRA_PROJECT_KEY, indexLagMs: 1_000 });
  const tetherUrl = `http://127.0.0.1:${config.PORT}`;
  jira.webhooks.sender = async (hook) => {
    const body = JSON.stringify(hook.body);
    return (
      await fetch(`${tetherUrl}/webhooks/jira`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature': jira.sign(body),
          'x-atlassian-webhook-identifier': hook.deliveryId,
          ...(hook.attempts > 1 ? { 'x-atlassian-webhook-retry': String(hook.attempts - 1) } : {}),
        },
        body,
      })
    ).status;
  };
  let deliver: NodeJS.Timeout | undefined;
  const accountOf = (email: string | null) => jira.users.find((u) => u.emailAddress === email)?.accountId ?? null;
  const NAMES = { todo: 'To Do', in_progress: 'In Progress', in_review: 'In Review', done: 'Done' } as const;
  return {
    mode: 'mock',
    transport: fetchTransport(config.JIRA_BASE_URL, 'jira', config.HTTP_TIMEOUT_MS),
    chaos: jira.chaos,
    human: {
      setStatus: async (k, s) => void jira.setStatus(k, NAMES[s]),
      setPriority: async (k, p) => void jira.editIssue(k, { priority: { name: CANONICAL_TO_JIRA_PRIORITY[p] } }),
      setAssignee: async (k, e) => {
        const id = accountOf(e);
        jira.editIssue(k, { assignee: id ? { accountId: id } : null });
      },
      setDueDate: async (k, d) => void jira.editIssue(k, { duedate: d }),
    },
    list: async () =>
      [...jira.issues.values()].map((i) => {
        const email = jira.users.find((u) => u.accountId === i.fields.assignee?.accountId)?.emailAddress ?? null;
        let item: WorkItem | { error: string };
        try {
          item = jiraToCanonical(i, email);
        } catch (e) {
          item = { error: (e as Error).message };
        }
        return { key: i.key, labels: i.fields.labels, item };
      }),
    webhooks: () => ({ pending: jira.webhooks.pending, delivered: jira.webhooks.delivered, abandoned: jira.webhooks.abandoned }),
    apiCalls: () => jira.apiCalls,
    start: async () => {
      await jira.app.listen({ port: 4002, host: '127.0.0.1' });
      deliver = setInterval(() => void jira.webhooks.flush().catch(() => undefined), 300);
    },
    stop: async () => {
      clearInterval(deliver);
      await jira.app.close();
    },
  };
}

function realJiraSide(config: Config): DemoJira {
  const chaos = new Chaos(Date.now() & 0xffff);
  const base = fetchTransport(config.JIRA_BASE_URL, 'jira', config.HTTP_TIMEOUT_MS);
  // A second, chaos-free client plays "the engineers" and feeds the dashboard's Jira view.
  const clean = new JiraConnector(
    new ApiClient({
      system: 'jira',
      transport: base,
      clock: systemClock,
      metrics: new Metrics(),
      defaultHeaders: { authorization: 'Basic ' + Buffer.from(`${config.JIRA_EMAIL}:${config.JIRA_API_TOKEN}`).toString('base64') },
      ratePerSec: 3,
      burst: 6,
      maxInlineWaitMs: 3000,
    }),
    { projectKey: config.JIRA_PROJECT_KEY, issueType: config.JIRA_ISSUE_TYPE, statuses: config.jiraStatuses, userMap: config.jiraUserMap },
  );
  let cache: { at: number; rows: Awaited<ReturnType<DemoJira['list']>> } = { at: 0, rows: [] };
  return {
    mode: 'real',
    transport: chaosTransport(base, chaos, 'jira'),
    chaos,
    human: {
      setStatus: (k, s) => clean.update(k, { status: s }),
      setPriority: (k, p) => clean.update(k, { priority: p }),
      setAssignee: (k, e) => clean.update(k, { assigneeEmail: e }),
      setDueDate: (k, d) => clean.update(k, { dueDate: d }),
    },
    list: async () => {
      if (Date.now() - cache.at > 2_500) {
        const rows = await clean.listSynced().catch(() => null);
        if (rows) cache = { at: Date.now(), rows: rows.map((r) => ({ key: r.raw.key, labels: r.raw.fields.labels, item: r.snap.item })) };
      }
      return cache.rows;
    },
    webhooks: () => null,
    apiCalls: () => null,
    start: async () => {
      try {
        await clean.timeZone();
      } catch (e) {
        throw new Error(`cannot reach ${config.JIRA_BASE_URL}: ${(e as Error).message} — run \`npm run preflight\``);
      }
    },
    stop: async () => undefined,
  };
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
