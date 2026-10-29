import { PermanentError } from '../core/errors.js';
import {
  DEFAULT_JIRA_STATUSES,
  canonicalToJiraFields,
  jiraStatusToCanonical,
  jiraToCanonical,
  parseJiraDate,
  textToAdf,
  type JiraIssue,
  type JiraStatusMap,
} from '../core/mapping.js';
import { STATUSES, type Snapshot, type Status, type WorkItem } from '../core/model.js';
import { JIRA_API } from '../core/vendor.js';
import type { ApiClient } from './http.js';

export interface JiraRecord {
  raw: JiraIssue;
  snap: Snapshot;
}

export interface JiraConnectorOptions {
  projectKey: string;
  issueType?: string;
  statuses?: JiraStatusMap;
  /**
   * Optional e-mail → accountId map. Jira Cloud hides e-mail addresses unless a user's profile
   * visibility allows it, so on many real tenants identity can only be matched through a map.
   */
  userMap?: Record<string, string>;
}

export const SYNC_LABEL = 'tether';
/** Placeholder identity for a Jira user whose e-mail address is hidden by their privacy settings. */
export const HIDDEN_PREFIX = 'jira-account:';
/** Idempotency marker: lets a retried create find the issue a lost response already created. */
export const markerLabel = (wfId: string) => `tether-${wfId}`;

/** Everything needed to map an issue to canonical. The enhanced search endpoint returns only ids unless asked. */
const SEARCH_FIELDS = ['summary', 'description', 'status', 'duedate', 'priority', 'assignee', 'updated', 'labels'];

export class JiraConnector {
  private emailById = new Map<string, string | null>();
  private idByEmail = new Map<string, string | null>();
  private jqlTimeZone: string | null = null;
  private readonly statuses: JiraStatusMap;
  private readonly issueType: string;

  constructor(
    private readonly api: ApiClient,
    private readonly o: JiraConnectorOptions,
  ) {
    this.statuses = o.statuses ?? DEFAULT_JIRA_STATUSES;
    this.issueType = o.issueType ?? 'Task';
    for (const [email, id] of Object.entries(o.userMap ?? {})) {
      this.idByEmail.set(email.toLowerCase(), id);
      this.emailById.set(id, email.toLowerCase());
    }
  }

  private canonicalStatus(name: string): Status | null {
    try {
      return jiraStatusToCanonical(name, this.statuses);
    } catch {
      return null;
    }
  }

  async getIssue(key: string): Promise<JiraRecord> {
    const raw = await this.api.send<JiraIssue>('issue.get', { method: 'GET', path: `${JIRA_API}/issue/${encodeURIComponent(key)}` });
    return this.toRecord(raw);
  }

  async toRecord(raw: JiraIssue): Promise<JiraRecord> {
    // An assignee whose e-mail we can't see must NOT read as "unassigned" — that would clear the
    // assignee in Workfront. A stable placeholder identity routes it to the conflict inbox instead.
    const a = raw.fields.assignee;
    const email = a ? ((await this.emailOf(a.accountId)) ?? `${HIDDEN_PREFIX}${a.accountId}`) : null;
    return { raw, snap: { item: jiraToCanonical(raw, email, this.statuses), updatedAt: parseJiraDate(raw.fields.updated) } };
  }

  /** `beforeHop` is called with each status we are about to move through, *before* the call is made. */
  async update(key: string, patch: Partial<WorkItem>, beforeHop?: (s: Status) => void): Promise<void> {
    const { status, ...rest } = patch;
    const fields = canonicalToJiraFields(rest);
    if (rest.assigneeEmail !== undefined) fields.assignee = rest.assigneeEmail ? { accountId: await this.requireAccountId(rest.assigneeEmail) } : null;
    if (Object.keys(fields).length > 0) {
      await this.api.send('issue.update', { method: 'PUT', path: `${JIRA_API}/issue/${encodeURIComponent(key)}`, body: { fields } });
    }
    if (status !== undefined) await this.transitionTo(key, status, beforeHop);
  }

  /**
   * Jira status can only change via workflow transitions, and only the transitions available from
   * the *current* status are visible. Walk towards the target one hop at a time (e.g. Done → In
   * Progress = Reopen, then Start progress). Each hop is its own API call, so this can fail half-way;
   * that is fine because the next sync run re-reads the status and continues from wherever it is.
   * (Team-managed projects usually allow any-to-any transitions, so this is one hop there.)
   */
  async transitionTo(key: string, target: Status, beforeHop?: (s: Status) => void, maxHops = 6): Promise<void> {
    const rank = (s: string) => STATUSES.indexOf(this.canonicalStatus(s) ?? 'todo');
    const visited = new Set<string>();
    for (let hop = 0; hop < maxHops; hop++) {
      const issue = await this.api.send<JiraIssue>('issue.get', { method: 'GET', path: `${JIRA_API}/issue/${encodeURIComponent(key)}`, query: { fields: 'status' } });
      const current = issue.fields.status.name;
      if (this.canonicalStatus(current) === target) return;
      visited.add(current.toLowerCase());
      const { transitions } = await this.api.send<{ transitions: { id: string; to: { name: string } }[] }>('issue.transitions', {
        method: 'GET',
        path: `${JIRA_API}/issue/${encodeURIComponent(key)}/transitions`,
      });
      const goal = STATUSES.indexOf(target);
      const next = transitions
        .filter((t) => !visited.has(t.to.name.toLowerCase()) && this.canonicalStatus(t.to.name) !== null)
        .sort((a, b) => Math.abs(rank(a.to.name) - goal) - Math.abs(rank(b.to.name) - goal))[0];
      if (!next) throw new PermanentError(`Jira workflow: no path from '${current}' to '${this.statuses[target]}'`, 'jira');
      const via = this.canonicalStatus(next.to.name);
      if (via && via !== target) beforeHop?.(via);
      await this.api.send('issue.transition', {
        method: 'POST',
        path: `${JIRA_API}/issue/${encodeURIComponent(key)}/transitions`,
        body: { transition: { id: next.id } },
      });
    }
    throw new PermanentError(`Jira workflow: '${target}' not reached within ${maxHops} transitions`, 'jira');
  }

  async create(wfId: string, item: WorkItem): Promise<string> {
    const fields: Record<string, unknown> = {
      project: { key: this.o.projectKey },
      issuetype: { name: this.issueType },
      labels: [SYNC_LABEL, markerLabel(wfId)],
      ...canonicalToJiraFields({ title: item.title, description: item.description, dueDate: item.dueDate, priority: item.priority }),
    };
    if (item.assigneeEmail) {
      const id = await this.resolveAccountId(item.assigneeEmail);
      if (id) fields.assignee = { accountId: id };
    }
    const res = await this.api.send<{ key: string }>('issue.create', { method: 'POST', path: `${JIRA_API}/issue`, body: { fields } });
    return res.key;
  }

  /**
   * Find an issue previously created for this Workfront task. Jira has no idempotency keys, so the
   * marker label *is* the idempotency key. Jira's search index can trail writes by a few seconds;
   * the syncer accounts for that (see Syncer.create).
   */
  async findByMarker(wfId: string): Promise<string | null> {
    const res = await this.api.send<{ issues: { id: string; key?: string }[] }>('issue.search', {
      method: 'POST',
      path: `${JIRA_API}/search/jql`,
      body: { jql: `labels = "${markerLabel(wfId)}"`, maxResults: 2, fields: ['labels'] },
    });
    const hit = res.issues[0];
    return hit ? (hit.key ?? hit.id) : null;
  }

  async searchUpdatedSince(sinceMs: number): Promise<JiraIssue[]> {
    const jqlDate = formatJqlDate(sinceMs, await this.timeZone());
    const out: JiraIssue[] = [];
    let token: string | undefined;
    do {
      const res = await this.api.send<{ issues: JiraIssue[]; nextPageToken?: string }>('issue.search', {
        method: 'POST',
        path: `${JIRA_API}/search/jql`,
        body: {
          jql: `project = "${this.o.projectKey}" AND labels = "${SYNC_LABEL}" AND updated >= "${jqlDate}" ORDER BY updated ASC`,
          maxResults: 50,
          fields: SEARCH_FIELDS,
          ...(token ? { nextPageToken: token } : {}),
        },
      });
      out.push(...res.issues);
      token = res.nextPageToken;
    } while (token);
    return out;
  }

  /** Every issue Tether manages in the project, mapped to canonical (drift reports, demo views, cleanup). */
  async listSynced(max = 500): Promise<JiraRecord[]> {
    const out: JiraRecord[] = [];
    let token: string | undefined;
    do {
      const res = await this.api.send<{ issues: JiraIssue[]; nextPageToken?: string }>('issue.search', {
        method: 'POST',
        path: `${JIRA_API}/search/jql`,
        body: {
          jql: `project = "${this.o.projectKey}" AND labels = "${SYNC_LABEL}" ORDER BY key ASC`,
          maxResults: 100,
          fields: SEARCH_FIELDS,
          ...(token ? { nextPageToken: token } : {}),
        },
      });
      for (const raw of res.issues) {
        try {
          out.push(await this.toRecord(raw));
        } catch {
          /* unmapped status etc. — skipped from the listing, surfaced by the syncer */
        }
      }
      token = res.nextPageToken;
    } while (token && out.length < max);
    return out;
  }

  /**
   * JQL date literals are interpreted in the *API user's profile timezone*, not UTC. Formatting them
   * in UTC silently misses changes for any user west of Greenwich (and over-fetches east of it).
   */
  async timeZone(): Promise<string> {
    if (!this.jqlTimeZone) {
      const me = await this.api.send<{ timeZone?: string }>('myself', { method: 'GET', path: `${JIRA_API}/myself` });
      this.jqlTimeZone = me.timeZone || 'UTC';
    }
    return this.jqlTimeZone;
  }

  async comment(key: string, text: string): Promise<void> {
    await this.api.send('issue.comment', { method: 'POST', path: `${JIRA_API}/issue/${encodeURIComponent(key)}/comment`, body: { body: textToAdf(text) } });
  }

  async resolveAccountId(email: string): Promise<string | null> {
    const key = email.toLowerCase();
    if (key.startsWith(HIDDEN_PREFIX)) return email.slice(HIDDEN_PREFIX.length);
    if (!this.idByEmail.has(key)) {
      const users = await this.api.send<{ accountId: string; emailAddress?: string; accountType?: string }[]>('user.search', {
        method: 'GET',
        path: `${JIRA_API}/user/search`,
        query: { query: key },
      });
      const humans = users.filter((u) => !u.accountType || u.accountType === 'atlassian');
      // Prefer an exact (visible) e-mail match; accept a lone fuzzy match when e-mails are hidden.
      const exact = humans.find((u) => u.emailAddress?.toLowerCase() === key);
      this.idByEmail.set(key, exact?.accountId ?? (humans.length === 1 && !humans[0]!.emailAddress ? humans[0]!.accountId : null));
    }
    return this.idByEmail.get(key)!;
  }

  private async requireAccountId(email: string): Promise<string> {
    const id = await this.resolveAccountId(email);
    if (!id) throw new PermanentError(`no Jira user for ${email}`, 'jira');
    return id;
  }

  private async emailOf(accountId: string): Promise<string | null> {
    if (!this.emailById.has(accountId)) {
      const u = await this.api.send<{ emailAddress?: string }>('user.get', { method: 'GET', path: `${JIRA_API}/user`, query: { accountId } });
      this.emailById.set(accountId, u.emailAddress?.toLowerCase() ?? null);
    }
    return this.emailById.get(accountId)!;
  }
}

/** "yyyy/MM/dd HH:mm" wall-clock time in `timeZone` (JQL has minute granularity). */
export function formatJqlDate(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(instant));
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${g('year')}/${g('month')}/${g('day')} ${g('hour')}:${g('minute')}`;
}
