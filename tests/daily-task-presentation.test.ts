import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store';
import type { Command, Entity, Task } from '../packages/domain/contracts';
import type { Occurrence, Routine, TaskEvent, TaskState } from '../packages/domain/tasks';
import { completedToday, inTaskDestination, isCurrentDailyOccurrence, isDailyOccurrence, isHistoricalDailyOccurrence, isTaskCarryForward, taskPlanningDay, taskPresentationContext, taskPresentationProjection } from '../packages/domain/task-presentation';

const initial = Date.parse('2026-03-07T20:00:00Z'), zone = 'America/Los_Angeles';
const taskValue: Task = { title: 'Ordinary work', notes: '', status: 'open', planned: '2026-03-06', due: '' };
const routineValue: Routine = { title: 'Daily walk', notes: '', kind: 'habit', state: 'active', startsOn: '2026-03-07', timezone: zone, cadence: 'daily', weekdays: [], projectId: null, plannedTime: '', priority: 'normal', estimateMinutes: 0 };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'nova-daily-presentation-')); let now = initial, store = new Store(directory, () => now);
  const save = (kind: Command['kind'], id: string, payload: unknown, expectedRevision = 0) => store.mutate('fixture', { requestId: randomUUID(), epoch: store.epoch, kind, entityId: id, expectedRevision, payload });
  return { get store() { return store; }, get now() { return now; }, set now(value: number) { now = value; }, save,
    task: () => save('task', 'task:' + randomUUID(), taskValue) as Entity<Task>,
    routine: (value: Routine = routineValue) => save('routine', 'routine:' + randomUUID(), value) as Entity<Routine>,
    edit: (task: Entity<Task>, patch: Partial<Task>) => save('task', task.id, { ...task.value, ...patch }, task.revision) as Entity<Task>,
    snapshot: () => store.snapshot('fixture'), restart() { store.close(); store = new Store(directory, () => now); },
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const emptyState = (occurrences: Occurrence[] = [], events: TaskEvent[] = []): TaskState => ({ occurrences, events, routineEvents: [], focus: [], earnedXp: 0 });

test('original stored routine revision controls history after cadence edits without changing saved work', () => {
  const f = fixture(); try {
    let routine = f.routine(); const original = f.snapshot().tasks[0];
    routine = f.save('routine', routine.id, { ...routine.value, cadence: 'weekly', weekdays: [0] }, routine.revision) as Entity<Routine>;
    f.now = Date.parse('2026-03-09T19:00:00Z'); const snapshot = f.snapshot();
    const context = taskPresentationContext(snapshot.taskState, snapshot.routines, f.now);
    assert.equal(snapshot.tasks.length, 2);
    assert.equal(snapshot.taskState!.presentation![original.id].recurrence?.cadence, 'daily');
    assert.equal(isHistoricalDailyOccurrence(original, context), true);
    assert.equal(inTaskDestination(original, 'Today', '2026-03-09', zone, context), false);
    assert.equal(isTaskCarryForward(original, '2026-03-09', context), false);
    const weekly = snapshot.tasks.find(task => task.id !== original.id)!;
    assert.equal(isDailyOccurrence(weekly, context), false);
    assert.equal(inTaskDestination(weekly, 'Today', '2026-03-09', zone, context), true);
    assert.equal(isTaskCarryForward(weekly, '2026-03-09', context), true);
    assert.deepEqual(f.store.readEntity('task', original.id), original);
    assert.equal(snapshot.taskState!.earnedXp, 0);
    const before = f.store.captureBackup('2.9.6', { status: 'not-configured', notes: [] });
    f.snapshot();
    const after = f.store.captureBackup('2.9.6', { status: 'not-configured', notes: [] });
    assert.deepEqual(after.entities, before.entities); assert.deepEqual(after.history, before.history); assert.deepEqual(after.services, before.services);
    f.restart(); const restored = f.snapshot();
    assert.equal(isDailyOccurrence(original, taskPresentationContext(restored.taskState, restored.routines, f.now)), true);
  } finally { f.close(); }
});

test('genuine completion survives the client event cap; edits, trash and restore do not move it', () => {
  const f = fixture(); try {
    let task = f.edit(f.task(), { status: 'done' }); const completedAt = new Date(f.now).toISOString();
    let noise = f.task();
    for (let index = 0; index < 505; index++) { f.now += 1; noise = f.edit(noise, { status: index % 2 ? 'open' : 'active' }); }
    let snapshot = f.snapshot();
    assert.equal(snapshot.taskState!.events.length, 500);
    assert.equal(snapshot.taskState!.events.some(event => event.taskId === task.id), false);
    assert.equal(snapshot.taskState!.presentation![task.id].completedAt, completedAt);
    assert.equal(completedToday(task, '2026-03-07', zone, taskPresentationContext(snapshot.taskState, snapshot.routines, f.now)), true);
    f.now = Date.parse('2026-03-08T20:00:00Z');
    task = f.edit(task, { notes: 'A later note', planned: '2026-03-08' });
    task = f.edit(task, { trashed: true }); task = f.edit(task, { trashed: false });
    snapshot = f.snapshot(); const context = taskPresentationContext(snapshot.taskState, snapshot.routines, f.now);
    assert.equal(snapshot.taskState!.presentation![task.id].completedAt, completedAt);
    assert.equal(inTaskDestination(task, 'Today', '2026-03-08', zone, context), false);
    assert.equal(inTaskDestination(task, 'Completed', '2026-03-08', zone, context), true);
    assert.equal(snapshot.taskState!.earnedXp, 10);
  } finally { f.close(); }
});

test('saved transition revision wins after clock correction and reopening never looks completed', () => {
  const f = fixture(); try {
    f.now = Date.parse('2026-03-09T20:00:00Z'); let task = f.edit(f.task(), { status: 'done' });
    task = f.edit(task, { status: 'open' });
    let snapshot = f.snapshot();
    assert.equal(completedToday(task, '2026-03-09', zone, taskPresentationContext(snapshot.taskState, [], f.now)), false);
    f.now = Date.parse('2026-03-08T20:00:00Z'); task = f.edit(task, { status: 'done' });
    snapshot = f.snapshot();
    assert.equal(snapshot.taskState!.presentation![task.id].completedAt, '2026-03-08T20:00:00.000Z');
    assert.equal(completedToday(task, '2026-03-08', zone, taskPresentationContext(snapshot.taskState, [], f.now)), true);
    assert.equal(snapshot.taskState!.earnedXp, 10);
  } finally { f.close(); }
});

test('daily history follows the original timezone through DST, while completion follows planning timezone', () => {
  const task: Entity<Task> = { id: 'task:daily', revision: 1, deviceId: 'fixture', updatedAt: '2026-03-08T08:30:00Z', value: { ...taskValue, status: 'active', planned: '2026-03-12' } };
  const occurrence: Occurrence = { taskId: task.id, routineId: 'routine:daily', templateRevision: 1, date: '2026-03-07', timezone: zone, kind: 'habit' };
  const routine: Entity<Routine> = { id: occurrence.routineId, revision: 1, updatedAt: task.updatedAt, deviceId: 'fixture', value: routineValue };
  const state = emptyState([occurrence]);
  assert.equal(isHistoricalDailyOccurrence(task, taskPresentationContext(state, [routine], Date.parse('2026-03-08T07:59:00Z'))), false);
  let context = taskPresentationContext(state, [routine], Date.parse('2026-03-08T08:01:00Z'));
  assert.equal(isHistoricalDailyOccurrence(task, context), true);
  assert.equal(inTaskDestination(task, 'Today', '2026-03-08', 'UTC', context), false);
  assert.equal(inTaskDestination(task, 'Scheduled', '2026-03-08', 'UTC', context), false, 'editing planned does not turn a historical daily occurrence into future work');
  task.value.status = 'done'; state.events.push({ id: task.id + ':2', taskId: task.id, at: '2026-03-08T07:30:00Z', from: 'active', to: 'done', xpDelta: 10 });
  context = taskPresentationContext(state, [routine], Date.parse('2026-03-08T08:01:00Z'));
  assert.equal(completedToday(task, '2026-03-08', 'UTC', context), true);
  assert.equal(completedToday(task, '2026-03-08', zone, context), false);
  assert.equal(inTaskDestination(task, 'Today', '2026-03-08', 'UTC', context), true);
});

test('unknown exact recurrence stays actionable and interval-two daily still carries forward', () => {
  const task: Entity<Task> = { id: 'task:daily', revision: 1, deviceId: 'fixture', updatedAt: '2026-03-09T20:00:00Z', value: taskValue };
  const occurrence: Occurrence = { taskId: task.id, routineId: 'routine:daily', templateRevision: 1, date: '2026-03-07', timezone: zone, kind: 'habit' };
  const routine: Entity<Routine> = { id: occurrence.routineId, revision: 2, deviceId: 'fixture', updatedAt: task.updatedAt, value: routineValue };
  let context = taskPresentationContext(emptyState([occurrence]), [routine], Date.parse(task.updatedAt));
  assert.equal(isDailyOccurrence(task, context), false); assert.equal(inTaskDestination(task, 'Today', '2026-03-09', zone, context), true);
  const state = emptyState([occurrence]); state.presentation = taskPresentationProjection([occurrence], [], () => undefined);
  routine.revision = 1; context = taskPresentationContext(state, [routine], Date.parse(task.updatedAt));
  assert.equal(isDailyOccurrence(task, context), false, 'an authoritative unknown does not fall back to the current series');
  routine.value = { ...routineValue, interval: 2 }; context = taskPresentationContext(emptyState([occurrence]), [routine], Date.parse(task.updatedAt));
  assert.equal(isDailyOccurrence(task, context), false); assert.equal(isTaskCarryForward(task, '2026-03-09', context), true);
  task.value = { ...taskValue, status: 'done', planned: '2026-03-09' };
  assert.equal(inTaskDestination(task, 'Today', '2026-03-09', zone, context), false, 'planned/edited dates do not invent a completion');
});

test('current daily occurrence uses its original date and timezone while explicit future planning stays scheduled', () => {
  const task: Entity<Task> = { id: 'task:tokyo', revision: 1, deviceId: 'fixture', updatedAt: '2026-10-19T19:00:00Z', value: { ...taskValue, planned: '2026-10-20' } };
  const occurrence: Occurrence = { taskId: task.id, routineId: 'routine:tokyo', templateRevision: 1, date: '2026-10-20', timezone: 'Asia/Tokyo', kind: 'habit' };
  const routine: Entity<Routine> = { id: occurrence.routineId, revision: 1, deviceId: 'fixture', updatedAt: task.updatedAt, value: { ...routineValue, timezone: occurrence.timezone } };
  const context = taskPresentationContext(emptyState([occurrence]), [routine], Date.parse(task.updatedAt));
  assert.equal(isCurrentDailyOccurrence(task, context), true);
  assert.equal(taskPlanningDay(task, '2026-10-19', context), '2026-10-20');
  assert.equal(inTaskDestination(task, 'Today', '2026-10-19', zone, context), true);
  assert.equal(inTaskDestination(task, 'Scheduled', '2026-10-19', zone, context), false);
  task.value.planned = '2026-10-21';
  assert.equal(isCurrentDailyOccurrence(task, context), true, 'edited planned date does not change original occurrence chronology');
  assert.equal(inTaskDestination(task, 'Today', '2026-10-19', zone, context), false);
  assert.equal(inTaskDestination(task, 'Scheduled', '2026-10-19', zone, context), true);
  task.value.planned = '2026-10-19'; occurrence.date = '2026-10-19'; occurrence.timezone = 'Pacific/Honolulu';
  const behind = taskPresentationContext(emptyState([occurrence]), [routine], Date.parse(task.updatedAt));
  assert.equal(isCurrentDailyOccurrence(task, behind), true);
  assert.equal(isTaskCarryForward(task, '2026-10-20', behind), false, 'a current daily in an earlier timezone is not carry-forward work');
});

test('daily order uses the same current and historical-completed membership as presentation', () => {
  const f = fixture(); try {
    f.routine(); const ordinary = f.task(); f.now = Date.parse('2026-03-09T19:00:00Z');
    let snapshot = f.snapshot(), context = taskPresentationContext(snapshot.taskState, snapshot.routines, f.now);
    const current = snapshot.tasks.find(task => task.value.planned === '2026-03-09')!;
    const historical = snapshot.tasks.find(task => task.value.planned === '2026-03-07')!;
    const command = (taskIds: string[], expectedRevision = 0) => ({ requestId: randomUUID(), epoch: f.store.epoch, date: '2026-03-09', timezone: zone, expectedRevision, taskIds });
    const visible = snapshot.tasks.filter(task => inTaskDestination(task, 'Today', '2026-03-09', zone, context)).map(task => task.id);
    assert.deepEqual(new Set(visible), new Set([ordinary.id, current.id]));
    assert.throws(() => f.store.orderTasks('fixture', command([...visible, historical.id])), /day’s tasks changed/);
    f.store.orderTasks('fixture', command(visible)); f.edit(historical, { status: 'done' });
    snapshot = f.snapshot(); context = taskPresentationContext(snapshot.taskState, snapshot.routines, f.now);
    const updated = snapshot.tasks.filter(task => inTaskDestination(task, 'Today', '2026-03-09', zone, context)).map(task => task.id);
    assert.deepEqual(new Set(updated), new Set([ordinary.id, current.id, historical.id]));
    assert.deepEqual(f.store.orderTasks('fixture', command(updated, 1)).taskIds, updated);
    assert.equal(snapshot.tasks.length, 4); assert.equal(snapshot.taskState!.earnedXp, 10);
  } finally { f.close(); }
});

test('All Open, Unsorted and Anytime reuse existing task placement without carrying daily history forward', () => {
 const f=fixture();try {
  const ordinary=f.task();f.routine();const oldDaily=f.snapshot().tasks.find(t=>t.id!==ordinary.id)!;
  f.now+=86400000;const snapshot=f.snapshot(),context=taskPresentationContext(snapshot.taskState,snapshot.routines,f.now);
  const select=(task:Entity<Task>,view:'All Open'|'Unsorted'|'Anytime')=>inTaskDestination(task,view,'2026-03-08',zone,context);
  assert.equal(select(ordinary,'All Open'),true);assert.equal(select(oldDaily,'All Open'),false);
  const unsorted={...ordinary,value:{...ordinary.value,planned:'',bucket:'capture' as const}};
  assert.equal(select(unsorted,'Unsorted'),true);assert.equal(select(unsorted,'Anytime'),false);
  const anytime={...unsorted,value:{...unsorted.value,bucket:'anytime' as const}};
  assert.equal(select(anytime,'Anytime'),true);assert.equal(select(anytime,'Unsorted'),false);
  assert.equal(select({...anytime,value:{...anytime.value,status:'done'}},'All Open'),false);
  assert.equal(select({...anytime,value:{...anytime.value,status:'done'}},'Anytime'),false);
  assert.equal(f.store.readEntity('task',ordinary.id)?.value.planned,'2026-03-06');
 } finally {f.close();}
});
