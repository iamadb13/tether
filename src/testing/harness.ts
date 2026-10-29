import { buildTether, type Tether } from '../app.js';
import { loadConfig } from '../config.js';
import { ManualClock } from '../core/clock.js';
import { jiraToCanonical, wfToCanonical } from '../core/mapping.js';
import type { Policies } from '../core/merge.js';
import { FIELDS, type Field, type WorkItem } from '../core/model.js';
import { seededRng } from '../core/rng.js';
import { injectTransport, type Transport } from '../connectors/transport.js';
import type { WorkerOptions } from '../engine/worker.js';
import { CALM, Chaos, type ChaosConfig } from '../mocks/chaos.js';
import { JiraMock } from '../mocks/jira.js';
import { WorkfrontMock } from '../mocks/workfront.js';
import { silentLogger, type Logger } from '../observability/logger.js';

export interface HarnessOptions {
  seed?: number;
  chaos?: Partial<ChaosConfig>;
  policies?: Partial<Policies>;
  worker?: Partial<WorkerOptions>;
  logger?: Logger;
  /** Decorate the vendor transports (e.g. to record every API call for a replay). */
  wrapTransport?: (t: Transport, system: 'workfront' | 'jira') => Transport;
}

/**
 * Everything in one process, on a virtual clock: two mock vendors, the real Tether service, and
 * webhook delivery between them — all through Fastify `inject()`, so the real HTTP clients, routes,
 * status codes and signatures are exercised without sockets or timers. Same seed ⇒ same run.
 */
export class Harness {
  readonly clock = new ManualClock();
  readonly wf: WorkfrontMock;
  readonly jira: JiraMock;
  readonly tether: Tether;
  readonly timeZone = 'Europe/Bucharest';

  constructor(o: HarnessOptions = {}) {
    const seed = o.seed ?? 1;
    this.wf = new WorkfrontMock({ clock: this.clock, chaos: new Chaos(seed * 7919 + 1, o.chaos), timeZone: this.timeZone, pageSize: 7 });
    // A Jira user west of UTC: catches any JQL date formatted in the wrong timezone (it would miss changes).
    this.jira = new JiraMock({ clock: this.clock, chaos: new Chaos(seed * 7919 + 2, o.chaos), pageSize: 7, userTimeZone: 'America/Los_Angeles', indexLagMs: 3_000 });
    const base = loadConfig({ DB_PATH: ':memory:', TIMEZONE: this.timeZone, WORKFRONT_RPS: 'Infinity', JIRA_RPS: 'Infinity' });
    const config = { ...base, policies: { ...base.policies, ...o.policies } };
    this.tether = buildTether({
      config,
      clock: this.clock,
      rng: seededRng(seed),
      logger: o.logger ?? silentLogger(),
      workfrontTransport: (o.wrapTransport ?? ((t) => t))(injectTransport(this.wf.app, 'workfront'), 'workfront'),
      jiraTransport: (o.wrapTransport ?? ((t) => t))(injectTransport(this.jira.app, 'jira'), 'jira'),
      maxInlineWaitMs: 0,
      worker: { concurrency: 1, ...o.worker },
    });

    this.wf.webhooks.sender = async (hook) =>
      (
        await this.tether.api.inject({
          method: 'POST',
          url: '/webhooks/workfront',
          headers: { authorization: config.WORKFRONT_WEBHOOK_TOKEN, 'content-type': 'application/json' },
          payload: JSON.stringify(hook.body),
        })
      ).statusCode;
    this.jira.webhooks.sender = async (hook) => {
      const body = JSON.stringify(hook.body);
      return (
        await this.tether.api.inject({
          method: 'POST',
          url: '/webhooks/jira',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature': this.jira.sign(body),
            'x-atlassian-webhook-identifier': hook.deliveryId,
            ...(hook.attempts > 1 ? { 'x-atlassian-webhook-retry': String(hook.attempts - 1) } : {}),
          },
          payload: body,
        })
      ).statusCode;
    };
  }

  get store() {
    return this.tether.store;
  }

  setChaos(c: Partial<ChaosConfig>): void {
    this.wf.chaos.set(c);
    this.jira.chaos.set(c);
  }

  calm(): void {
    this.setChaos(CALM);
  }

  /**
   * Run the world until it is quiet: deliver webhooks, drain the queue, jump the virtual clock to
   * the next scheduled retry, and (optionally) run a reconcile pass once things look idle.
   */
  async settle(o: { reconcile?: boolean; maxRounds?: number } = {}): Promise<void> {
    const { reconcile = true, maxRounds = 2000 } = o;
    // The reconciler's overlap window re-enqueues recently changed items forever (by design: those
    // syncs are cheap no-ops). So "quiet" means: a reconcile pass ran and no vendor write followed.
    let reconciledWhileIdle = false;
    let writesAtReconcile = -1;
    const writes = () => this.wf.apiCalls.writes + this.jira.apiCalls.writes;
    for (let round = 0; round < maxRounds; round++) {
      this.clock.advance(1_000);
      await this.wf.webhooks.flush();
      await this.jira.webhooks.flush();
      const n = await this.tether.worker.drain();
      if (n > 0 || this.wf.webhooks.pending > 0 || this.jira.webhooks.pending > 0) {
        if (writes() !== writesAtReconcile) reconciledWhileIdle = false;
        continue;
      }
      const next = this.store.queueStats(this.clock.now()).nextRunAt;
      if (next !== null) {
        this.clock.set(next);
        continue;
      }
      if (reconcile && !reconciledWhileIdle) {
        reconciledWhileIdle = true;
        writesAtReconcile = writes();
        try {
          await this.tether.reconciler.runOnce();
        } catch {
          /* vendor flaking during reconcile: the next idle round tries again */
          reconciledWhileIdle = false;
          this.clock.advance(5_000);
        }
        continue;
      }
      return;
    }
    throw new Error(`world did not settle after ${maxRounds} rounds: ${JSON.stringify(this.store.queueStats(this.clock.now()))}`);
  }

  // ---------- views straight from the mocks' storage (bypassing chaos) ----------

  wfItem(id: string): WorkItem | null {
    const t = this.wf.tasks.get(id);
    if (!t) return null;
    const email = this.wf.users.find((u) => u.ID === t.assignedToID)?.emailAddr ?? null;
    return wfToCanonical(t, email, { timeZone: this.timeZone });
  }

  jiraItem(key: string): WorkItem | null {
    const i = this.jira.issues.get(key);
    if (!i) return null;
    const email = this.jira.users.find((u) => u.accountId === i.fields.assignee?.accountId)?.emailAddress ?? null;
    return jiraToCanonical(i, email);
  }

  jiraFor(wfId: string): WorkItem | null {
    const key = this.store.linkByWf(wfId)?.jiraKey;
    return key ? this.jiraItem(key) : null;
  }

  /** Field-level differences between linked pairs, excluding fields parked in the conflict inbox. */
  divergence(): { wfId: string; field: Field; wf: unknown; jira: unknown }[] {
    const out: { wfId: string; field: Field; wf: unknown; jira: unknown }[] = [];
    const parked = new Set(this.store.conflicts().map((c) => `${c.wfId}/${c.field}`));
    for (const l of this.store.links('active')) {
      const a = this.wfItem(l.wfId);
      const b = l.jiraKey ? this.jiraItem(l.jiraKey) : null;
      if (!a || !b) continue;
      for (const f of FIELDS) if (a[f] !== b[f] && !parked.has(`${l.wfId}/${f}`)) out.push({ wfId: l.wfId, field: f, wf: a[f], jira: b[f] });
    }
    return out;
  }
}
