import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildBriefing, emptyDismissals, type DismissalState } from '../apps/client/src/briefing.js';
import type { Draft, Entity, Snapshot, Task } from '../packages/domain/contracts.js';

function makeTask(overrides: Partial<Task> & { id: string }): Entity<Task> {
  return {
    id: overrides.id,
    revision: 1,
    deviceId: "test-device",
    updatedAt: new Date().toISOString(),
    value: {
      title: 'Test task',
      notes: '',
      status: 'open',
      planned: null,
      due: null,
      ...overrides,
    } as Task,
  };
}

function makeSnapshot(tasks: Entity<Task>[]): Snapshot {
  return {
    epoch: 'test',
    cursor: 0,
    deviceId: 'test-device',
    layout: { id: 'layout', revision: 1, updatedAt: '', value: { widgets: [] } } as any,
    tasks,
    drafts: [],
    projects: [],
    capabilities: { assistant: false, voice: false, reason: '' },
  } as Snapshot;
}

const NOW = new Date('2026-09-30T09:00:00').getTime();

describe('buildBriefing', () => {
  it('ranks overdue high-priority tasks in tier 1', () => {
    const snapshot = makeSnapshot([
      makeTask({ id: 't1', due: '2026-09-28', priority: 'high' }),
      makeTask({ id: 't2', due: '2026-09-28', priority: 'normal' }),
    ]);
    const briefing = buildBriefing(snapshot, NOW, emptyDismissals());
    assert.equal(briefing.items.length, 2);
    assert.equal(briefing.items[0].id, 't1');
    assert.equal(briefing.items[0].tier, 1);
    assert.equal(briefing.items[1].tier, 4);
  });

  it('uses honest wording for overdue tasks', () => {
    const snapshot = makeSnapshot([makeTask({ id: 't1', due: '2026-09-28' })]);
    const briefing = buildBriefing(snapshot, NOW, emptyDismissals());
    assert.match(briefing.items[0].detail, /Due date was 2 days ago/);
    assert.doesNotMatch(briefing.items[0].detail, /late/i);
  });

  it('places blocked tasks in tier 2', () => {
    const snapshot = makeSnapshot([
      makeTask({ id: 't1', status: 'blocked', waitReason: 'Needs approval' }),
    ]);
    const briefing = buildBriefing(snapshot, NOW, emptyDismissals());
    assert.equal(briefing.items[0].tier, 2);
    assert.match(briefing.items[0].detail, /Needs approval/);
  });

  it('includes due-today tasks in tier 3', () => {
    const snapshot = makeSnapshot([makeTask({ id: 't1', due: '2026-09-30' })]);
    const briefing = buildBriefing(snapshot, NOW, emptyDismissals());
    assert.equal(briefing.items[0].tier, 3);
    assert.equal(briefing.items[0].detail, 'Due today.');
  });

  it('only includes due-tomorrow tasks with substantial estimates', () => {
    const snapshot = makeSnapshot([
      makeTask({ id: 't1', due: '2026-10-01', estimateMinutes: 90 }),
      makeTask({ id: 't2', due: '2026-10-01', estimateMinutes: 15 }),
    ]);
    const briefing = buildBriefing(snapshot, NOW, emptyDismissals());
    assert.equal(briefing.items.length, 1);
    assert.equal(briefing.items[0].id, 't1');
  });

  it('respects dismissals', () => {
    const snapshot = makeSnapshot([makeTask({ id: 't1', due: '2026-09-28' })]);
    const dismissals: DismissalState = {
      dismissed: { 'task:t1:2026-09-30': 'hidden' },
      snoozeUntil: {},
    };
    const briefing = buildBriefing(snapshot, NOW, dismissals);
    assert.equal(briefing.items.length, 0);
  });

  it('respects snooze expiry', () => {
    const snapshot = makeSnapshot([makeTask({ id: 't1', due: '2026-09-28' })]);
    const dismissals: DismissalState = {
      dismissed: { 'task:t1:2026-09-30': 'snoozed' },
      snoozeUntil: { 'task:t1:2026-09-30': NOW - 1000 }, // expired
    };
    const briefing = buildBriefing(snapshot, NOW, dismissals);
    assert.equal(briefing.items.length, 1);
  });

  it('caps at 5 items and reports overflow', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => makeTask({ id: `t${i}`, due: '2026-09-28' }));
    const snapshot = makeSnapshot(tasks);
    const briefing = buildBriefing(snapshot, NOW, emptyDismissals());
    assert.equal(briefing.items.length, 5);
    assert.equal(briefing.overflowCount, 3);
  });

  it('skips completed and trashed tasks', () => {
    const snapshot = makeSnapshot([
      makeTask({ id: 't1', due: '2026-09-28', status: 'done' }),
      makeTask({ id: 't2', due: '2026-09-28', trashed: true }),
    ]);
    const briefing = buildBriefing(snapshot, NOW, emptyDismissals());
    assert.equal(briefing.items.length, 0);
  });

  it('every item has a whyThis with source, freshness, and reason', () => {
    const snapshot = makeSnapshot([makeTask({ id: 't1', due: '2026-09-28' })]);
    const briefing = buildBriefing(snapshot, NOW, emptyDismissals());
    const why = briefing.items[0].whyThis;
    assert.ok(why.source.length > 0);
    assert.ok(why.freshness.length > 0);
    assert.ok(why.reason.length > 0);
  });

  it('does not present the generation clock as a source observation time', () => {
    const snapshot = makeSnapshot([makeTask({ id: 't1', due: '2026-09-28' })]);
    const first = buildBriefing(snapshot, NOW, emptyDismissals());
    const later = buildBriefing(snapshot, NOW + 60 * 60 * 1000, emptyDismissals());
    assert.equal(first.freshnessLine, 'From saved tasks and drafts');
    assert.equal(later.freshnessLine, first.freshnessLine);
    assert.equal(later.items[0].whyThis.freshness, first.items[0].whyThis.freshness);
    assert.notEqual(later.generatedAt, first.generatedAt);
  });

  it('prepares for the next calendar day across both daylight saving transitions', () => {
    for (const [now, due] of [
      // Adding 24 hours to Saturday night skips to Monday after spring-forward.
      ['2026-03-08T07:30:00Z', '2026-03-08'],
      // Adding 24 hours near fall-back stays on the same local date.
      ['2026-11-01T07:30:00Z', '2026-11-02'],
    ]) {
      const snapshot = makeSnapshot([makeTask({ id: 'next-day', due, estimateMinutes: 90 })]);
      const briefing = buildBriefing(snapshot, Date.parse(now), emptyDismissals(), 'America/Los_Angeles');
      assert.equal(briefing.items.length, 1, `${now} should include ${due}`);
      assert.equal(briefing.items[0].id, 'next-day');
      assert.match(briefing.items[0].detail, /Due tomorrow/);
    }
  });

  it('keeps timed snoozes hidden through midnight without a per-day snoozed marker', () => {
    const snapshot = makeSnapshot([makeTask({ id: 't1', due: '2026-09-28' })]);
    const until = Date.parse('2026-10-01T14:00:00Z'); // 07:00 in Los Angeles.
    const dismissals: DismissalState = {
      dismissed: { 'task:t1:2026-09-30': 'hidden' },
      snoozeUntil: { 'task:t1': until },
    };
    for (const now of ['2026-10-01T06:59:00Z', '2026-10-01T07:01:00Z', '2026-10-01T13:59:00Z']) {
      assert.equal(buildBriefing(snapshot, Date.parse(now), dismissals, 'America/Los_Angeles').items.length, 0);
    }
    assert.equal(buildBriefing(snapshot, until, dismissals, 'America/Los_Angeles').items.length, 1);
    // The same-day hide is a separate decision and remains effective after expiry.
    dismissals.dismissed['task:t1:2026-10-01'] = 'hidden';
    assert.equal(buildBriefing(snapshot, until, dismissals, 'America/Los_Angeles').items.length, 0);
  });

  it('continues honoring unexpired legacy snoozes', () => {
    const snapshot = makeSnapshot([makeTask({ id: 't1', due: '2026-09-28' })]);
    const dismissals: DismissalState = {
      dismissed: { 'task:t1:2026-09-30': 'snoozed' },
      snoozeUntil: { 'task:t1:2026-09-30': NOW + 1000 },
    };
    assert.equal(buildBriefing(snapshot, NOW, dismissals).items.length, 0);
  });

  it('counts due and blocked work once, retaining both reasons and the stronger priority', () => {
    const snapshot = makeSnapshot(Array.from({ length: 5 }, (_, index) => makeTask({
      id: `t${index}`, due: '2026-09-28', status: 'blocked',
      waitReason: 'Waiting for a reply', priority: index === 0 ? 'high' : 'normal',
    })));
    const briefing = buildBriefing(snapshot, NOW, emptyDismissals());
    assert.equal(briefing.items.length, 5);
    assert.equal(briefing.overflowCount, 0);
    assert.equal(new Set(briefing.items.map(item => item.id)).size, 5);
    assert.equal(briefing.items[0].tier, 1);
    for (const item of briefing.items) {
      assert.ok(snapshot.tasks.some(task => task.id === item.id));
      assert.match(item.detail, /Due date was 2 days ago/);
      assert.match(item.detail, /Waiting for a reply/);
      assert.match(item.whyThis.reason, /due date/i);
      assert.match(item.whyThis.reason, /blocked/);
      assert.doesNotMatch(item.whyThis.reason, /only you/i);
      assert.equal(item.actions[0].taskId, item.id);
      if (item.id !== 't0') assert.equal(item.tier, 2);
    }
  });

  it('keeps blocked-only tasks on their real identity without assigning ownership', () => {
    const snapshot = makeSnapshot([makeTask({ id: 'blocked', status: 'waiting' })]);
    const [item] = buildBriefing(snapshot, NOW, emptyDismissals()).items;
    assert.equal(item.id, 'blocked');
    assert.equal(item.occurrenceKey, 'task:blocked:2026-09-30');
    assert.doesNotMatch(`${item.detail} ${item.whyThis.reason}`, /only you|your decision/i);
  });

  it('excludes archived and deleted draft revisions while keeping newer saved writing', () => {
    const snapshot = makeSnapshot([]);
    snapshot.drafts = ['active', 'archived', 'deleted', 'revised'].map(id => ({
      id, revision: id === 'revised' ? 2 : 1, deviceId: 'test-device', updatedAt: '',
      value: { title: id, text: 'Unsent writing', projectId: null, attachments: [] },
    } satisfies Entity<Draft>));
    snapshot.draftOrganization = [
      { draftId: 'active', draftRevision: 1, revision: 1, pinned: false, folder: 'active' },
      { draftId: 'archived', draftRevision: 1, revision: 1, pinned: false, folder: 'archive' },
      { draftId: 'deleted', draftRevision: 1, revision: 1, pinned: false, folder: 'deleted' },
      { draftId: 'revised', draftRevision: 1, revision: 1, pinned: false, folder: 'archive' },
    ];
    const briefing = buildBriefing(snapshot, NOW, emptyDismissals());
    assert.deepEqual(briefing.items.map(item => item.id), ['active', 'revised']);
    for (const item of briefing.items) {
      assert.match(item.detail, /Unsent content/);
      assert.doesNotMatch(`${item.detail} ${item.whyThis.reason}`, /approv/i);
      assert.equal(item.actions[0].kind, 'review-draft');
    }
  });
});
