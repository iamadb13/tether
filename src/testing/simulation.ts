import { FIELDS, type Field } from '../core/model.js';
import { pick, seededRng } from '../core/rng.js';
import type { ChaosConfig } from '../mocks/chaos.js';
import type { Transport } from '../connectors/transport.js';
import { Harness } from './harness.js';
import type { Recorder } from './recorder.js';

/**
 * Randomised fault-injection simulation (in the spirit of deterministic simulation testing).
 *
 * Each seed builds a world where both vendors misbehave — 5xx errors, 429s with and without
 * Retry-After, responses lost *after* a write was committed, webhooks dropped / duplicated /
 * reordered — and the sync worker "crashes" mid-run. Random humans edit both systems while syncs
 * are half-way through. After every round the invariants that matter to the customer are checked:
 *
 *   1. Convergence      both systems hold the same value for every field not parked for a human
 *   2. No lost updates  every edit made in the round is what both systems ended up with
 *   3. No duplicates    exactly one Jira issue per synced Workfront task, ever
 *   4. No stuck work    the queue drains and nothing lands in the dead-letter queue
 *   5. Conflicts are    concurrent edits to `manual` fields reach the inbox and resolve cleanly
 *      surfaced, not
 *      silently lost
 *
 * Used by test/convergence.sim.test.ts (hundreds of seeds) and by `npm run replay` (one seed,
 * recorded and rendered as an interactive timeline).
 */
export const SIM_CHAOS: Partial<ChaosConfig> = {
  errorRate: 0.1,
  rateLimitRate: 0.05,
  lostResponseRate: 0.05,
  webhookDropRate: 0.25,
  webhookDupRate: 0.2,
  webhookReorder: true,
};

export interface SimulationOptions {
  seed: number;
  rounds?: number;
  opsPerRound?: number;
  initialTasks?: number;
  concurrentPerRound?: number;
  chaos?: Partial<ChaosConfig>;
  recorder?: Recorder;
  /** Called on a lost update with the audit trail, for debugging. */
  onLostUpdate?: (key: string, expected: unknown, h: Harness) => void;
}

export interface SimulationResult {
  violations: string[];
  stats: { ops: number; crashes: number; conflictsResolved: number; links: number; midSync: number };
  harness: Harness;
}

const WF_STATUS = ['NEW', 'INP', 'RVW', 'CPL'];
const JIRA_STATUS = ['To Do', 'In Progress', 'In Review', 'Done'];
const WF_USERS = ['u-ana', 'u-ben', 'u-chen', null];
const JIRA_USERS = ['557058:ana', '557058:ben', '557058:chen', null];
const JIRA_PRIO = ['Low', 'Medium', 'High', 'Highest'];

type Side = 'workfront' | 'jira';
/** Mirrors DEFAULT_POLICIES for the fields with a fixed owner. */
const DEFAULT_OWNER = { title: 'workfront', description: 'workfront', status: 'jira' } as const;

export async function runSimulation(o: SimulationOptions): Promise<SimulationResult> {
  const { seed, rounds = 4, opsPerRound = 25, initialTasks = 5, concurrentPerRound = 3, chaos = SIM_CHAOS, recorder } = o;
  const rng = seededRng(seed * 104729);

  // Mid-sync human edits: when armed, the next time Tether reads a linked task/issue, a human edits that
  // same item *right after the read* — i.e. while Tether is deciding what to write. This is the
  // read→write race that emulated compare-and-set (Syncer.verifyUnchanged) exists to close.
  let midSync: { fn: (wfId: string) => void; wfId?: string; sys?: Side } | null = null;
  let h!: Harness;
  const recOpts = recorder?.harnessOptions();
  const wrapTransport = (t: Transport, sys: 'workfront' | 'jira'): Transport => {
    const inner = recOpts?.wrapTransport ? recOpts.wrapTransport(t, sys) : t;
    return {
      request: async (req) => {
        const res = await inner.request(req);
        const m = req.method === 'GET' && res.status === 200 ? (sys === 'workfront' ? /\/task\/(wf-[\w-]+)$/ : /\/issue\/([A-Z]+-\d+)$/).exec(req.path) : null;
        if (midSync && m) {
          const wfId = sys === 'workfront' ? m[1]! : h.store.linkByJira(m[1]!)?.wfId;
          if (wfId && h.store.linkByWf(wfId)?.state === 'active' && (!midSync.wfId || midSync.wfId === wfId) && (!midSync.sys || midSync.sys === sys)) {
            const edit = midSync.fn;
            midSync = null;
            edit(wfId);
          }
        }
        return res;
      },
    };
  };
  h = new Harness({ seed, chaos, worker: { maxAttempts: 30, concurrency: 2 }, ...recOpts, wrapTransport });
  recorder?.attach(h);
  const stats = { ops: 0, crashes: 0, conflictsResolved: 0, links: 0, midSync: 0 };
  // Phase A bookkeeping: each (item, field) may be edited by one side only per round, so "no lost
  // updates" has an unambiguous expected value.
  let owner: Map<string, Side> | null = null;
  let touched = new Set<string>();
  function editRespectingOwner(wfId: string, tag: string, mid = false): void {
    const field = pick(rng, FIELDS);
    const k = `${wfId}/${field}`;
    const side = owner!.get(k) ?? (rng() < 0.5 ? 'workfront' : 'jira');
    owner!.set(k, side);
    touched.add(k);
    humanEdit(wfId, side, field, tag, mid);
  }
  const violations: string[] = [];
  const check = (ok: boolean, msg: string) => {
    if (!ok) violations.push(`seed ${seed}: ${msg}`);
    return ok;
  };
  const phase = (name: string) => recorder?.phase(name);

  /** Apply one random human edit to `field` on `side`. */
  function humanEdit(wfId: string, side: Side, field: Field, tag: string, mid = false): void {
    // A mid-sync edit must actually change the value, or there is no race to test.
    const current = side === 'workfront' ? h.wfItem(wfId)?.status : h.jiraFor(wfId)?.status;
    const CANON = ['todo', 'in_progress', 'in_review', 'done'];
    const pickStatus = (names: string[]) => (mid ? pick(rng, names.filter((_, i) => CANON[i] !== current)) : pick(rng, names));
    const date = `2026-${String(1 + Math.floor(rng() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rng() * 28)).padStart(2, '0')}`;
    if (side === 'workfront') {
      const patch = {
        title: { name: `WF ${tag}` },
        description: { description: `brief ${tag}\nline two` },
        status: { status: pickStatus(WF_STATUS) },
        dueDate: { plannedCompletionDate: rng() < 0.15 ? null : `${date}T17:00:00:000+0200` },
        priority: { priority: Math.floor(rng() * 5) },
        assigneeEmail: { assignedToID: pick(rng, WF_USERS) },
      }[field];
      recorder?.human('workfront', wfId, field, mid);
      h.wf.editTask(wfId, patch);
    } else {
      const key = h.store.linkByWf(wfId)!.jiraKey!;
      const patch = {
        title: { summary: `Jira ${tag}` },
        description: { description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: `spec ${tag}` }] }] } },
        status: { status: { name: pickStatus(JIRA_STATUS) } },
        dueDate: { duedate: rng() < 0.15 ? null : date },
        priority: { priority: { name: pick(rng, JIRA_PRIO) } },
        assigneeEmail: { assignee: (() => { const a = pick(rng, JIRA_USERS); return a ? { accountId: a } : null; })() },
      }[field];
      recorder?.human('jira', wfId, field, mid);
      h.jira.editIssue(key, patch as never);
    }
  }

  /** Do a little bit of the system's work, so edits interleave with half-finished syncs. */
  async function partialStep(): Promise<void> {
    const r = rng();
    h.clock.advance(Math.floor(rng() * 3_000));
    if (r < 0.25) await h.wf.webhooks.flush();
    else if (r < 0.5) await h.jira.webhooks.flush();
    else if (r < 0.75) {
      if (owner && rng() < 0.5) midSync = { fn: (wfId) => editRespectingOwner(wfId, `mid-${stats.midSync++}`, true) };
      await h.tether.worker.drain(1 + Math.floor(rng() * 3));
      midSync = null;
    }
    else if (r < 0.85) await h.tether.reconciler.runOnce().catch(() => undefined);
    else {
      // Simulated crash: a worker leases a job, its write is committed upstream but the response is
      // lost, and the process dies before recording anything. The lease must expire for recovery.
      const job = h.store.claim(h.clock.now(), h.tether.worker.opts.leaseMs);
      if (job) {
        stats.crashes++;
        recorder?.crash(job.entity.slice(3));
        h.jira.chaos.failNext('PUT', /\/issue\//, 'lost-response');
        await h.tether.syncer.sync(job.entity.slice(3), 'crash-sim').catch(() => undefined);
      }
    }
  }

  function checkNoDuplicates(when: string): boolean {
    const counts = new Map<string, number>();
    for (const i of h.jira.issues.values()) {
      for (const l of i.fields.labels) if (l.startsWith('tether-wf-')) counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    const dupes = [...counts].filter(([, n]) => n > 1);
    let ok = check(dupes.length === 0, `${when}: duplicate Jira issues ${JSON.stringify(dupes)}`);
    const flagged = [...h.wf.tasks.values()].filter((t) => t.parameterValues['DE:Sync to Jira'] === 'Yes');
    for (const t of flagged) ok = check(h.store.linkByWf(t.ID)?.state === 'active', `${when}: ${t.ID} not linked`) && ok;
    return check(h.jira.issues.size === flagged.length, `${when}: ${h.jira.issues.size} issues for ${flagged.length} tasks`) && ok;
  }

  async function settleUnderChaosThenRecover(): Promise<void> {
    phase('settle (chaos still on)');
    await h.settle(); // still under chaos: must make progress and not wedge
    h.calm(); // vendors recover
    phase('vendors recover');
    await h.settle();
    h.setChaos(chaos);
  }

  const verdict = (round: number, label: string, before: number) => recorder?.check(round, label, violations.length === before, violations.slice(before));

  const ids: string[] = [];
  phase(`setup: ${initialTasks} Workfront tasks flagged for Jira`);
  for (let i = 0; i < initialTasks; i++) ids.push(h.wf.createTask({ name: `Seed task ${i}`, assignedToID: 'u-ana' }).ID);
  await settleUnderChaosThenRecover();
  let before = violations.length;
  checkNoDuplicates('after seeding');
  verdict(0, 'all tasks linked, no duplicates', before);

  for (let round = 1; round <= rounds && violations.length === 0; round++) {
    // ---- Phase A: non-overlapping edits on both sides, interleaved with partial syncs.
    phase(`round ${round}: humans edit both sides while syncs run`);
    owner = new Map<string, Side>(); // `${wfId}/${field}` → the only side allowed to edit it
    touched = new Set<string>();
    for (let op = 0; op < opsPerRound; op++) {
      stats.ops++;
      if (rng() < 0.08) {
        const t = h.wf.createTask({ name: `Created r${round} op${op}`, priority: 3 });
        recorder?.human('workfront', t.ID, 'created');
        ids.push(t.ID);
        await partialStep();
        continue;
      }
      const linked = ids.filter((id) => h.store.linkByWf(id)?.state === 'active');
      if (linked.length === 0) continue;
      editRespectingOwner(pick(rng, linked), `r${round}-${op}`);
      if (rng() < 0.6) await partialStep();
    }
    // What each touched field must end up as: whatever its owner side holds right now.
    const expected = new Map<string, unknown>();
    for (const k of touched) {
      const [wfId, field] = k.split('/') as [string, Field];
      expected.set(k, owner.get(k) === 'workfront' ? h.wfItem(wfId)![field] : h.jiraFor(wfId)![field]);
    }
    owner = null; // no mid-sync edits while settling: the expected values are now fixed

    await settleUnderChaosThenRecover();

    before = violations.length;
    checkNoDuplicates(`round ${round}`);
    check(h.divergence().length === 0, `round ${round}: divergence ${JSON.stringify(h.divergence())}`);
    check(h.store.conflicts().length === 0, `round ${round}: unexpected conflicts`);
    for (const [k, v] of expected) {
      const [wfId, field] = k.split('/') as [string, Field];
      const okWf = check(h.wfItem(wfId)![field] === v, `round ${round}: lost update ${k} (wf): expected ${JSON.stringify(v)}, got ${JSON.stringify(h.wfItem(wfId)![field])}`);
      const okJ = check(h.jiraFor(wfId)![field] === v, `round ${round}: lost update ${k} (jira): expected ${JSON.stringify(v)}, got ${JSON.stringify(h.jiraFor(wfId)![field])}`);
      if (!(okWf && okJ)) o.onLostUpdate?.(k, v, h);
    }
    check(h.store.deadLetters().length === 0, `round ${round}: dead letters`);
    verdict(round, `converged · ${expected.size} edits kept · no duplicates · nothing stuck`, before);
    if (violations.length) break;

    // ---- Phase C: the read→write race. The losing side edits a field, so Tether wants to write it
    // into the winning side; a human on the winning side edits the same field right after Tether has
    // read it. Correct outcome: the winner's latest value everywhere. Without emulated compare-and-set
    // Tether would overwrite that fresh edit with the stale decision.
    phase(`round ${round}: humans edit while Tether is mid-sync (read→write race)`);
    const raceExpected = new Map<string, unknown>();
    for (const wfId of ids.filter((id) => h.store.linkByWf(id)?.state === 'active').slice(0, concurrentPerRound)) {
      const field = pick(rng, ['title', 'description', 'status'] as const); // owner-policy fields
      const winner: Side = DEFAULT_OWNER[field];
      const loser: Side = winner === 'workfront' ? 'jira' : 'workfront';
      humanEdit(wfId, loser, field, `race${round}l`);
      midSync = {
        wfId,
        sys: winner,
        fn: () => {
          stats.midSync++;
          humanEdit(wfId, winner, field, `race${round}w`, true);
          raceExpected.set(`${wfId}/${field}`, winner === 'workfront' ? h.wfItem(wfId)![field] : h.jiraFor(wfId)![field]);
        },
      };
      for (let k = 0; k < 20 && midSync; k++) {
        h.clock.advance(1_000);
        await h.wf.webhooks.flush();
        await h.jira.webhooks.flush();
        await h.tether.worker.drain(3);
        if (k === 10) await h.tether.reconciler.runOnce().catch(() => undefined);
      }
      midSync = null;
    }
    await settleUnderChaosThenRecover();
    before = violations.length;
    for (const [k, v] of raceExpected) {
      const [wfId, field] = k.split('/') as [string, Field];
      check(h.wfItem(wfId)![field] === v && h.jiraFor(wfId)![field] === v, `round ${round}: mid-sync edit lost on ${k}: expected ${JSON.stringify(v)}, got wf=${JSON.stringify(h.wfItem(wfId)![field])} jira=${JSON.stringify(h.jiraFor(wfId)![field])}`);
    }
    check(h.divergence().length === 0, `round ${round}: divergence after race`);
    verdict(round, `${raceExpected.size} edits made mid-sync, none overwritten`, before);
    if (violations.length) break;

    // ---- Phase B: truly concurrent edits to the same fields on both sides.
    phase(`round ${round}: concurrent edits to the same fields`);
    h.setChaos({ ...chaos, webhookDropRate: 1 }); // nobody syncs in between
    const victims = ids.filter((id) => h.store.linkByWf(id)?.state === 'active').slice(0, concurrentPerRound);
    for (const wfId of victims) {
      const field = pick(rng, FIELDS);
      humanEdit(wfId, 'workfront', field, `c${round}w`);
      humanEdit(wfId, 'jira', field, `c${round}j`);
    }
    h.setChaos(chaos);
    await settleUnderChaosThenRecover();
    before = violations.length;
    check(h.divergence().length === 0, `round ${round}: divergence after concurrent edits`);
    verdict(round, `concurrent edits resolved by policy · ${h.store.conflicts().length} sent to a human`, before);

    // Humans clear the inbox (manual-policy fields), then everything converges.
    phase(`round ${round}: a human clears the conflict inbox`);
    for (const c of h.store.conflicts()) {
      check(c.field === 'dueDate', `round ${round}: conflict on a non-manual field ${c.field}`);
      const choose = rng() < 0.5 ? 'workfront' : 'jira';
      recorder?.resolve(c.wfId, c.field, choose);
      const res = await h.tether.api.inject({
        method: 'POST',
        url: `/admin/conflicts/${c.id}/resolve`,
        headers: { authorization: 'Bearer admin' },
        payload: { choose },
      });
      check(res.statusCode === 200, `round ${round}: resolve returned ${res.statusCode}`);
      stats.conflictsResolved++;
    }
    await settleUnderChaosThenRecover();
    before = violations.length;
    check(h.store.conflicts().length === 0, `round ${round}: conflicts left`);
    check(h.divergence().length === 0, `round ${round}: divergence after resolution`);
    checkNoDuplicates(`round ${round} end`);
    verdict(round, 'inbox empty · both systems identical', before);
  }

  stats.links = h.store.links().length;
  return { violations, stats, harness: h };
}
