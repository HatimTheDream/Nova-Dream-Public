import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultLayout, type Entity, type Snapshot, type Task } from '../packages/domain/contracts';
import type { Routine, TaskState } from '../packages/domain/tasks';
import { homeTaskState } from '../apps/client/src/home-task-state';
import { dailyRoutineTasks } from '../apps/client/src/DailyRoutinesWidget';
import { buildBriefing, emptyDismissals } from '../apps/client/src/briefing';

const now = Date.parse('2026-10-19T23:00:00Z');
const entity = <T>(id: string, value: T, revision = 1): Entity<T> => ({ id, value, revision, deviceId: 'fixture', updatedAt: new Date(now).toISOString() });
const task = (id: string, value: Partial<Task> = {}): Entity<Task> => entity(id, { title: id, notes: '', status: 'open', planned: '2026-10-19', due: '', ...value });
const snapshot = (tasks: Entity<Task>[], taskState: TaskState): Snapshot => ({
  epoch: 'fixture', cursor: 0, deviceId: 'fixture', layout: entity('layout', { ...defaultLayout, timezone: 'America/Los_Angeles' }),
  tasks, taskState, drafts: [], projects: [], capabilities: { assistant: false, voice: false, reason: '' },
});
const state = (): TaskState => ({ occurrences: [], events: [], routineEvents: [], focus: [], earnedXp: 0, presentation: {} });
function occurrence(data: TaskState, id: string, date: string, cadence: Routine['cadence'] = 'daily', interval = 1, timezone = 'America/Los_Angeles') {
  data.occurrences.push({ taskId: id, routineId: `routine:${id}`, templateRevision: 1, date, timezone, kind: 'task' });
  data.presentation![id] = { recurrence: { cadence, interval } };
}

test('hundreds of missed daily occurrences stay saved without inflating Home or briefing', () => {
  const data = state();
  const old = Array.from({ length: 830 }, (_, index) => {
    const id = `daily:${index}`;
    occurrence(data, id, '2026-10-18');
    return task(id, { status: (['open', 'active', 'waiting', 'blocked'] as const)[index % 4], planned: index % 2 ? '2026-10-18' : '2026-10-19', due: '2026-10-18' });
  });
  occurrence(data, 'current-daily', '2026-10-19');
  occurrence(data, 'old-weekly', '2026-10-18', 'weekly');
  occurrence(data, 'old-interval', '2026-10-18', 'daily', 2);
  const ordinary = task('ordinary', { planned: '2026-10-18', due: '2026-10-18' });
  const current = task('current-daily', { due: '2026-10-19' });
  const weekly = task('old-weekly', { planned: '2026-10-18', due: '2026-10-18' });
  const interval = task('old-interval', { planned: '2026-10-18', due: '2026-10-18' });
  const source = snapshot([...old, ordinary, current, weekly, interval], data), before = structuredClone(source);
  const home = homeTaskState(source, source.layout.value, now);
  assert.equal(home.saved.length, 834);
  assert.deepEqual(new Set(home.active.map(item => item.id)), new Set(['ordinary', 'current-daily', 'old-weekly', 'old-interval']));
  assert.equal(home.ready.length, 4);
  assert.equal(home.attention.length, 3);
  assert.equal(homeTaskState(source, { ...source.layout.value, showCompleted: true }, now).tasks.length, 4);
  const briefing = buildBriefing(source, now, emptyDismissals(), source.layout.value.timezone);
  assert.equal(briefing.items.length, 4);
  assert.equal(briefing.overflowCount, 0);
  assert.deepEqual(dailyRoutineTasks(source, now).map(item => item.id), ['current-daily']);
  assert.deepEqual(source, before, 'presentation must not rewrite incomplete history, dates or events');
});

test('Home does not call missed incomplete daily history finished', () => {
  const data = state(); occurrence(data, 'missed', '2026-10-18');
  const source = snapshot([task('missed', { planned: '2026-10-18' })], data);
  const home = homeTaskState(source, source.layout.value, now);
  assert.equal(home.active.length, 0);
  assert.equal(home.completed, 0);
  assert.equal(home.emptyState, 'routine-history');
});

test('Home retains real same-day completions including historical daily occurrences without adding ready work', () => {
  const data = state(); occurrence(data, 'old-daily', '2026-10-18'); occurrence(data, 'current-daily', '2026-10-19');
  data.presentation!['old-daily'].completedAt = new Date(now).toISOString();
  data.presentation!.ordinary = { completedAt: new Date(now).toISOString() };
  data.presentation!.yesterday = { completedAt: new Date(now - 86400000).toISOString() };
  data.orders = [{ date: '2026-10-19', timezone: 'America/Los_Angeles', revision: 1, taskIds: ['ordinary', 'old-daily', 'current-daily'] }];
  const source = snapshot([task('old-daily', { status: 'done', planned: '2026-10-18' }), task('ordinary', { status: 'done', planned: '2026-10-15' }), task('current-daily'), task('yesterday', { status: 'done', planned: '2026-10-19' })], data);
  assert.deepEqual(homeTaskState(source, source.layout.value, now).tasks.map(item => item.id), ['ordinary', 'old-daily', 'current-daily']);
  assert.deepEqual(homeTaskState(source, source.layout.value, now).ready.map(item => item.id), ['current-daily']);
  source.tasks[0].value.status = 'open';
  assert.deepEqual(homeTaskState(source, source.layout.value, now).tasks.map(item => item.id), ['ordinary', 'current-daily'], 'reopening an old daily occurrence returns it to history');
  assert.equal(homeTaskState(source, source.layout.value, Date.parse('2026-10-20T07:00:00Z')).tasks.length, 0);
});

test('original cadence and occurrence timezone control the daily widget after routine edits and midnight', () => {
  const data = state();
  occurrence(data, 'original-daily', '2026-10-19');
  occurrence(data, 'original-weekly', '2026-10-19', 'weekly');
  occurrence(data, 'unknown', '2026-10-18'); delete data.presentation!.unknown;
  const source = snapshot([task('original-daily'), task('original-weekly'), task('unknown', { due: '2026-10-18' })], data);
  const rule = (id: string, cadence: Routine['cadence']) => entity<Routine>(`routine:${id}`, { title: id, notes: '', kind: 'task', state: 'active', startsOn: '2026-01-01', timezone: 'America/Los_Angeles', cadence, weekdays: [], projectId: null, plannedTime: '', priority: 'normal', estimateMinutes: 0 }, 2);
  source.routines = [rule('original-daily', 'weekly'), rule('original-weekly', 'daily'), rule('unknown', 'daily')];
  assert.deepEqual(dailyRoutineTasks(source, now).map(item => item.id), ['original-daily']);
  assert.ok(homeTaskState(source, source.layout.value, now).active.some(item => item.id === 'unknown'), 'missing original revision must not hide work');
  const beforeMidnight = Date.parse('2026-10-20T06:59:59Z'), afterMidnight = beforeMidnight + 1000;
  assert.equal(dailyRoutineTasks(source, beforeMidnight).length, 1);
  assert.equal(dailyRoutineTasks(source, afterMidnight).length, 0);
  assert.deepEqual(new Set(homeTaskState(source, source.layout.value, afterMidnight).active.map(item => item.id)), new Set(['original-weekly', 'unknown']));
  assert.deepEqual(buildBriefing(source, afterMidnight, emptyDismissals(), source.layout.value.timezone).items.map(item => item.id), ['unknown']);
});

test('Home uses the original daily timezone for current, past-plan and upcoming work', () => {
  const data = state(); occurrence(data, 'tokyo', '2026-10-20', 'daily', 1, 'Asia/Tokyo');
  occurrence(data, 'later', '2026-10-20', 'daily', 1, 'Asia/Tokyo');
  const source = snapshot([task('tokyo', { planned: '2026-10-20' }), task('later', { planned: '2026-10-21' })], data);
  const home = homeTaskState(source, source.layout.value, now);
  assert.deepEqual(home.ready.map(item => item.id), ['tokyo']);
  assert.deepEqual(home.upcoming.map(item => item.id), ['later']);
  assert.deepEqual(home.attention, []);
  assert.deepEqual(dailyRoutineTasks(source, now).map(item => item.id), ['tokyo']);
  source.layout.value.timezone = 'Pacific/Kiritimati';
  occurrence(data, 'la', '2026-10-19', 'daily', 1, 'America/Los_Angeles');
  source.tasks = [task('la', { planned: '2026-10-19' })];
  assert.deepEqual(homeTaskState(source, source.layout.value, now).attention, [], 'a current occurrence behind the planning day is not a missed plan');
});
