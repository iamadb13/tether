/**
 * `npm run preflight [-- --deep]` — validates a real Jira Cloud site against Tether's configuration
 * *before* any sync runs, and says exactly how to fix what's wrong. This is the first thing to run on a
 * new customer tenant.
 *
 *   default  read-only: auth, timezone, project, issue type, create-screen fields, statuses, priorities, users
 *   --deep   also creates one scratch issue (label `tether-preflight`), round-trips every mapped field,
 *            walks the workflow through every mapped status, and MEASURES search-index lag
 */
import { loadConfig, loadDotEnv } from '../config.js';
import { systemClock } from '../core/clock.js';
import type { WorkItem } from '../core/model.js';
import { JIRA_API } from '../core/vendor.js';
import { ApiClient } from '../connectors/http.js';
import { JiraConnector } from '../connectors/jira.js';
import { fetchTransport } from '../connectors/transport.js';
import { Metrics } from '../observability/metrics.js';

loadDotEnv();
const config = loadConfig();
const deep = process.argv.includes('--deep');

type Result = { ok: boolean | 'warn'; check: string; detail: string; fix?: string };
const results: Result[] = [];
const report = (ok: Result['ok'], check: string, detail: string, fix?: string) => {
  results.push({ ok, check, detail, fix });
  const icon = ok === true ? '\x1b[32m✓\x1b[0m' : ok === 'warn' ? '\x1b[33m!\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${icon} ${check.padEnd(26)} ${detail}`);
  if (fix && ok !== true) console.log(`    ${' '.repeat(26)} \x1b[2m→ ${fix}\x1b[0m`);
};

const api = new ApiClient({
  system: 'jira',
  transport: fetchTransport(config.JIRA_BASE_URL, 'jira', config.HTTP_TIMEOUT_MS),
  clock: systemClock,
  metrics: new Metrics(),
  defaultHeaders: { authorization: 'Basic ' + Buffer.from(`${config.JIRA_EMAIL}:${config.JIRA_API_TOKEN}`).toString('base64') },
  ratePerSec: 5,
  burst: 5,
  maxInlineWaitMs: 2000,
});
const get = <T>(path: string, query?: Record<string, string>) => api.send<T>('preflight', { method: 'GET', path: `${JIRA_API}${path}`, query });
const key = config.JIRA_PROJECT_KEY;

console.log(`\nTether preflight → ${config.JIRA_BASE_URL}  (project ${key}, issue type ${config.JIRA_ISSUE_TYPE})\n`);

async function main(): Promise<void> {
  // 1. auth + timezone
  let me: { accountId: string; displayName: string; emailAddress?: string; timeZone?: string };
  try {
    me = await get('/myself');
    report(true, 'authentication', `as ${me.displayName} (${me.accountId})`);
  } catch (e) {
    report(false, 'authentication', (e as Error).message, 'check JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in .env');
    return;
  }
  report(true, 'JQL timezone', `${me.timeZone ?? 'UTC'} — reconciler formats JQL dates in this zone`);
  report(
    me.emailAddress ? true : 'warn',
    'e-mail visibility',
    me.emailAddress ? `own e-mail visible (${me.emailAddress})` : 'e-mail addresses are hidden by profile visibility',
    'set JIRA_USER_MAP=email=accountId,... for people whose e-mail is hidden',
  );

  // 2. project
  let project: { id: string; name: string; style?: string; simplified?: boolean };
  try {
    project = await get(`/project/${encodeURIComponent(key)}`);
    report(true, 'project', `${project.name} (${project.simplified || project.style === 'next-gen' ? 'team-managed' : 'company-managed'})`);
  } catch (e) {
    report(false, 'project', (e as Error).message, `create a project with key ${key}, or set JIRA_PROJECT_KEY`);
    return;
  }

  // 3. issue type + create-screen fields
  const types = await get<{ issueTypes?: { id: string; name: string }[]; values?: { id: string; name: string }[] }>(
    `/issue/createmeta/${encodeURIComponent(key)}/issuetypes`,
  );
  const typeList = types.issueTypes ?? types.values ?? [];
  const type = typeList.find((t) => t.name.toLowerCase() === config.JIRA_ISSUE_TYPE.toLowerCase());
  if (!type) {
    report(false, 'issue type', `'${config.JIRA_ISSUE_TYPE}' not available (have: ${typeList.map((t) => t.name).join(', ')})`, 'set JIRA_ISSUE_TYPE');
    return;
  }
  report(true, 'issue type', `${type.name} (id ${type.id})`);
  const meta = await get<{ fields?: { fieldId: string }[]; values?: { fieldId: string }[] }>(
    `/issue/createmeta/${encodeURIComponent(key)}/issuetypes/${type.id}`,
    { maxResults: '200' },
  );
  const fieldIds = new Set((meta.fields ?? meta.values ?? []).map((f) => f.fieldId));
  const needed: [string, string, boolean][] = [
    ['summary', 'title', true],
    ['description', 'description', true],
    ['labels', 'idempotency marker', true],
    ['duedate', 'due date', true],
    ['priority', 'priority', true],
    ['assignee', 'assignee', false],
  ];
  for (const [id, what, required] of needed) {
    const has = fieldIds.has(id);
    report(
      has ? true : required ? false : 'warn',
      `field: ${id}`,
      has ? `on the create screen (${what})` : `missing from the ${type.name} create screen`,
      project.simplified
        ? `Project settings → Issue types → ${type.name} → add the "${id === 'duedate' ? 'Due date' : id}" field`
        : `add "${id}" to the create/edit screens of ${type.name}`,
    );
  }

  // 4. statuses
  const st = await get<{ name: string; statuses: { name: string; statusCategory?: { key: string } }[] }[]>(`/project/${encodeURIComponent(key)}/statuses`);
  const names = (st.find((s) => s.name.toLowerCase() === type.name.toLowerCase()) ?? st[0])?.statuses.map((s) => s.name) ?? [];
  const lower = new Set(names.map((n) => n.toLowerCase()));
  for (const [canonical, name] of Object.entries(config.jiraStatuses)) {
    report(
      lower.has(name.toLowerCase()),
      `status: ${canonical}`,
      lower.has(name.toLowerCase()) ? `→ "${name}"` : `"${name}" does not exist (have: ${names.join(', ')})`,
      `add a board column / status named "${name}", or map it: JIRA_STATUSES=${canonical}=<existing status>,...`,
    );
  }
  const mapped = new Set(Object.values(config.jiraStatuses).map((n) => n.toLowerCase()));
  const unmapped = names.filter((n) => !mapped.has(n.toLowerCase()));
  if (unmapped.length) report('warn', 'unmapped statuses', unmapped.join(', '), 'issues moved there will dead-letter with a clear reason; map them in JIRA_STATUSES');

  // 5. priorities
  const prios = await get<{ values?: { name: string }[] } | { name: string }[]>('/priority/search', { maxResults: '50' }).catch(() => get<{ name: string }[]>('/priority'));
  const prioNames = new Set((Array.isArray(prios) ? prios : (prios.values ?? [])).map((p) => p.name));
  const missingPrio = ['Low', 'Medium', 'High', 'Highest'].filter((p) => !prioNames.has(p));
  report(missingPrio.length === 0, 'priorities', missingPrio.length ? `missing ${missingPrio.join(', ')}` : 'Low / Medium / High / Highest available', 'use the default priority scheme, or extend the priority mapping');

  // 6. people
  const jira = new JiraConnector(api, { projectKey: key, issueType: config.JIRA_ISSUE_TYPE, statuses: config.jiraStatuses, userMap: config.jiraUserMap });
  const emails = [...new Set([...Object.keys(config.jiraUserMap), ...(me.emailAddress ? [me.emailAddress] : [])])];
  for (const email of emails) {
    const id = await jira.resolveAccountId(email);
    report(id ? true : 'warn', `user: ${email}`, id ? `→ ${id}` : 'not found', 'add to JIRA_USER_MAP, or they will be parked in the conflict inbox');
  }

  // 7. webhooks vs polling
  report(
    'warn',
    'change notifications',
    `polling via reconciler every ${config.RECONCILE_INTERVAL_MS / 1000}s (Jira can't reach localhost)`,
    'for push: expose /webhooks/jira (e.g. a tunnel) and add a webhook with secret JIRA_WEBHOOK_SECRET under Settings → System → WebHooks',
  );

  if (deep) await deepCheck(jira);
}

/** Live round-trip on one scratch issue. Leaves it in Done with label `tether-preflight`. */
async function deepCheck(jira: JiraConnector): Promise<void> {
  console.log('\n  Deep check (creates one scratch issue)…');
  const marker = `wf-preflight-${Date.now().toString(36)}`;
  const item: WorkItem = {
    title: 'Tether preflight — safe to delete',
    description: 'Created by `npm run preflight -- --deep`.\nLine two survives the ADF round-trip.',
    status: 'todo',
    dueDate: '2026-12-01',
    priority: 'high',
    assigneeEmail: null,
  };
  const t0 = Date.now();
  let issueKey: string;
  try {
    issueKey = await jira.create(marker, item);
    report(true, 'create', `${issueKey} in ${Date.now() - t0} ms`);
  } catch (e) {
    report(false, 'create', (e as Error).message, 'fix the field errors above first');
    return;
  }

  // Measure how long until the new issue is searchable by its marker label.
  const tIndex = Date.now();
  let found: string | null = null;
  while (!found && Date.now() - tIndex < 60_000) {
    found = await jira.findByMarker(marker);
    if (!found) await new Promise((r) => setTimeout(r, 500));
  }
  const lag = Date.now() - tIndex;
  report(
    found ? (lag * 3 <= config.JIRA_INDEX_LAG_MS ? true : 'warn') : false,
    'search index lag',
    found ? `issue searchable after ~${lag} ms (guard: JIRA_INDEX_LAG_MS=${config.JIRA_INDEX_LAG_MS})` : 'not searchable after 60 s',
    `set JIRA_INDEX_LAG_MS to at least ${Math.max(5000, lag * 3)}`,
  );

  const back = (await jira.getIssue(issueKey)).snap.item;
  const fields = ['title', 'description', 'dueDate', 'priority'] as const;
  const bad = fields.filter((f) => back[f] !== item[f]);
  report(bad.length === 0, 'field round-trip', bad.length ? `changed: ${bad.map((f) => `${f}=${JSON.stringify(back[f])}`).join(', ')}` : 'title, description (ADF), due date, priority identical');

  for (const s of ['in_progress', 'in_review', 'done', 'todo', 'done'] as const) {
    try {
      const hops: string[] = [];
      await jira.transitionTo(issueKey, s, (h) => hops.push(h));
      report(true, `workflow → ${s}`, hops.length ? `via ${hops.join(' → ')}` : 'direct');
    } catch (e) {
      report(false, `workflow → ${s}`, (e as Error).message, 'make the target status reachable from the others');
    }
  }
  try {
    await api.send('preflight', { method: 'PUT', path: `${JIRA_API}/issue/${issueKey}`, body: { update: { labels: [{ add: 'tether-preflight' }] } } });
  } catch {
    /* label is cosmetic */
  }
  console.log(`\n  Scratch issue ${issueKey} left in Done (label tether-preflight) — delete it whenever you like.`);
}

await main().catch((e) => report(false, 'unexpected error', (e as Error).message));
const failed = results.filter((r) => r.ok === false).length;
const warned = results.filter((r) => r.ok === 'warn').length;
console.log(`\n${failed ? `\x1b[31m${failed} problem(s)\x1b[0m` : '\x1b[32mReady to sync.\x1b[0m'}${warned ? `  ${warned} warning(s).` : ''}\n`);
process.exit(failed ? 1 : 0);
