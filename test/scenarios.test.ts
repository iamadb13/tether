import { describe, expect, it } from 'vitest';
import { JIRA_KEY_FIELD } from '../src/core/vendor.js';
import { Harness } from '../src/testing/harness.js';

/**
 * End-to-end stories, each one a sentence the customer would say. They run the real service,
 * real HTTP clients and real webhook routes against the mock vendors (in-process, virtual time).
 */

async function withLinkedTask(h = new Harness()) {
  const t = h.wf.createTask({ name: 'Holiday campaign landing page', description: 'Hero banner + signup form', priority: 3, assignedToID: 'u-ben', plannedCompletionDate: '2026-11-20T17:00:00:000+0200' });
  await h.settle();
  const key = h.store.linkByWf(t.ID)!.jiraKey!;
  return { h, wfId: t.ID, key };
}

describe('happy path', () => {
  it('a task flagged in Workfront appears in Jira with all fields mapped, and links back', async () => {
    const { h, wfId, key } = await withLinkedTask();
    const issue = h.jira.issues.get(key)!;
    expect(issue.fields.summary).toBe('Holiday campaign landing page');
    expect(issue.fields.priority?.name).toBe('High');
    expect(issue.fields.duedate).toBe('2026-11-20');
    expect(issue.fields.assignee?.accountId).toBe('557058:ben');
    expect(issue.fields.labels).toContain(`tether-${wfId}`);
    expect(h.wf.tasks.get(wfId)!.parameterValues[JIRA_KEY_FIELD]).toBe(key);
    expect(h.divergence()).toEqual([]);
  });

  it('tasks not flagged for sync are left alone', async () => {
    const h = new Harness();
    h.wf.createTask({ name: 'Internal brainstorm' }, false);
    await h.settle();
    expect(h.jira.issues.size).toBe(0);
  });

  it('engineering progress in Jira shows up in Workfront', async () => {
    const { h, wfId, key } = await withLinkedTask();
    h.jira.setStatus(key, 'In Review');
    await h.settle();
    expect(h.wf.tasks.get(wfId)!.status).toBe('RVW');
  });

  it('a status set in Workfront is walked through the Jira workflow one transition at a time', async () => {
    const { h, wfId, key } = await withLinkedTask();
    h.wf.editTask(wfId, { status: 'CPL' }); // To Do → In Progress → In Review → Done
    await h.settle();
    expect(h.jira.issues.get(key)!.fields.status.name).toBe('Done');
    h.wf.editTask(wfId, { status: 'INP' }); // Done → (Reopen) To Do → In Progress
    await h.settle();
    expect(h.jira.issues.get(key)!.fields.status.name).toBe('In Progress');
  });
});

describe('conflicts', () => {
  it('concurrent edits to different fields both survive (field-level merge, no lost update)', async () => {
    const { h, wfId, key } = await withLinkedTask();
    h.setChaos({ webhookDropRate: 1 }); // make the edits truly concurrent: nobody syncs in between
    h.wf.editTask(wfId, { name: 'Holiday campaign landing page v2' });
    h.jira.editIssue(key, { priority: { name: 'Highest' } });
    h.calm();
    await h.settle();
    expect(h.jiraItem(key)!.title).toBe('Holiday campaign landing page v2');
    expect(h.wfItem(wfId)!.priority).toBe('urgent');
  });

  it('same-field conflicts follow the ownership policy (status: Jira wins, title: Workfront wins)', async () => {
    const { h, wfId, key } = await withLinkedTask();
    h.setChaos({ webhookDropRate: 1 });
    h.wf.editTask(wfId, { status: 'CPL', name: 'Title from marketing' });
    h.jira.editIssue(key, { status: { name: 'In Progress' }, summary: 'Title from engineering' });
    h.calm();
    await h.settle();
    expect(h.wfItem(wfId)).toMatchObject({ status: 'in_progress', title: 'Title from marketing' });
    expect(h.jiraItem(key)).toMatchObject({ status: 'in_progress', title: 'Title from marketing' });
  });

  it('a due-date conflict goes to the human inbox while other fields keep syncing, then resolves', async () => {
    const { h, wfId, key } = await withLinkedTask();
    h.setChaos({ webhookDropRate: 1 });
    h.wf.editTask(wfId, { plannedCompletionDate: '2026-11-27T17:00:00:000+0200', name: 'Renamed in WF' });
    h.jira.editIssue(key, { duedate: '2026-12-04' });
    h.calm();
    await h.settle();

    const [c] = h.store.conflicts();
    expect(c).toMatchObject({ field: 'dueDate', wfValue: '2026-11-27', jiraValue: '2026-12-04', baseValue: '2026-11-20', status: 'open' });
    expect(h.jiraItem(key)!.title).toBe('Renamed in WF'); // not blocked by the conflict
    expect(h.wfItem(wfId)!.dueDate).toBe('2026-11-27'); // neither side overwritten yet
    expect(h.jiraItem(key)!.dueDate).toBe('2026-12-04');

    const res = await h.tether.api.inject({
      method: 'POST',
      url: `/admin/conflicts/${c!.id}/resolve`,
      headers: { authorization: 'Bearer admin' },
      payload: { choose: 'jira' },
    });
    expect(res.statusCode).toBe(200);
    await h.settle();
    expect(h.wfItem(wfId)!.dueDate).toBe('2026-12-04');
    expect(h.store.conflicts()).toEqual([]);
    expect(h.divergence()).toEqual([]);
  });

  it('a conflict closes by itself if both sides converge on the same value', async () => {
    const { h, wfId, key } = await withLinkedTask();
    h.setChaos({ webhookDropRate: 1 });
    h.wf.editTask(wfId, { plannedCompletionDate: '2026-11-27T17:00:00:000+0200' });
    h.jira.editIssue(key, { duedate: '2026-12-04' });
    h.calm();
    await h.settle();
    expect(h.store.conflicts()).toHaveLength(1);
    h.jira.editIssue(key, { duedate: '2026-11-27' });
    await h.settle();
    expect(h.store.conflicts()).toEqual([]);
  });
});

describe('partial failure and retries', () => {
  it('echo webhooks from our own writes cause zero further writes', async () => {
    const { h, wfId } = await withLinkedTask();
    h.wf.editTask(wfId, { name: 'Edited once' });
    await h.settle();
    const writes = { wf: h.wf.apiCalls.writes, jira: h.jira.apiCalls.writes };
    // Re-deliver a burst of stale/duplicate events: still nothing to write.
    for (let i = 0; i < 5; i++) h.store.enqueue(`wf:${wfId}`, 'webhook', h.clock.now());
    await h.settle();
    expect({ wf: h.wf.apiCalls.writes, jira: h.jira.apiCalls.writes }).toEqual(writes);
  });

  it('a lost response on create does not produce a duplicate Jira issue', async () => {
    const h = new Harness();
    h.jira.chaos.failNext('POST', /\/rest\/api\/3\/issue$/, 'lost-response');
    const t = h.wf.createTask({ name: 'Ambiguous create' });
    await h.settle();
    expect(h.jira.issues.size).toBe(1);
    expect(h.store.linkByWf(t.ID)!.state).toBe('active');
    expect(h.divergence()).toEqual([]);
  });

  it('Workfront write succeeds, Jira write fails, Jira user edits before the retry: no spurious conflict', async () => {
    const { h, wfId, key } = await withLinkedTask();
    // WF edits title + due date; Jira's PUT fails once → half-applied sync.
    h.jira.chaos.failNext('PUT', /\/issue\/ENG-\d+$/, 503);
    h.jira.editIssue(key, { summary: 'Jira renamed it' }); // propagates to WF...
    h.wf.editTask(wfId, { priority: 4 }); // ...in the same run as this goes to Jira (and fails)
    await h.wf.webhooks.flush();
    await h.jira.webhooks.flush();
    await h.tether.worker.drain(1);
    expect(h.store.linkByWf(wfId)!.own.jira).not.toEqual({}); // write-ahead intent recorded
    // Before the retry, an engineer edits the title again.
    h.jira.editIssue(key, { summary: 'Jira renamed it twice' });
    await h.settle();
    expect(h.store.conflicts()).toEqual([]);
    expect(h.wfItem(wfId)).toMatchObject({ title: 'Jira renamed it twice', priority: 'urgent' });
    expect(h.divergence()).toEqual([]);
  });

  it('a Jira outage opens the circuit, defers work without dead-lettering, and drains on recovery', async () => {
    const { h, wfId, key } = await withLinkedTask();
    h.jira.chaos.set({ outage: true });
    for (let i = 0; i < 6; i++) h.wf.createTask({ name: `During outage ${i}` });
    h.wf.editTask(wfId, { name: 'Edited during outage' });
    for (let i = 0; i < 4; i++) {
      await h.wf.webhooks.flush();
      await h.tether.worker.drain();
      h.clock.advance(2_000);
    }
    expect(h.tether.clients.jira.breaker.state).toBe('open');
    expect(h.store.queueStats(h.clock.now()).dead).toBe(0);
    h.jira.chaos.set({ outage: false });
    await h.settle();
    expect(h.store.queueStats(h.clock.now()).dead).toBe(0);
    expect(h.jira.issues.size).toBe(7);
    expect(h.jiraItem(key)!.title).toBe('Edited during outage');
    expect(h.divergence()).toEqual([]);
  });

  it('when every webhook is lost, the reconciler still converges both systems', async () => {
    const { h, wfId, key } = await withLinkedTask();
    h.setChaos({ webhookDropRate: 1 });
    h.wf.editTask(wfId, { name: 'Changed while webhooks were down' });
    h.jira.setStatus(key, 'In Progress');
    const fresh = h.wf.createTask({ name: 'Created while webhooks were down' });
    await h.settle(); // idle → reconcile pass picks everything up
    expect(h.jiraItem(key)!.title).toBe('Changed while webhooks were down');
    expect(h.wfItem(wfId)!.status).toBe('in_progress');
    expect(h.store.linkByWf(fresh.ID)?.state).toBe('active');
    const repairs = await h.tether.metrics.reconcilerRepairs.get();
    expect(repairs.values[0]!.value).toBeGreaterThan(0);
  });

  it('a Jira-only change with every webhook lost is found by the Jira-side reconcile (JQL timezone-correct)', async () => {
    // The mock's API user lives in America/Los_Angeles: a JQL date formatted in UTC would point
    // hours into the future there and this change would never be found.
    const { h, wfId, key } = await withLinkedTask();
    // Move the Workfront watermark well past our item, so only the Jira-side search can find it.
    h.clock.advance(10 * 60_000);
    h.wf.createTask({ name: 'Unrelated later task' });
    await h.settle();
    h.setChaos({ webhookDropRate: 1 });
    h.clock.advance(10 * 60_000);
    h.jira.setStatus(key, 'Done');
    await h.settle();
    expect(h.wfItem(wfId)!.status).toBe('done');
  });

  it('a human edit landing between Tether’s read and its write is not overwritten (emulated compare-and-set)', async () => {
    // Arm a one-shot hook: right after Tether's next read of the Workfront task, a marketer edits it.
    let armed = false;
    let h!: Harness;
    h = new Harness({
      wrapTransport: (t, sys) => ({
        request: async (req) => {
          const res = await t.request(req);
          if (armed && sys === 'workfront' && req.method === 'GET' && /\/task\/wf-0001$/.test(req.path)) {
            armed = false;
            h.wf.editTask('wf-0001', { name: 'Marketer’s newer title' });
          }
          return res;
        },
      }),
    });
    h.wf.createTask({ name: 'Original' });
    await h.settle();
    const key = h.store.linkByWf('wf-0001')!.jiraKey!;
    armed = true;
    h.jira.editIssue(key, { summary: 'Engineer’s title' }); // Tether will read WF (old), then the marketer edits…
    await h.settle();
    // Both changed the title → policy says Workfront owns titles → the marketer's newer title wins on both sides.
    expect(h.wfItem('wf-0001')!.title).toBe('Marketer’s newer title');
    expect(h.jiraItem(key)!.title).toBe('Marketer’s newer title');
    const aborted = await h.tether.metrics.concurrentEdits.get();
    expect(aborted.values.reduce((a, v) => a + v.value, 0)).toBe(1);
  });

  it('a permanent error dead-letters immediately and can be replayed after the fix', async () => {
    const { h, wfId } = await withLinkedTask();
    h.wf.tasks.set(wfId, { ...h.wf.tasks.get(wfId)!, status: 'XYZ' }); // a status nobody mapped
    h.store.enqueue(`wf:${wfId}`, 'manual', h.clock.now());
    await h.settle({ reconcile: false });
    const [dl] = h.store.deadLetters();
    expect(String(dl!.error)).toMatch(/unmapped Workfront status 'XYZ'/);
    expect(Number(dl!.attempts)).toBe(1); // not retried 8 times

    h.wf.editTask(wfId, { status: 'INP' }); // admin fixes the data
    await h.tether.api.inject({ method: 'POST', url: `/admin/dead-letters/${dl!.id}/replay`, headers: { authorization: 'Bearer admin' } });
    await h.settle();
    expect(h.jiraFor(wfId)!.status).toBe('in_progress');
  });
});

describe('edge cases customers hit in week one', () => {
  it('an assignee who only exists in Workfront is parked for a human, everything else still syncs', async () => {
    const { h, wfId, key } = await withLinkedTask();
    h.wf.editTask(wfId, { assignedToID: 'u-dana', name: 'Reassigned' });
    await h.settle();
    const [c] = h.store.conflicts();
    expect(c).toMatchObject({ field: 'assigneeEmail', reason: 'unmapped_user', wfValue: 'dana@brand.example' });
    expect(h.jiraItem(key)).toMatchObject({ title: 'Reassigned', assigneeEmail: 'ben@brand.example' });
    expect(h.wfItem(wfId)!.assigneeEmail).toBe('dana@brand.example'); // WF not overwritten back
  });

  it('deleting the Workfront task never deletes the Jira issue; it is tombstoned with a comment', async () => {
    const { h, wfId, key } = await withLinkedTask();
    h.wf.deleteTask(wfId);
    await h.settle();
    expect(h.jira.issues.has(key)).toBe(true);
    expect(h.store.linkByWf(wfId)!.state).toBe('tombstoned');
    expect(h.jira.comments.get(key)?.length).toBe(1);
  });

  it('a 300-character Workfront title does not ping-pong with Jira’s 255-char limit', async () => {
    const h = new Harness();
    const t = h.wf.createTask({ name: 'A'.repeat(300) });
    await h.settle();
    const writes = h.wf.apiCalls.writes;
    h.store.enqueue(`wf:${t.ID}`, 'manual', h.clock.now());
    await h.settle();
    expect(h.wf.tasks.get(t.ID)!.name).toHaveLength(300); // Workfront keeps the full title
    expect(h.wf.apiCalls.writes).toBe(writes);
  });

  it('the drift report shows what would change without writing anything', async () => {
    const { h, key } = await withLinkedTask();
    h.setChaos({ webhookDropRate: 1 });
    h.jira.editIssue(key, { summary: 'Drifted in Jira' });
    const writes = h.wf.apiCalls.writes + h.jira.apiCalls.writes;
    const res = await h.tether.api.inject({ method: 'GET', url: '/admin/drift', headers: { authorization: 'Bearer admin' } });
    expect(res.json()).toMatchObject({ drifted: 1, report: [{ jiraKey: key, toWorkfront: { title: 'Drifted in Jira' } }] });
    expect(h.wf.apiCalls.writes + h.jira.apiCalls.writes).toBe(writes);
  });

  it('rejects webhooks with a bad signature and dedupes redelivered ones', async () => {
    const { h } = await withLinkedTask();
    const bad = await h.tether.api.inject({ method: 'POST', url: '/webhooks/jira', headers: { 'content-type': 'application/json', 'x-hub-signature': 'sha256=nope' }, payload: '{}' });
    expect(bad.statusCode).toBe(401);
    const body = JSON.stringify({ webhookEvent: 'jira:issue_updated', issue: { key: 'ENG-1', fields: {} } });
    const send = () =>
      h.tether.api.inject({
        method: 'POST',
        url: '/webhooks/jira',
        headers: { 'content-type': 'application/json', 'x-hub-signature': h.jira.sign(body), 'x-atlassian-webhook-identifier': 'same-id' },
        payload: body,
      });
    expect((await send()).json()).toMatchObject({ queued: expect.any(String) });
    expect((await send()).json()).toMatchObject({ duplicate: true });
  });
});
