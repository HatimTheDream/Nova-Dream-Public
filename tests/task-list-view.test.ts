import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Entity, Snapshot, Task } from '../packages/domain/contracts';
import type { TaskState } from '../packages/domain/tasks';
import { orderTaskView, taskPresentationContext } from '../packages/domain/task-presentation';
import { orderDailyHistory, selectTaskList, taskListProjectCount, taskProgressLabel, type TaskListScope } from '../apps/client/src/task-list-view';
import { TaskOccurrenceDetails } from '../apps/client/src/TaskOccurrenceDetails';

const today = '2026-10-19', now = Date.parse(`${today}T16:00:00Z`);
const task = (id: string, planned: string, status: Task['status'] = 'open', projectId = 'project:a'): Entity<Task> => ({ id, revision: 1, deviceId: 'fixture', updatedAt: `${today}T15:00:00Z`, value: { title: id, notes: '', planned, status, due: '', projectId } });
function fixture() {
  const tasks = [task('ordinary', '2026-10-10'), task('missed', '2026-10-18', 'waiting'), task('current', today), task('unknown', '2026-10-18'), task('custom', '2026-10-18'), task('late-done', '2026-10-17', 'done'), task('other', today, 'open', 'project:b')];
  const occurrences = tasks.filter(t => !['ordinary', 'other'].includes(t.id)).map(t => ({ taskId: t.id, routineId: `routine:${t.id}`, templateRevision: 1, date: t.value.planned, timezone: 'UTC', kind: 'task' as const }));
  const presentation = Object.fromEntries(occurrences.filter(o => o.taskId !== 'unknown').map(o => [o.taskId, { recurrence: { cadence: 'daily' as const, interval: o.taskId === 'custom' ? 2 : 1 }, ...(o.taskId === 'late-done' ? { completedAt: `${today}T12:00:00Z` } : {}) }]));
  const snapshot = { tasks, projects: [{ id: 'project:a', value: { name: 'Garden' } }, { id: 'project:b', value: { name: 'Studio' } }], layout: { value: { timezone: 'UTC' } }, taskState: { occurrences, presentation, events: [], routineEvents: [], focus: [], orders: [], earnedXp: 0 } as TaskState } as Snapshot;
  return { snapshot, context: taskPresentationContext(snapshot.taskState, [], now) };
}
const scope: TaskListScope = { destination: 'Today', project: 'all', query: '', priority: 'all', status: 'all' };

test('Today counts and grouping membership keep ordinary, custom and unknown work, plus genuine completed-today rows', () => {
  const { snapshot, context } = fixture(), before = structuredClone(snapshot);
  const selected = selectTaskList(snapshot, scope, today, context);
  assert.deepEqual(selected.map(t => t.id), ['ordinary', 'current', 'unknown', 'custom', 'late-done', 'other']);
  assert.equal(taskListProjectCount(snapshot, scope, 'project:a', today, context), 4);
  assert.equal(taskListProjectCount(snapshot, { ...scope, status: 'waiting' }, 'project:a', today, context), 0);
  assert.equal(taskProgressLabel(selected.map(t => t.value.status)), '5 open · 1 done');
  assert.equal(taskProgressLabel(['done', 'skipped', 'waiting']), '1 open · 1 done · 1 skipped');
  assert.deepEqual(snapshot, before);
});

test('Daily History preserves exact identities, original dates and unfinished status after a planning edit', () => {
  const { snapshot, context } = fixture();
  snapshot.tasks.find(t => t.id === 'missed')!.value.planned = '2026-10-25';
  const history = { ...scope, destination: 'Daily History' as const }, selected = selectTaskList(snapshot, history, today, context);
  assert.deepEqual(orderDailyHistory(selected, context).map(t => t.id), ['missed', 'late-done']);
  assert.equal(selected.find(t => t.id === 'missed'), snapshot.tasks.find(t => t.id === 'missed'));
  assert.equal(selected.find(t => t.id === 'missed')!.value.status, 'waiting');
  assert.equal(taskListProjectCount(snapshot, history, 'project:a', today, context), 2);
  const markup = renderToStaticMarkup(createElement(TaskOccurrenceDetails, { occurrence: context.occurrences.get('missed')!, status: 'waiting' }));
  assert.match(markup, /Waiting/); assert.match(markup, /dateTime="2026-10-18"/); assert.match(markup, /UTC/); assert.doesNotMatch(markup, /2026-10-25|Completed/);
});

test('global search still finds history while explicit history search and project filters agree with their counts', () => {
  const { snapshot, context } = fixture();
  const search = { ...scope, query: 'Garden' };
  assert.equal(selectTaskList(snapshot, search, today, context).length, 6);
  assert.equal(taskListProjectCount(snapshot, search, 'project:a', today, context), 6);
  assert.equal(taskListProjectCount(snapshot, search, 'project:b', today, context), 0);
  assert.deepEqual(selectTaskList(snapshot, { ...search, destination: 'Daily History', status: 'waiting' }, today, context).map(t => t.id), ['missed']);
  assert.deepEqual(selectTaskList(snapshot, { ...search, project: 'project:b' }, today, context), []);
});

test('completing today preserves the normal row position and later editing cannot manufacture a new completion day', () => {
  const { snapshot, context } = fixture(), dailyOrder = ['other', 'ordinary', 'current', 'unknown', 'custom', 'late-done'];
  const initial = orderTaskView(selectTaskList(snapshot, scope, today, context), 'planned', dailyOrder).map(t => t.id);
  snapshot.tasks.find(t => t.id === 'ordinary')!.value.status = 'done';
  snapshot.taskState!.presentation!.ordinary = { completedAt: `${today}T16:00:00Z` };
  assert.deepEqual(orderTaskView(selectTaskList(snapshot, scope, today, taskPresentationContext(snapshot.taskState, [], now)), 'planned', dailyOrder).map(t => t.id), initial);
  snapshot.tasks.find(t => t.id === 'ordinary')!.updatedAt = '2026-10-20T16:00:00Z';
  assert.equal(selectTaskList(snapshot, scope, '2026-10-20', taskPresentationContext(snapshot.taskState, [], now + 86400000)).some(t => t.id === 'ordinary'), false);
  assert.equal(selectTaskList(snapshot, { ...scope, destination: 'Completed' }, '2026-10-20', context).some(t => t.id === 'ordinary'), true);
});
