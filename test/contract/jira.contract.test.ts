import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, loadDotEnv } from '../../src/config.js';
import { systemClock } from '../../src/core/clock.js';
import type { Status, WorkItem } from '../../src/core/model.js';
import { ApiClient } from '../../src/connectors/http.js';
import { JiraConnector } from '../../src/connectors/jira.js';
import { fetchTransport, injectTransport, type Transport } from '../../src/connectors/transport.js';
import { JiraMock } from '../../src/mocks/jira.js';
import { Metrics } from '../../src/observability/metrics.js';

/**
 * Connector contract: the behaviour Tether relies on, asserted against
 *   - the mock (always, in `npm test`), and
 *   - a real Jira Cloud site (`npm run test:contract:real`, credentials from .env).
 * If both pass, the mock is a faithful stand-in for the parts that matter, which is what makes the
 * chaos simulation's results meaningful for the real system.
 */
const REAL = process.env.JIRA_CONTRACT === 'real';
if (REAL) loadDotEnv();
const config = loadConfig(REAL ? process.env : { JIRA_BASE_URL: 'http://jira.mock' });

let jira: JiraConnector;
let transport: Transport;

/** Real Jira's search index is eventually consistent: poll until `probe` is truthy. */
async function eventually<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs = REAL ? 30_000 : 1_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for Jira');
    await new Promise((r) => setTimeout(r, REAL ? 1000 : 10));
  }
}

beforeAll(() => {
  if (REAL) {
    transport = fetchTransport(config.JIRA_BASE_URL, 'jira', 15_000);
  } else {
    const mock = new JiraMock({ clock: systemClock, projectKey: config.JIRA_PROJECT_KEY, userTimeZone: 'America/New_York' });
    transport = injectTransport(mock.app, 'jira');
  }
  const api = new ApiClient({
    system: 'jira',
    transport,
    clock: systemClock,
    metrics: new Metrics(),
    defaultHeaders: { authorization: 'Basic ' + Buffer.from(`${config.JIRA_EMAIL}:${config.JIRA_API_TOKEN}`).toString('base64') },
    ratePerSec: REAL ? 4 : Infinity,
    burst: 8,
    maxInlineWaitMs: 5000,
  });
  jira = new JiraConnector(api, { projectKey: config.JIRA_PROJECT_KEY, issueType: config.JIRA_ISSUE_TYPE, statuses: config.jiraStatuses, userMap: config.jiraUserMap });
});

describe(`Jira connector contract (${REAL ? `REAL: ${config.JIRA_BASE_URL}` : 'mock'})`, () => {
  const marker = `wf-contract-${Date.now().toString(36)}`;
  const item: WorkItem = {
    title: 'Tether contract test — safe to delete',
    description: 'Line one\n\nLine three after an empty line',
    status: 'todo',
    dueDate: '2026-12-01',
    priority: 'high',
    assigneeEmail: null,
  };
  let key = '';

  it('reports the API user timezone used for JQL dates', async () => {
    expect(await jira.timeZone()).toMatch(/\w+/);
  });

  it('creates an issue that is then findable by its idempotency marker', async () => {
    key = await jira.create(marker, item);
    expect(key).toMatch(new RegExp(`^${config.JIRA_PROJECT_KEY}-\\d+$`));
    expect(await eventually(() => jira.findByMarker(marker))).toBe(key);
  }, 60_000);

  it('reads back exactly what was written (mapping is a fixed point on the real API)', async () => {
    const back = (await jira.getIssue(key)).snap.item;
    expect(back).toEqual(item);
  });

  it('updates fields and reads them back', async () => {
    const patch = { title: 'Contract test (edited)', description: 'Edited body', dueDate: '2026-12-24', priority: 'urgent' } as const;
    await jira.update(key, patch);
    expect((await jira.getIssue(key)).snap.item).toMatchObject(patch);
  }, 30_000);

  it.each(['in_progress', 'in_review', 'done', 'todo', 'done'] as Status[])('walks the workflow to %s', async (s) => {
    await jira.transitionTo(key, s);
    expect((await jira.getIssue(key)).snap.item.status).toBe(s);
  }, 30_000);

  it('finds the issue in the incremental, timezone-aware "updated since" search', async () => {
    const since = Date.now() - 10 * 60_000;
    const hits = await eventually(async () => (await jira.searchUpdatedSince(since)).filter((i) => i.key === key || i.id === key).length > 0 && true);
    expect(hits).toBe(true);
  }, 60_000);

  it('lists it among synced issues, fully mapped', async () => {
    const rows = await eventually(async () => (await jira.listSynced()).find((r) => r.raw.key === key));
    expect(rows.snap.item.title).toBe('Contract test (edited)');
  }, 60_000);

  it('can comment (used when a Workfront task is deleted)', async () => {
    await expect(jira.comment(key, 'Tether contract test comment')).resolves.toBeUndefined();
  });
});
