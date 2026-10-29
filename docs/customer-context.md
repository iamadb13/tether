# Customer context (assumed) and the value Tether creates

> The brief is intentionally open. Everything here is a **fictional but realistic** composite, written
> the way I'd write it after a first discovery call. The numbers are assumptions to validate with the customer,
> not facts.

## The customer

**Lumen & Co.** (fictional) is a mid-size European consumer brand with about €400M revenue, selling direct-to-consumer
online in 6 markets.

| Team | Tool | Owns | Size |
|---|---|---|---|
| Brand Marketing (campaign managers, creative ops) | **Adobe Workfront** | the plan: campaigns, briefs, launch dates, approvals | ~35 |
| Digital Engineering (web, e-commerce, analytics) | **Jira Cloud** | delivery: landing pages, banners, tracking, feeds | ~20 |

Each campaign in Workfront breaks into tasks. About **150 a month** need engineering work, such as a landing page,
a promo banner, a signup form or analytics tags. Each one has to exist as a Jira issue that engineers can pull into their sprint.

## The pain (what we heard in "discovery")

1. **Re-keying.** Three marketing project managers copy each engineering task from Workfront into Jira by hand.
   They then chase status back ("is the landing page done?") in Slack and copy it into Workfront. We assume **~6 hours per PM per week**.
2. **Drift causes missed launches.** A launch date moves in Workfront but the Jira due date doesn't follow, so
   engineering builds against a stale date. Two Q3 campaigns slipped because of this. Each one cost paid media that was
   already booked for launch day.
3. **No single source of truth.** Workfront reports show "In Progress" for work that engineering finished days
   ago, so leadership doesn't trust the plan.
4. **The native connector didn't fit.** They tried Workfront's built-in Jira integration. It syncs mostly one way, routes
   everything to one Jira project, and needs a person-by-person user mapping that broke whenever someone joined. (These
   limitations are reported in Adobe's own community forums; see [research.md](research.md).) Workfront Fusion could do this,
   but nobody on their side owns a low-code scenario that has to handle retries, conflicts and drift correctly. That logic
   is the hard part, and it is the part this service is built around.

## What the customer actually wants (in their words)

- "When a task is flagged for engineering in Workfront, it should just *appear* in Jira."
- "Engineers should never have to open Workfront."
- "When engineering moves a card, the plan should update itself."
- "If someone changes the launch date on both sides, **don't guess**. Tell us."
- "If it breaks, we need to know before the campaign manager does."

## Assumptions behind the design

| # | Assumption | Design consequence |
|---|---|---|
| A1 | Marketing owns the *brief* (title, description); engineering owns *delivery status* | Ownership policy per field (`workfront` / `jira`) |
| A2 | Launch dates are business commitments | `dueDate` conflicts go to a human inbox (`manual`) |
| A3 | Priority and assignee are re-triaged on both sides | `latest` edit wins |
| A4 | Only tasks with the custom field **"Sync to Jira" = Yes** are in scope | Explicit opt-in; nothing else is touched |
| A5 | People are the same people in both tools, matched by **e-mail** | No user-mapping table to maintain; anyone missing on one side goes to the inbox |
| A6 | One business timezone (Europe/Bucharest); due dates are calendar days | Date-only canonical due date, written to Workfront as 17:00 local |
| A7 | Volume: hundreds to low thousands of active items, a few thousand edits a day | Single process + SQLite is enough; there is a scaling path for 10–100× |
| A8 | Deleting in one tool must never destroy work in the other | Tombstone and comment, never cascade-delete |
| A9 | Comments and attachments are nice-to-have for v1 | Explicitly out of scope (see README) |

## Value

| Outcome | Estimate (to validate) |
|---|---|
| Manual re-keying removed | 3 PMs × ~6 h/week × 46 weeks ≈ **800+ hours/year** (≈ €45k at a €55/h loaded cost) |
| Fewer missed launches caused by stale dates | Even one avoided slip per quarter protects booked media spend that is usually much larger than the above |
| A plan leadership can trust | Workfront status reflects Jira within seconds (sync-lag SLI on the dashboard) |
| Trust in the integration itself | Every field change is audited ("who changed my date, when, why"), conflicts are visible, failures are alerted on |

## How I would roll this out as an FDE

0. **Day 1.** Run `npm run preflight -- --deep` against their Jira. It checks auth, the project, issue type, fields on
   the create screen, statuses, priorities and user visibility, and measures the search-index lag, with a fix for every red line.
1. **Week 1, read-only.** Connect to both systems and run the **drift report** (`npm run drift`) over the existing
   items. This writes nothing anywhere. It shows the customer how far their systems have already drifted apart, and that
   number becomes the baseline for the value story.
2. **Week 2, pilot.** Turn on sync for *one* campaign. Hold a 15-minute daily review of the conflict inbox
   with a marketing PM and an engineering lead. Tune the field-ownership table, which is plain configuration.
3. **Week 3+, expand.** Roll out to all campaigns and hand over the runbook and dashboard to their ops team.
4. **Measure.** Track PM hours spent re-keying (survey), date-drift incidents, sync lag p95 and conflicts per week.

Open questions I'd bring to the next call: other custom fields that matter (budget codes, Jira epics, components)?
Do they want sub-tasks? Who owns the conflict inbox day to day? Is there one Jira project or several?
