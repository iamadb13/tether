import { PermanentError } from '../core/errors.js';
import {
  canonicalToWfUpdate,
  formatWfDate,
  parseWfDate,
  wfToCanonical,
  type MappingConfig,
  type WfTask,
} from '../core/mapping.js';
import type { Snapshot, WorkItem } from '../core/model.js';
import { JIRA_KEY_FIELD, SYNC_FLAG, WF_API } from '../core/vendor.js';
import type { ApiClient } from './http.js';

export interface WfRecord {
  raw: WfTask;
  snap: Snapshot;
  syncEnabled: boolean;
}

export class WorkfrontConnector {
  private emailById = new Map<string, string | null>();
  private idByEmail = new Map<string, string | null>();

  constructor(
    private readonly api: ApiClient,
    private readonly cfg: MappingConfig,
  ) {}

  async getTask(id: string): Promise<WfRecord> {
    const res = await this.api.send<{ data: WfTask }>('task.get', { method: 'GET', path: `${WF_API}/task/${encodeURIComponent(id)}`, query: { fields: '*' } });
    return this.toRecord(res.data);
  }

  async toRecord(raw: WfTask): Promise<WfRecord> {
    const email = raw.assignedToID ? await this.emailOf(raw.assignedToID) : null;
    return {
      raw,
      snap: { item: wfToCanonical(raw, email, this.cfg), updatedAt: parseWfDate(raw.lastUpdateDate) },
      syncEnabled: raw.parameterValues[SYNC_FLAG] === 'Yes',
    };
  }

  async update(id: string, patch: Partial<WorkItem>): Promise<void> {
    const body = canonicalToWfUpdate(patch, this.cfg);
    if (patch.assigneeEmail !== undefined) {
      const uid = patch.assigneeEmail ? await this.resolveUserId(patch.assigneeEmail) : null;
      if (patch.assigneeEmail && !uid) throw new PermanentError(`no Workfront user for ${patch.assigneeEmail}`, 'workfront');
      body.assignedToID = uid;
    }
    if (Object.keys(body).length === 0) return;
    await this.api.send('task.update', { method: 'PUT', path: `${WF_API}/task/${encodeURIComponent(id)}`, body });
  }

  /** Writes the Jira key back to a custom field so planners can click through from Workfront. */
  async setJiraKey(id: string, jiraKey: string): Promise<void> {
    await this.api.send('task.update', {
      method: 'PUT',
      path: `${WF_API}/task/${encodeURIComponent(id)}`,
      body: { parameterValues: { [JIRA_KEY_FIELD]: jiraKey } },
    });
  }

  /**
   * All sync-enabled tasks modified at or after `sinceMs`, following $$FIRST/$$LIMIT paging.
   * The server may cap the page below what we ask for, so we advance by what we actually received
   * and stop only on an empty page (found by the chaos simulation: stopping on a "short" page
   * silently skipped everything after the server's cap).
   */
  async searchUpdatedSince(sinceMs: number, pageSize = 500): Promise<WfTask[]> {
    const out: WfTask[] = [];
    for (let first = 0; ; ) {
      const res = await this.api.send<{ data: WfTask[] }>('task.search', {
        method: 'GET',
        path: `${WF_API}/task/search`,
        query: {
          fields: '*',
          lastUpdateDate: formatWfDate(sinceMs, 'UTC'),
          lastUpdateDate_Mod: 'gte',
          [SYNC_FLAG]: 'Yes',
          $$FIRST: String(first),
          $$LIMIT: String(pageSize),
        },
      });
      if (res.data.length === 0) return out;
      out.push(...res.data);
      first += res.data.length;
    }
  }

  async resolveUserId(email: string): Promise<string | null> {
    const key = email.toLowerCase();
    if (!this.idByEmail.has(key)) {
      const res = await this.api.send<{ data: { ID: string }[] }>('user.search', {
        method: 'GET',
        path: `${WF_API}/user/search`,
        query: { emailAddr: key },
      });
      this.idByEmail.set(key, res.data[0]?.ID ?? null);
    }
    return this.idByEmail.get(key)!;
  }

  private async emailOf(userId: string): Promise<string | null> {
    if (!this.emailById.has(userId)) {
      const res = await this.api.send<{ data: { emailAddr: string } }>('user.get', { method: 'GET', path: `${WF_API}/user/${encodeURIComponent(userId)}` });
      this.emailById.set(userId, res.data.emailAddr ?? null);
    }
    return this.emailById.get(userId)!;
  }
}
