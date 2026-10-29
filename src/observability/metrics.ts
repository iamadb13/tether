import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Metrics are chosen to answer the questions an on-call engineer actually asks:
 *
 *  "Are we in sync?"            tether_queue_oldest_age_seconds  (sync lag SLI), tether_open_conflicts
 *  "Is a vendor hurting us?"    tether_http_requests_total{system,status}, tether_circuit_state
 *  "Are webhooks being lost?"   tether_reconciler_repairs_total  (should be ~0; if not, webhooks are failing)
 *  "Are we wasting API quota?"  tether_sync_runs_total{outcome="noop"} vs "applied" (echo/duplicate load)
 *  "Is anything stuck?"         tether_dead_letters, tether_job_attempts_total{result}
 *
 * Each instance gets its own Registry so parallel tests don't share global state.
 */
export class Metrics {
  readonly registry = new Registry();

  readonly syncRuns = new Counter({
    name: 'tether_sync_runs_total',
    help: 'Sync runs by outcome (applied | noop | conflict | created | tombstoned | dry_run)',
    labelNames: ['outcome', 'trigger'],
    registers: [this.registry],
  });
  readonly syncDuration = new Histogram({
    name: 'tether_sync_duration_seconds',
    help: 'End-to-end duration of one entity sync (read both sides, merge, write)',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  readonly fieldWrites = new Counter({
    name: 'tether_field_writes_total',
    help: 'Field values written, by target system and field',
    labelNames: ['target', 'field'],
    registers: [this.registry],
  });
  readonly conflicts = new Counter({
    name: 'tether_conflicts_total',
    help: 'Concurrent edits detected, by field and how they were resolved',
    labelNames: ['field', 'resolution'],
    registers: [this.registry],
  });
  readonly httpRequests = new Counter({
    name: 'tether_http_requests_total',
    help: 'Outbound API calls by system, operation and status (or error class)',
    labelNames: ['system', 'op', 'status'],
    registers: [this.registry],
  });
  readonly httpDuration = new Histogram({
    name: 'tether_http_request_duration_seconds',
    help: 'Outbound API latency',
    labelNames: ['system', 'op'],
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  readonly circuitState = new Gauge({
    name: 'tether_circuit_state',
    help: 'Circuit breaker state per system (0 closed, 1 half-open, 2 open)',
    labelNames: ['system'],
    registers: [this.registry],
  });
  readonly webhooks = new Counter({
    name: 'tether_webhooks_received_total',
    help: 'Inbound webhooks by source and result (accepted | duplicate | ignored | rejected)',
    labelNames: ['source', 'result'],
    registers: [this.registry],
  });
  readonly jobAttempts = new Counter({
    name: 'tether_job_attempts_total',
    help: 'Queue job executions by result (ok | retry | deferred | dead)',
    labelNames: ['result'],
    registers: [this.registry],
  });
  readonly reconcilerRepairs = new Counter({
    name: 'tether_reconciler_repairs_total',
    help: 'Syncs triggered by the reconciler that actually changed data (i.e. a webhook was missed)',
    registers: [this.registry],
  });
  readonly concurrentEdits = new Counter({
    name: 'tether_concurrent_edits_total',
    help: 'Writes aborted because a human changed the field after Tether read it (emulated compare-and-set)',
    labelNames: ['system'],
    registers: [this.registry],
  });
  readonly reconcilerSkipped = new Counter({
    name: 'tether_reconciler_skipped_total',
    help: 'Items the reconciler saw in a search page but did not enqueue, because they match what Tether last saw',
    registers: [this.registry],
  });
  readonly queueDepth = new Gauge({ name: 'tether_queue_depth', help: 'Jobs waiting or running', registers: [this.registry] });
  readonly queueOldestAge = new Gauge({
    name: 'tether_queue_oldest_age_seconds',
    help: 'Age of the oldest pending job — the sync-lag SLI',
    registers: [this.registry],
  });
  readonly deadLetters = new Gauge({ name: 'tether_dead_letters', help: 'Jobs in the dead-letter queue', registers: [this.registry] });
  readonly openConflicts = new Gauge({ name: 'tether_open_conflicts', help: 'Conflicts awaiting a human decision', registers: [this.registry] });

  constructor(withDefaults = false) {
    if (withDefaults) collectDefaultMetrics({ register: this.registry, prefix: 'tether_process_' });
  }
}
