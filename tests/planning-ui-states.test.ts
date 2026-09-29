import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { Children, createElement, isValidElement, type ReactNode, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Parser } from 'htmlparser2';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { createStore } from 'zustand/vanilla';
import { HomeAppointmentContent } from '../apps/client/src/HomeAppointmentWidget';
import type { CalendarState } from '../packages/domain/calendar';
import type { GitHubRepository } from '../packages/domain/work-repositories';
import type { EventDraft } from '../apps/client/src/calendar-edit';
import { CalendarStoreProvider, createCalendarStore, type CalendarHost } from '../apps/client/src/dreamclaw/stores/calendarStore';
import { DEFAULT_FILTER, type CalendarEvent } from '../apps/client/src/dreamclaw/pages/Calendar/calendarTypes';

const styles = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { RepositoryResults } = await import('../apps/client/src/GitHubRepositoryPicker');
const { TaskEmptyState } = await import('../apps/client/src/Tasks');
const { MonthView } = await import('../apps/client/src/dreamclaw/pages/Calendar/MonthView');
const { WeekView } = await import('../apps/client/src/dreamclaw/pages/Calendar/WeekView');
const { default: CalendarPage } = await import('../apps/client/src/dreamclaw/pages/Calendar/index');
styles.deregister();
const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { translation: {} } } });

type Node = { tag: string; attrs: Record<string, string>; parent?: Node; text: string };
function nodes(markup: string) {
  const found: Node[] = [], stack: Node[] = [];
  new Parser({ onopentag(tag, attrs) { const node = { tag, attrs, parent: stack.at(-1), text: '' }; found.push(node); stack.push(node); }, ontext(text) { for (const node of stack) node.text += text; }, onclosetag() { stack.pop(); } }).end(markup);
  return found;
}
function elements(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(tree).flatMap(child => isValidElement<Record<string, unknown>>(child) ? [child, ...elements(child.props.children as ReactNode), ...elements(child.props.action as ReactNode)] : []);
}

const savedCalendar: CalendarState = { epoch: 'fixture', deviceId: 'device', range: { from: '2026-09-19', to: '2026-10-19', timezone: 'UTC' }, eventsLimited: false, events: [], localEvents: [], sources: [], selection: { revision: 0, sourceIds: [], showLocal: true, showTasks: true }, jobs: [], accountMessages: [] };
test('compact Home never presents incomplete or failed calendar reads as a confirmed empty schedule', () => {
  const render = (state?: CalendarState, error = '', size: 'compact' | 'square' = 'compact') => renderToStaticMarkup(createElement(HomeAppointmentContent, { state, error, size, timezone: 'UTC', now: Date.parse('2026-09-19T18:00:00Z'), openCalendar() {} }));
  const selectedSource = { id: 'source', accountId: 'account', generation: 'generation', provider: 'google' as const, calendarId: 'calendar', name: 'Fixture', accountLabel: 'Fixture', primary: true, providerCanWrite: false, selected: true, state: 'stale' as const };
  for (const state of [
    { ...savedCalendar, eventsLimited: true },
    { ...savedCalendar, sources: [selectedSource] },
    { ...savedCalendar, selection: { ...savedCalendar.selection, sourceIds: ['missing'] } },
    { ...savedCalendar, accountMessages: [{ accountId: 'account', label: 'Fixture', message: 'Limited', limited: true }] },
  ]) {
    const before = structuredClone(state);
    assert.match(render(state), /Schedule needs refreshing/);
    assert.doesNotMatch(render(state), /No upcoming event/);
    assert.match(render(state, '', 'square'), /Schedule needs refreshing/);
    assert.deepEqual(state, before);
  }
  assert.match(render(savedCalendar, 'Refresh failed'), /Schedule needs refreshing/);
  assert.match(render(undefined, 'Refresh failed'), /Calendar unavailable/);
  assert.match(render(), /Loading your schedule/);
  assert.match(render(savedCalendar), /No upcoming event/);
  assert.match(render(savedCalendar), /Open Calendar/);
});

test('Tasks explains each empty destination, preserves calendar uncertainty, and wires filter recovery', () => {
  const base = { searching: false, filtered: false, calendarStatus: 'ready' as const, clearFilters() {} };
  for (const [destination, message] of [['Trash', 'Trash is empty.'], ['Completed', 'No completed tasks yet.'], ['Daily', 'No daily tasks for today.'], ['To-dos', 'No to-dos for today.']]) {
    const markup = renderToStaticMarkup(createElement(TaskEmptyState, { ...base, destination }));
    assert.ok(markup.includes(message));
    assert.equal(nodes(markup).some(node => node.tag === 'button'), false);
  }
  for (const calendarStatus of ['loading', 'unavailable'] as const) {
    let cleared = 0;
    const tree = TaskEmptyState({ ...base, destination: 'Search results', searching: true, calendarStatus, clearFilters() { cleared++; } });
    const markup = renderToStaticMarkup(tree);
    assert.match(markup, /No saved tasks match your search/);
    assert.ok(markup.includes(calendarStatus === 'loading' ? 'still loading' : 'could not be checked'));
    const clear = elements(tree).find(node => node.type === 'button')!;
    (clear.props.onClick as () => void)();
    assert.equal(cleared, 1);
  }
  assert.match(renderToStaticMarkup(createElement(TaskEmptyState, { ...base, destination: 'Scheduled', filtered: true })), /No tasks match these filters/);
});

test('repository picker distinguishes loading, accessible-empty, filter-empty and retry without losing repository choices', () => {
  const repository: GitHubRepository = { id: 7, fullName: 'fixture/Planning', description: '', private: true, defaultBranch: 'main', canPush: true, archived: false };
  let cleared = 0, retries = 0, selected: GitHubRepository | undefined;
  const props = { repositories: [repository], query: '', state: 'ready' as const, disabled: false, selectedId: 7, onChoose(value: GitHubRepository) { selected = value; }, clearQuery() { cleared++; }, retry() { retries++; } };
  const render = (patch: Partial<Parameters<typeof RepositoryResults>[0]>) => renderToStaticMarkup(createElement(RepositoryResults, { ...props, ...patch }));
  assert.doesNotMatch(render({ state: 'idle', repositories: [] }), /No accessible repositories/);
  assert.match(render({ state: 'loading', repositories: [] }), /Loading repositories/);
  assert.doesNotMatch(render({ state: 'loading', repositories: [] }), /No accessible repositories/);
  assert.match(render({ repositories: [] }), /No accessible repositories found/);
  assert.match(render({ query: 'missing' }), /No loaded repositories match/);
  const clear = elements(RepositoryResults({ ...props, query: 'missing' })).find(node => node.type === 'button')!;
  (clear.props.onClick as () => void)(); assert.equal(cleared, 1);
  const retry = elements(RepositoryResults({ ...props, repositories: [], state: 'error' })).find(node => node.type === 'button')!;
  (retry.props.onClick as () => void)(); assert.equal(retries, 1);
  const choice = elements(RepositoryResults({ ...props, query: '  PLANNING  ' })).find(node => node.type === 'button')!;
  assert.equal(choice.props['aria-pressed'], true); (choice.props.onClick as () => void)(); assert.equal(selected, repository);
  assert.equal(nodes(render({ repositories: [{ ...repository, archived: true }] })).find(node => node.tag === 'button')?.attrs.disabled, '');
  assert.equal(nodes(render({ disabled: true })).find(node => node.tag === 'button')?.attrs.disabled, '');
});

function calendarFixture(weekStartDay: 0 | 1 = 0, draft?: EventDraft) {
  const date = new Date(2099, 8, 15);
  const event: CalendarEvent = { id: 'event-kept', title: 'Planning meeting', date: '2099-09-15', startTime: '10:00', endTime: '11:00', allDay: false, category: 'work', source: 'local', reminderMinutes: 0, reminderStatus: 'none', deliveryChannel: 'last', status: 'scheduled', createdAt: '', updatedAt: '' };
  const host = { keepView() {}, editor: createStore(() => ({ open: false, keptDrafts: [], draft })), readCached: () => ({ events: [event], operationalEvents: [], queryState: 'ready', error: null, syncMode: 'local-only', sourceStates: [], lastSyncedAt: null }) } as unknown as CalendarHost;
  const store = createCalendarStore(host, { date, view: 'month', timezone: 'UTC', filter: DEFAULT_FILTER });
  // The server snapshot is captured at store creation, so update the shared settings fixture.
  store.getState().settings.weekStartDay = weekStartDay;
  const render = (child: ReactNode) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(CalendarStoreProvider, { store, children: child })));
  return { render, event };
}

test('month calendar owns its header and six week rows with 42 cells and one selected date tab stop', () => {
  for (const start of [0, 1] as const) {
    const { render } = calendarFixture(start);
    const rendered = nodes(render(createElement(MonthView, { onDateClick() {}, onEventClick() {} })));
    const grid = rendered.find(node => node.attrs.role === 'grid')!;
    assert.equal(grid.attrs['aria-label'], 'September 2099 calendar');
    const rows = rendered.filter(node => node.attrs.role === 'row');
    assert.equal(rows.length, 7);
    const headers = rendered.filter(node => node.attrs.role === 'columnheader');
    assert.equal(headers.length, 7); assert.equal(headers[0].text, start === 0 ? 'Sun' : 'Mon');
    assert.equal(headers[0].parent?.parent, grid);
    const cells = rendered.filter(node => node.attrs.role === 'gridcell');
    assert.equal(cells.length, 42);
    for (const cell of cells) { assert.equal(cell.parent?.attrs.role, 'row'); assert.equal(cell.parent?.parent?.attrs.role, 'rowgroup'); assert.equal(cell.parent?.parent?.parent, grid); }
    const dates = rendered.filter(node => node.tag === 'button' && 'data-calendar-day' in node.attrs);
    assert.equal(dates.length, 42); assert.equal(dates.filter(node => node.attrs.tabindex === '0').length, 1);
    assert.match(dates.find(node => node.attrs.tabindex === '0')!.attrs['aria-label'], /September 15, 2099/);
  }
});

test('both Calendar agendas expose saved event identities as native buttons', () => {
  const { render, event } = calendarFixture();
  const before = structuredClone(event);
  const rendered = nodes(render(createElement(CalendarPage)));
  const eventButtons = rendered.filter(node => node.tag === 'button' && node.attrs['data-calendar-event-id'] === event.id);
  assert.equal(eventButtons.length, 2, 'Selected-day and upcoming agendas are both native controls');
  for (const button of eventButtons) { assert.equal(button.attrs.type, 'button'); assert.match(button.text, /Planning meeting/); }
  assert.deepEqual(event, before);
});

test('Calendar sidebar announces a new event or a retained edit without presenting a retained edit as Add', () => {
  const kept: EventDraft = { id: 'saved-event', epoch: 'fixture', revision: 7, value: { title: 'Kept edit', notes: '', location: '', timezone: 'UTC', allDay: true, start: { date: '2099-09-15', time: '' }, end: { date: '2099-09-15', time: '' }, state: 'confirmed', projectId: null, taskId: null } };
  for (const draft of [undefined, kept]) {
    const before = structuredClone(draft);
    const { render } = calendarFixture(0, draft);
    const button = nodes(render(createElement(CalendarPage))).find(node => node.tag === 'button' && node.attrs.class?.includes('dc-calendar-agenda-add'))!;
    assert.equal(button.text, draft ? 'Continue' : 'Add');
    assert.equal(button.attrs['aria-label'], draft ? 'Continue event draft' : 'Add event');
    assert.deepEqual(draft, before);
  }
});

test('week schedule provides a named keyboard-focusable region with all seven date controls and saved events', () => {
  const { render, event } = calendarFixture();
  const rendered = nodes(render(createElement(WeekView, { onDateClick() {}, onEventClick() {} })));
  const regions = rendered.filter(node => node.attrs.role === 'region');
  assert.equal(regions.length, 1); assert.equal(regions[0].attrs['aria-label'], 'Week schedule'); assert.equal(regions[0].attrs.tabindex, '0');
  assert.equal(rendered.filter(node => node.tag === 'button' && 'data-calendar-day' in node.attrs).length, 7);
  assert.equal(rendered.filter(node => node.attrs['data-calendar-event-id'] === event.id).length, 1);
});
