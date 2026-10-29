import { describe, expect, it } from 'vitest';
import { merge, type MergeInput, type Policies } from '../src/core/merge.js';
import type { WorkItem } from '../src/core/model.js';

const base: WorkItem = {
  title: 'Launch page',
  description: 'brief',
  status: 'todo',
  dueDate: '2026-11-20',
  priority: 'medium',
  assigneeEmail: 'ben@brand.example',
};
const policies: Policies = { title: 'workfront', description: 'workfront', status: 'jira', dueDate: 'manual', priority: 'latest', assigneeEmail: 'latest' };
const snap = (patch: Partial<WorkItem>, updatedAt = 1) => ({ item: { ...base, ...patch }, updatedAt });

/** A link after a clean sync: both sides last seen at `base`, nothing of ours in flight. */
function run(wf: Partial<WorkItem>, jira: Partial<WorkItem>, extra: Partial<MergeInput> = {}) {
  return merge({
    wf: snap(wf),
    jira: snap(jira),
    target: base,
    seen: { workfront: base, jira: base },
    own: { workfront: {}, jira: {} },
    policies,
    ...extra,
  });
}

describe('merge: the basics', () => {
  it('no changes → no-op (this is also why echo webhooks are free)', () => {
    const p = run({}, {});
    expect(p.isNoop).toBe(true);
    expect(p.target).toEqual(base);
  });

  it('one-sided change propagates to the other side only', () => {
    const p = run({ title: 'New' }, {});
    expect(p.writeJira).toEqual({ title: 'New' });
    expect(p.writeWorkfront).toEqual({});
  });

  it('different fields changed on each side are merged, not overwritten', () => {
    const p = run({ title: 'New' }, { status: 'in_progress' });
    expect(p.writeJira).toEqual({ title: 'New' });
    expect(p.writeWorkfront).toEqual({ status: 'in_progress' });
    expect(p.conflicts).toEqual([]);
  });

  it('both sides changed to the same value → not a conflict', () => {
    const p = run({ dueDate: '2026-12-01' }, { dueDate: '2026-12-01' });
    expect(p.isNoop).toBe(true);
    expect(p.target.dueDate).toBe('2026-12-01');
  });
});

describe('merge: conflict policies', () => {
  it.each([
    ['title', 'WF title', 'J title', 'WF title'], // workfront owns the brief
    ['status', 'done', 'in_review', 'in_review'], // jira owns delivery progress
  ] as const)('true conflict on %s resolved by the owner policy', (field, a, j, expected) => {
    const p = run({ [field]: a }, { [field]: j });
    expect(p.target[field]).toBe(expected);
    expect(p.conflicts).toEqual([]);
  });

  it('latest-writer-wins uses record timestamps, ties go to Workfront', () => {
    const at = (wfT: number, jT: number) =>
      merge({ wf: snap({ priority: 'low' }, wfT), jira: snap({ priority: 'urgent' }, jT), target: base, seen: { workfront: base, jira: base }, own: { workfront: {}, jira: {} }, policies });
    expect(at(100, 200).target.priority).toBe('urgent');
    expect(at(100, 100).target.priority).toBe('low');
  });

  it('manual policy parks the field: nothing written, target held, other fields still flow', () => {
    const p = run({ dueDate: '2026-12-01', title: 'T2' }, { dueDate: '2026-12-08' });
    expect(p.conflicts).toEqual([{ field: 'dueDate', kind: 'conflict', wf: '2026-12-01', jira: '2026-12-08', base: '2026-11-20' }]);
    expect(p.writeJira).toEqual({ title: 'T2' });
    expect(p.writeWorkfront).toEqual({});
    expect(p.target.dueDate).toBe(base.dueDate);
  });

  it('a sticky conflict stays in the inbox even if one side edits again', () => {
    const seen = { workfront: { ...base, dueDate: '2026-12-01' }, jira: { ...base, dueDate: '2026-12-08' } };
    const p = merge({
      wf: snap({ dueDate: '2026-12-01' }),
      jira: snap({ dueDate: '2026-12-15' }), // Jira moved again; WF's claim must not be silently dropped
      target: base,
      seen,
      own: { workfront: {}, jira: {} },
      policies,
      parked: new Map([['dueDate', 'sticky']]),
    });
    expect(p.conflicts.map((c) => [c.field, c.jira])).toEqual([['dueDate', '2026-12-15']]);
    expect(p.isNoop).toBe(true);
  });

  it('a human resolution overrides everything and is written to whichever side differs', () => {
    const p = run({ dueDate: '2026-12-01' }, { dueDate: '2026-12-08' }, { resolutions: { dueDate: '2026-12-08' } });
    expect(p.writeWorkfront).toEqual({ dueDate: '2026-12-08' });
    expect(p.writeJira).toEqual({});
  });
});

describe('merge: partial-failure recovery (each case found or pinned by the chaos simulation)', () => {
  it('resumes an interrupted write instead of treating our own write as a user edit', () => {
    // Run 1 saw WF title "New", recorded it, wrote it to Jira — the response was lost.
    const p = merge({
      wf: snap({ title: 'New' }),
      jira: snap({}),
      target: { ...base, title: 'New' },
      seen: { workfront: { ...base, title: 'New' }, jira: base },
      own: { workfront: {}, jira: { title: ['New'] } },
      policies,
    });
    expect(p.writeJira).toEqual({ title: 'New' });
    expect(p.conflicts).toEqual([]);
  });

  it('our half-applied write vs a genuine new user edit on the other side → the user edit wins cleanly', () => {
    // Run 1 propagated Jira's "in_progress" to WF (succeeded), then failed on another field.
    // Before the retry an engineer moves the Jira card on to "in_review".
    const p = merge({
      wf: snap({ status: 'in_progress' }),
      jira: snap({ status: 'in_review' }),
      target: { ...base, status: 'in_progress' },
      seen: { workfront: base, jira: { ...base, status: 'in_progress' } },
      own: { workfront: { status: ['in_progress'] }, jira: {} },
      policies: { ...policies, status: 'manual' }, // even under `manual` this must not be a conflict
    });
    expect(p.conflicts).toEqual([]);
    expect(p.writeWorkfront).toEqual({ status: 'in_review' });
  });

  it('an interrupted multi-hop Jira transition is not mistaken for an engineer moving the card', () => {
    // WF moved to done; the Jira walk To Do → In Progress → In Review → Done died at In Progress.
    const p = merge({
      wf: snap({ status: 'done' }),
      jira: snap({ status: 'in_progress' }),
      target: { ...base, status: 'done' },
      seen: { workfront: { ...base, status: 'done' }, jira: base },
      own: { workfront: {}, jira: { status: ['done', 'in_progress', 'in_review'] } },
      policies,
    });
    expect(p.writeWorkfront).toEqual({});
    expect(p.writeJira).toEqual({ status: 'done' });
  });

  it('ABA: a user reverting to the old value during an in-flight write is respected', () => {
    // Base priority "medium". Marketer sets "low"; we observe it and push "low" to Jira (response lost).
    // Marketer then changes their mind back to "medium" — equal to the old base!
    // A base-only three-way merge sees "WF unchanged" and finishes pushing "low": a lost update.
    const p = merge({
      wf: snap({ priority: 'medium' }),
      jira: snap({ priority: 'low' }),
      target: { ...base, priority: 'low' },
      seen: { workfront: { ...base, priority: 'low' }, jira: base },
      own: { workfront: {}, jira: { priority: ['low'] } },
      policies,
    });
    expect(p.target.priority).toBe('medium');
    expect(p.writeJira).toEqual({ priority: 'medium' });
    expect(p.writeWorkfront).toEqual({});
  });
});
