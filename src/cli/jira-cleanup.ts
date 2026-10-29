/**
 * `npm run jira:cleanup [-- --yes]` — removes issues Tether created on a (demo) Jira site.
 * Only touches issues in JIRA_PROJECT_KEY that carry the `tether` label. Dry run unless --yes.
 */
import { loadConfig, loadDotEnv } from '../config.js';
import { systemClock } from '../core/clock.js';
import { JIRA_API } from '../core/vendor.js';
import { ApiClient } from '../connectors/http.js';
import { fetchTransport } from '../connectors/transport.js';
import { Metrics } from '../observability/metrics.js';

loadDotEnv();
const config = loadConfig();
const yes = process.argv.includes('--yes');
const api = new ApiClient({
  system: 'jira',
  transport: fetchTransport(config.JIRA_BASE_URL, 'jira', 15_000),
  clock: systemClock,
  metrics: new Metrics(),
  defaultHeaders: { authorization: 'Basic ' + Buffer.from(`${config.JIRA_EMAIL}:${config.JIRA_API_TOKEN}`).toString('base64') },
  ratePerSec: 4,
  burst: 4,
  maxInlineWaitMs: 5000,
});

const keys: string[] = [];
let token: string | undefined;
do {
  const res = await api.send<{ issues: { key: string; fields: { summary: string } }[]; nextPageToken?: string }>('cleanup', {
    method: 'POST',
    path: `${JIRA_API}/search/jql`,
    body: { jql: `project = "${config.JIRA_PROJECT_KEY}" AND labels = "tether" ORDER BY key ASC`, maxResults: 100, fields: ['summary'], ...(token ? { nextPageToken: token } : {}) },
  });
  for (const i of res.issues) {
    keys.push(i.key);
    console.log(`  ${i.key}  ${i.fields.summary}`);
  }
  token = res.nextPageToken;
} while (token);

if (!yes) {
  console.log(`\n${keys.length} Tether-created issue(s) in ${config.JIRA_PROJECT_KEY} on ${config.JIRA_BASE_URL}. Re-run with -- --yes to delete them.\n`);
  process.exit(0);
}
for (const k of keys) {
  await api.send('cleanup', { method: 'DELETE', path: `${JIRA_API}/issue/${k}` });
  console.log(`  deleted ${k}`);
}
console.log(`\nDeleted ${keys.length} issue(s).\n`);
