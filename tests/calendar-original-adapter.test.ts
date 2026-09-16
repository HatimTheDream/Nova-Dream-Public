import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarFormInput, localEditorValues, projectCalendarEvent } from '../apps/client/src/dreamclaw/calendar-projection';
import type { CalendarState, LocalCalendarOccurrence, LocalEventInput } from '../packages/domain/calendar';

const value: LocalEventInput = { title: 'Across timezones', notes: 'Kept note', location: 'Studio', timezone: 'Asia/Tokyo', allDay: false,
  start: { date: '2026-09-09', time: '09:00' }, end: { date: '2026-09-09', time: '10:00' }, state: 'confirmed', projectId: 'project:kept', taskId: null };
const local: LocalCalendarOccurrence = { id: 'local-id', eventId: 'local-id', deviceId: 'device', revision: 4, overrideRevision: 0, updatedAt: '2026-09-08T10:00:00Z', value };
const state: CalendarState = { epoch: 'epoch', deviceId: 'device', range: { from: '2026-09-01', to: '2026-10-01', timezone: 'America/Los_Angeles' }, eventsLimited: false, events: [], localEvents: [local], sources: [], selection: { revision: 0, sourceIds: [], showLocal: true, showTasks: true }, jobs: [], accountMessages: [] };

test('original calendar shows host-zone dates while editing preserves the event’s own timezone and context', () => {
  const shown = projectCalendarEvent({ id: local.id, sourceId: 'local', title: value.title, notes: value.notes, location: value.location, status: 'confirmed', interval: { kind: 'instant', start: '2026-09-09T00:00:00Z', end: '2026-09-09T01:00:00Z' } }, state);
  assert.equal(shown.date, '2026-09-08'); assert.equal(shown.startTime, '17:00');
  const editor = localEditorValues(shown, local);
  assert.equal(editor.date, '2026-09-09'); assert.equal(editor.startTime, '09:00');
  const saved = calendarFormInput({ ...editor, title: 'Title only' }, state.range.timezone, value);
  assert.equal(saved.timezone, 'Asia/Tokyo'); assert.deepEqual(saved.start, value.start); assert.deepEqual(saved.end, value.end);
  assert.equal(saved.projectId, value.projectId);
});

test('original inclusive all-day display and moves retain the exclusive multi-day host span', () => {
  const allDay: LocalEventInput = { ...value, allDay: true, start: { date: '2026-09-08', time: '00:00' }, end: { date: '2026-09-11', time: '00:00' } };
  const source = { ...local, value: allDay };
  const shown = projectCalendarEvent({ id: local.id, sourceId: 'local', title: value.title, notes: '', location: '', status: 'confirmed', interval: { kind: 'date', start: '2026-09-08', end: '2026-09-11' } }, { ...state, localEvents: [source] });
  assert.equal(shown.date, '2026-09-08'); assert.equal(shown.endDate, '2026-09-10');
  const edited = localEditorValues(shown, source);
  assert.equal(calendarFormInput(edited, state.range.timezone, allDay).end.date, '2026-09-11');
  const moved = calendarFormInput({ ...edited, date: '2026-09-15', endDate: undefined }, state.range.timezone, allDay);
  assert.equal(moved.end.date, '2026-09-18'); assert.equal(moved.timezone, 'Asia/Tokyo');
});

test('simpler original repeat field does not erase existing interval, monthly policy, count, or clock disambiguation', () => {
  const previous: LocalEventInput = { ...value, start: { ...value.start, overlap: 'later' }, repeat: { cadence: 'monthly', interval: 2, weekdays: [], count: 7, monthDay: 31, missingDay: 'skip', monthPattern: 'date' } };
  const saved = calendarFormInput({ title: 'Refined title', date: value.start.date, startTime: '09:00', endTime: '10:00', allDay: false, recurrence: { freq: 'monthly', interval: 1 } }, 'UTC', previous);
  assert.deepEqual(saved.repeat, previous.repeat); assert.equal(saved.start.overlap, 'later');
  assert.equal(calendarFormInput({ title: 'No repeat', date: value.start.date, startTime: '09:00', endTime: '10:00', allDay: false }, 'UTC', previous).repeat, undefined);
});

test('the original calendar keeps provider identities separate across accounts and retains non-editable clock reviews', () => {
  const event = { id: 'shared-provider-id', title: 'Meeting', notes: '', location: '', status: 'confirmed' as const, interval: { kind: 'date' as const, start: '2026-09-08', end: '2026-09-09' } };
  const connected: CalendarState = { ...state, sources: ['a', 'b'].map(id => ({ id: `account-${id}`, accountId: id, generation: 'generation', provider: 'google', calendarId: 'calendar', name: 'Calendar', accountLabel: id, primary: true, providerCanWrite: false, selected: true, state: 'ready' })) };
  const first = projectCalendarEvent({ ...event, sourceId: 'account-a' }, connected);
  const second = projectCalendarEvent({ ...event, sourceId: 'account-b' }, connected);
  assert.notEqual(first.id, second.id);
  assert.equal(first.sourceAccount, 'a'); assert.equal(second.sourceAccount, 'b');
  assert.throws(() => projectCalendarEvent({ ...event, sourceId: 'account-missing' }, connected), /source is unavailable/);
  const review = projectCalendarEvent({ ...event, id: local.id, sourceId: 'local', warning: 'Clock time needs review' }, state);
  assert.equal(review.readOnly, true); assert.match(review.notes!, /Clock time needs review/);
});


test('original related-schedule choices preserve opaque account identities, include the target and stay bounded', async () => {
  const { relatedCalendarSeries } = await import('../apps/client/src/dreamclaw/services/calendar/seriesDeletion');
  const make = (id: string, account = 'Account', calendar = 'Calendar'): any => ({ id, title: 'Classes: morning', source: 'google', sourceAccount: account, calendarId: calendar, recurringEventId: id, date: '2026-09-10' });
  const target = make('selected');
  const isolated = relatedCalendarSeries([make('other-account', 'account'), make('other-calendar', 'Account', 'calendar'), make('matching')], target);
  assert.deepEqual(new Set(isolated.map(item => item.seriesId)), new Set(['selected', 'matching']));
  const many = Array.from({ length: 40 }, (_, i) => make('series-' + i));
  for (const limit of [31, 1, 40, NaN]) {
    const choices = relatedCalendarSeries(many, target, limit);
    assert.ok(choices.length <= 31); assert.ok(choices.some(item => item.seriesId === 'selected'));
    if (limit === 1) assert.equal(choices.length, 1);
  }
});

test('original Calendar opens the exact one-off or recurring provider checklist even on read-only calendars', async t => {
  const { createCalendarHost } = await import('../apps/client/src/dreamclaw/calendar-host');
  const records = new Map<string, string>(), previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); });
  const received: any[] = [], navigated: string[] = [];
  const sources: CalendarState['sources'] = ['a', 'b'].map(id => ({ id, accountId: id, generation: 'generation', provider: 'google', calendarId: 'calendar', name: 'Calendar', accountLabel: id, primary: false, providerCanWrite: false, accountCanWrite: false, selected: true, state: 'ready' }));
  const events: CalendarState['events'] = [
    ...sources.map(source => ({ id: 'same-id', sourceId: source.id, title: 'Provider event', notes: '', location: '', status: 'confirmed' as const, interval: { kind: 'date' as const, start: '2026-09-13', end: '2026-09-14' }, ...(source.id === 'b' ? { seriesId: 'series', originalStart: '2026-09-13' } : {}) })),
    { id: 'task:one-off', taskId: 'task:one-off', sourceId: 'tasks', title: 'Existing task', notes: '', location: '', status: 'confirmed', interval: { kind: 'date', start: '2026-09-13', end: '2026-09-14' } },
  ];
  events.push({ id: local.id, sourceId: 'local', title: value.title, notes: value.notes, location: value.location, status: 'confirmed', interval: { kind: 'instant', start: '2026-09-09T00:00:00Z', end: '2026-09-09T01:00:00Z' } });
  const response = { ...state, sources, events, selection: { ...state.selection, revision: 1 } };
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } }));
  const host = createCalendarHost({ snapshot: { epoch: state.epoch, deviceId: state.deviceId, layout: { value: { timezone: 'UTC' } } } as any, windowId: 'subtasks', keepView() {}, changed: async () => {}, navigate: route => navigated.push(route), openSubtasks: (row, captured, original) => received.push({ row, captured, original }) });
  const read = await host.read({ startDate: '2026-09-01', endDate: '2026-10-01' } as any, false, new AbortController().signal);
  for (const event of read.events.filter(e => e.source !== 'local')) host.openSubtasks!(event);
  assert.deepEqual(received.map(item => item.row.key), ['a:same-id', 'b:same-id']);
  assert.equal(received[0].row.group, 'One-offs'); assert.equal(received[1].row.event.originalStart, '2026-09-13');
  assert.ok(received.every(item => item.original.readOnly));
  const { eventForDraft } = await import('../apps/client/src/dreamclaw/calendar-editor');
  host.editor.getState().openSaved({ epoch: state.epoch, event: { id: local.id, revision: local.revision, value }, occurrence: local } as any);
  host.openSubtasks!(eventForDraft(host.editor.getState().draft!));
  assert.equal(received.at(-1).row.localId, local.id);
  assert.ok(received.at(-1).original.writeToken); // Returning to Calendar retains the original editor identity.
  assert.throws(() => host.openSubtasks!({ ...read.events[0], id: 'missing' }), /exact date/);
  host.openSubtasks!(read.operationalEvents![0]);
  assert.deepEqual(navigated, ['/tasks?task=task%3Aone-off']);
});
