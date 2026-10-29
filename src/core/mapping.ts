import { PermanentError } from './errors.js';
import type { Priority, Status, WorkItem } from './model.js';

/**
 * Vendor <-> canonical mapping.
 *
 * Rule of thumb used throughout: canonical values are normalised to the *intersection* of what
 * both systems can represent (date-only due dates, 255-char single-line titles, plain-text
 * descriptions). If a mapping were not idempotent (map(unmap(x)) !== x), every sync would
 * produce a "change" on the other side and the systems would ping-pong forever. These
 * properties are pinned down in test/mapping.test.ts.
 */

// ---------- Raw vendor shapes (modelled on the public APIs; only the fields we use) ----------

export interface WfTask {
  ID: string;
  name: string;
  description: string | null;
  status: string; // 3-letter status key, e.g. NEW / INP / CPL, plus custom ones
  /** Workfront's datetime format, e.g. "2026-11-03T17:00:00:000+0200" (note the colon before ms). */
  plannedCompletionDate: string | null;
  priority: number; // 0..4
  assignedToID: string | null;
  lastUpdateDate: string;
  projectID: string;
  parameterValues: Record<string, string | undefined>;
}

export interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  version?: number;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description: AdfNode | null;
    status: { name: string };
    duedate: string | null;
    priority: { name: string } | null;
    assignee: { accountId: string } | null;
    updated: string; // "2026-10-25T10:00:00.000+0000"
    labels: string[];
  };
}

// ---------- Status ----------

const WF_STATUS_TO_CANONICAL: Record<string, Status> = { NEW: 'todo', INP: 'in_progress', RVW: 'in_review', CPL: 'done' };
const CANONICAL_TO_WF_STATUS: Record<Status, string> = { todo: 'NEW', in_progress: 'INP', in_review: 'RVW', done: 'CPL' };
/** Canonical status → Jira status *name*. Configurable, because every Jira project names its workflow differently. */
export type JiraStatusMap = Record<Status, string>;
export const DEFAULT_JIRA_STATUSES: JiraStatusMap = {
  todo: 'To Do',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
};

/** Jira status name → canonical. Case-insensitive: Jira UIs show "IN REVIEW" for a status called "In Review". */
export function jiraStatusToCanonical(name: string, map: JiraStatusMap = DEFAULT_JIRA_STATUSES): Status {
  const hit = (Object.entries(map) as [Status, string][]).find(([, n]) => n.toLowerCase() === name.toLowerCase());
  if (!hit) throw new PermanentError(`unmapped Jira status '${name}' — add it to JIRA_STATUSES (or run npm run preflight)`);
  return hit[0];
}

function mapOrFail<T>(table: Record<string, T>, key: string, what: string): T {
  const v = table[key];
  // Unknown statuses are a configuration problem, not a transient one: dead-letter with a clear message.
  if (v === undefined) throw new PermanentError(`unmapped ${what} '${key}' — add it to the status map`);
  return v;
}

// ---------- Priority ----------

const WF_PRIORITY_TO_CANONICAL: Priority[] = ['low', 'low', 'medium', 'high', 'urgent']; // index = WF priority 0..4
const CANONICAL_TO_WF_PRIORITY: Record<Priority, number> = { low: 1, medium: 2, high: 3, urgent: 4 };
const JIRA_PRIORITY_TO_CANONICAL: Record<string, Priority> = {
  Lowest: 'low',
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  Highest: 'urgent',
};
export const CANONICAL_TO_JIRA_PRIORITY: Record<Priority, string> = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Highest' };

// ---------- Text ----------

export const MAX_TITLE = 255; // Jira summary limit; Workfront allows longer names

export function normaliseTitle(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, ' ').trim().slice(0, MAX_TITLE).trimEnd();
}

export function normaliseDescription(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
}

/** Plain text -> Atlassian Document Format (one paragraph per line). */
export function textToAdf(text: string): AdfNode | null {
  if (!text) return null;
  return {
    type: 'doc',
    version: 1,
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}

/** ADF -> plain text. Lossy by design: formatting is dropped, block structure becomes lines. */
export function adfToText(doc: AdfNode | null): string {
  if (!doc) return '';
  const lines: string[] = [];
  const inline = (n: AdfNode): string =>
    n.type === 'text' ? (n.text ?? '') : n.type === 'hardBreak' ? '\n' : (n.content ?? []).map(inline).join('');
  const block = (n: AdfNode, prefix = ''): void => {
    if (n.type === 'paragraph' || n.type === 'heading') lines.push(prefix + (n.content ?? []).map(inline).join(''));
    else if (n.type === 'listItem') (n.content ?? []).forEach((c) => block(c, '- '));
    else (n.content ?? []).forEach((c) => block(c, prefix));
  };
  block(doc);
  return lines.join('\n');
}

// ---------- Dates ----------

/** Offset (minutes) of `timeZone` from UTC at the given instant. */
function tzOffsetMinutes(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - instant) / 60000);
}

/** Wall-clock time in `timeZone` → epoch ms. */
export function zonedToInstant(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  return guess - tzOffsetMinutes(guess, timeZone) * 60000;
}

/** Parse Workfront's "YYYY-MM-DDTHH:mm:ss:SSS+HHMM" (also accepts standard ISO). */
export function parseWfDate(s: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})[:.](\d{3})([+-]\d{2}):?(\d{2})$/.exec(s);
  const t = m ? Date.parse(`${m[1]}T${m[2]}.${m[3]}${m[4]}:${m[5]}`) : Date.parse(s);
  if (Number.isNaN(t)) throw new PermanentError(`unparseable Workfront date '${s}'`);
  return t;
}

export function formatWfDate(instant: number, timeZone: string): string {
  const off = tzOffsetMinutes(instant, timeZone);
  const local = new Date(instant + off * 60000).toISOString(); // wall-clock time in tz, labelled Z
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const hhmm = `${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
  return `${local.slice(0, 19)}:${local.slice(20, 23)}${sign}${hhmm}`;
}

/** The calendar date of an instant in the business timezone. */
export function instantToLocalDate(instant: number, timeZone: string): string {
  return new Date(instant + tzOffsetMinutes(instant, timeZone) * 60000).toISOString().slice(0, 10);
}

/** A due date becomes "end of business day" (17:00 local) when written to Workfront. */
export function localDateToWfDate(date: string, timeZone: string, endOfDay = '17:00'): string {
  const guess = Date.parse(`${date}T${endOfDay}:00Z`);
  const instant = guess - tzOffsetMinutes(guess, timeZone) * 60000;
  return formatWfDate(instant, timeZone);
}

/** Jira timestamps look like "2026-10-25T10:00:00.000+0000". */
export const parseJiraDate = (s: string): number => Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
export const formatJiraDate = (t: number): string => new Date(t).toISOString().replace('Z', '+0000');

// ---------- Whole-record mapping ----------

export interface MappingConfig {
  timeZone: string;
}

export function wfToCanonical(t: WfTask, assigneeEmail: string | null, cfg: MappingConfig): WorkItem {
  return {
    title: normaliseTitle(t.name),
    description: normaliseDescription(t.description),
    status: mapOrFail(WF_STATUS_TO_CANONICAL, t.status, 'Workfront status'),
    dueDate: t.plannedCompletionDate ? instantToLocalDate(parseWfDate(t.plannedCompletionDate), cfg.timeZone) : null,
    priority: WF_PRIORITY_TO_CANONICAL[t.priority] ?? 'medium',
    assigneeEmail: assigneeEmail?.toLowerCase() ?? null,
  };
}

/** Partial canonical -> Workfront update body. `assignedToID` must be resolved by the caller. */
export function canonicalToWfUpdate(p: Partial<WorkItem>, cfg: MappingConfig): Record<string, unknown> {
  const u: Record<string, unknown> = {};
  if (p.title !== undefined) u.name = p.title;
  if (p.description !== undefined) u.description = p.description;
  if (p.status !== undefined) u.status = CANONICAL_TO_WF_STATUS[p.status];
  if (p.dueDate !== undefined) u.plannedCompletionDate = p.dueDate ? localDateToWfDate(p.dueDate, cfg.timeZone) : null;
  if (p.priority !== undefined) u.priority = CANONICAL_TO_WF_PRIORITY[p.priority];
  return u;
}

export function jiraToCanonical(i: JiraIssue, assigneeEmail: string | null, statuses: JiraStatusMap = DEFAULT_JIRA_STATUSES): WorkItem {
  return {
    title: normaliseTitle(i.fields.summary),
    description: normaliseDescription(adfToText(i.fields.description)),
    status: jiraStatusToCanonical(i.fields.status.name, statuses),
    dueDate: i.fields.duedate,
    priority: i.fields.priority ? (JIRA_PRIORITY_TO_CANONICAL[i.fields.priority.name] ?? 'medium') : 'medium',
    assigneeEmail: assigneeEmail?.toLowerCase() ?? null,
  };
}

/** Partial canonical -> Jira `fields` body. Status is not a field in Jira (it needs a transition). */
export function canonicalToJiraFields(p: Partial<WorkItem>): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (p.title !== undefined) f.summary = p.title;
  if (p.description !== undefined) f.description = textToAdf(p.description);
  if (p.dueDate !== undefined) f.duedate = p.dueDate;
  if (p.priority !== undefined) f.priority = { name: CANONICAL_TO_JIRA_PRIORITY[p.priority] };
  return f;
}
