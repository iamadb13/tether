/**
 * Error taxonomy. The queue's behaviour is driven entirely by these classes:
 *
 *  - TransientError     → retry with backoff (5xx, timeouts, network). May be *ambiguous*:
 *                          the write could have been applied before the response was lost.
 *  - RateLimitedError   → retry no earlier than `retryAfterMs`; not counted as a failure
 *                          for the circuit breaker.
 *  - CircuitOpenError   → the downstream is known to be unhealthy; defer without burning
 *                          an attempt (an outage is not a poison message).
 *  - NotYetError       → defer for `retryAfterMs` without counting an attempt (eventual consistency).
 *  - NotFoundError      → the counterpart record no longer exists; handled by the syncer.
 *  - PermanentError     → retrying cannot help (validation, auth, workflow); dead-letter now.
 */
export class SyncError extends Error {
  constructor(
    message: string,
    readonly system?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class TransientError extends SyncError {
  constructor(
    message: string,
    system?: string,
    readonly ambiguous = false,
  ) {
    super(message, system);
  }
}

export class RateLimitedError extends SyncError {
  constructor(
    message: string,
    system: string,
    readonly retryAfterMs: number,
  ) {
    super(message, system);
  }
}

/** Not an error of the downstream: we must simply wait (e.g. for Jira's search index to catch up). */
export class NotYetError extends SyncError {
  constructor(
    message: string,
    system: string,
    readonly retryAfterMs: number,
  ) {
    super(message, system);
  }
}

/**
 * A human changed a field we were about to overwrite, after we read it. Neither vendor offers
 * conditional writes, so the syncer re-reads right before writing and aborts the run; it is
 * re-queued immediately (not a failure, not counted as an attempt) and re-decided on fresh data.
 */
export class ConcurrentEditError extends NotYetError {
  constructor(system: string, fields: string[]) {
    super(`${system} changed under us (${fields.join(', ')}); re-running with fresh data`, system, 0);
  }
}

export class CircuitOpenError extends SyncError {
  constructor(
    system: string,
    readonly retryAt: number,
  ) {
    super(`circuit open for ${system}`, system);
  }
}

export class NotFoundError extends SyncError {}

export class PermanentError extends SyncError {}

export const isRetryable = (e: unknown): boolean =>
  e instanceof TransientError || e instanceof RateLimitedError || e instanceof CircuitOpenError || e instanceof NotYetError;
