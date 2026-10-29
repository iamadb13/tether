# Vendor research: the facts the design and the mocks are built on

The mocks imitate the failure modes and API quirks below. Where I couldn't confirm a detail, it is
marked as an assumption. These details must be re-verified against the customer's tenant before go-live.

## Adobe Workfront

| Fact | Source | Where it shows up in Tether |
|---|---|---|
| Event subscription endpoints must return **2xx within 5 seconds**, or the message counts as failed | [Delivery requirements](https://experienceleague.adobe.com/en/docs/workfront/using/adobe-workfront-api/event-subscriptions/setup-event-sub-endpoint) | The webhook handler only authenticates, dedupes and enqueues. It never calls a vendor API inline |
| Failed deliveries are **retried with backoff for up to 48 h** (11 attempts); subscriptions can be auto-disabled after repeated failure | [Event subscription retries](https://experienceleague.adobe.com/en/docs/workfront/using/adobe-workfront-api/event-subscriptions/event-sub-retries), [FAQ](https://experienceleague.adobe.com/en/docs/workfront/using/adobe-workfront-api/event-subscriptions/event-subs-faq) | Webhooks are treated as *hints*. A reconciler is the safety net if a subscription is frozen or disabled |
| Recommended pattern: **save the message, respond immediately, process later** | same | Durable queue (SQLite) between ingest and processing |
| Messages ≤ 1 MB | same | `bodyLimit: 1 MB` on the webhook route |
| Status values are 3-letter keys (NEW / INP / CPL…), plus custom statuses | [System task statuses](https://experienceleague.adobe.com/en/docs/workfront/using/administration-and-setup/customize/statuses-priority-labels/system-task-statuses), [community](https://experienceleaguecommunities.adobe.com/t5/workfront-questions/populating-plain-language-task-status-on-a-project-report-help/m-p/684738/highlight/true) | Explicit status map. An unknown status is a configuration error and is dead-lettered with a clear message, never guessed |
| Custom fields are addressed with a `DE:` prefix | Workfront API conventions | `DE:Sync to Jira` (opt-in flag), `DE:Jira Key` (click-through link) |
| Native Jira connector: largely one-directional, tasks from all projects route to a single Jira project, per-user mapping is high-maintenance | [Community thread 1](https://experienceleaguecommunities.adobe.com/adobe-workfront-23/how-does-jira-works-with-workfront-125158), [thread 2](https://experienceleaguecommunities.adobe.com/t5/workfront-questions/integration-between-jira-and-workfront/m-p/647142) | The "why not the built-in connector" part of the customer story |
| *Assumption:* event payloads carry `eventType`, `newState`, `oldState` | Event Subscription API docs | Only the object ID is used, so payload shape changes are low-risk |
| *Assumption:* datetime format `2026-11-03T17:00:00:000+0200` (colon before milliseconds) | Observed in API examples | `parseWfDate` also accepts plain ISO |

## Jira Cloud

| Fact | Source | Where it shows up in Tether |
|---|---|---|
| Webhooks can be **delivered more than once**. `X-Atlassian-Webhook-Identifier` is stable across retries | [Jira webhooks](https://developer.atlassian.com/cloud/jira/platform/webhooks/) | Inbox table dedupes on that header |
| Retries happen on 408/409/425/429/5xx and timeouts, **up to 5 times**, 5–15 minutes apart; deliveries can be delayed (up to ~30 min reported) | [Webhooks](https://developer.atlassian.com/cloud/jira/platform/webhooks/), [retry policy announcement](https://community.developer.atlassian.com/t/new-jira-cloud-webhook-retry-policy/30554) | No ordering assumption at all: every run re-reads current state |
| **No documented ordering guarantee** | (absence in docs; retries imply reordering) | State-based sync makes order irrelevant |
| Rate limiting is layered: per-second burst limits per endpoint, **per-issue write limits**, and an hourly points quota | [Respecting rate limits](https://developer.atlassian.com/cloud/jira/platform/build-an-app-that-respects-rate-limits/) | Proactive token bucket, reactive pause, coalescing per issue |
| `Retry-After` is **not always present** on 429. Fall back to `X-RateLimit-Reset` | [Missing headers thread](https://community.developer.atlassian.com/t/jira-cloud-api-rate-limits-and-missing-headers/94358), [incident](https://developer.status.atlassian.com/incidents/bb38p4wdd7mz) | `retryAfterMs()`: Retry-After → X-RateLimit-Reset → 5 s default. The mock omits Retry-After 30% of the time |
| Status cannot be set as a field. It changes via **workflow transitions**, and only those available from the current status are visible | Jira REST v3 | `transitionTo()` walks the workflow hop by hop. Each hop is recorded as "ours" before it is made |
| Descriptions are **Atlassian Document Format** (ADF) | Jira REST v3 | `textToAdf` / `adfToText`, round-trip tested |
| Search is `POST /rest/api/3/search/jql` with cursor pagination (`nextPageToken`). JQL dates are minute-granular | Jira REST v3 (enhanced search) | Reconciler overlap window ≥ 1 minute. Cursor pagination in the connector |
| Summary ≤ 255 characters | Jira field limits | Titles are normalised to ≤ 255 chars in *both* directions, so they don't ping-pong |
| E-mail addresses are often **hidden** by profile visibility settings | Atlassian privacy controls | `JIRA_USER_MAP` override. An unresolvable assignee becomes a stable placeholder identity that goes to the inbox, **never** "unassigned", which would clear the Workfront assignee |
| JQL date literals are interpreted in the **API user's profile timezone** | Jira JQL reference (date fields) | The reconciler reads `timeZone` from `GET /myself` and formats JQL dates in it. The mock user lives in Los Angeles to keep this honest |
| `POST /search/jql` returns **only issue ids unless `fields` is requested** | Jira REST v3 enhanced search | Every search names its fields; the mock behaves the same way |
| The search index is **eventually consistent**: a new issue can be unsearchable for a few seconds | Common Atlassian developer guidance; measured by `npm run preflight -- --deep` | The create path waits out the lag before trusting a negative marker search; the mock models a 1–3 s lag |
| Team-managed projects usually allow **any-to-any** transitions; company-managed ones can restrict them | Jira workflow docs | `transitionTo` handles both: one hop, or a walk through allowed transitions |
| Webhooks can't reach `localhost` | Network reality | Demo against a real site uses 3 s reconciler polling; production uses an admin webhook with a secret |
