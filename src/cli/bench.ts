/**
 * `npm run bench` — measures the engine's own cost and API-call budget, in-process (no network),
 * so vendor latency is excluded and the numbers isolate what Tether itself contributes.
 *
 *   phase 1  initial load: N new Workfront tasks → N Jira issues
 *   phase 2  steady state: 1 field edit per item, on alternating sides
 *   phase 3  echo storm: every item re-notified 3× with nothing changed
 */
import { Harness } from '../testing/harness.js';

const N = Number(process.env.BENCH_N ?? 1000);

async function phase(h: Harness, name: string, act: () => void | Promise<void>) {
  const before = { wfR: h.wf.apiCalls.reads, wfW: h.wf.apiCalls.writes, jR: h.jira.apiCalls.reads, jW: h.jira.apiCalls.writes };
  const t0 = performance.now();
  await act();
  await h.settle({ reconcile: false });
  const ms = performance.now() - t0;
  const calls = {
    reads: h.wf.apiCalls.reads - before.wfR + (h.jira.apiCalls.reads - before.jR),
    writes: h.wf.apiCalls.writes - before.wfW + (h.jira.apiCalls.writes - before.jW),
  };
  console.log(
    `${name.padEnd(40)} ${ms.toFixed(0).padStart(6)} ms   ${((N / ms) * 1000).toFixed(0).padStart(5)} items/s   ` +
      `API calls/item: ${(calls.reads / N).toFixed(2)} reads, ${(calls.writes / N).toFixed(2)} writes`,
  );
}

const h = new Harness({ worker: { concurrency: 8 } });
console.log(`\nTether engine benchmark — ${N} work items, in-process mocks, no chaos\n`);

const ids: string[] = [];
await phase(h, '1. initial load (create + link)', () => {
  for (let i = 0; i < N; i++) ids.push(h.wf.createTask({ name: `Item ${i}`, priority: 2, assignedToID: 'u-ben' }).ID);
});
await phase(h, '2. one edit per item, both sides', () => {
  ids.forEach((id, i) => {
    if (i % 2) h.wf.editTask(id, { name: `Item ${i} (edited in WF)` });
    else h.jira.editIssue(h.store.linkByWf(id)!.jiraKey!, { priority: { name: 'High' } });
  });
});
await phase(h, '3. echo storm (3 events/item, no-op)', () => {
  for (let k = 0; k < 3; k++) for (const id of ids) h.store.enqueue(`wf:${id}`, 'webhook', h.clock.now());
});

const runs = await h.tether.metrics.syncRuns.get();
console.log('\nsync outcomes:', Object.fromEntries(runs.values.map((v) => [`${v.labels.outcome}/${v.labels.trigger}`, v.value])));
console.log(`divergent fields after run: ${h.divergence().length}\n`);
