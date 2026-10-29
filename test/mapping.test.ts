import { describe, expect, it } from 'vitest';
import {
  adfToText,
  canonicalToJiraFields,
  canonicalToWfUpdate,
  instantToLocalDate,
  jiraToCanonical,
  localDateToWfDate,
  normaliseDescription,
  normaliseTitle,
  parseWfDate,
  textToAdf,
  wfToCanonical,
  type JiraIssue,
  type WfTask,
} from '../src/core/mapping.js';
import { PRIORITIES, STATUSES, type WorkItem } from '../src/core/model.js';
import { seededRng, pick } from '../src/core/rng.js';

/**
 * The property that matters most for a bidirectional sync: mapping must be a fixed point.
 * If canonical → vendor → canonical changes the value, every sync creates a "change" on the
 * other side and the two systems ping-pong forever.
 */
const cfg = { timeZone: 'Europe/Bucharest' };

function randomItem(rng: () => number): WorkItem {
  const words = ['launch', 'hero', 'banner', ' ', '\n', 'Ünïcödé', '🚀', 'a'.repeat(200), '  ', 'form'];
  const text = (n: number) => Array.from({ length: n }, () => pick(rng, words)).join(rng() < 0.3 ? '\n' : ' ');
  const day = 1 + Math.floor(rng() * 28);
  const month = 1 + Math.floor(rng() * 12);
  return {
    title: normaliseTitle(text(1 + Math.floor(rng() * 4)) || 'x'),
    description: normaliseDescription(text(Math.floor(rng() * 8))),
    status: pick(rng, STATUSES),
    dueDate: rng() < 0.2 ? null : `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    priority: pick(rng, PRIORITIES),
    assigneeEmail: null,
  };
}

function viaWorkfront(item: WorkItem): WorkItem {
  const u = canonicalToWfUpdate(item, cfg);
  const task: WfTask = {
    ID: 'wf-1',
    name: u.name as string,
    description: u.description as string,
    status: u.status as string,
    plannedCompletionDate: u.plannedCompletionDate as string | null,
    priority: u.priority as number,
    assignedToID: null,
    lastUpdateDate: '2026-10-25T10:00:00:000+0300',
    projectID: 'p',
    parameterValues: {},
  };
  return wfToCanonical(task, null, cfg);
}

function viaJira(item: WorkItem): WorkItem {
  const f = canonicalToJiraFields(item) as Record<string, any>;
  const issue: JiraIssue = {
    id: '1',
    key: 'ENG-1',
    fields: {
      summary: f.summary,
      description: f.description,
      status: { name: { todo: 'To Do', in_progress: 'In Progress', in_review: 'In Review', done: 'Done' }[item.status] },
      duedate: f.duedate,
      priority: f.priority,
      assignee: null,
      updated: '2026-10-25T10:00:00.000+0000',
      labels: [],
    },
  };
  return jiraToCanonical(issue, null);
}

describe('mapping round-trips are fixed points (no ping-pong)', () => {
  it('canonical → Workfront → canonical, 2 000 random items', () => {
    const rng = seededRng(42);
    for (let i = 0; i < 2000; i++) {
      const item = randomItem(rng);
      expect(viaWorkfront(item)).toEqual(item);
    }
  });

  it('canonical → Jira → canonical, 2 000 random items', () => {
    const rng = seededRng(43);
    for (let i = 0; i < 2000; i++) {
      const item = randomItem(rng);
      expect(viaJira(item)).toEqual(item);
    }
  });
});

describe('dates', () => {
  it('parses the Workfront colon-millisecond format', () => {
    expect(parseWfDate('2026-11-03T17:00:00:000+0200')).toBe(Date.parse('2026-11-03T15:00:00Z'));
  });

  it('a due date is the calendar day in the *business* timezone, not UTC', () => {
    // 00:30 local on 1 Nov is 22:30Z on 31 Oct — a UTC-based mapping would put it on the wrong day.
    expect(instantToLocalDate(parseWfDate('2026-11-01T00:30:00:000+0200'), 'Europe/Bucharest')).toBe('2026-11-01');
  });

  it('round-trips across the DST change (25 Oct 2026 in Europe)', () => {
    for (const d of ['2026-10-24', '2026-10-25', '2026-10-26', '2026-03-29']) {
      expect(instantToLocalDate(parseWfDate(localDateToWfDate(d, 'Europe/Bucharest')), 'Europe/Bucharest')).toBe(d);
    }
  });
});

describe('lossy conversions are normalised to the intersection of both systems', () => {
  it('titles become single-line and ≤255 chars (Jira summary limit)', () => {
    expect(normaliseTitle('  Hero\n banner  ')).toBe('Hero banner');
    expect(normaliseTitle('x'.repeat(300))).toHaveLength(255);
  });

  it('rich Jira descriptions flatten to text deterministically', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'Scope' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hero' }] }] }] },
      ],
    };
    expect(adfToText(adf)).toBe('Scope\n- hero');
    expect(adfToText(textToAdf(adfToText(adf)))).toBe('Scope\n- hero');
  });

  it('Workfront priority 0 and 1 both read as "low" and do not trigger a write back', () => {
    const t = (priority: number) => wfToCanonical({ ID: '1', name: 'x', description: '', status: 'NEW', plannedCompletionDate: null, priority, assignedToID: null, lastUpdateDate: '2026-10-25T10:00:00:000+0300', projectID: 'p', parameterValues: {} }, null, cfg);
    expect(t(0).priority).toBe('low');
    expect(t(1).priority).toBe('low');
  });

  it('unknown statuses fail loudly (config error → dead letter), never silently map', () => {
    expect(() => wfToCanonical({ ID: '1', name: 'x', description: '', status: 'ONH', plannedCompletionDate: null, priority: 2, assignedToID: null, lastUpdateDate: '2026-10-25T10:00:00:000+0300', projectID: 'p', parameterValues: {} }, null, cfg)).toThrow(/unmapped Workfront status 'ONH'/);
  });
});
