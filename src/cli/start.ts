/**
 * `npm start` — production entrypoint: talks to whatever WORKFRONT_BASE_URL / JIRA_BASE_URL point at
 * (configured via environment variables; see .env.example).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildTether } from '../app.js';
import { loadConfig, loadDotEnv } from '../config.js';
import { systemClock } from '../core/clock.js';
import { seededRng } from '../core/rng.js';
import { fetchTransport } from '../connectors/transport.js';
import { createLogger } from '../observability/logger.js';

loadDotEnv();
const config = loadConfig();
const logger = createLogger();
if (config.DB_PATH !== ':memory:') mkdirSync(dirname(config.DB_PATH), { recursive: true });

const tether = buildTether({
  config,
  clock: systemClock,
  rng: seededRng(Date.now() & 0xffff),
  logger,
  workfrontTransport: fetchTransport(config.WORKFRONT_BASE_URL, 'workfront', config.HTTP_TIMEOUT_MS),
  jiraTransport: fetchTransport(config.JIRA_BASE_URL, 'jira', config.HTTP_TIMEOUT_MS),
  defaultMetrics: true,
});

await tether.api.listen({ port: config.PORT, host: '0.0.0.0' });
tether.worker.start();
tether.reconciler.start(config.RECONCILE_INTERVAL_MS);
logger.info({ port: config.PORT, policies: config.policies, workfront: config.WORKFRONT_BASE_URL, jira: config.JIRA_BASE_URL }, 'tether started');

// Graceful shutdown: stop taking work, let in-flight syncs finish, then close. Anything not finished
// is still in the durable queue and resumes on the next start.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    logger.info({ sig }, 'shutting down');
    tether.reconciler.stop();
    await tether.worker.stop();
    await tether.api.close();
    tether.store.close();
    process.exit(0);
  });
}
