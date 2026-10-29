/**
 * `npm run drift` — prints the dry-run drift report of a running Tether: every field that would be
 * written, and every conflict, if sync ran right now. Writes nothing.
 */
const url = process.env.TETHER_URL ?? 'http://127.0.0.1:4000';
const token = process.env.ADMIN_TOKEN ?? 'admin';

type Report = {
  checked: number;
  drifted: number;
  report: { wfId: string; jiraKey: string; toWorkfront?: object; toJira?: object; conflicts?: { field: string; wf: unknown; jira: unknown }[]; error?: string }[];
};

const res = await fetch(`${url}/admin/drift`, { headers: { authorization: `Bearer ${token}` } });
if (!res.ok) {
  console.error(`drift report failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const r = (await res.json()) as Report;
console.log(`\nChecked ${r.checked} linked items — ${r.drifted} would change.\n`);
const rows: string[][] = [];
for (const d of r.report) {
  if (d.error) rows.push([d.wfId, d.jiraKey, 'error', d.error]);
  for (const [f, v] of Object.entries(d.toJira ?? {})) rows.push([d.wfId, d.jiraKey, `→ Jira.${f}`, JSON.stringify(v)]);
  for (const [f, v] of Object.entries(d.toWorkfront ?? {})) rows.push([d.wfId, d.jiraKey, `→ Workfront.${f}`, JSON.stringify(v)]);
  for (const c of d.conflicts ?? []) rows.push([d.wfId, d.jiraKey, `⚠ conflict.${c.field}`, `WF ${JSON.stringify(c.wf)} vs Jira ${JSON.stringify(c.jira)}`]);
}
if (rows.length) {
  const w = [0, 1, 2].map((i) => Math.max(...rows.map((x) => x[i]!.length)));
  for (const x of rows) console.log(`  ${x[0]!.padEnd(w[0]!)}  ${x[1]!.padEnd(w[1]!)}  ${x[2]!.padEnd(w[2]!)}  ${x[3]}`);
  console.log();
}
