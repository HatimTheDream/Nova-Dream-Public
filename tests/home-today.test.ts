import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultLayout, type Entity, type Snapshot, type Task } from '../packages/domain/contracts';
import type { TaskState } from '../packages/domain/tasks';
import { homePlanChanges, homeQuickTask, homeTodayState, newHomePlan, readHomePlan, readHomeQuick, taskEstimate } from '../apps/client/src/home-today-state';
import { createTaskActions, type TaskJournal } from '../apps/client/src/task-actions';

const now = Date.parse('2026-10-19T23:00:00Z');
const entity = <T>(id: string, value: T, revision = 1): Entity<T> => ({ id, value, revision, deviceId: 'fixture', updatedAt: new Date(now).toISOString() });
const task = (id: string, value: Partial<Task> = {}) => entity<Task>(id, { title: id, notes: '', status: 'open', planned: '2026-10-19', due: '', ...value });
const state = (): TaskState => ({ occurrences: [], events: [], routineEvents: [], focus: [], earnedXp: 0, presentation: {} });
const snapshot = (tasks: Entity<Task>[], taskState = state()): Snapshot => ({
 epoch: crypto.randomUUID(), cursor: 0, deviceId: 'fixture', layout: entity('layout', { ...defaultLayout, timezone: 'America/Los_Angeles' }),
 tasks, taskState, drafts: [], projects: [], capabilities: { assistant: false, voice: false, reason: '' },
});
function occurrence(data: TaskState, id: string, date: string, cadence: 'daily' | 'weekly' = 'daily', interval = 1, timezone = 'America/Los_Angeles') {
 data.occurrences.push({ taskId: id, routineId: `routine:${id}`, templateRevision: 1, date, timezone, kind: 'task' });
 data.presentation![id] = { recurrence: { cadence, interval } };
}

test('purpose-built Today preserves shared membership, original cadence, order and real completion identity without rewriting history', () => {
 const data = state();
 const missed = Array.from({ length: 830 }, (_, i) => { const id = `missed:${i}`;occurrence(data, id, '2026-10-18');return task(id, { status: 'active', planned: '2026-10-19', due: '2026-10-18' }); });
 occurrence(data, 'daily', '2026-10-19');occurrence(data, 'weekly', '2026-10-18', 'weekly');occurrence(data, 'interval', '2026-10-18', 'daily', 2);
 occurrence(data, 'completed-history', '2026-10-18');data.presentation!['completed-history'].completedAt = new Date(now).toISOString();
 data.orders = [{ date: '2026-10-19', timezone: 'America/Los_Angeles', revision: 1, taskIds: ['weekly', 'ordinary', 'daily', 'completed-history', 'interval'] }];
 const source = snapshot([...missed, task('ordinary', { planned: '', bucket: 'anytime', estimateMinutes: 25 }), task('daily'), task('weekly', { planned: '2026-10-18', due: '2026-10-18' }), task('interval', { planned: '2026-10-18' }), task('completed-history', { status: 'done', planned: '2026-10-18' })], data);
 const before = structuredClone(source), today = homeTodayState(source, now);
 assert.deepEqual(today.tasks.map(t => t.id), ['weekly', 'ordinary', 'daily', 'completed-history', 'interval']);
 assert.deepEqual(today.routines.map(t => t.id), ['daily', 'completed-history']);
 assert.deepEqual(today.overdue.map(t => t.id), ['weekly']);
 assert.deepEqual(taskEstimate(today.tasks), { minutes: 25, missing: 3 });
 assert.ok(!today.candidates.some(t => ['daily', 'completed-history'].includes(t.id)));
 assert.deepEqual(homeTodayState(source, Date.parse('2026-10-20T07:00:00Z')).tasks.map(t => t.id).sort(), ['interval', 'ordinary', 'weekly']);
 assert.deepEqual(source, before);
});

test('Today uses original daily timezone while planning dates and deadlines stay distinct', () => {
 const data = state();occurrence(data, 'tokyo', '2026-10-20', 'daily', 1, 'Asia/Tokyo');
 const source = snapshot([task('tokyo', { planned: '2026-10-20' }), task('future-deadline', { planned: '2026-10-23', due: '2026-10-18' })], data);
 assert.deepEqual(homeTodayState(source, now).tasks.map(t => t.id), ['tokyo']);
 assert.deepEqual(homeTodayState(source, now).overdue.map(t => t.id), ['future-deadline']);
});

test('Plan Today changes only explicit exact revisions, preserves deadlines, timezone, dependencies and all other fields', () => {
 const data = state();occurrence(data, 'daily', '2026-10-19');
 const source = snapshot([task('future', { planned: '2026-10-25', plannedTime: '15:30', due: '2026-10-24', dueTime: '18:00', timezone: 'Asia/Tokyo', dependencies: ['parent'], notes: 'Keep', estimateMinutes: 60 }), task('today'), task('daily')], data);
 const plan = newHomePlan(source, now);plan.changes = [{ id: 'future', revision: 1, selected: true }, { id: 'today', revision: 1, selected: false }];
 const changes = homePlanChanges(plan, source, now);
 assert.deepEqual(changes[0], { task: source.tasks[0], value: { ...source.tasks[0].value, planned: '2026-10-19' } });
 assert.deepEqual(changes[1].value, { ...source.tasks[1].value, planned: '', plannedTime: '', bucket: 'anytime' });
 assert.throws(() => homePlanChanges({ ...plan, changes: [{ id: 'daily', revision: 1, selected: true }] }, source, now), /no longer available/);
 assert.throws(() => homePlanChanges(plan, { ...source, epoch: 'other' }, now), /workspace/);
 assert.throws(() => homePlanChanges(plan, source, now + 86400000), /day/);
 assert.throws(() => homePlanChanges(plan, { ...source, tasks: source.tasks.map(t => ({ ...t, revision: 2 })) }, now), /changed/);
 assert.deepEqual(readHomePlan(JSON.stringify(plan)), plan);
 assert.equal(readHomePlan(JSON.stringify({ ...plan, changes: [plan.changes[0], plan.changes[0]] })), undefined);
});

test('original queue keeps partial confirmations and retries only the exact remaining plan request', async () => {
 const source = snapshot([task('first', { planned: '' }), task('second', { planned: '' })]), plan = newHomePlan(source, now);
 plan.changes = source.tasks.map(t => ({ id: t.id, revision: t.revision, selected: true }));
 let kept: TaskJournal | undefined, unknown = true;const sent: any[] = [];
 const make = () => createTaskActions({ epoch: source.epoch, initial: kept, persist(value) { kept = structuredClone(value);return true; }, changed() {}, async refresh() {}, async commit(command) {
  sent.push(structuredClone(command));if (command.entityId === 'second' && unknown) throw Error('Connection closed after sending');
  return { ...source.tasks.find(t => t.id === command.entityId)!, revision: command.expectedRevision + 1, value: command.payload as Task };
 } });
 assert.equal(await make().run(homePlanChanges(plan, source, now), 'Plan saved'), false);
 assert.equal(kept!.undo.length, 1);assert.equal(kept!.queue.length, 1);const remaining = structuredClone(kept!.queue[0].command);
 unknown = false;assert.equal(await make().retry(), true);
 assert.deepEqual(sent.map(c => c.entityId), ['first', 'second', 'second']);assert.deepEqual(sent[2], remaining);
 assert.equal(kept!.queue.length, 0);assert.equal(kept!.undo.length, 2);
});

test('quick capture keeps its original stable ID and refuses to duplicate a saved task', () => {
 const source = snapshot([]), quick = { id: 'task:' + crypto.randomUUID(), title: '  Keep this exact draft  ' };
 assert.deepEqual(readHomeQuick(JSON.stringify(quick)), quick);
 const original = homeQuickTask(quick, source, now);
 assert.equal(original.id, quick.id);assert.equal(original.revision, 0);assert.equal(original.value.planned, '2026-10-19');assert.equal(original.value.due, '');
 assert.equal(original.value.title, 'Keep this exact draft');
 assert.throws(() => homeQuickTask(quick, { ...source, tasks: [{ ...original, revision: 1 }] }, now), /already has/);
 assert.equal(readHomeQuick('{"id":"other","title":"keep"}'), undefined);
});
