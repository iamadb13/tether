import type { Priority, Status } from '../core/model.js';
import { pick, seededRng } from '../core/rng.js';
import type { WorkfrontMock } from '../mocks/workfront.js';

/**
 * "The users" of the demo: a seeded campaign plan plus random human edits on either side.
 * The Jira side is behind a small interface so the same buttons drive the mock or a real Jira site.
 */
export interface JiraHuman {
  setStatus(key: string, s: Status): Promise<void>;
  setPriority(key: string, p: Priority): Promise<void>;
  setAssignee(key: string, email: string | null): Promise<void>;
  setDueDate(key: string, date: string): Promise<void>;
}

export interface People {
  /** Workfront user IDs that also exist in Jira (assignee sync works for them). */
  shared: string[];
  /** Their e-mails, for edits made on the Jira side. */
  sharedEmails: string[];
  /** A Workfront-only person, to demonstrate the unmapped-user inbox. */
  wfOnly: string;
}

const CAMPAIGN = [
  { name: 'Holiday campaign — landing page build', priority: 4, due: '2026-11-20', status: 'INP' },
  { name: 'Black Friday promo banner (homepage takeover)', priority: 3, due: '2026-11-24', status: 'NEW' },
  { name: 'Newsletter signup form + consent tracking', priority: 3, due: '2026-11-18', status: 'NEW' },
  { name: 'Product feed update for gift guide', priority: 2, due: '2026-11-27', status: 'NEW' },
  { name: 'Analytics tagging for campaign UTMs', priority: 2, due: '2026-11-16', status: 'RVW' },
  { name: 'Localise landing page (RO, DE, FR)', priority: 2, due: '2026-12-02', status: 'NEW' },
  { name: 'A/B test: hero headline variants', priority: 1, due: '2026-12-05', status: 'NEW', wfOnly: true },
];

export function seedDemoData(wf: WorkfrontMock, people: People): void {
  CAMPAIGN.forEach((c, i) => {
    wf.createTask({
      name: c.name,
      description: `Campaign: Holiday 2026\nOwner: Brand Marketing\nAcceptance: see creative brief in Workfront`,
      priority: c.priority,
      assignedToID: c.wfOnly ? people.wfOnly : people.shared[i % people.shared.length]!,
      status: c.status,
      plannedCompletionDate: `${c.due}T17:00:00:000+0200`,
    });
  });
  wf.createTask({ name: 'Internal: agency invoice review', priority: 1 }, false); // not flagged → never synced
}

const rng = seededRng(Date.now() & 0xffff);

function linked(wf: WorkfrontMock) {
  return [...wf.tasks.values()].filter((t) => t.parameterValues['DE:Jira Key']);
}

/** One random "human" edit in either system, like a planner or engineer clicking around. */
export async function randomHumanEdit(wf: WorkfrontMock, jira: JiraHuman, people: People): Promise<string> {
  const tasks = linked(wf);
  if (tasks.length === 0) return 'nothing linked yet';
  const t = pick(rng, tasks);
  const key = t.parameterValues['DE:Jira Key']!;
  const day = String(1 + Math.floor(rng() * 20)).padStart(2, '0');
  if (rng() < 0.5) {
    const edits = [
      () => (wf.editTask(t.ID, { name: t.name.replace(/( v\d+)?$/, ` v${2 + Math.floor(rng() * 8)}`) }), `WF ${t.ID}: renamed`),
      () => (wf.editTask(t.ID, { priority: Math.floor(rng() * 5) }), `WF ${t.ID}: priority changed`),
      () => (wf.editTask(t.ID, { plannedCompletionDate: `2026-12-${day}T17:00:00:000+0200` }), `WF ${t.ID}: due date moved`),
      () => (wf.editTask(t.ID, { assignedToID: pick(rng, people.shared) }), `WF ${t.ID}: reassigned`),
    ];
    return pick(rng, edits)();
  }
  const edits = [
    async () => (await jira.setStatus(key, pick(rng, ['todo', 'in_progress', 'in_review', 'done'] as const)), `Jira ${key}: moved on board`),
    async () => (await jira.setPriority(key, pick(rng, ['low', 'medium', 'high', 'urgent'] as const)), `Jira ${key}: re-prioritised`),
    async () => (await jira.setAssignee(key, pick(rng, people.sharedEmails)), `Jira ${key}: reassigned`),
  ];
  return pick(rng, edits)();
}

/** The same due date moved differently on both sides before either side syncs. */
export async function makeConflict(wf: WorkfrontMock, jira: JiraHuman): Promise<{ wfId: string; jiraKey: string } | { error: string }> {
  const t = linked(wf)[0];
  if (!t) return { error: 'no linked task yet' };
  const key = t.parameterValues['DE:Jira Key']!;
  const day = 10 + Math.floor(rng() * 10);
  // Jira first: against a real site the API call takes a few hundred ms, and the Workfront edit's
  // webhook must not get there (and propagate) before the Jira edit has landed.
  await jira.setDueDate(key, `2026-12-${day + 3}`);
  wf.editTask(t.ID, { plannedCompletionDate: `2026-12-${day}T17:00:00:000+0200` });
  return { wfId: t.ID, jiraKey: key };
}
