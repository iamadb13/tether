import { pino } from 'pino';
import type { WorkItem } from '../core/model.js';
import type { Transport } from '../connectors/transport.js';
import type { Harness, HarnessOptions } from './harness.js';

/**
 * Records one simulated world as a flat event stream for the replay viewer. Nothing in the engine
 * knows about it: it taps the mocks (state changes, webhook outcomes), the transports (every API call
 * and its fate) and the engine's *structured logs* (sync decisions, retries, conflicts). That the
 * logs alone are enough to reconstruct what happened is itself a check on the observability design.
 */
export type ReplayEvent = { i: number; t: number } & (
  | { k: 'phase'; name: string }
  | { k: 'human'; side: 'workfront' | 'jira'; wfId: string; field: string; mid?: boolean }
  | { k: 'state'; sys: 'workfront' | 'jira'; id: string; wfId: string | null; item: WorkItem | null }
  | { k: 'api'; sys: 'workfront' | 'jira'; m: string; path: string; st: number | 'lost' | 'net' }
  | { k: 'hook'; src: 'workfront' | 'jira'; r: string }
  | { k: 'sync'; wfId: string; out: string; trig: string; toWf: string[]; toJira: string[]; cf: string[] }
  | { k: 'job'; wfId: string; r: 'retry' | 'defer' | 'dead' | 'cas'; why: string }
  | { k: 'conflict'; wfId: string; field: string; wf: unknown; jira: unknown; reason: string }
  | { k: 'note'; wfId: string; text: string }
  | { k: 'crash'; wfId: string }
  | { k: 'resolve'; wfId: string; field: string; choose: string }
  | { k: 'check'; round: number; label: string; ok: boolean; details: string[] }
);

type Body<E> = E extends unknown ? Omit<E, 'i' | 't'> : never;

const MARKER = /^tether-(wf-[\w-]+)$/;

export class Recorder {
  readonly events: ReplayEvent[] = [];
  private h: Harness | null = null;

  push(e: Body<ReplayEvent>): void {
    this.events.push({ ...e, i: this.events.length, t: this.h?.clock.now() ?? 0 } as ReplayEvent);
  }

  /** Options to build the harness with: a log sink and recording transports. */
  harnessOptions(): Partial<HarnessOptions> {
    const sink = { write: (line: string) => this.onLog(JSON.parse(line)) };
    return {
      logger: pino({ level: 'debug', base: null, timestamp: false }, sink),
      wrapTransport: (t: Transport, sys: 'workfront' | 'jira'): Transport => ({
        request: async (req) => {
          const path = req.path.replace(/^\/(attask\/api\/v[\d.]+|rest\/api\/3)/, '');
          try {
            const res = await t.request(req);
            this.push({ k: 'api', sys, m: req.method, path, st: res.status });
            return res;
          } catch (e) {
            this.push({ k: 'api', sys, m: req.method, path, st: (e as { ambiguous?: boolean }).ambiguous ? 'lost' : 'net' });
            throw e;
          }
        },
      }),
    };
  }

  attach(h: Harness): void {
    this.h = h;
    h.wf.onChange = (id) => this.push({ k: 'state', sys: 'workfront', id, wfId: id, item: h.wfItem(id) });
    h.jira.onChange = (key) => {
      const issue = h.jira.issues.get(key);
      const wfId = issue?.fields.labels.map((l) => MARKER.exec(l)?.[1]).find(Boolean) ?? h.store.linkByJira(key)?.wfId ?? null;
      let item: WorkItem | null = null;
      try {
        item = h.jiraItem(key);
      } catch {
        /* unmapped status: shown as missing */
      }
      this.push({ k: 'state', sys: 'jira', id: key, wfId, item });
    };
    h.wf.webhooks.onOutcome = (r) => this.push({ k: 'hook', src: 'workfront', r });
    h.jira.webhooks.onOutcome = (r) => this.push({ k: 'hook', src: 'jira', r });
  }

  phase(name: string): void {
    this.push({ k: 'phase', name });
  }
  human(side: 'workfront' | 'jira', wfId: string, field: string, mid = false): void {
    this.push({ k: 'human', side, wfId, field, ...(mid ? { mid } : {}) });
  }
  crash(wfId: string): void {
    this.push({ k: 'crash', wfId });
  }
  resolve(wfId: string, field: string, choose: string): void {
    this.push({ k: 'resolve', wfId, field, choose });
  }
  check(round: number, label: string, ok: boolean, details: string[]): void {
    this.push({ k: 'check', round, label, ok, details });
  }

  private onLog(l: Record<string, unknown>): void {
    const msg = String(l.msg ?? '');
    const wfId = String(l.wfId ?? String(l.entity ?? '').replace(/^wf:/, ''));
    if (msg.startsWith('sync ') && l.outcome && msg !== 'sync failed') {
      this.push({
        k: 'sync',
        wfId,
        out: String(l.outcome),
        trig: String(l.trigger ?? ''),
        toWf: (l.toWorkfront as string[]) ?? [],
        toJira: (l.toJira as string[]) ?? [],
        cf: (l.conflicts as string[]) ?? [],
      });
    } else if (msg === 'transient failure, will retry') this.push({ k: 'job', wfId, r: 'retry', why: String(l.error ?? '') });
    else if (msg === 'deferring') this.push({ k: 'job', wfId, r: String(l.reason ?? '').includes('changed under us') ? 'cas' : 'defer', why: String(l.reason ?? '') } as Body<ReplayEvent>);
    else if (msg === 'job dead-lettered') this.push({ k: 'job', wfId, r: 'dead', why: String(l.error ?? '') });
    else if (msg === 'conflict needs a human decision') this.push({ k: 'conflict', wfId, field: String(l.field), wf: l.wf, jira: l.jira, reason: String(l.reason) });
    else if (msg.startsWith('adopting Jira issue')) this.push({ k: 'note', wfId, text: `adopted ${String(l.jiraKey)} — created earlier, response was lost` });
  }
}
