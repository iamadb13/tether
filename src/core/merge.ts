import { FIELDS, sameValue, type Field, type Snapshot, type System, type WorkItem } from './model.js';

/**
 * Field-level merge with per-side change detection.
 *
 * Per link we keep:
 *   target   – the state we want both systems to hold (after a fully successful run: what they hold)
 *   seen[S]  – the value we last *observed* in system S (recorded on every read, even if the run fails)
 *   own[S]   – values *we* wrote (or may have written) to S since the last fully successful run,
 *              including intermediate ones such as each hop of a multi-step Jira transition
 *
 * A system S changed field f iff  current ≠ seen[S][f]  and  current ∉ own[S][f].
 *
 * Why not a classic three-way merge against one shared base? The chaos simulation broke that
 * version twice:
 *   - ABA: a user changes a field and then changes it back to the base value while our write is in
 *     flight. Compared to the base, "nothing changed", so the interrupted write was finished and
 *     overwrote the user's latest choice. Comparing against the last *observed* value catches it.
 *   - Partial writes: a half-applied run leaves our own values (or intermediate workflow states)
 *     on one side. Without `own`, they look like fresh user edits and propagate back.
 *
 * Echo webhooks are free under this model: after a successful run current == seen == target on
 * both sides, so the plan is empty.
 */
export type Policy = 'workfront' | 'jira' | 'latest' | 'manual';
export type Policies = Record<Field, Policy>;

/** Per field: values we wrote or may have written to a system and must not mistake for user edits. */
export type Pending = Partial<Record<Field, unknown[]>>;

export type Decision =
  | { field: Field; kind: 'in_sync' }
  | { field: Field; kind: 'propagate'; from: System; value: unknown }
  | { field: Field; kind: 'resume'; value: unknown } // finishing a partially applied run
  | { field: Field; kind: 'resolved_by_policy'; policy: Policy; winner: System; value: unknown }
  | { field: Field; kind: 'resolved_by_human'; value: unknown }
  | { field: Field; kind: 'parked' } // open conflict, nothing new on either side
  | { field: Field; kind: 'conflict'; wf: unknown; jira: unknown; base: unknown };

export interface MergeInput {
  wf: Snapshot;
  jira: Snapshot;
  target: WorkItem;
  seen: { workfront: WorkItem; jira: WorkItem };
  own: { workfront: Pending; jira: Pending };
  policies: Policies;
  /**
   * Fields with an open conflict.
   *  sticky        – a genuine concurrent edit: stays in the inbox until both sides agree or a human decides
   *                  (a newer edit on one side must not silently discard the other side's pending claim)
   *  until_change  – could not be applied (e.g. unmapped user): re-evaluated as soon as either side changes
   */
  parked?: ReadonlyMap<Field, 'sticky' | 'until_change'>;
  /** Values chosen by a human in the conflict inbox, applied with highest precedence. */
  resolutions?: Partial<WorkItem>;
}

export interface MergePlan {
  /** The state both systems should end up in (conflicted fields keep their previous target). */
  target: WorkItem;
  writeWorkfront: Partial<WorkItem>;
  writeJira: Partial<WorkItem>;
  decisions: Decision[];
  conflicts: Extract<Decision, { kind: 'conflict' }>[];
  isNoop: boolean;
}

export function merge(input: MergeInput): MergePlan {
  const { wf, jira, seen, own, policies, parked = new Map(), resolutions = {} } = input;
  const target = { ...input.target } as Record<Field, unknown>;
  const writeWorkfront: Record<string, unknown> = {};
  const writeJira: Record<string, unknown> = {};
  const decisions: Decision[] = [];

  for (const f of FIELDS) {
    const a = wf.item[f];
    const j = jira.item[f];
    const changed = (v: unknown, s: System) => !sameValue(v, seen[s][f]) && !(own[s][f] ?? []).some((x) => sameValue(x, v));
    const changedA = changed(a, 'workfront');
    const changedJ = changed(j, 'jira');

    let value: unknown;
    let decision: Decision;

    if (f in resolutions) {
      value = resolutions[f];
      decision = { field: f, kind: 'resolved_by_human', value };
    } else if (sameValue(a, j)) {
      value = a;
      decision = { field: f, kind: 'in_sync' };
    } else if (parked.get(f) === 'sticky') {
      decisions.push({ field: f, kind: 'conflict', wf: a, jira: j, base: target[f] });
      continue;
    } else if (parked.get(f) === 'until_change' && !changedA && !changedJ) {
      decisions.push({ field: f, kind: 'parked' });
      continue;
    } else if (changedA && !changedJ) {
      value = a;
      decision = { field: f, kind: 'propagate', from: 'workfront', value };
    } else if (changedJ && !changedA) {
      value = j;
      decision = { field: f, kind: 'propagate', from: 'jira', value };
    } else if (!changedA && !changedJ) {
      // Neither side moved since we last looked, yet they differ: a previous run was interrupted.
      value = target[f];
      decision = { field: f, kind: 'resume', value };
    } else {
      const policy = policies[f];
      const winner = pickWinner(policy, wf, jira);
      if (winner === null) {
        decisions.push({ field: f, kind: 'conflict', wf: a, jira: j, base: target[f] });
        continue; // keep target[f], write nothing for this field
      }
      value = winner === 'workfront' ? a : j;
      decision = { field: f, kind: 'resolved_by_policy', policy, winner, value };
    }

    target[f] = value;
    if (!sameValue(a, value)) writeWorkfront[f] = value;
    if (!sameValue(j, value)) writeJira[f] = value;
    decisions.push(decision);
  }

  const conflicts = decisions.filter((d): d is Extract<Decision, { kind: 'conflict' }> => d.kind === 'conflict');
  return {
    target: target as unknown as WorkItem,
    writeWorkfront: writeWorkfront as Partial<WorkItem>,
    writeJira: writeJira as Partial<WorkItem>,
    decisions,
    conflicts,
    isNoop: Object.keys(writeWorkfront).length === 0 && Object.keys(writeJira).length === 0,
  };
}

function pickWinner(policy: Policy, wf: Snapshot, jira: Snapshot): System | null {
  switch (policy) {
    case 'workfront':
      return 'workfront';
    case 'jira':
      return 'jira';
    case 'latest':
      // Record-level last-writer-wins. Ties go to Workfront (the system of record for the plan).
      return jira.updatedAt > wf.updatedAt ? 'jira' : 'workfront';
    case 'manual':
      return null;
  }
}
