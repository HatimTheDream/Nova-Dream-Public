import test from 'node:test';
import assert from 'node:assert/strict';
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Home } from '../apps/client/src/Home';
import { HomeWidgetContent } from '../apps/client/src/HomeWidgets';
import { homeTaskState } from '../apps/client/src/home-task-state';
import { defaultLayout, emptyDraft, type Draft, type Entity, type Layout, type Snapshot, type Task, type WidgetId } from '../packages/domain/contracts';
import { createHomeWidget, resolveWidgetType, type HomeWidget } from '../packages/domain/home-widgets';

const now = Date.parse('2026-09-18T07:30:00Z');
const layout: Layout = { ...defaultLayout, timezone: 'America/Los_Angeles' };
const task = (id: string, value: Partial<Task> = {}): Entity<Task> => ({ id, revision: 1, deviceId: 'fixture', updatedAt: new Date(now).toISOString(), value: { title: id, notes: '', status: 'open', planned: '', due: '', ...value } });
const state = (tasks: Entity<Task>[], options: Partial<Layout> = {}, at = now) => homeTaskState({ tasks }, { ...layout, ...options }, at);
const markup = (tasks: Entity<Task>[], options: Partial<Layout> = {}, dirty = false, draft: Partial<Draft> = {}, extra: Partial<Pick<Snapshot, 'projects' | 'taskState'>> = {}) => {
  const currentLayout = { ...layout, ...options };
  const snapshot: Snapshot = { epoch: 'fixture', cursor: 0, deviceId: 'fixture', layout: { id: 'layout', revision: 1, deviceId: 'fixture', updatedAt: '', value: currentLayout }, tasks, drafts: [], projects: [], capabilities: { assistant: false, voice: false, reason: '' }, ...extra };
  return renderToStaticMarkup(createElement(Home, { snapshot, layout: currentLayout, saveLayout() {}, open() {}, openSettings() {}, newTask() {}, editTask() {}, complete() {}, draft: { ...emptyDraft, text: dirty ? 'Keep this unsaved thought' : '', ...draft }, dirty, draftStatus: 'Waiting to save' }));
};
const onlyWidget = (id: WidgetId): Partial<Layout> => ({ widgets: layout.widgets.map(widget => ({ ...widget, hidden: widget.id !== id })) });
const widgetProps = (tasks: Entity<Task>[], widget: HomeWidget, overrides: Partial<Parameters<typeof HomeWidgetContent>[0]> = {}): Parameters<typeof HomeWidgetContent>[0] => ({
  id: resolveWidgetType(widget), widget, state: state(tasks), draft: emptyDraft, dirty: false, draftStatus: '',
  time: '12:30 AM', date: 'Friday, September 18', timezone: layout.timezone, now,
  open() {}, openSettings() {}, newTask() {}, editTask() {}, complete() {}, ...overrides,
});
const renderWidget = (tasks: Entity<Task>[], widget: HomeWidget, overrides: Partial<Parameters<typeof HomeWidgetContent>[0]> = {}) => renderToStaticMarkup(createElement(HomeWidgetContent, widgetProps(tasks, widget, overrides)));
const section = (rendered: string, title: string) => {
  const match = rendered.match(new RegExp(`<section[^>]*aria-label="${title}"[\\s\\S]*?</section>`));
  assert.ok(match, `Expected the ${title} widget`);
  return match[0];
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
  assert.match(markup([]), /Add Your First Task/);
  const future = markup([task('Future task', { planned: '9999-01-01' })]);
  assert.doesNotMatch(future, /Add Your First Task/);
  assert.match(future, /Your next tasks are planned for later/);
  const finished = task('Finished task', { status: 'done' });
  assert.match(markup([finished]), /Show completed tasks to review them/);
  assert.match(markup([finished], { showCompleted: true }), /Reopen Finished task/);
  assert.doesNotMatch(markup([finished], { showCompleted: true }), /Show completed tasks to review them/);
});

test('Home keeps specific task attention visible alongside unsaved draft recovery', () => {
  const overdue = task('Overdue task', { due: '2000-01-01' });
  const single = markup([overdue], onlyWidget('attention'));
  assert.match(single, /1 task needs review/);
  assert.match(single, /aria-label="Review Overdue task: Overdue deadline"/);
  const waiting = task('Waiting task', { status: 'waiting', planned: '2000-01-01' });
  const combined = markup([overdue, waiting], onlyWidget('attention'), true);
  assert.match(combined, /2 tasks need review/);
  assert.match(combined, /aria-label="Review Overdue task: Overdue deadline"/);
  assert.doesNotMatch(combined, /aria-label="Review Waiting task:/);
  assert.match(combined, /1 more task to review/);
  assert.match(combined, /Waiting to save/);
  assert.match(combined, /Review Draft/);
  assert.match(combined, /Open Tasks/);
  const draft = markup([overdue], onlyWidget('draft'), true);
  assert.match(draft, /Keep this unsaved thought/);
  assert.match(draft, /Waiting to save/);
});

test('Home bounds attention previews and discloses the remaining tasks', () => {
  const tasks = ['First', 'Second', 'Third', 'Fourth', 'Fifth'].map(title => task(title, { status: 'blocked' }));
  for (const count of [3, 4, 5]) {
    const rendered = markup(tasks.slice(0, count), onlyWidget('attention'));
    assert.equal((rendered.match(/aria-label="Review /g) ?? []).length, 2);
    for (const title of ['First', 'Second']) assert.ok(rendered.includes(`aria-label="Review ${title}: Blocked"`));
    assert.doesNotMatch(rendered, /Third|Fourth|Fifth/);
    assert.ok(rendered.includes(`${count - 2} more ${count === 3 ? 'task' : 'tasks'} to review`));
    assert.match(rendered, /Open Tasks/);
  }
});

test('Home recognizes attachment-only drafts without claiming pending attachments are saved', () => {
  const attached: Partial<Draft> = { title: 'Brief to continue', text: '   ', attachments: [{ id: 'file:brief', name: 'brief.txt', size: 12, sha256: 'a'.repeat(64) }] };
  const rendered = markup([], onlyWidget('draft'), true, attached);
  assert.match(rendered, /Brief to continue/);
  assert.match(rendered, /Continue Draft/);
  assert.match(rendered, /1 attachment/);
  assert.match(rendered, /Waiting to save/);
  assert.doesNotMatch(rendered, /saved attachment|Start a conversation|Open Assistant/);
  assert.match(markup([], onlyWidget('setup'), false, attached), /Continue Draft/);
  assert.match(markup([], onlyWidget('draft'), false, { text: '   ' }), /Open Assistant/);
});

test('Reviewing a Home attention item opens its exact task without completing it', () => {
  const target = task('Needs a decision', { status: 'blocked' });
  const edits: Entity<Task>[] = [], completions: Entity<Task>[] = [];
  const content = HomeWidgetContent({ id: 'attention', state: state([target]), draft: emptyDraft, dirty: false, draftStatus: '', time: '', date: '', timezone: layout.timezone, open() {}, openSettings() {}, newTask() {}, editTask: item => edits.push(item), complete: item => completions.push(item) });
  type ButtonProps = { children?: ReactNode; onClick?: () => void; 'aria-label'?: string };
  const buttons = (node: ReactNode): ReactElement<ButtonProps>[] => Children.toArray(node).flatMap(child => {
    if (!isValidElement<ButtonProps>(child)) return [];
    return [...(child.type === 'button' ? [child] : []), ...buttons(child.props.children)];
  });
  const review = buttons(content).find(button => button.props['aria-label'] === 'Review Needs a decision: Blocked');
  assert.ok(review?.props.onClick);
  review.props.onClick();
  assert.deepEqual(edits, [target]);
  assert.equal(edits[0], target);
  assert.deepEqual(completions, []);
});

test('ready work excludes unmet, skipped, missing, and trashed prerequisites while preserving saved order', () => {
  const tasks = [
    task('ready-second', { dependencies: ['finished-prerequisite'] }),
    task('ready-first', { status: 'active', dependencies: ['finished-prerequisite'] }),
    task('open-prerequisite'), task('finished-prerequisite', { status: 'done' }),
    task('skipped-prerequisite', { status: 'skipped' }),
    task('trashed-prerequisite', { status: 'done', trashed: true }),
    task('waiting-on-open', { dependencies: ['open-prerequisite'] }),
    task('waiting-on-skipped', { dependencies: ['skipped-prerequisite'] }),
    task('waiting-on-missing', { dependencies: ['missing-prerequisite'] }),
    task('waiting-on-trash', { dependencies: ['trashed-prerequisite'] }),
    task('waiting-on-itself', { dependencies: ['waiting-on-itself'] }),
    task('future', { planned: '2026-09-19' }),
    task('waiting', { status: 'waiting' }), task('blocked', { status: 'blocked' }),
  ];
  const original = structuredClone(tasks);
  const taskState = { occurrences: [], events: [], routineEvents: [], focus: [], earnedXp: 0,
    orders: [{ date: '2026-09-18', timezone: layout.timezone, revision: 1, taskIds: ['ready-first', 'ready-second', 'open-prerequisite'] }] };
  const current = homeTaskState({ tasks, taskState }, { ...layout, showCompleted: true }, now);
  assert.deepEqual(current.ready.map(item => item.id), ['ready-first', 'ready-second', 'open-prerequisite']);
  assert.equal(current.tasks.length, tasks.length - 1);
  assert.deepEqual(tasks, original);
});

test('a project task remains ready when its completed prerequisite belongs to another project', () => {
  const prerequisite = task('other-project-prerequisite', { projectId: 'project:beta', status: 'done' });
  const dependent = task('project-alpha-next', { projectId: 'project:alpha', dependencies: [prerequisite.id] });
  const all = [prerequisite, dependent];
  const filtered = homeTaskState({ tasks: [dependent] }, layout, now, all);
  assert.deepEqual(filtered.ready, [dependent]);
  assert.deepEqual(homeTaskState({ tasks: [dependent] }, layout, now, [dependent]).ready, []);
  const trashed = { ...prerequisite, value: { ...prerequisite.value, trashed: true } };
  assert.deepEqual(homeTaskState({ tasks: [dependent] }, layout, now, [trashed, dependent]).ready, []);
});

test('each Tasks widget applies its own view and preview limit independently of legacy history visibility', () => {
  const tasks = [task('Ready first'), task('Ready second'), task('Waiting item', { status: 'waiting' }),
    task('Future item', { planned: '2026-09-19' }), task('Completed item', { status: 'done' }), task('Trashed item', { trashed: true })];
  const base = { ...createHomeWidget('next'), size: 'large' as const };
  const ready = renderWidget(tasks, { ...base, settings: { view: 'ready', limit: 1 } }, { state: state(tasks, { showCompleted: true }) });
  assert.match(ready, /Ready first/);
  assert.doesNotMatch(ready, /Ready second|Waiting item|Future item|Completed item|Trashed item/);
  assert.match(ready, /Showing 1 of 2 matching tasks/);
  const all = renderWidget(tasks, { ...base, settings: { view: 'all', limit: 12 } });
  for (const title of ['Ready first', 'Ready second', 'Waiting item', 'Future item', 'Completed item']) assert.ok(all.includes(title));
  assert.doesNotMatch(all, /Trashed item/);
  const attention = renderWidget(tasks, { ...base, settings: { view: 'attention', limit: 12 } });
  assert.match(attention, /Waiting item/);
  assert.doesNotMatch(attention, /Ready first|Ready second|Future item|Completed item|Trashed item/);
  const upcoming = renderWidget(tasks, { ...base, settings: { view: 'upcoming', limit: 12 } });
  assert.match(upcoming, /Future item/);
  assert.doesNotMatch(upcoming, /Ready first|Ready second|Waiting item|Completed item|Trashed item/);
});

test('the Home board keeps two project filters independent and resolves prerequisites across the whole workspace', () => {
  const alpha = { ...createHomeWidget('next'), title: 'Alpha work', settings: { projectId: 'project:alpha', view: 'ready' as const, limit: 1 } };
  const beta = { ...createHomeWidget('next'), title: 'Beta work', settings: { projectId: 'project:beta', view: 'all' as const, limit: 12 } };
  const projects: Snapshot['projects'] = ['alpha', 'beta'].map(name => ({ id: `project:${name}`, revision: 1, deviceId: 'fixture', updatedAt: '', value: { name, purpose: '' } }));
  const tasks = [task('Alpha next', { projectId: 'project:alpha', dependencies: ['Beta finished'] }),
    task('Beta finished', { projectId: 'project:beta', status: 'done' }), task('Beta next', { projectId: 'project:beta' }),
    task('No project task')];
  const original = structuredClone({ tasks, widgets: [alpha, beta] });
  const rendered = markup(tasks, { widgets: [alpha, beta], showCompleted: true }, false, {}, { projects });
  assert.match(section(rendered, 'Alpha work'), /Alpha next/);
  assert.doesNotMatch(section(rendered, 'Alpha work'), /Beta next|Beta finished|No project task/);
  assert.match(section(rendered, 'Beta work'), /Beta next/);
  assert.match(section(rendered, 'Beta work'), /Beta finished/);
  assert.doesNotMatch(section(rendered, 'Beta work'), /Alpha next|No project task/);
  assert.deepEqual({ tasks, widgets: [alpha, beta] }, original);
});

test('unavailable project filters stay explicit while existing empty projects do not fall back to unrelated tasks', () => {
  const missing = { ...createHomeWidget('next'), title: 'Missing project work', settings: { projectId: 'project:missing', view: 'all' as const } };
  const empty = { ...createHomeWidget('next'), title: 'Empty project work', settings: { projectId: 'project:empty', view: 'ready' as const } };
  const projects: Snapshot['projects'] = [{ id: 'project:empty', revision: 1, deviceId: 'fixture', updatedAt: '', value: { name: 'Empty project', purpose: '' } }];
  const rendered = markup([task('Unrelated work'), task('Orphaned project task', { projectId: 'project:missing' })], { widgets: [missing, empty] }, false, {}, { projects });
  assert.match(section(rendered, 'Missing project work'), /Project unavailable/);
  assert.match(section(rendered, 'Missing project work'), /Customize Widget/);
  assert.doesNotMatch(section(rendered, 'Missing project work'), /Orphaned project task|Unrelated work/);
  assert.match(section(rendered, 'Empty project work'), /No tasks yet/);
  assert.doesNotMatch(section(rendered, 'Empty project work'), /Project unavailable|Unrelated work|Orphaned project task/);
});

test('Next action opens the exact first ready task without completing it or starting blocked work', () => {
  const finished = task('Completed prerequisite', { status: 'done' });
  const ready = task('The next ready task', { dependencies: [finished.id] });
  const blocked = task('Unmet prerequisite task', { dependencies: ['missing'] });
  const tasks = [blocked, finished, ready];
  const widget = createHomeWidget('next-action');
  const edits: Entity<Task>[] = [], completions: Entity<Task>[] = [];
  const content = HomeWidgetContent(widgetProps(tasks, widget, { editTask: item => edits.push(item), complete: item => completions.push(item) }));
  const rendered = renderToStaticMarkup(content);
  assert.match(rendered, /The next ready task/);
  assert.doesNotMatch(rendered, /Completed prerequisite|Unmet prerequisite task/);
  type ButtonProps = { children?: ReactNode; onClick?: () => void };
  const buttons = (node: ReactNode): ReactElement<ButtonProps>[] => Children.toArray(node).flatMap(child => !isValidElement<ButtonProps>(child) ? [] : [...(child.type === 'button' ? [child] : []), ...buttons(child.props.children)]);
  const open = buttons(content).find(button => button.props.children === 'Open Task');
  assert.ok(open?.props.onClick);
  open.props.onClick();
  assert.deepEqual(edits, [ready]);
  assert.equal(edits[0], ready);
  assert.deepEqual(completions, []);
  const unavailable = renderWidget([blocked, finished], widget, { state: state([blocked, finished], { showCompleted: true }) });
  assert.match(unavailable, /No ready task right now/);
  assert.doesNotMatch(unavailable, /Open Task|The next ready task/);
});

test('Next action leaves routine occurrences to their widget and selects the first ready regular task', () => {
  const routine = task('A routine occurrence'), regular = task('B regular work');
  const tasks = [routine, regular];
  const snapshot: Snapshot = {
    epoch: 'fixture', cursor: 0, deviceId: 'fixture',
    layout: { id: 'layout', revision: 1, deviceId: 'fixture', updatedAt: '', value: layout },
    tasks, drafts: [], projects: [], capabilities: { assistant: false, voice: false, reason: '' },
    taskState: { occurrences: [{ taskId: routine.id, routineId: 'routine:daily', templateRevision: 1, date: '2026-09-18', timezone: layout.timezone, kind: 'task' }], events: [], routineEvents: [], focus: [], earnedXp: 0 },
  };
  assert.equal(state(tasks).ready[0], routine);
  const rendered = renderWidget(tasks, createHomeWidget('next-action'), { snapshot });
  assert.match(rendered, /B regular work/);
  assert.doesNotMatch(rendered, /A routine occurrence/);
  const onlyRoutine = renderWidget([routine], createHomeWidget('next-action'), { snapshot });
  assert.match(onlyRoutine, /No ready task right now/);
  assert.doesNotMatch(onlyRoutine, /Open Task/);
  assert.deepEqual(state(tasks).ready, [routine, regular]);
});

test('upcoming task widgets use the supplied Home timezone date and omit finished future plans', () => {
  const tasks = [task('Next local day', { planned: '2026-09-18' }), task('Tomorrow again', { planned: '2026-09-19' }),
    task('Finished future plan', { planned: '2026-09-19', status: 'done' }), task('Skipped future plan', { planned: '2026-09-19', status: 'skipped' })];
  const widget = { ...createHomeWidget('next'), settings: { view: 'upcoming' as const, limit: 12 } };
  const honolulu = renderWidget(tasks, widget, { timezone: 'Pacific/Honolulu', state: state(tasks, { timezone: 'Pacific/Honolulu' }) });
  assert.match(honolulu, /Next local day/);
  assert.match(honolulu, /Tomorrow again/);
  assert.doesNotMatch(honolulu, /Finished future plan|Skipped future plan/);
  const losAngeles = renderWidget(tasks, widget);
  assert.doesNotMatch(losAngeles, /Next local day|Finished future plan|Skipped future plan/);
  assert.match(losAngeles, /Tomorrow again/);
});

test('multiple clocks display their own dates and timezones without changing workspace settings', context => {
  context.mock.method(Date, 'now', () => now);
  const homeClock = { ...createHomeWidget('clock'), title: 'Home clock' };
  const otherClock = { ...createHomeWidget('clock'), title: 'Honolulu clock', settings: { timezone: 'Pacific/Honolulu' } };
  const options = { widgets: [homeClock, otherClock], timezone: 'America/Los_Angeles' };
  const original = structuredClone(options);
  const rendered = markup([], options);
  const home = section(rendered, 'Home clock'), other = section(rendered, 'Honolulu clock');
  assert.match(home, /America\/Los Angeles/);
  assert.match(other, /Pacific\/Honolulu/);
  assert.ok(home.includes(new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' }).format(now)));
  assert.ok(other.includes(new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'Pacific/Honolulu' }).format(now)));
  assert.match(home, /dateTime="2026-09-18T07:30:00.000Z"/);
  assert.match(other, /dateTime="2026-09-18T07:30:00.000Z"/);
  assert.deepEqual(options, original);
});
