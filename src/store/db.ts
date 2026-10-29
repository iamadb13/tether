import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import type { Pending } from '../core/merge.js';
import type { Field, WorkItem } from '../core/model.js';

// node:sqlite is loaded via require so test runners that don't know the module yet don't choke,
// and its one-line ExperimentalWarning doesn't pollute structured logs.
const originalEmit = process.emitWarning;
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  if (String(w).includes('SQLite')) return;
  return (originalEmit as (...a: unknown[]) => void).call(process, w, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * SQLite-backed state. Why SQLite: the whole service is one process with a small, write-light
 * workload (thousands of links, not millions), it is transactional, needs zero infrastructure for
 * the customer's pilot, and every query here is portable to Postgres when we need >1 replica
 * (claim() becomes `SELECT … FOR UPDATE SKIP LOCKED`).
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS links (
  id           INTEGER PRIMARY KEY,
  wf_id        TEXT NOT NULL UNIQUE,
  jira_key     TEXT UNIQUE,
  state        TEXT NOT NULL,                -- creating | active | tombstoned
  target       TEXT,                         -- JSON WorkItem: the state both systems should hold
  seen_wf      TEXT,                         -- JSON WorkItem: last values observed in Workfront
  seen_jira    TEXT,                         -- JSON WorkItem: last values observed in Jira
  own          TEXT,                         -- JSON {workfront, jira}: our (possibly unconfirmed) writes
  tombstone_reason TEXT,
  create_attempted_at INTEGER,               -- last time we POSTed a create (index-lag guard)
  last_synced_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY,
  entity       TEXT NOT NULL UNIQUE,         -- one job per work item => natural coalescing
  trigger      TEXT NOT NULL,                -- webhook | reconcile | manual | resolve
  attempts     INTEGER NOT NULL DEFAULT 0,
  run_after    INTEGER NOT NULL,
  leased_until INTEGER,
  dirty        INTEGER NOT NULL DEFAULT 0,   -- set when new events arrive while the job is running
  last_error   TEXT,
  enqueued_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (run_after);

CREATE TABLE IF NOT EXISTS dead_letters (
  id         INTEGER PRIMARY KEY,
  entity     TEXT NOT NULL,
  trigger    TEXT NOT NULL,
  attempts   INTEGER NOT NULL,
  error      TEXT NOT NULL,
  failed_at  INTEGER NOT NULL,
  replayed_at INTEGER
);

CREATE TABLE IF NOT EXISTS conflicts (
  id          INTEGER PRIMARY KEY,
  link_id     INTEGER NOT NULL REFERENCES links(id),
  field       TEXT NOT NULL,
  reason      TEXT NOT NULL,                 -- concurrent_edit | unmapped_user
  wf_value    TEXT,
  jira_value  TEXT,
  base_value  TEXT,
  status      TEXT NOT NULL,                 -- open | resolving | resolved
  resolution  TEXT,                          -- JSON value chosen by a human
  resolved_by TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS conflicts_one_open ON conflicts (link_id, field) WHERE status != 'resolved';

CREATE TABLE IF NOT EXISTS inbox (
  delivery_id TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id       INTEGER PRIMARY KEY,
  at       INTEGER NOT NULL,
  run_id   TEXT NOT NULL,
  wf_id    TEXT NOT NULL,
  jira_key TEXT,
  target   TEXT NOT NULL,                    -- workfront | jira | link
  field    TEXT NOT NULL,
  before   TEXT,
  after    TEXT,
  cause    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_wf ON audit (wf_id, at);

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export interface LinkRow {
  id: number;
  wfId: string;
  jiraKey: string | null;
  state: 'creating' | 'active' | 'tombstoned';
  target: WorkItem | null;
  seen: { workfront: WorkItem; jira: WorkItem } | null;
  own: { workfront: Pending; jira: Pending };
  tombstoneReason: string | null;
  createAttemptedAt: number | null;
  lastSyncedAt: number | null;
}

export interface JobRow {
  id: number;
  entity: string;
  trigger: string;
  attempts: number;
  runAfter: number;
  enqueuedAt: number;
  lastError: string | null;
}

export interface ConflictRow {
  id: number;
  linkId: number;
  wfId: string;
  jiraKey: string | null;
  field: Field;
  reason: string;
  wfValue: unknown;
  jiraValue: unknown;
  baseValue: unknown;
  status: 'open' | 'resolving' | 'resolved';
  resolution: unknown;
  createdAt: number;
}

export interface AuditEntry {
  runId: string;
  wfId: string;
  jiraKey: string | null;
  target: string;
  field: string;
  before: unknown;
  after: unknown;
  cause: string;
}

const j = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const p = <T>(s: unknown): T => (s == null ? (null as T) : (JSON.parse(String(s)) as T));
type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSyncT;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- links

  private toLink(r: Row | undefined): LinkRow | null {
    if (!r) return null;
    return {
      id: Number(r.id),
      wfId: String(r.wf_id),
      jiraKey: (r.jira_key as string) ?? null,
      state: r.state as LinkRow['state'],
      target: p(r.target),
      seen: r.seen_wf ? { workfront: p<WorkItem>(r.seen_wf), jira: p<WorkItem>(r.seen_jira) } : null,
      own: p<LinkRow['own']>(r.own) ?? { workfront: {}, jira: {} },
      tombstoneReason: (r.tombstone_reason as string) ?? null,
      createAttemptedAt: (r.create_attempted_at as number) ?? null,
      lastSyncedAt: (r.last_synced_at as number) ?? null,
    };
  }

  linkByWf(wfId: string): LinkRow | null {
    return this.toLink(this.db.prepare('SELECT * FROM links WHERE wf_id = ?').get(wfId) as Row);
  }

  linkByJira(key: string): LinkRow | null {
    return this.toLink(this.db.prepare('SELECT * FROM links WHERE jira_key = ?').get(key) as Row);
  }

  links(state?: LinkRow['state']): LinkRow[] {
    const rows = state
      ? this.db.prepare('SELECT * FROM links WHERE state = ? ORDER BY id').all(state)
      : this.db.prepare('SELECT * FROM links ORDER BY id').all();
    return (rows as Row[]).map((r) => this.toLink(r)!);
  }

  /** Records the intent to create a Jira issue *before* calling Jira (crash-safe creation). */
  beginCreate(wfId: string, now: number): LinkRow {
    this.db
      .prepare(`INSERT INTO links (wf_id, state, created_at, updated_at) VALUES (?, 'creating', ?, ?) ON CONFLICT(wf_id) DO NOTHING`)
      .run(wfId, now, now);
    return this.linkByWf(wfId)!;
  }

  markCreateAttempt(wfId: string, now: number): void {
    this.db.prepare('UPDATE links SET create_attempted_at = ?, updated_at = ? WHERE wf_id = ?').run(now, now, wfId);
  }

  /** After creation: both sides are considered to have last been seen holding `initial`. */
  activate(wfId: string, jiraKey: string, initial: WorkItem, now: number): void {
    const v = j(initial);
    this.db
      .prepare(`UPDATE links SET jira_key = ?, state = 'active', target = ?, seen_wf = ?, seen_jira = ?, own = NULL, last_synced_at = ?, updated_at = ? WHERE wf_id = ?`)
      .run(jiraKey, v, v, v, now, now, wfId);
  }

  /**
   * Persist what this run observed and decided, *before* writing anything:
   *  - observations are facts and must survive a failure later in the run (that is what makes
   *    the next run's change detection correct);
   *  - our intended writes are *added* to `own`, which only a fully successful run clears.
   */
  recordRun(linkId: number, r: { target: WorkItem; seen: { workfront: WorkItem; jira: WorkItem }; intent: { workfront: Partial<WorkItem>; jira: Partial<WorkItem> } }, now: number): void {
    this.tx(() => {
      const own = this.linkOwn(linkId);
      for (const side of ['workfront', 'jira'] as const) {
        for (const [f, v] of Object.entries(r.intent[side]) as [Field, unknown][]) own[side][f] = [v, ...(own[side][f] ?? [])];
      }
      this.db
        .prepare('UPDATE links SET target = ?, seen_wf = ?, seen_jira = ?, own = ?, updated_at = ? WHERE id = ?')
        .run(j(r.target), j(r.seen.workfront), j(r.seen.jira), j(own), now, linkId);
    });
  }

  /** Record a value we are about to write (e.g. the next hop of a Jira workflow transition). */
  addOwn(linkId: number, side: 'workfront' | 'jira', field: Field, value: unknown, now: number): void {
    this.tx(() => {
      const own = this.linkOwn(linkId);
      own[side][field] = [...(own[side][field] ?? []), value];
      this.db.prepare('UPDATE links SET own = ?, updated_at = ? WHERE id = ?').run(j(own), now, linkId);
    });
  }

  private linkOwn(linkId: number): LinkRow['own'] {
    const cur = this.db.prepare('SELECT own FROM links WHERE id = ?').get(linkId) as Row | undefined;
    return p<LinkRow['own']>(cur?.own) ?? { workfront: {}, jira: {} };
  }

  /** Every write of the run succeeded: we now know exactly what each side holds. */
  commit(linkId: number, target: WorkItem, seen: { workfront: WorkItem; jira: WorkItem }, now: number): void {
    this.db
      .prepare('UPDATE links SET target = ?, seen_wf = ?, seen_jira = ?, own = NULL, last_synced_at = ?, updated_at = ? WHERE id = ?')
      .run(j(target), j(seen.workfront), j(seen.jira), now, now, linkId);
  }

  tombstone(linkId: number, reason: string, now: number): void {
    this.db.prepare(`UPDATE links SET state = 'tombstoned', tombstone_reason = ?, own = NULL, updated_at = ? WHERE id = ?`).run(reason, now, linkId);
  }

  // ---------------------------------------------------------------- jobs (durable, coalescing queue)

  /**
   * Enqueue a sync for an entity. If a job already exists it is *coalesced*: 50 webhooks for the
   * same task become one sync. If that job is currently running, it is marked dirty so it runs once
   * more after finishing — otherwise an edit landing mid-sync (after we read) could be missed.
   */
  enqueue(entity: string, trigger: string, now: number, runAt = now): void {
    this.db
      .prepare(
        `INSERT INTO jobs (entity, trigger, run_after, enqueued_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(entity) DO UPDATE SET
           dirty = CASE WHEN leased_until IS NOT NULL THEN 1 ELSE dirty END,
           run_after = CASE WHEN leased_until IS NULL THEN MIN(run_after, excluded.run_after) ELSE run_after END`,
      )
      .run(entity, trigger, runAt, now);
  }

  /** Atomically lease the next ready job. Expired leases (crashed worker) are reclaimable. */
  claim(now: number, leaseMs: number): JobRow | null {
    const r = this.db
      .prepare(
        `UPDATE jobs SET leased_until = ?
         WHERE id = (SELECT id FROM jobs WHERE run_after <= ? AND (leased_until IS NULL OR leased_until < ?)
                     ORDER BY run_after, id LIMIT 1)
         RETURNING *`,
      )
      .get(now + leaseMs, now, now) as Row | undefined;
    return r ? this.toJob(r) : null;
  }

  private toJob(r: Row): JobRow {
    return {
      id: Number(r.id),
      entity: String(r.entity),
      trigger: String(r.trigger),
      attempts: Number(r.attempts),
      runAfter: Number(r.run_after),
      enqueuedAt: Number(r.enqueued_at),
      lastError: (r.last_error as string) ?? null,
    };
  }

  /** Done: delete, unless new work arrived while running — then re-arm immediately. */
  completeJob(id: number, now: number): void {
    this.tx(() => {
      const res = this.db.prepare('DELETE FROM jobs WHERE id = ? AND dirty = 0').run(id);
      if (Number(res.changes) === 0) {
        this.db
          .prepare(`UPDATE jobs SET dirty = 0, attempts = 0, leased_until = NULL, run_after = ?, last_error = NULL WHERE id = ?`)
          .run(now, id);
      }
    });
  }

  retryJob(id: number, runAt: number, error: string, countAttempt: boolean): void {
    this.db
      .prepare(`UPDATE jobs SET attempts = attempts + ?, run_after = ?, leased_until = NULL, last_error = ? WHERE id = ?`)
      .run(countAttempt ? 1 : 0, runAt, error, id);
  }

  deadLetter(job: JobRow, error: string, now: number): void {
    this.tx(() => {
      this.db
        .prepare('INSERT INTO dead_letters (entity, trigger, attempts, error, failed_at) VALUES (?, ?, ?, ?, ?)')
        .run(job.entity, job.trigger, job.attempts + 1, error, now);
      this.db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
    });
  }

  replayDeadLetter(id: number, now: number): boolean {
    return this.tx(() => {
      const r = this.db.prepare('SELECT * FROM dead_letters WHERE id = ? AND replayed_at IS NULL').get(id) as Row | undefined;
      if (!r) return false;
      this.db.prepare('UPDATE dead_letters SET replayed_at = ? WHERE id = ?').run(now, id);
      this.enqueue(String(r.entity), 'manual', now);
      return true;
    });
  }

  deadLetters(includeReplayed = false): Row[] {
    return this.db
      .prepare(`SELECT * FROM dead_letters ${includeReplayed ? '' : 'WHERE replayed_at IS NULL'} ORDER BY id DESC LIMIT 200`)
      .all() as Row[];
  }

  jobs(): JobRow[] {
    return (this.db.prepare('SELECT * FROM jobs ORDER BY run_after').all() as Row[]).map((r) => this.toJob(r));
  }

  queueStats(now: number): { depth: number; oldestAgeMs: number; nextRunAt: number | null; dead: number } {
    const q = this.db.prepare('SELECT COUNT(*) n, MIN(enqueued_at) oldest, MIN(run_after) next FROM jobs').get() as Row;
    const d = this.db.prepare('SELECT COUNT(*) n FROM dead_letters WHERE replayed_at IS NULL').get() as Row;
    return {
      depth: Number(q.n),
      oldestAgeMs: q.oldest == null ? 0 : now - Number(q.oldest),
      nextRunAt: q.next == null ? null : Number(q.next),
      dead: Number(d.n),
    };
  }

  /** On startup of a single-instance deployment, leases held by a previous process are void. */
  releaseAllLeases(): void {
    this.db.exec('UPDATE jobs SET leased_until = NULL');
  }

  // ---------------------------------------------------------------- conflicts

  private toConflict(r: Row): ConflictRow {
    return {
      id: Number(r.id),
      linkId: Number(r.link_id),
      wfId: String(r.wf_id),
      jiraKey: (r.jira_key as string) ?? null,
      field: r.field as Field,
      reason: String(r.reason),
      wfValue: p(r.wf_value),
      jiraValue: p(r.jira_value),
      baseValue: p(r.base_value),
      status: r.status as ConflictRow['status'],
      resolution: p(r.resolution),
      createdAt: Number(r.created_at),
    };
  }

  /** Opens a conflict, or refreshes the values of the one already open for this field. Returns true if new. */
  upsertConflict(linkId: number, field: Field, reason: string, wf: unknown, jira: unknown, base: unknown, now: number): boolean {
    const existing = this.db.prepare(`SELECT id FROM conflicts WHERE link_id = ? AND field = ? AND status != 'resolved'`).get(linkId, field) as Row | undefined;
    if (existing) {
      this.db.prepare('UPDATE conflicts SET wf_value = ?, jira_value = ?, reason = ?, updated_at = ? WHERE id = ?').run(j(wf), j(jira), reason, now, Number(existing.id));
      return false;
    }
    this.db
      .prepare(`INSERT INTO conflicts (link_id, field, reason, wf_value, jira_value, base_value, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
      .run(linkId, field, reason, j(wf), j(jira), j(base), now, now);
    return true;
  }

  conflicts(status: 'unresolved' | 'all' = 'unresolved'): ConflictRow[] {
    const where = status === 'unresolved' ? `WHERE c.status != 'resolved'` : '';
    return (
      this.db.prepare(`SELECT c.*, l.wf_id, l.jira_key FROM conflicts c JOIN links l ON l.id = c.link_id ${where} ORDER BY c.id DESC`).all() as Row[]
    ).map((r) => this.toConflict(r));
  }

  conflictsForLink(linkId: number): ConflictRow[] {
    return (
      this.db.prepare(`SELECT c.*, l.wf_id, l.jira_key FROM conflicts c JOIN links l ON l.id = c.link_id WHERE c.link_id = ? AND c.status != 'resolved'`).all(linkId) as Row[]
    ).map((r) => this.toConflict(r));
  }

  /** A human picked a value; the next sync applies it and then closes the conflict. */
  resolveConflict(id: number, value: unknown, by: string, now: number): ConflictRow | null {
    const r = this.db
      .prepare(`UPDATE conflicts SET status = 'resolving', resolution = ?, resolved_by = ?, updated_at = ? WHERE id = ? AND status = 'open' RETURNING *`)
      .get(j(value), by, now, id) as Row | undefined;
    if (!r) return null;
    return this.conflicts('all').find((c) => c.id === id) ?? null;
  }

  closeConflicts(linkId: number, fields: Field[], now: number): void {
    const stmt = this.db.prepare(`UPDATE conflicts SET status = 'resolved', updated_at = ? WHERE link_id = ? AND field = ? AND status != 'resolved'`);
    for (const f of fields) stmt.run(now, linkId, f);
  }

  // ---------------------------------------------------------------- webhook inbox (dedupe)

  /** Returns true the first time a delivery id is seen. */
  markDelivery(deliveryId: string, source: string, now: number): boolean {
    const r = this.db.prepare('INSERT INTO inbox (delivery_id, source, received_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(deliveryId, source, now);
    return Number(r.changes) === 1;
  }

  pruneInbox(olderThan: number): number {
    return Number(this.db.prepare('DELETE FROM inbox WHERE received_at < ?').run(olderThan).changes);
  }

  // ---------------------------------------------------------------- audit

  audit(entries: AuditEntry[], now: number): void {
    if (entries.length === 0) return;
    const stmt = this.db.prepare('INSERT INTO audit (at, run_id, wf_id, jira_key, target, field, before, after, cause) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const e of entries) stmt.run(now, e.runId, e.wfId, e.jiraKey, e.target, e.field, j(e.before), j(e.after), e.cause);
  }

  auditFor(wfId?: string, limit = 100): Row[] {
    const rows = wfId
      ? this.db.prepare('SELECT * FROM audit WHERE wf_id = ? ORDER BY id DESC LIMIT ?').all(wfId, limit)
      : this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit);
    return (rows as Row[]).map((r) => ({ ...r, before: p(r.before), after: p(r.after) }));
  }

  // ---------------------------------------------------------------- kv

  get(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined;
    return r ? String(r.value) : null;
  }

  set(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
