/**
 * Canonical work item: the neutral shape both systems are mapped into.
 *
 * Every comparison, merge and conflict decision happens on this shape, never on
 * raw API payloads. That keeps the merge logic independent of either vendor and
 * makes lossy conversions explicit (they live in mapping.ts and are tested for
 * round-trip stability, otherwise the two systems would ping-pong forever).
 */
export const STATUSES = ['todo', 'in_progress', 'in_review', 'done'] as const;
export type Status = (typeof STATUSES)[number];

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface WorkItem {
  title: string;
  description: string;
  status: Status;
  /** Calendar date (YYYY-MM-DD) in the customer's business timezone. */
  dueDate: string | null;
  priority: Priority;
  /** Identity is matched across systems by e-mail, never by vendor user id. */
  assigneeEmail: string | null;
}

export const FIELDS = ['title', 'description', 'status', 'dueDate', 'priority', 'assigneeEmail'] as const;
export type Field = (typeof FIELDS)[number];

export type System = 'workfront' | 'jira';
export const otherSide = (s: System): System => (s === 'workfront' ? 'jira' : 'workfront');

/** A canonical item plus the vendor metadata the engine needs. */
export interface Snapshot {
  item: WorkItem;
  /** Vendor's last-modified timestamp (epoch ms), used only by the `latest` policy. */
  updatedAt: number;
}

export function sameValue(a: unknown, b: unknown): boolean {
  return a === b || (a == null && b == null);
}
