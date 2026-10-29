import { existsSync } from 'node:fs';
import { z } from 'zod';
import { DEFAULT_JIRA_STATUSES, type JiraStatusMap } from './core/mapping.js';
import type { Policies } from './core/merge.js';
import { STATUSES, type Status } from './core/model.js';

/**
 * Default field ownership. This table *is* the customer agreement, written down:
 *
 *  title, description  → Workfront wins: marketing owns the brief.
 *  status              → Jira wins: engineering owns delivery progress.
 *  dueDate             → manual: a launch date is a business commitment; when both sides move it
 *                        differently, a human decides (conflict inbox) rather than an algorithm.
 *  priority, assignee  → latest edit wins: low stakes, frequently re-triaged on both sides.
 *
 * Non-conflicting edits always flow in both directions regardless of this table; it only decides
 * what happens when the *same field* was changed on *both sides* since the last sync.
 */
export const DEFAULT_POLICIES: Policies = {
  title: 'workfront',
  description: 'workfront',
  status: 'jira',
  dueDate: 'manual',
  priority: 'latest',
  assigneeEmail: 'latest',
};

const policy = z.enum(['workfront', 'jira', 'latest', 'manual']);

const Env = z.object({
  PORT: z.coerce.number().default(4000),
  DB_PATH: z.string().default('./data/tether.db'),
  TIMEZONE: z.string().default('Europe/Bucharest'),

  WORKFRONT_BASE_URL: z.string().url().transform((u) => u.replace(/\/+$/, '')).default('http://127.0.0.1:4001'),
  WORKFRONT_API_KEY: z.string().default('wf-demo-key'),
  WORKFRONT_WEBHOOK_TOKEN: z.string().default('wf-webhook-token'),
  WORKFRONT_RPS: z.coerce.number().default(10),

  JIRA_BASE_URL: z.string().url().transform((u) => u.replace(/\/+$/, '')).default('http://127.0.0.1:4002'),
  JIRA_EMAIL: z.string().default('tether@brand.example'),
  JIRA_API_TOKEN: z.string().default('jira-demo-token'),
  JIRA_PROJECT_KEY: z.string().default('ENG'),
  JIRA_ISSUE_TYPE: z.string().default('Task'),
  /** e.g. "todo=To Do,in_progress=In Progress,in_review=In Review,done=Done" */
  JIRA_STATUSES: z.string().optional(),
  /** e.g. "ben@brand.example=557058:abc,ana@brand.example=712020:def" (needed when Jira hides e-mails) */
  JIRA_USER_MAP: z.string().optional(),
  JIRA_WEBHOOK_SECRET: z.string().default('jira-demo-secret'),
  JIRA_RPS: z.coerce.number().default(10),
  JIRA_INDEX_LAG_MS: z.coerce.number().default(15_000),

  ADMIN_TOKEN: z.string().default('admin'),
  RECONCILE_INTERVAL_MS: z.coerce.number().default(15_000),
  HTTP_TIMEOUT_MS: z.coerce.number().default(5_000),
  WORKER_CONCURRENCY: z.coerce.number().default(4),
  MAX_ATTEMPTS: z.coerce.number().default(8),

  POLICY_TITLE: policy.optional(),
  POLICY_DESCRIPTION: policy.optional(),
  POLICY_STATUS: policy.optional(),
  POLICY_DUE_DATE: policy.optional(),
  POLICY_PRIORITY: policy.optional(),
  POLICY_ASSIGNEE: policy.optional(),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const e = Env.parse(env);
  const policies: Policies = {
    title: e.POLICY_TITLE ?? DEFAULT_POLICIES.title,
    description: e.POLICY_DESCRIPTION ?? DEFAULT_POLICIES.description,
    status: e.POLICY_STATUS ?? DEFAULT_POLICIES.status,
    dueDate: e.POLICY_DUE_DATE ?? DEFAULT_POLICIES.dueDate,
    priority: e.POLICY_PRIORITY ?? DEFAULT_POLICIES.priority,
    assigneeEmail: e.POLICY_ASSIGNEE ?? DEFAULT_POLICIES.assigneeEmail,
  };
  return { ...e, policies, jiraStatuses: parseStatuses(e.JIRA_STATUSES), jiraUserMap: parsePairs(e.JIRA_USER_MAP) };
}

function parsePairs(s: string | undefined): Record<string, string> {
  if (!s) return {};
  return Object.fromEntries(
    s.split(',').map((kv) => {
      const i = kv.indexOf('=');
      if (i < 1) throw new Error(`bad key=value pair '${kv}'`);
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
}

function parseStatuses(s: string | undefined): JiraStatusMap {
  const m = { ...DEFAULT_JIRA_STATUSES, ...parsePairs(s) };
  for (const k of Object.keys(m)) if (!STATUSES.includes(k as Status)) throw new Error(`JIRA_STATUSES: unknown canonical status '${k}'`);
  return m;
}

/** Load ./.env (if present) without overriding real environment variables. */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
