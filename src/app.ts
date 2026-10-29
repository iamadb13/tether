import type { FastifyInstance } from 'fastify';
import { buildApi, type ApiDeps } from './api/server.js';
import type { Config } from './config.js';
import type { Clock } from './core/clock.js';
import type { Rng } from './core/rng.js';
import { ApiClient } from './connectors/http.js';
import { JiraConnector } from './connectors/jira.js';
import type { Transport } from './connectors/transport.js';
import { WorkfrontConnector } from './connectors/workfront.js';
import { Reconciler } from './engine/reconciler.js';
import { Syncer } from './engine/syncer.js';
import { DEFAULT_WORKER, Worker, type WorkerOptions } from './engine/worker.js';
import type { Logger } from './observability/logger.js';
import { Metrics } from './observability/metrics.js';
import { Store } from './store/db.js';

export interface TetherDeps {
  config: Config;
  clock: Clock;
  rng: Rng;
  logger: Logger;
  workfrontTransport: Transport;
  jiraTransport: Transport;
  store?: Store;
  worker?: Partial<WorkerOptions>;
  /** Max ms the token bucket may sleep inline; 0 in simulations (virtual time). */
  maxInlineWaitMs?: number;
  demo?: ApiDeps['demo'];
  defaultMetrics?: boolean;
}

export interface Tether {
  connectors: { workfront: WorkfrontConnector; jira: JiraConnector };
  store: Store;
  metrics: Metrics;
  syncer: Syncer;
  worker: Worker;
  reconciler: Reconciler;
  api: FastifyInstance;
  clients: { workfront: ApiClient; jira: ApiClient };
}

/** Composition root: the only place that knows how the pieces fit together. */
export function buildTether(d: TetherDeps): Tether {
  const { config, clock, logger } = d;
  const metrics = new Metrics(d.defaultMetrics);
  const store = d.store ?? new Store(config.DB_PATH);

  const wfClient = new ApiClient({
    system: 'workfront',
    transport: d.workfrontTransport,
    clock,
    metrics,
    defaultHeaders: { apikey: config.WORKFRONT_API_KEY },
    ratePerSec: config.WORKFRONT_RPS,
    burst: Math.max(1, config.WORKFRONT_RPS * 2),
    maxInlineWaitMs: d.maxInlineWaitMs ?? 1000,
  });
  const jiraClient = new ApiClient({
    system: 'jira',
    transport: d.jiraTransport,
    clock,
    metrics,
    defaultHeaders: { authorization: 'Basic ' + Buffer.from(`${config.JIRA_EMAIL}:${config.JIRA_API_TOKEN}`).toString('base64') },
    ratePerSec: config.JIRA_RPS,
    burst: Math.max(1, config.JIRA_RPS * 2),
    maxInlineWaitMs: d.maxInlineWaitMs ?? 1000,
  });

  const workfront = new WorkfrontConnector(wfClient, { timeZone: config.TIMEZONE });
  const jira = new JiraConnector(jiraClient, {
    projectKey: config.JIRA_PROJECT_KEY,
    issueType: config.JIRA_ISSUE_TYPE,
    statuses: config.jiraStatuses,
    userMap: config.jiraUserMap,
  });
  const syncer = new Syncer({ store, workfront, jira, policies: config.policies, clock, metrics, logger, searchIndexLagMs: config.JIRA_INDEX_LAG_MS });
  const worker = new Worker(store, syncer, clock, metrics, logger.child({ component: 'worker' }), d.rng, {
    ...DEFAULT_WORKER,
    concurrency: config.WORKER_CONCURRENCY,
    maxAttempts: config.MAX_ATTEMPTS,
    ...d.worker,
  });
  const reconciler = new Reconciler(store, workfront, jira, clock, logger.child({ component: 'reconciler' }), metrics);

  const api = buildApi({
    store,
    syncer,
    worker,
    reconciler,
    metrics,
    clock,
    logger,
    secrets: { workfrontToken: config.WORKFRONT_WEBHOOK_TOKEN, jiraSecret: config.JIRA_WEBHOOK_SECRET, adminToken: config.ADMIN_TOKEN },
    breakers: () => ({ workfront: wfClient.breaker.state, jira: jiraClient.breaker.state }),
    demo: d.demo,
  });

  return { store, metrics, syncer, worker, reconciler, api, clients: { workfront: wfClient, jira: jiraClient }, connectors: { workfront, jira } };
}
