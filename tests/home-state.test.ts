import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Home } from '../apps/client/src/Home';
import { homeTaskState } from '../apps/client/src/home-task-state';
import { defaultLayout, emptyDraft, type Entity, type Layout, type Snapshot, type Task } from '../packages/domain/contracts';

const now = Date.parse('2026-09-18T07:30:00Z');
const layout: Layout = { ...defaultLayout, timezone: 'America/Los_Angeles' };
const task = (id: string, value: Partial<Task> = {}): Entity<Task> => ({ id, revision: 1, deviceId: 'fixture', updatedAt: new Date(now).toISOString(), value: { title: id, notes: '', status: 'open', planned: '', due: '', ...value } });
const state = (tasks: Entity<Task>[], options: Partial<Layout> = {}, at = now) => homeTaskState({ tasks }, { ...layout, ...options }, at);
const markup = (tasks: Entity<Task>[], options: Partial<Layout> = {}, dirty = false) => {
  const currentLayout = { ...layout, ...options };
  const snapshot: Snapshot = { epoch: 'fixture', cursor: 0, deviceId: 'fixture', layout: { id: 'layout', revision: 1, deviceId: 'fixture', updatedAt: '', value: currentLayout }, tasks, drafts: [], projects: [], capabilities: { assistant: false, voice: false, reason: '' } };
  return renderToStaticMarkup(createElement(Home, { snapshot, layout: currentLayout, saveLayout() {}, open() {}, openSettings() {}, newTask() {}, editTask() {}, complete() {}, draft: { ...emptyDraft, text: dirty ? 'Keep this unsaved thought' : '' }, dirty, draftStatus: 'Waiting to save' }));
};

test('Home attention includes overdue deadlines without a plan and keeps every applicable reason once', () => {
  const tasks = [
    task('due-only', { due: '2026-09-17' }),
    task('future-plan', { planned: '2026-09-20', due: '2026-09-17' }),
    task('waiting', { status: 'waiting', planned: '2026-09-17', due: '2026-09-17' }),
    task('blocked', { status: 'blocked' }),
    task('done', { status: 'done', due: '2026-09-17' }),
    task('skipped', { status: 'skipped', planned: '2026-09-17' }),
    task('trashed', { trashed: true, status: 'blocked', due: '2026-09-17' }),
  ];
  const original = structuredClone(tasks);
  assert.deepEqual(state(tasks).attention.map(item => [item.task.id, item.reasons]), [
    ['due-only', ['overdue']], ['future-plan', ['overdue']], ['waiting', ['waiting', 'past-plan', 'overdue']], ['blocked', ['blocked']],
  ]);
  assert.deepEqual(tasks, original);
  assert.equal(state(tasks, { showCompleted: true }).attention.length, 4);
  assert.ok(state(tasks, { showCompleted: true }).tasks.every(item => !item.value.trashed));
});

test('date-only deadlines and missed plans follow the Home day across midnight', () => {
  const tasks = [task('due', { due: '2026-09-17', timezone: 'Asia/Tokyo' }), task('plan', { planned: '2026-09-17' })];
  assert.deepEqual(state(tasks, {}, Date.parse('2026-09-18T06:59:59Z')).attention, []);
  assert.deepEqual(state(tasks, {}, Date.parse('2026-09-18T07:00:00Z')).attention.map(item => item.reasons), [['overdue'], ['past-plan']]);
  assert.equal(state(tasks, { timezone: 'Pacific/Honolulu' }).attention.length, 0);
  assert.equal(state(tasks, { timezone: 'UTC' }).attention.length, 2);
});

test('timed deadlines follow their saved timezone and fall back to the Home timezone', () => {
  const tasks = [
    task('passed', { due: '2026-09-18', dueTime: '00:29', timezone: 'America/Los_Angeles' }),
    task('exact', { due: '2026-09-18', dueTime: '00:30', timezone: 'America/Los_Angeles' }),
    task('later', { due: '2026-09-18', dueTime: '00:31', timezone: 'America/Los_Angeles' }),
    task('different-zone', { due: '2026-09-17', dueTime: '23:00', timezone: 'Pacific/Honolulu' }),
    task('fallback', { due: '2026-09-18', dueTime: '00:29' }),
    task('all-day', { due: '2026-09-18' }),
  ];
  assert.deepEqual(state(tasks).attention.map(item => item.task.id), ['passed', 'fallback']);
  assert.deepEqual(state(tasks, {}, now + 1).attention.map(item => item.task.id), ['passed', 'exact', 'fallback']);
});

test('deadline attention does not invent a DST instant for overlaps or gaps', () => {
  const overlap = task('overlap', { due: '2026-11-01', dueTime: '01:30', timezone: 'America/Los_Angeles' });
  assert.equal(state([overlap], {}, Date.parse('2026-11-01T08:45:00Z')).attention.length, 0);
  assert.equal(state([overlap], {}, Date.parse('2026-11-01T09:31:00Z')).attention.length, 1);
  const gap = task('gap', { due: '2026-03-08', dueTime: '02:30', timezone: 'America/Los_Angeles' });
  assert.equal(state([gap], {}, Date.parse('2026-03-08T11:00:00Z')).attention.length, 0);
  assert.equal(state([gap], {}, Date.parse('2026-03-09T07:00:00Z')).attention.length, 1);
});

test('Home separates a new workspace, future work, unavailable work, and hidden history', () => {
  const future = task('future', { planned: '2026-09-19' }), finished = task('finished', { status: 'done' });
  assert.equal(state([]).emptyState, 'empty');
  assert.equal(state([task('trash', { trashed: true })]).emptyState, 'empty');
  assert.equal(state([future]).emptyState, 'future');
  assert.equal(state([task('waiting', { status: 'waiting' })]).emptyState, 'not-ready');
  assert.equal(state([finished]).emptyState, 'finished');
  assert.equal(state([future, finished]).tasks.length, 0);
  assert.deepEqual(state([future, finished], { showCompleted: true }).tasks.map(item => item.id), ['future', 'finished']);
});

test('Home keeps the selected day and timezone task order', () => {
  const first = task('first', { planned: '2026-09-18' }), second = task('second', { planned: '2026-09-18' });
  const taskState = { occurrences: [], events: [], routineEvents: [], focus: [], earnedXp: 0, orders: [
    { date: '2026-09-18', timezone: 'UTC', revision: 1, taskIds: ['first', 'second'] },
    { date: '2026-09-18', timezone: layout.timezone, revision: 1, taskIds: ['second', 'first'] },
  ] };
  assert.deepEqual(homeTaskState({ tasks: [first, second], taskState }, layout, now).tasks.map(item => item.id), ['second', 'first']);
});

test('Home renders first-task guidance only for empty work and retains history filter guidance', () => {
  assert.match(markup([]), /Add your first task/);
  const future = markup([task('Future task', { planned: '9999-01-01' })]);
  assert.doesNotMatch(future, /Add your first task/);
  assert.match(future, /Your next tasks are planned for later/);
  const finished = task('Finished task', { status: 'done' });
  assert.match(markup([finished]), /Show completed tasks to review them/);
  assert.match(markup([finished], { showCompleted: true }), /Reopen Finished task/);
  assert.doesNotMatch(markup([finished], { showCompleted: true }), /Show completed tasks to review them/);
});

test('Home renders singular and plural attention reasons while keeping unsaved draft recovery', () => {
  const overdue = task('Overdue task', { due: '2000-01-01' });
  const single = markup([overdue]);
  assert.match(single, /1 step needs a fresh look/);
  assert.match(single, /1 overdue deadline/);
  const plural = markup([overdue, task('Waiting task', { status: 'waiting' })]);
  assert.match(plural, /2 steps need a fresh look/);
  assert.match(plural, /1 waiting task/);
  const draft = markup([overdue], {}, true);
  assert.match(draft, /Keep this unsaved thought/);
  assert.match(draft, /Waiting to save/);
  assert.match(draft, /Review draft/);
  assert.match(draft, /Review tasks/);
});
