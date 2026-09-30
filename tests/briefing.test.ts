import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildBriefing, emptyDismissals, type DismissalState } from '../apps/client/src/briefing.js';
import type { Entity, Snapshot, Task } from '../packages/domain/contracts.js';

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
});
