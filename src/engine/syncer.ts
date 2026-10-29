import { randomUUID } from 'node:crypto';
import type { Clock } from '../core/clock.js';
import { ConcurrentEditError, NotFoundError, NotYetError } from '../core/errors.js';
import { merge, type Decision, type MergePlan, type Policies } from '../core/merge.js';
import type { Field, WorkItem } from '../core/model.js';
import { JIRA_KEY_FIELD } from '../core/vendor.js';
import type { JiraConnector, JiraRecord } from '../connectors/jira.js';
import type { WfRecord, WorkfrontConnector } from '../connectors/workfront.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { AuditEntry, LinkRow, Store } from '../store/db.js';

export type SyncOutcome = 'applied' | 'noop' | 'conflict' | 'created' | 'tombstoned' | 'skipped' | 'dry_run';

export interface SyncResult {
  outcome: SyncOutcome;
  runId: string;
  plan?: MergePlan;
}

export interface SyncerDeps {
  store: Store;
  workfront: WorkfrontConnector;
  jira: JiraConnector;
  policies: Policies;
  clock: Clock;
  metrics: Metrics;
  logger: Logger;
  /** How long Jira's search index may trail a create (a negative marker search isn't trusted before that). */
  searchIndexLagMs?: number;
}

/**
 * State-based sync of one work item.
 *
 * Webhooks are treated as *hints* ("something about wf-0042 changed"), never as data. Every run
 * re-reads both systems and merges them using the per-link state described in core/merge.ts.
 * Consequences, all deliberate:
 *   - duplicate, late and out-of-order webhooks are harmless (the run reads current truth);
 *   - echoes of our own writes produce an empty plan (current == seen == target);
 *   - a crash or failure at any point is recovered by simply running again (idempotent), with the
 *     write-ahead `own` values telling the merge which values were our own partial writes.
 */
export class Syncer {
  constructor(private readonly d: SyncerDeps) {}

  /** `dryRun` computes the full plan (the drift report) without writing anything anywhere. */
  async sync(wfId: string, trigger = 'manual', dryRun = false): Promise<SyncResult> {
    const runId = randomUUID().slice(0, 8);
    const end = this.d.metrics.syncDuration.startTimer();
    const log = this.d.logger.child({ runId, wfId, trigger });
    try {
      const result = await this.run(wfId, runId, log, dryRun);
      this.d.metrics.syncRuns.inc({ outcome: result.outcome, trigger });
      log[result.outcome === 'noop' || result.outcome === 'skipped' ? 'debug' : 'info'](
        { outcome: result.outcome, jiraKey: this.d.store.linkByWf(wfId)?.jiraKey, ...(result.plan ? summarisePlan(result.plan) : {}) },
        `sync ${result.outcome}`,
      );
      return result;
    } catch (e) {
      log.warn({ err: { type: (e as Error).name, message: (e as Error).message } }, 'sync failed');
      throw e;
    } finally {
      end();
    }
  }

  private async run(wfId: string, runId: string, log: Logger, dry: boolean): Promise<SyncResult> {
    const { store, workfront } = this.d;
    let link = store.linkByWf(wfId);
    if (link?.state === 'tombstoned') return { outcome: 'skipped', runId };

    let wf: WfRecord;
    try {
      wf = await workfront.getTask(wfId);
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      if (link?.state !== 'active') return { outcome: 'skipped', runId };
      return this.tombstone(link, 'workfront task deleted', runId, log, true, dry);
    }

    if (!link || link.state === 'creating') {
      if (!wf.syncEnabled) return { outcome: 'skipped', runId };
      if (dry) return { outcome: 'dry_run', runId };
      await this.create(wf, runId, log);
      link = store.linkByWf(wfId)!;
      const after = await this.syncLinked(link, wf, runId, log, false);
      return { ...after, outcome: 'created' };
    }

    if (!wf.syncEnabled) return this.tombstone(link, 'sync disabled in workfront', runId, log, false, dry);
    return this.syncLinked(link, wf, runId, log, dry);
  }

  /**
   * Creation is the one place where a naive retry corrupts data: if Jira commits the create but the
   * response is lost, retrying creates a duplicate. Defence in depth:
   *   1. persist intent (`creating`) before calling Jira,
   *   2. tag the issue with an idempotency label derived from the Workfront id,
   *   3. on every (re)try, search for that label first and adopt an existing issue;
   *   4. never trust a negative search until Jira's search index has had time to catch up.
   * Both sides are then recorded as "last seen" holding what Jira *actually* holds after creation, so
   * every Workfront value Jira did not take (a non-default status, an assignee…) shows up as a
   * Workfront change and flows through the normal, retry-safe path.
   */
  private async create(wf: WfRecord, runId: string, log: Logger): Promise<void> {
    const { store, jira, clock } = this.d;
    const wfId = wf.raw.ID;
    const link = store.beginCreate(wfId, clock.now());
    let key = await jira.findByMarker(wfId);
    if (key) log.warn({ jiraKey: key }, 'adopting Jira issue from an earlier create whose response was lost');
    else {
      // A previous attempt may have created the issue moments ago, before the search index saw it.
      // Trusting "not found" now would create a duplicate, so wait out the index lag first.
      const lag = this.d.searchIndexLagMs ?? 15_000;
      const since = link.createAttemptedAt === null ? Infinity : clock.now() - link.createAttemptedAt;
      if (since < lag) throw new NotYetError('previous create attempt may not be searchable yet (Jira index lag)', 'jira', lag - since);
      store.markCreateAttempt(wfId, clock.now());
      key = await jira.create(wfId, wf.snap.item);
    }
    const created = await jira.getIssue(key);
    store.activate(wfId, key, created.snap.item, clock.now());
    store.audit([{ runId, wfId, jiraKey: key, target: 'link', field: '*', before: null, after: key, cause: 'created' }], clock.now());
    log.info({ jiraKey: key }, 'linked Workfront task to new Jira issue');
  }

  private async syncLinked(link: LinkRow, wf: WfRecord, runId: string, log: Logger, dry: boolean): Promise<SyncResult> {
    const { store, workfront, jira, clock, metrics, policies } = this.d;
    const key = link.jiraKey!;
    log = log.child({ jiraKey: key });

    let jr: JiraRecord;
    try {
      jr = await jira.getIssue(key);
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      return this.tombstone(link, 'jira issue deleted', runId, log, false, dry);
    }

    const open = store.conflictsForLink(link.id);
    const resolutions: Partial<Record<Field, unknown>> = {};
    const parked = new Map<Field, 'sticky' | 'until_change'>();
    for (const c of open) {
      if (c.status === 'resolving') resolutions[c.field] = c.resolution;
      else parked.set(c.field, c.reason === 'unmapped_user' ? 'until_change' : 'sticky');
    }

    const plan = merge({
      wf: wf.snap,
      jira: jr.snap,
      target: link.target!,
      seen: link.seen!,
      own: link.own,
      policies,
      parked,
      resolutions: resolutions as Partial<WorkItem>,
    });
    const now = clock.now();

    // Identity mapping: an assignee that exists on only one side can't be propagated. Park it (it is
    // re-evaluated as soon as either side changes) and keep the previous target for the field.
    const unmapped: Field[] = [];
    if (plan.writeJira.assigneeEmail && !(await jira.resolveAccountId(plan.writeJira.assigneeEmail))) unmapped.push('assigneeEmail');
    if (plan.writeWorkfront.assigneeEmail && !(await workfront.resolveUserId(plan.writeWorkfront.assigneeEmail))) unmapped.push('assigneeEmail');
    for (const f of new Set(unmapped)) {
      delete plan.writeJira[f];
      delete plan.writeWorkfront[f];
      (plan.target as unknown as Record<Field, unknown>)[f] = link.target![f];
      plan.decisions = plan.decisions.filter((x) => x.field !== f);
      const c = { field: f, kind: 'conflict', wf: wf.snap.item[f], jira: jr.snap.item[f], base: link.target![f] } as const;
      plan.decisions.push(c);
      plan.conflicts.push(c);
      plan.isNoop = Object.keys(plan.writeJira).length + Object.keys(plan.writeWorkfront).length === 0;
    }

    if (dry) return { outcome: 'dry_run', runId, plan };

    for (const c of plan.conflicts) {
      const reason = unmapped.includes(c.field) ? 'unmapped_user' : 'concurrent_edit';
      if (store.upsertConflict(link.id, c.field, reason, c.wf, c.jira, c.base, now)) {
        metrics.conflicts.inc({ field: c.field, resolution: reason === 'unmapped_user' ? 'unmapped' : 'manual' });
        log.warn({ field: c.field, wf: c.wf, jira: c.jira, reason }, 'conflict needs a human decision');
      }
    }
    for (const x of plan.decisions) {
      if (x.kind === 'resolved_by_policy') metrics.conflicts.inc({ field: x.field, resolution: x.policy });
    }
    // Fields that now agree, or were decided, close any open conflict on them.
    const settled = new Set(plan.decisions.filter((x) => x.kind !== 'conflict' && x.kind !== 'parked').map((x) => x.field));
    const closeable = open.filter((c) => settled.has(c.field)).map((c) => c.field);

    // Persist observations + intent *before* writing. From here on any failure is retried by the
    // queue, and the next run's merge recognises our half-applied writes via `own`.
    const observed = { workfront: wf.snap.item, jira: jr.snap.item };
    store.recordRun(link.id, { target: plan.target, seen: observed, intent: { workfront: plan.writeWorkfront, jira: plan.writeJira } }, now);

    // Self-heal the click-through link field in Workfront.
    if (wf.raw.parameterValues[JIRA_KEY_FIELD] !== key) await workfront.setJiraKey(wf.raw.ID, key);

    // Compare-and-set, emulated: neither API supports If-Match, so re-read the fields we are about to
    // overwrite and abort if a human changed them since we decided. This shrinks the lost-update window
    // from the whole read→merge→write cycle to the single round-trip between this check and the PUT.
    if (Object.keys(plan.writeWorkfront).length) {
      await this.verifyUnchanged('workfront', wf.snap.item, plan.writeWorkfront, async () => (await workfront.getTask(wf.raw.ID)).snap.item);
      await workfront.update(wf.raw.ID, plan.writeWorkfront);
    }
    if (Object.keys(plan.writeJira).length) {
      await this.verifyUnchanged('jira', jr.snap.item, plan.writeJira, async () => (await jira.getIssue(key)).snap.item);
      // Multi-hop workflow transitions leave intermediate statuses behind if interrupted; record
      // each hop as ours *before* making it, so a retry doesn't mistake it for an engineer's move.
      await jira.update(key, plan.writeJira, (s) => store.addOwn(link.id, 'jira', 'status', s, clock.now()));
    }

    const audit: AuditEntry[] = [];
    for (const [target, writes, current] of [
      ['workfront', plan.writeWorkfront, wf.snap.item],
      ['jira', plan.writeJira, jr.snap.item],
    ] as const) {
      for (const [f, v] of Object.entries(writes)) {
        metrics.fieldWrites.inc({ target, field: f });
        audit.push({ runId, wfId: wf.raw.ID, jiraKey: key, target, field: f, before: current[f as Field], after: v, cause: causeOf(plan.decisions, f as Field) });
      }
    }
    store.tx(() => {
      store.commit(
        link.id,
        plan.target,
        { workfront: { ...wf.snap.item, ...plan.writeWorkfront }, jira: { ...jr.snap.item, ...plan.writeJira } },
        clock.now(),
      );
      store.closeConflicts(link.id, closeable, clock.now());
      store.audit(audit, clock.now());
    });
    if (plan.conflicts.length) return { outcome: 'conflict', runId, plan };
    return { outcome: plan.isNoop ? 'noop' : 'applied', runId, plan };
  }

  private async verifyUnchanged(system: string, observed: WorkItem, writes: Partial<WorkItem>, reread: () => Promise<WorkItem>): Promise<void> {
    const fresh = await reread();
    const moved = (Object.keys(writes) as Field[]).filter((f) => fresh[f] !== observed[f]);
    if (moved.length) {
      this.d.metrics.concurrentEdits.inc({ system });
      throw new ConcurrentEditError(system, moved);
    }
  }

  /** Never hard-delete downstream: stop syncing, leave a trail, let a human decide. */
  private async tombstone(link: LinkRow, reason: string, runId: string, log: Logger, notifyJira: boolean, dry: boolean): Promise<SyncResult> {
    const { store, jira, clock } = this.d;
    if (dry) return { outcome: 'dry_run', runId };
    if (notifyJira && link.jiraKey) {
      try {
        await jira.comment(link.jiraKey, `Tether: the linked Workfront task ${link.wfId} was deleted. Sync for this issue has stopped; this issue was left untouched.`);
      } catch (e) {
        if (!(e instanceof NotFoundError)) throw e;
      }
    }
    store.tombstone(link.id, reason, clock.now());
    store.audit([{ runId, wfId: link.wfId, jiraKey: link.jiraKey, target: 'link', field: '*', before: 'active', after: 'tombstoned', cause: reason }], clock.now());
    log.warn({ reason }, 'link tombstoned');
    return { outcome: 'tombstoned', runId };
  }
}

function causeOf(decisions: Decision[], f: Field): string {
  const d = decisions.find((x) => x.field === f);
  if (!d) return 'unknown';
  if (d.kind === 'propagate') return `propagate:${d.from}`;
  if (d.kind === 'resolved_by_policy') return `policy:${d.policy}:${d.winner}`;
  return d.kind;
}

function summarisePlan(plan: MergePlan) {
  return {
    toWorkfront: Object.keys(plan.writeWorkfront),
    toJira: Object.keys(plan.writeJira),
    conflicts: plan.conflicts.map((c) => c.field),
  };
}
