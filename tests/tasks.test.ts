import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../apps/service/store.js';
import type { Command, Entity, Task } from '../packages/domain/contracts.js';
import { dayInZone, focusElapsed, inTaskView, type Routine } from '../packages/domain/tasks.js';
const base: Task = { title: 'Task fixture', notes: '', status: 'open', planned: '', due: '' };
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'edition3-tasks-')); let now = Date.parse('2026-03-07T20:00:00Z'), store = new Store(path, () => now);
  const cmd = (kind: Command['kind'], id: string, payload: unknown, expectedRevision = 0): Command => ({ kind, entityId: id, payload, expectedRevision, epoch: store.epoch, requestId: randomUUID() });
  return { get store() { return store; }, path, cmd, time(value: string | number) { now = typeof value === 'number' ? value : Date.parse(value); }, get now() { return now; }, restart() { store.close(); store = new Store(path, () => now); }, close() { store.close(); rmSync(path, { recursive: true, force: true }); } };
}
const template = (): Routine => ({ title: 'Walk outside', notes: 'Daily fixture', kind: 'habit', state: 'active', startsOn: '2026-03-07', timezone: 'America/Los_Angeles', cadence: 'daily', weekdays: [1, 2, 3, 4, 5], projectId: null, plannedTime: '09:00', priority: 'normal', estimateMinutes: 15 });
test('task lifecycle receipts and completion corrections survive restart without moving dates', () => {
  const f = fixture(); try {
    const id = `task:${randomUUID()}`; let task = f.store.mutate('a', f.cmd('task', id, { ...base, planned: '2026-03-06', due: '2026-03-10' })) as Entity<Task>;
    for (const status of ['active', 'waiting', 'blocked', 'active', 'done', 'open', 'done'] as const) {
      const cmd = f.cmd('task', id, { ...task.value, status }, task.revision); task = f.store.mutate('a', cmd) as Entity<Task>; assert.deepEqual(f.store.mutate('a', cmd), task);
    }
    assert.equal(f.store.snapshot('a').taskState?.earnedXp, 10);
    assert.deepEqual(f.store.snapshot('a').taskState?.events.filter(e => e.xpDelta).map(e => e.xpDelta).sort(), [-10, 10, 10].sort());
    assert.equal(task.value.planned, '2026-03-06'); assert.equal(task.value.due, '2026-03-10');
    f.restart(); assert.equal(f.store.snapshot('b').taskState?.earnedXp, 10); assert.throws(() => f.store.mutate('b', f.cmd('task', id, base, 1)), /Another window/);
  } finally { f.close(); }
});
test('checklists, dependency cycles, skip and time validation reject invalid transitions', () => {
  const f = fixture(); try {
    const a = `task:${randomUUID()}`, b = `task:${randomUUID()}`; f.store.mutate('a', f.cmd('task', a, base)); f.store.mutate('a', f.cmd('task', b, { ...base, dependencies: [a] }));
    assert.throws(() => f.store.mutate('a', f.cmd('task', a, { ...base, dependencies: [b] }, 1)), /cannot form a loop/);
    assert.throws(() => f.store.mutate('a', f.cmd('task', b, { ...base, dependencies: [a], status: 'active' }, 1)), /prerequisite/);
    assert.equal(f.store.readEntity('task', a)?.revision, 1);
    f.store.mutate('a', f.cmd('task', a, { ...base, status: 'done' }, 1)); f.store.mutate('a', f.cmd('task', b, { ...base, dependencies: [a], status: 'active' }, 1));
    assert.throws(() => f.store.mutate('a', f.cmd('task', a, { ...base, status: 'skipped' }, 2)), /Skip belongs/);
    assert.throws(() => f.store.mutate('a', f.cmd('task', a, { ...base, dueTime: '09:00' }, 2)), /Choose a date/);
  } finally { f.close(); }
});
test('occurrences cross DST, replan and restart with stable identities and missed review dates', () => {
  const f = fixture(); try {
    f.store.mutate('a', f.cmd('routine', `routine:${randomUUID()}`, template())); const first = f.store.snapshot('a').tasks[0];
    f.store.mutate('a', f.cmd('task', first.id, { ...first.value, planned: '2026-03-12' }, 1)); f.time('2026-03-09T19:00:00Z'); f.restart(); const snap = f.store.snapshot('a');
    assert.equal(snap.tasks.length, 3); assert.deepEqual(snap.taskState?.occurrences.map(o => o.date), ['2026-03-07', '2026-03-08', '2026-03-09']);
    assert.equal(snap.tasks.find(t => t.id === first.id)?.value.planned, '2026-03-12'); assert.equal(snap.tasks.find(t => t.id.endsWith('2026-03-08'))?.value.planned, '2026-03-08');
    assert.equal(f.store.snapshot('b').tasks.length, 3); assert.equal(snap.taskState?.earnedXp, 0); assert.equal(dayInZone('America/Los_Angeles', Date.parse('2026-03-09T06:30:00Z')), '2026-03-08');
  } finally { f.close(); }
});
test('habit Skip and series Pause/Resume have separate histories without retroactive occurrences or XP', () => {
  const f = fixture(); try {
    const id = `routine:${randomUUID()}`; let routine = f.store.mutate('a', f.cmd('routine', id, template())) as Entity<Routine>; const occurrence = f.store.snapshot('a').tasks[0];
    f.store.mutate('a', f.cmd('task', occurrence.id, { ...occurrence.value, status: 'skipped' }, 1));
    routine = f.store.mutate('a', f.cmd('routine', id, { ...routine.value, state: 'paused' }, routine.revision)) as Entity<Routine>;
    f.time('2026-03-10T20:00:00Z'); routine = f.store.mutate('a', f.cmd('routine', id, { ...routine.value, state: 'active', title: 'A revised walk' }, routine.revision)) as Entity<Routine>;
    assert.equal(f.store.snapshot('a').tasks.length, 1); f.time('2026-03-11T20:00:00Z'); const snap = f.store.snapshot('a');
    assert.equal(snap.tasks.length, 2); assert.equal(snap.tasks.find(t => t.id.endsWith('2026-03-11'))?.value.title, 'A revised walk'); assert.equal(snap.tasks.find(t => t.id === occurrence.id)?.value.title, 'Walk outside');
    assert.equal(snap.taskState?.earnedXp, 0); assert.deepEqual(snap.taskState?.routineEvents.map(e => e.state).sort(), ['active', 'active', 'paused'].sort());
    assert.throws(() => f.store.mutate('a', f.cmd('routine', id, { ...routine.value, timezone: 'UTC' }, routine.revision)), /identify this series/);
  } finally { f.close(); }
});
test('weekly recurrence and bounded catch-up preserve their cursor without duplicates', () => {
  const f = fixture(); try {
    f.store.mutate('a', f.cmd('routine', `routine:${randomUUID()}`, { ...template(), kind: 'task', cadence: 'weekly', weekdays: [1, 3, 5] })); f.time('2026-03-14T20:00:00Z');
    assert.deepEqual(f.store.snapshot('a').taskState?.occurrences.map(o => o.date), ['2026-03-09', '2026-03-11', '2026-03-13']);
    f.time('2028-03-14T20:00:00Z'); const one = f.store.snapshot('a'), two = f.store.snapshot('a'); assert.ok(two.tasks.length > one.tasks.length); assert.equal(new Set(two.tasks.map(t => t.id)).size, two.tasks.length);
  } finally { f.close(); }
});
test('focus fences windows, reconciles lost pulses, caps disconnect time and retains confirmed time after restart', () => {
  const f = fixture(); try {
    const id = `task:${randomUUID()}`, clientId = randomUUID(); f.store.mutate('a', f.cmd('task', id, { ...base, status: 'active' }));
    const cmd = (action: 'start' | 'pulse' | 'pause', expectedRevision: number) => ({ taskId: id, clientId, action, expectedRevision, requestId: randomUUID(), epoch: f.store.epoch });
    let focus = f.store.focus('a', cmd('start', 0)); f.time(f.now + 10000); const pulse = cmd('pulse', focus.revision); focus = f.store.focus('a', pulse);
    assert.equal(focus.elapsedMs, 10000); assert.deepEqual(f.store.focus('a', pulse), focus);
    assert.throws(() => f.store.focus('b', { ...cmd('pulse', focus.revision), clientId: randomUUID() }), /Only the window/);
    assert.throws(() => f.store.focus('b', { ...cmd('start', focus.revision), clientId: randomUUID() }), /Another focus/);
    f.time(f.now + 100000); assert.equal(focusElapsed(focus, f.now), 40000); assert.throws(() => f.store.focus('a', cmd('pulse', focus.revision)), /interruption/);
    f.restart(); focus = f.store.snapshot('a').taskState!.focus[0]; assert.equal(focus.running, false); assert.equal(focus.elapsedMs, 10000);
    focus = f.store.focus('a', cmd('start', focus.revision)); f.time(f.now + 5000);
    const task = f.store.readEntity('task', id)!; f.store.mutate('a', f.cmd('task', id, { ...task.value, status: 'waiting' }, task.revision));
    focus = f.store.snapshot('a').taskState!.focus[0]; assert.equal(focus.running, false); assert.equal(focus.elapsedMs, 15000); assert.equal(f.store.snapshot('a').taskState?.earnedXp, 0);
  } finally { f.close(); }
});
test('views separate capture, planning, deadline, blocked work and missed review', () => {
  assert.equal(inTaskView({ ...base, due: '2026-03-07' }, 'Capture', '2026-03-07'), true); assert.equal(inTaskView({ ...base, due: '2026-03-07' }, 'Today', '2026-03-07'), false);
  assert.equal(inTaskView({ ...base, planned: '2026-03-06' }, 'Review', '2026-03-07'), true); assert.equal(inTaskView({ ...base, status: 'blocked' }, 'Waiting', '2026-03-07'), true);
  assert.equal(inTaskView({ ...base, status: 'skipped' }, 'History', '2026-03-07'), true); assert.equal(inTaskView({ ...base, bucket: 'anytime' }, 'Anytime', '2026-03-07'), true);
});
test('schema-one upgrade retains encrypted work; wrong keys cannot modify schema', () => {
  const f = fixture(); let closed = false; try {
    const id = `task:${randomUUID()}`; f.store.mutate('a', f.cmd('task', id, base)); f.store.close(); closed = true;
    let db = new DatabaseSync(join(f.path, 'workspace.sqlite')); db.exec('PRAGMA user_version=1'); db.close();
    const key = readFileSync(join(f.path, 'preview.key')), before = readFileSync(join(f.path, 'workspace.sqlite'));
    writeFileSync(join(f.path, 'preview.key'), randomBytes(32)); assert.throws(() => new Store(f.path)); assert.deepEqual(readFileSync(join(f.path, 'workspace.sqlite')), before);
    writeFileSync(join(f.path, 'preview.key'), key); const upgraded = new Store(f.path); assert.deepEqual(upgraded.readEntity('task', id)?.value, base); upgraded.close();
    db = new DatabaseSync(join(f.path, 'workspace.sqlite')); assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, 54); db.close();
  } finally { if (!closed) f.store.close(); rmSync(f.path, { recursive: true, force: true }); }
});
