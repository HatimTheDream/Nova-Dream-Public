import type { CalendarSource } from '../packages/domain/accounts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store';
import { CalendarService } from '../apps/service/calendar';
import { calendarCompletionTarget, calendarCompletionKey, type CalendarCompletionCommand } from '../packages/domain/calendar-completion';
import { createCalendarCompletionActions, type CompletionJournal } from '../apps/client/src/calendar-completion-actions';
import type { CalendarDisplayEvent, CalendarPage } from '../packages/domain/calendar';
const range = { from: '2026-09-12', to: '2026-10-12', timezone: 'UTC' };
const accounts = { state: () => ({ accounts: [], clients: [], attempts: [], probes: [] }), calendarSources: async (): Promise<{ items: CalendarSource[]; limited: boolean }> => ({ items: [], limited: false }), calendarEvents: async (): Promise<CalendarPage> => ({ events: [], coverage: 'complete', pages: 1, skipped: 0 }) };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'nova-calendar-completion-')); let store = new Store(directory), calendar = new CalendarService(store, accounts);
  const create = (repeat = false) => calendar.saveLocal('a', { requestId: randomUUID(), epoch: store.epoch, eventId: randomUUID(), expectedRevision: 0, scope: repeat ? 'series' : 'event', value: { title: 'Workshop', notes: 'Original details', location: '', timezone: 'UTC', allDay: true, start: { date: '2026-09-13', time: '00:00' }, end: { date: '2026-09-14', time: '00:00' }, state: 'confirmed', projectId: null, taskId: null, ...(repeat ? { repeat: { cadence: 'weekly', interval: 1, weekdays: [0] } } : {}) } });
  const command = (event: CalendarDisplayEvent, done = true, revision = 0): CalendarCompletionCommand => ({ requestId: randomUUID(), epoch: store.epoch, target: calendarCompletionTarget(event), range, expectedRevision: revision, done });
  return { get store() { return store; }, get calendar() { return calendar; }, create, command, async restart() { await calendar.close(); store.close(); store = new Store(directory); calendar = new CalendarService(store, accounts); }, async close() { await calendar.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
test('one-off completion keeps the original event and survives restart and dates outside the current view', async () => {
  const f = fixture(); try {
    f.create(); const before = f.calendar.state('a', range).events[0], command = f.command(before);
    const done = f.calendar.completeTaskEvent('a', command);
    assert.equal(done.done, true); assert.deepEqual(f.calendar.completeTaskEvent('a', command), done);
    assert.deepEqual(f.calendar.state('b', range).events[0], { ...before, taskStatus: 'done' }); assert.equal(f.store.snapshot('b').tasks.length, 0);
    await f.restart(); assert.equal(f.store.snapshot('b').calendarCompletions?.[0].done, true);
    const later = { from: '2027-01-01', to: '2027-02-01', timezone: 'UTC' };
    assert.equal(f.calendar.state('b', later).events.length, 0);
    const reopened = f.calendar.completeTaskEvent('b', { ...command, requestId: randomUUID(), expectedRevision: 1, range: later, done: false });
    assert.equal(reopened.done, false); assert.equal(reopened.event.title, before.title);
    assert.throws(() => f.calendar.completeTaskEvent('a', { ...command, requestId: randomUUID() }), /another window/);
    assert.throws(() => f.calendar.completeTaskEvent('a', { ...command, done: false }), /different work/);
  } finally { await f.close(); }
});
test('completion belongs to one exact occurrence, validates its target, and never creates duplicate Tasks', async () => {
  const f = fixture(); try {
    f.create(true); const events = f.calendar.state('a', range).events; assert.ok(events.length >= 2);
    const done = f.calendar.completeTaskEvent('a', f.command(events[0]));
    assert.notEqual(calendarCompletionKey(calendarCompletionTarget(events[1])), done.key);
    assert.equal(f.store.snapshot('b').calendarCompletions?.length, 1);
    assert.throws(() => f.calendar.completeTaskEvent('a', { ...f.command(events[1]), target: { ...calendarCompletionTarget(events[1]), originalStart: 'wrong' } }), /Refresh/);
    assert.throws(() => f.calendar.completeTaskEvent('a', { ...f.command(events[1]), epoch: randomUUID() }), /workspace changed/);
    assert.equal(f.store.snapshot('b').tasks.length, 0);
  } finally { await f.close(); }
});
test('a lost completion response replays its durable request after reload, without double completion', async () => {
  const f = fixture(); try {
    f.create(); let journal: CompletionJournal | undefined, drop = true, disk = true;
    const make = () => createCalendarCompletionActions({ initial: journal, persist(value) { if (!disk) return false; journal = structuredClone(value); return true; }, async send(command) { const result = f.calendar.completeTaskEvent('a', command); if (drop) { drop = false; throw Error('Response lost'); } return result; }, async refresh() {}, changed() {} });
    const command = f.command(f.calendar.state('a', range).events[0]);
    disk = false; assert.equal(await make().run(command), false); assert.equal(f.store.snapshot('a').calendarCompletions?.length, 0);
    disk = true; assert.equal(await make().run(command), false); assert.equal(journal?.pending?.requestId, command.requestId);
    await f.restart(); assert.equal(await make().retry(), true); assert.equal(journal?.pending, undefined); assert.equal(journal?.confirmed?.revision, 1);
    assert.equal(f.store.snapshot('a').calendarCompletions?.length, 1);
    await make().run({ ...command, requestId: randomUUID(), expectedRevision: 0, done: false });
    assert.equal(journal?.pending, undefined); assert.match(journal?.error ?? '', /another window/); assert.equal(f.store.snapshot('a').calendarCompletions?.[0].done, true);
  } finally { await f.close(); }
});

test('provider completion fences the current source generation and leaves the provider record untouched', async () => {
  const f = fixture(); try {
    const initial = f.calendar.state('a', range), generation = randomUUID();
    const event: CalendarDisplayEvent = { id: 'same-provider-id', sourceId: 'calendar-a', title: 'Provider meeting', notes: '', location: '', status: 'confirmed', interval: { kind: 'date', start: '2026-09-13', end: '2026-09-14' } };
    const sources = ['calendar-a', 'calendar-b'].map(id => ({ id, accountId: 'google-account', generation, provider: 'google' as const, calendarId: id, name: id, accountLabel: 'Fixture', primary: false, providerCanWrite: false, accountCanWrite: false, selected: true, state: 'ready' as const }));
    f.calendar.state = () => ({ ...initial, sources, events: [event, { ...event, sourceId: 'calendar-b' }] });
    assert.throws(() => f.calendar.completeTaskEvent('a', { ...f.command(event), generation: randomUUID() }), /Refresh/);
    const command = { ...f.command(event), generation }, result = f.calendar.completeTaskEvent('a', command);
    assert.equal(result.done, true); assert.equal(f.store.snapshot('b').calendarCompletions?.length, 1);
    assert.notEqual(result.key, calendarCompletionKey({ sourceId: 'calendar-b', eventId: event.id }));
    sources[0].generation = randomUUID();
    assert.deepEqual(f.calendar.completeTaskEvent('a', command), result); // Receipt recovery does not dispatch a new effect.
    assert.throws(() => f.calendar.completeTaskEvent('a', { ...command, requestId: randomUUID(), expectedRevision: 1 }), /Refresh/);
    assert.deepEqual(f.calendar.state('a', range).events[0], event);
    assert.equal(f.store.snapshot('a').tasks.length, 0);
  } finally { await f.close(); }
});

for (const repeating of [false, true]) test(`${repeating ? 'Recurring occurrence' : 'One-off'} subtasks and parent completion share one saved revision`, async () => {
  const f = fixture(); try {
    f.create(repeating); const events = f.calendar.state('a', range).events, event = events[0];
    const checklist = ['Prepare materials', 'Confirm the plan'].map(text => ({ id: randomUUID(), text, done: false }));
    const base = f.command(event, false);
    const first = f.calendar.completeTaskEvent('a', { ...base, checklist });
    assert.equal(first.done, false); assert.equal(first.checklist?.length, 2);
    const all = f.calendar.completeTaskEvent('a', { ...base, requestId: randomUUID(), expectedRevision: 1, checklist: checklist.map(i => ({ ...i, done: true })) });
    assert.equal(all.done, true); assert.equal(all.revision, 2);
    const partial = f.calendar.completeTaskEvent('b', { ...base, requestId: randomUUID(), expectedRevision: 2, done: true, checklist: all.checklist!.map((i, index) => ({ ...i, done: index !== 0 })) });
    assert.equal(partial.done, false); assert.deepEqual(partial.checklist?.map(i => i.done), [false, true]);
    const complete = f.calendar.completeTaskEvent('b', { ...base, requestId: randomUUID(), expectedRevision: 3, done: true });
    assert.equal(complete.done, true); assert.ok(complete.checklist?.every(i => i.done));
    await f.restart(); assert.deepEqual(f.store.snapshot('a').calendarCompletions?.[0], complete);
    const reopened = f.calendar.completeTaskEvent('b', { ...base, requestId: randomUUID(), expectedRevision: 4 });
    assert.equal(reopened.done, false); assert.ok(reopened.checklist?.every(i => !i.done));
    assert.equal(f.store.snapshot('a').tasks.length, 0); // No duplicate calendar Tasks.
    if (repeating) assert.equal(f.calendar.state('a', range).events.find(e => e.id === events[1].id)?.taskStatus, undefined);
    assert.equal(f.calendar.state('a', range).events[0].status, 'confirmed');
  } finally { await f.close(); }
});

test('inline checklist acceptance follows the durable receipt even when refresh fails', async () => {
  const f = fixture(); try {
    f.create(); let journal: CompletionJournal | undefined, retainReceipt = false;
    const command = f.command(f.calendar.state('a', range).events[0]);
    const make = () => createCalendarCompletionActions({ initial: journal, persist(value) { if (value.confirmed && !retainReceipt) return false; journal = structuredClone(value); return true; }, async send(input) { return f.calendar.completeTaskEvent('a', input); }, async refresh() { throw Error('Read unavailable'); }, changed() {} });
    assert.equal(await make().run(command), false);
    assert.equal(journal?.pending?.requestId, command.requestId);
    retainReceipt = true;
    assert.equal(await make().retry(), true);
    assert.equal(journal?.pending, undefined);
    assert.equal(journal?.confirmed?.revision, 1);
    assert.equal(f.store.snapshot('a').calendarCompletions?.length, 1);
    assert.equal(await make().run({ ...command, requestId: randomUUID(), done: false }), false);
    assert.equal(journal?.confirmed?.done, true);
  } finally { await f.close(); }
});
