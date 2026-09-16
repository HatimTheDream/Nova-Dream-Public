import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store.js';
import type { Command, Entity, Task } from '../packages/domain/contracts.js';
import { nextScheduled, scheduled, sortTasks, routineSchema, type Routine } from '../packages/domain/tasks.js';
import { reminderInstant, type Reminder } from '../packages/domain/reminders.js';
const base: Task = { title: 'Scheduling fixture', notes: '', status: 'open', planned: '2026-03-07', due: '2026-03-12' };
const template: Routine = { title: 'Monthly fixture', notes: '', kind: 'habit', state: 'active', startsOn: '2026-01-31', timezone: 'America/Los_Angeles', cadence: 'monthly', weekdays: [1], projectId: null, plannedTime: '09:00', priority: 'normal', estimateMinutes: 10 };
function fixture(initial = '2026-03-07T20:00:00Z') {
  const path = mkdtempSync(join(tmpdir(), 'edition3-scheduling-')); let now = Date.parse(initial), store = new Store(path, () => now);
  const cmd = (kind: Command['kind'], id: string, payload: unknown, expectedRevision = 0): Command => ({ kind, entityId: id, payload, expectedRevision, epoch: store.epoch, requestId: randomUUID() });
  return { get store() { return store; }, cmd, get now() { return now; }, time(time: string | number) { now = typeof time === 'number' ? time : Date.parse(time); }, restart() { store.close(); store = new Store(path, () => now); }, close() { store.close(); rmSync(path, { recursive: true, force: true }); } };
}
test('monthly and yearly rules have explicit missing dates, ordinals, intervals and inclusive endings', () => {
  assert.equal(nextScheduled(template, '2026-01-31'), '2026-03-31');
  assert.equal(nextScheduled({ ...template, missingDay: 'last-day' }, '2026-01-31'), '2026-02-28');
  assert.equal(nextScheduled({ ...template, interval: 2 }, '2026-01-31'), '2026-03-31');
  assert.equal(nextScheduled({ ...template, monthPattern: 'weekday', ordinal: -1, weekday: 5 }, '2026-01-31'), '2026-02-27');
  assert.equal(nextScheduled({ ...template, monthPattern: 'weekday', ordinal: 5, weekday: 1 }, '2026-01-31'), '2026-03-30');
  const leap: Routine = { ...template, cadence: 'yearly', startsOn: '2028-02-29' };
  assert.equal(nextScheduled(leap, '2028-02-29'), '2032-02-29');
  assert.equal(nextScheduled({ ...leap, missingDay: 'last-day' }, '2028-02-29'), '2029-02-28');
  assert.equal(nextScheduled({ ...leap, endsOn: '2031-12-31' }, '2028-02-29'), null);
  assert.equal(nextScheduled({ ...leap, monthDay: 31 }, '2028-02-29'), null);
  assert.equal(scheduled({ ...template, endsOn: '2026-03-31' }, '2026-03-31'), true);
  assert.equal(scheduled({ ...template, endsOn: '2026-03-31' }, '2026-05-31'), false);
  const weekly: Routine = { ...template, startsOn: '2026-03-04', cadence: 'weekly', interval: 2, weekdays: [1, 3] };
  assert.equal(nextScheduled(weekly, '2026-03-04'), '2026-03-16');
  assert.equal(nextScheduled({ ...template, cadence: 'daily', interval: 3 }, '2026-02-01'), '2026-02-03');
});
test('recurring monthly steps capture their original rule and keep missed dates through restart', () => {
  const f = fixture('2026-01-31T20:00:00Z'); try {
    const id = `routine:${randomUUID()}`; let series = f.store.mutate('a', f.cmd('routine', id, { ...template, missingDay: 'last-day', reminderTime: '09:00' })) as Entity<Routine>;
    f.time('2026-03-31T20:00:00Z'); f.store.tickTasks(); let state = f.store.snapshot('a');
    assert.deepEqual(state.taskState!.occurrences.map(o => o.date), ['2026-01-31', '2026-02-28', '2026-03-31']);
    assert.equal(state.taskState!.reminders!.length, 3); assert.ok(state.taskState!.reminders!.every(r => r.state === 'missed'));
    series = f.store.mutate('a', f.cmd('routine', id, { ...series.value, monthDay: 15 }, series.revision)) as Entity<Routine>;
    f.time('2026-04-15T20:00:00Z'); f.store.tickTasks(); state = f.store.snapshot('a');
    assert.equal(state.taskState!.occurrences.at(-1)!.templateRevision, 2); assert.equal(state.taskState!.occurrences[0].templateRevision, 1);
    const before = { tasks: state.tasks, occurrences: state.taskState!.occurrences, reminders: state.taskState!.reminders }; f.restart(); const after = f.store.snapshot('a');
    assert.deepEqual({ tasks: after.tasks, occurrences: after.taskState!.occurrences, reminders: after.taskState!.reminders }, before); assert.equal(after.taskState!.earnedXp, 0);
  } finally { f.close(); }
});
test('reminder wall times reject gaps and require a deliberate repeated-time choice', () => {
  const gap = { date: '2026-03-08', time: '02:30', timezone: 'America/Los_Angeles' };
  assert.equal(reminderInstant(gap).problem, 'gap');
  const repeated = { date: '2026-11-01', time: '01:30', timezone: 'America/Los_Angeles' };
  const time = reminderInstant(repeated); assert.equal(time.problem, 'overlap'); assert.equal(time.choices.length, 2);
  assert.equal(reminderInstant({ ...repeated, overlap: 'later' }).instant! - reminderInstant({ ...repeated, overlap: 'earlier' }).instant!, 3600000);
  assert.equal(reminderInstant({ date: '2026-10-04', time: '02:15', timezone: 'Australia/Lord_Howe' }).problem, 'gap');
  assert.equal(reminderInstant({ date: '2011-12-30', time: '12:00', timezone: 'Pacific/Apia' }).problem, 'gap');
  const f = fixture(); try { assert.throws(() => f.store.mutate('a', f.cmd('task', `task:${randomUUID()}`, { ...base, reminder: gap })), /does not exist/); assert.throws(() => f.store.mutate('a', f.cmd('task', `task:${randomUUID()}`, { ...base, reminder: repeated })), /occurs twice/); } finally { f.close(); }
});
test('a recurring DST gap keeps the task and a reviewable unavailable reminder', () => {
  const f = fixture('2026-03-07T20:00:00Z'); try {
    f.store.mutate('a', f.cmd('routine', `routine:${randomUUID()}`, { ...template, startsOn: '2026-03-08', cadence: 'daily', reminderTime: '02:30' }));
    f.time('2026-03-08T20:00:00Z'); f.store.tickTasks(); const snapshot = f.store.snapshot('a');
    assert.equal(snapshot.tasks.length, 1); assert.equal(snapshot.taskState!.reminders![0].state, 'unavailable'); assert.equal(snapshot.tasks[0].value.planned, '2026-03-08');
  } finally { f.close(); }
});
test('daily order has exact membership, retained revisions and idempotent cross-window recovery', () => {
  const f = fixture(); try {
    const tasks = [1, 2, 3].map(i => f.store.mutate('a', f.cmd('task', `task:${randomUUID()}`, { ...base, title: `Task ${i}` })) as Entity<Task>);
    const cmd = { requestId: randomUUID(), epoch: f.store.epoch, date: '2026-03-07', timezone: 'America/Los_Angeles', expectedRevision: 0, taskIds: tasks.map(t => t.id).reverse() };
    const result = f.store.orderTasks('a', cmd); assert.deepEqual(f.store.orderTasks('a', cmd), result);
    assert.throws(() => f.store.orderTasks('b', { ...cmd, requestId: randomUUID() }), /Another window/);
    assert.deepEqual(sortTasks(tasks, result.taskIds).map(t => t.value.title), ['Task 3', 'Task 2', 'Task 1']);
    f.store.mutate('a', f.cmd('task', tasks[0].id, { ...tasks[0].value, planned: '2026-03-08' }, 1));
    assert.throws(() => f.store.orderTasks('a', { ...cmd, requestId: randomUUID(), expectedRevision: 1 }), /tasks changed/);
    f.restart(); assert.deepEqual(f.store.snapshot('a').taskState!.orders![0], result); assert.equal(f.store.readEntity('task', tasks[0].id)!.value.due, '2026-03-12');
  } finally { f.close(); }
});
test('host ticks make due reminders durable; snooze, dismiss and completion never change deadlines or award credit', () => {
  const f = fixture(); try {
    const id = `task:${randomUUID()}`; const task = f.store.mutate('a', f.cmd('task', id, { ...base, reminder: { date: '2026-03-07', time: '12:01', timezone: 'America/Los_Angeles' } })) as Entity<Task>;
    let reminder = f.store.snapshot('a').taskState!.reminders![0]; assert.equal(reminder.state, 'scheduled');
    f.time('2026-03-07T20:01:02Z'); f.store.tickTasks(); reminder = f.store.snapshot('a').taskState!.reminders![0]; assert.equal(reminder.state, 'ready');
    const snooze = { requestId: randomUUID(), epoch: f.store.epoch, reminderId: reminder.id, expectedRevision: reminder.revision, action: 'snooze', minutes: 10 };
    reminder = f.store.actOnReminder('a', snooze); assert.deepEqual(f.store.actOnReminder('a', snooze), reminder); assert.equal(reminder.dueAt, f.now + 600000); assert.equal(f.store.readEntity('task', id)!.value.due, base.due);
    f.time(f.now + 30 * 60000); f.restart(); f.store.tickTasks(); reminder = f.store.snapshot('a').taskState!.reminders![0]; assert.equal(reminder.state, 'missed');
    const done = f.store.mutate('a', f.cmd('task', id, { ...task.value, status: 'done' }, task.revision)) as Entity<Task>;
    assert.equal(f.store.snapshot('a').taskState!.reminders![0].state, 'cancelled');
    f.store.mutate('a', f.cmd('task', id, { ...task.value, status: 'open' }, done.revision)); assert.equal(f.store.snapshot('a').taskState!.reminders![0].state, 'cancelled'); assert.equal(f.store.snapshot('a').taskState!.earnedXp, 0);
  } finally { f.close(); }
});
test('one notification claim survives lost replies, rejects other clients and never auto-retries an unknown display', () => {
  const f = fixture(); try {
    f.store.mutate('a', f.cmd('task', `task:${randomUUID()}`, { ...base, reminder: { date: '2026-03-07', time: '12:00', timezone: 'America/Los_Angeles' } }));
    let r = f.store.snapshot('a').taskState!.reminders![0]; const claim = { requestId: randomUUID(), epoch: f.store.epoch, reminderId: r.id, clientId: randomUUID(), action: 'claim' };
    r = f.store.deliverReminder('a', claim); assert.deepEqual(f.store.deliverReminder('a', claim), r);
    assert.throws(() => f.store.deliverReminder('b', { ...claim, requestId: randomUUID(), clientId: randomUUID() }), /already exists/);
    const report = { ...claim, requestId: randomUUID(), attemptId: r.notification!.attemptId, action: 'shown' };
    assert.throws(() => f.store.deliverReminder('b', report), /different attempt/);
    f.time(f.now + 25000); f.restart(); f.store.tickTasks(); assert.equal(f.store.snapshot('a').taskState!.reminders![0].notification!.state, 'unknown');
    assert.throws(() => f.store.deliverReminder('a', { ...claim, requestId: randomUUID() }), /already exists/);
    r = f.store.deliverReminder('a', report); assert.equal(r.notification!.state, 'shown'); assert.deepEqual(f.store.deliverReminder('a', report), r);
    const snooze = f.store.actOnReminder('a', { requestId: randomUUID(), epoch: f.store.epoch, reminderId: r.id, expectedRevision: r.revision, action: 'snooze', minutes: 10 });
    assert.equal(snooze.notification, undefined); assert.deepEqual(f.store.deliverReminder('a', { ...report, requestId: randomUUID() }), snooze); assert.equal(f.store.snapshot('a').taskState!.reminderAttempts![0].state, 'shown');
    f.time(snooze.dueAt!); f.store.tickTasks();
    const second = f.store.deliverReminder('a', { ...claim, requestId: randomUUID() });
    const later = f.store.actOnReminder('a', { requestId: randomUUID(), epoch: f.store.epoch, reminderId: r.id, expectedRevision: second.revision, action: 'snooze', minutes: 10 });
    f.time(f.now + 25000); f.store.tickTasks();
    const historical = f.store.snapshot('a').taskState!.reminderAttempts!.find(a => a.attemptId === second.notification!.attemptId)!;
    assert.equal(historical.state, 'unknown'); assert.deepEqual(f.store.snapshot('a').taskState!.reminders![0], later);
    assert.deepEqual(f.store.deliverReminder('a', { ...report, requestId: randomUUID(), attemptId: historical.attemptId }), later);
    assert.equal(f.store.snapshot('a').taskState!.reminderAttempts!.find(a => a.attemptId === historical.attemptId)!.state, 'shown');
  } finally { f.close(); }
});

test('multiple monthly dates advance in order, honor boundaries and collapse month-end overlaps', () => {
  const multi: Routine = { ...template, startsOn: '2026-01-10', monthDays: [31, 1, 15, -1] };
  for (const [after, expected] of [['2026-01-01','2026-01-15'],['2026-01-15','2026-01-31'],['2026-01-31','2026-02-01'],['2026-02-15','2026-02-28'],['2028-02-15','2028-02-29']]) assert.equal(nextScheduled(multi, after), expected);
  assert.equal(nextScheduled({ ...multi, interval: 2 }, '2026-01-31'), '2026-03-01');
  assert.equal(nextScheduled({ ...multi, endsOn: '2026-02-14' }, '2026-02-01'), null);
  assert.equal(nextScheduled({ ...multi, endsOn: '2026-02-15' }, '2026-02-01'), '2026-02-15');
  assert.equal(nextScheduled({ ...multi, monthDays: [29, 30, 31], missingDay: 'skip' }, '2026-01-31'), '2026-03-29');
  assert.equal(nextScheduled({ ...multi, monthDays: [29, 30, 31], missingDay: 'last-day' }, '2026-01-31'), '2026-02-28');
  assert.equal(nextScheduled({ ...multi, cadence: 'yearly', month: 2, monthDays: [1, 15, -1] }, '2026-02-01'), '2026-02-15');
  for (const patch of [{monthDays:[]},{monthDays:[1,1]},{monthDays:[0]},{monthDays:[-2]},{monthDays:[32]},{monthDays:[1],monthDay:1},{monthDays:[1],monthPattern:'weekday'},{monthDays:[1],cadence:'daily'}]) assert.equal(routineSchema.safeParse({...multi,...patch}).success,false);
  assert(routineSchema.safeParse(multi).success);
});

test('multi-date occurrences, completion and original revisions survive edits and restart exactly once', () => {
  const f = fixture('2026-01-01T20:00:00Z'); try {
    const id = `routine:${randomUUID()}`;
    let series = f.store.mutate('a', f.cmd('routine', id, { ...template, startsOn:'2026-01-01', monthDays:[1,15,31,-1], reminderTime:'09:00' })) as Entity<Routine>;
    f.time('2026-02-28T20:00:00Z'); let state=f.store.snapshot('a');
    assert.deepEqual(state.taskState!.occurrences.map(o=>o.date), ['2026-01-01','2026-01-15','2026-01-31','2026-02-01','2026-02-15','2026-02-28']);
    assert.equal(state.taskState!.reminders!.length,6);
    const task=state.tasks[0];const done=f.cmd('task',task.id,{...task.value,status:'done'},task.revision);
    const receipt=f.store.mutate('a',done);assert.deepEqual(f.store.mutate('a',done),receipt);
    const xp=f.store.profileProgress().earnedXp;
    series=f.store.mutate('a',f.cmd('routine',id,{...series.value,monthDays:[10,20]},series.revision)) as Entity<Routine>;
    f.time('2026-03-20T20:00:00Z');state=f.store.snapshot('a');
    assert.deepEqual(state.taskState!.occurrences.slice(-2).map(o=>[o.date,o.templateRevision]),[['2026-03-10',2],['2026-03-20',2]]);
    assert(state.taskState!.occurrences.slice(0,6).every(o=>o.templateRevision===1));
    const before={tasks:state.tasks,occurrences:state.taskState!.occurrences,reminders:state.taskState!.reminders};
    f.restart();const after=f.store.snapshot('a');assert.deepEqual({tasks:after.tasks,occurrences:after.taskState!.occurrences,reminders:after.taskState!.reminders},before);assert.equal(f.store.profileProgress().earnedXp,xp);
    assert.deepEqual(f.store.mutate('a',done),receipt);
  } finally { f.close(); }
});
