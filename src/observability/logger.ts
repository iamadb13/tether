import { pino, type Logger } from 'pino';

export type { Logger };

/**
 * Structured JSON logs. Every sync run gets a child logger carrying `runId`, `wfId` and
 * `jiraKey`, so a single grep for a work item reconstructs its whole history across webhooks,
 * retries and both vendors.
 */
export function createLogger(level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { svc: 'tether' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}

export const silentLogger = (): Logger => pino({ level: 'silent' });
