import type { Clock } from '../core/clock.js';
import { parseJiraDate, parseWfDate } from '../core/mapping.js';
import { FIELDS, sameValue, type System, type WorkItem } from '../core/model.js';
import type { JiraConnector } from '../connectors/jira.js';
import type { WorkfrontConnector } from '../connectors/workfront.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { Store } from '../store/db.js';

const MARKER = /^tether-(wf-[\w-]+)$/;

/**
 * Webhooks are the fast path; the reconciler is the safety net. Every interval it asks both
 * systems "what changed since the watermark?". The search pages already carry every mapped field,
 * so each hit is compared with what Tether last *saw* in that system: only items that really differ
 * are enqueued. Without this filter, the overlap window re-syncs every recently touched item on
 * every pass (2 GETs each), which is what dominated API usage when polling a real Jira site.
 *
 * Watermarks come from the vendors' own `updated` timestamps (not our clock) and are re-read with
 * an overlap window, which absorbs clock skew, JQL's minute granularity and same-millisecond edits.
 */
export class Reconciler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly workfront: WorkfrontConnector,
    private readonly jira: JiraConnector,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly metrics?: Metrics,
    private readonly overlapMs = 2 * 60_000,
  ) {}

  /** True unless the item is linked and the system still holds exactly what Tether last saw there. */
  private async changedSinceSeen(wfId: string, side: System, item: () => Promise<WorkItem>): Promise<boolean> {
    const link = this.store.linkByWf(wfId);
    if (link?.state === 'tombstoned') return false;
    if (!link || link.state !== 'active' || !link.seen) return true;
    const seen = link.seen[side];
    try {
      const cur = await item();
      return FIELDS.some((f) => !sameValue(cur[f], seen[f]));
    } catch {
      return true; // unmappable (e.g. unknown status) or must-handle (sync disabled): let the syncer decide
    }
  }

  async runOnce(): Promise<{ workfront: number; jira: number; skipped: number }> {
    const now = this.clock.now();
    const wfMark = Number(this.store.get('watermark:workfront') ?? 0);
    const tasks = await this.workfront.searchUpdatedSince(Math.max(0, wfMark - this.overlapMs));
    let wfMax = wfMark;
    let wfEnqueued = 0;
    let skipped = 0;
    for (const t of tasks) {
      wfMax = Math.max(wfMax, parseWfDate(t.lastUpdateDate));
      const changed = await this.changedSinceSeen(t.ID, 'workfront', async () => {
        const r = await this.workfront.toRecord(t);
        if (!r.syncEnabled) throw new Error('sync disabled'); // must reach the syncer (tombstone)
        return r.snap.item;
      });
      if (changed) {
        this.store.enqueue(`wf:${t.ID}`, 'reconcile', now);
        wfEnqueued++;
      } else skipped++;
    }
    this.store.set('watermark:workfront', String(wfMax));

    const jMark = Number(this.store.get('watermark:jira') ?? 0);
    const issues = await this.jira.searchUpdatedSince(Math.max(0, jMark - this.overlapMs));
    let jMax = jMark;
    let jiraEnqueued = 0;
    for (const i of issues) {
      const wfId = this.store.linkByJira(i.key)?.wfId ?? i.fields.labels.map((l) => MARKER.exec(l)?.[1]).find(Boolean);
      if (wfId && (await this.changedSinceSeen(wfId, 'jira', async () => (await this.jira.toRecord(i)).snap.item))) {
        this.store.enqueue(`wf:${wfId}`, 'reconcile', now);
        jiraEnqueued++;
      } else if (wfId) skipped++;
      jMax = Math.max(jMax, parseJiraDate(i.fields.updated));
    }
    this.store.set('watermark:jira', String(jMax));
    this.store.set('reconciler:last_run', String(now));
    // Webhook dedupe only needs to outlive the vendors' retry windows (Workfront: 48 h).
    this.store.pruneInbox(now - 7 * 24 * 3600_000);

    this.metrics?.reconcilerSkipped.inc(skipped);
    const result = { workfront: wfEnqueued, jira: jiraEnqueued, skipped };
    this.logger.debug(result, 'reconcile pass');
    return result;
  }

  /** Re-checks every active link regardless of watermarks (nightly, or on demand from the ops UI). */
  fullScan(): number {
    const now = this.clock.now();
    const links = this.store.links('active');
    for (const l of links) this.store.enqueue(`wf:${l.wfId}`, 'reconcile', now);
    this.store.set('watermark:workfront', '0');
    this.store.set('watermark:jira', '0');
    return links.length;
  }

  start(intervalMs: number): void {
    const tick = async () => {
      try {
        await this.runOnce();
      } catch (e) {
        this.logger.warn({ err: { message: (e as Error).message } }, 'reconcile pass failed; will retry next interval');
      }
      this.timer = setTimeout(tick, intervalMs);
    };
    this.timer = setTimeout(tick, intervalMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
