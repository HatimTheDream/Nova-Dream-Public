import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store.js';
import { CalendarService } from '../apps/service/calendar.js';
import { accountCapabilities } from '../apps/service/providers.js';
import type { AccountsState, CalendarSource, ConnectedAccount } from '../packages/domain/accounts.js';
import type { CalendarJob, CalendarPage, LocalEventInput } from '../packages/domain/calendar.js';
const range = { from: '2026-09-01', to: '2026-10-01', timezone: 'America/Los_Angeles' };
const local: LocalEventInput = { title: 'Quiet writing', notes: 'Kept local plan', location: '', timezone: range.timezone, allDay: false, start: { date: '2026-09-08', time: '09:00' }, end: { date: '2026-09-08', time: '10:00' }, state: 'confirmed', projectId: null, taskId: null };
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 2)); } assert.fail('Calendar job did not settle'); }
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-calendar-')); let store = new Store(directory);
  const accounts: ConnectedAccount[] = (['google', 'microsoft'] as const).map(provider => ({ id: provider + '-account', provider, subject: provider + '-subject', label: provider, email: provider + '@example.test', revision: 1, generation: randomUUID(), state: 'connected', scopes: [], capabilities: { ...accountCapabilities(provider, []), calendarRead: true }, connectedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  let readSources = async (id: string): Promise<{ items: CalendarSource[]; limited: boolean }> => ({ items: [{ id: id + '-calendar', name: id, primary: true, providerCanWrite: true }], limited: false });
  let readEvents = async (account: string, generation: string, calendarId: string, start: string, end: string): Promise<CalendarPage> => ({ events: [{ id: account + '-event', title: account, interval: { kind: 'date', start: '2026-09-08', end: '2026-09-09' }, status: 'confirmed', notes: '', location: '' }], coverage: 'complete', pages: 1, skipped: 0 });
  const authority = { state: (): AccountsState => ({ accounts, clients: [], attempts: [], probes: [] }), calendarSources: (id: string) => readSources(id), calendarEvents: (...args: Parameters<typeof readEvents>) => readEvents(...args) };
  let calendar = new CalendarService(store, authority);
  const command = () => ({ requestId: randomUUID(), epoch: store.epoch });
  const settle = async (job: CalendarJob) => until(() => store.internalRead<CalendarJob>(`calendar:job:${job.id}`)?.state !== 'running');
  return { accounts, command, settle, get store() { return store; }, get calendar() { return calendar; }, set readEvents(fn: typeof readEvents) { readEvents = fn; }, set readSources(fn: typeof readSources) { readSources = fn; }, async discover() { const job = calendar.discover('a', command()); await settle(job); return calendar.state('a', range).sources; }, async restart() { await calendar.close(); store.close(); store = new Store(directory); calendar = new CalendarService(store, authority); }, async close() { await calendar.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('source selection, event reads and local event receipts survive restart without touching tasks or deadlines', async () => {
  const f = fixture(); try {
    const sources = await f.discover(), command = { ...f.command(), expectedRevision: 0, sourceIds: sources.map(s => s.id), showLocal: true, showTasks: true };
    assert.equal(f.calendar.select('a', command).revision, 1); assert.equal(f.calendar.select('a', command).revision, 1);
    assert.throws(() => f.calendar.select('b', command), /different work/);
    const taskId = 'task:' + randomUUID(); f.store.mutate('a', { ...f.command(), kind: 'task', entityId: taskId, expectedRevision: 0, payload: { title: 'Writing task', notes: '', planned: '2026-09-08', due: '2026-09-30', status: 'open', plannedTime: '09:00', timezone: range.timezone, estimateMinutes: 45 } });
    const save = { ...f.command(), eventId: randomUUID(), expectedRevision: 0, value: { ...local, taskId } }, event = f.calendar.saveLocal('a', save);
    const refresh = { ...f.command(), range, sourceIds: sources.map(s => s.id) }, job = f.calendar.refresh('a', refresh); await f.settle(job);
    const before = f.calendar.state('a', range); assert.equal(before.events.length, 4); assert.equal(before.sources.every(s => s.state === 'ready'), true);
    assert.equal(f.store.readEntity('task', taskId)?.revision, 1); assert.equal(f.store.readEntity('task', taskId)?.value.due, '2026-09-30'); assert.equal(f.store.snapshot('a').taskState!.earnedXp, 0);
    assert.equal(f.calendar.state('a', { ...range, from: '2026-09-08', to: '2026-09-09' }).events.length, 4);
    await f.restart(); assert.deepEqual(f.calendar.saveLocal('a', save), event); assert.equal(f.calendar.refresh('a', refresh).id, job.id); assert.deepEqual(f.calendar.state('a', range), before);
  } finally { await f.close(); }
});
test('partial reads retain cached rows, but moved and cancelled instances remove their old positions; complete reads replace only their source', async () => {
  const f = fixture(); try {
    const sources = await f.discover(); f.calendar.select('a', { ...f.command(), expectedRevision: 0, sourceIds: sources.map(s => s.id), showLocal: true, showTasks: true });
    const refresh = () => f.calendar.refresh('a', { ...f.command(), range, sourceIds: sources.map(s => s.id) }); await f.settle(refresh());
    f.calendar.saveLocal('a', { ...f.command(), eventId: randomUUID(), expectedRevision: 0, value: local });
    f.readEvents = async account => { if (account.startsWith('microsoft')) throw new Error('private diagnostic'); return { events: [{ id: account + '-event', title: 'Moved', interval: { kind: 'date', start: '2026-10-02', end: '2026-10-03' }, status: 'confirmed', notes: '', location: '' }], coverage: 'partial', pages: 1, skipped: 1 }; };
    await f.settle(refresh()); let state = f.calendar.state('a', range); assert.equal(state.events.some(e => e.title === 'Moved'), false); assert.equal(state.events.length, 2); assert.ok(state.sources.every(s => s.cache?.lastCompleteAt)); assert.ok(!JSON.stringify(state).includes('private diagnostic'));
    f.readEvents = async () => ({ events: [], coverage: 'complete', pages: 1, skipped: 0 }); await f.settle(refresh()); state = f.calendar.state('a', range); assert.equal(state.events.length, 1); assert.equal(state.events[0].sourceId, 'local');
  } finally { await f.close(); }
});
test('disconnect and new account generations fence delayed reads and hide old cached provider data', async () => {
  const f = fixture(); let release!: (page: CalendarPage) => void; try {
    const sources = await f.discover(), source = sources[0]; f.calendar.select('a', { ...f.command(), expectedRevision: 0, sourceIds: [source.id], showLocal: true, showTasks: true });
    const cmd = { ...f.command(), range, sourceIds: [source.id] }; f.readEvents = () => new Promise(r => { release = r; }); const job = f.calendar.refresh('a', cmd); await until(() => !!release);
    f.accounts[0].generation = randomUUID(); f.accounts[0].state = 'disconnected';
    release({ events: [], coverage: 'complete', pages: 1, skipped: 0 }); await f.settle(job); assert.equal(f.calendar.state('a', range).sources.length, 1); assert.equal(f.store.internalList('calendar:cache:').length, 0); assert.equal(f.calendar.refresh('a', cmd).id, job.id);
    assert.deepEqual(f.calendar.state('a', range).selection.sourceIds, [source.id]);
  } finally { await f.close(); }
});
test('local conflicts keep the host revision, invalid time is rejected, cancel and restore are explicit reversible changes', async () => {
  const f = fixture(); try {
    const save = { ...f.command(), eventId: randomUUID(), expectedRevision: 0, value: local }; f.calendar.saveLocal('a', save);
    assert.throws(() => f.calendar.saveLocal('b', { ...save, ...f.command(), value: { ...local, title: 'Other window' } }), (e: any) => e.code === 'calendar_event_changed' && e.current.value.title === local.title);
    assert.throws(() => f.calendar.saveLocal('a', { ...f.command(), eventId: randomUUID(), expectedRevision: 0, value: { ...local, start: { date: '2026-03-08', time: '02:30' } } }), /does not exist/);
    const cancel = f.calendar.saveLocal('b', { ...save, ...f.command(), expectedRevision: 1, value: { ...local, state: 'cancelled' } }); assert.equal(cancel.revision, 2); assert.equal(f.calendar.state('a', range).events.length, 0); assert.equal(f.calendar.state('a', range).localEvents.length, 1);
    f.calendar.saveLocal('b', { ...save, ...f.command(), expectedRevision: 2 }); assert.equal(f.calendar.state('a', range).events.length, 1);
    assert.throws(() => f.calendar.saveLocal('a', { ...save, ...f.command(), epoch: randomUUID(), expectedRevision: 3 }), /workspace changed/);
  } finally { await f.close(); }
});
test('bounded source discovery preserves older sources on partial or failed lists and selection conflicts preserve shared state', async () => {
  const f = fixture(); try {
    const sources = await f.discover(), cmd = { ...f.command(), expectedRevision: 0, sourceIds: [sources[0].id], showLocal: true, showTasks: false }; f.calendar.select('a', cmd);
    f.readSources = async () => ({ items: [{ id: 'another-calendar', name: 'Another', primary: false, providerCanWrite: false }], limited: true }); await f.discover(); assert.equal(f.calendar.state('a', range).sources.length, 4);
    f.readSources = async () => { throw new Error('unavailable'); }; await f.discover(); assert.equal(f.calendar.state('a', range).sources.length, 4); assert.ok(f.calendar.state('a', range).accountMessages.every(m => /unavailable/.test(m.message)));
    assert.throws(() => f.calendar.select('b', { ...cmd, ...f.command(), showTasks: true }), (e: any) => e.code === 'calendar_selection_changed' && !e.current.showTasks);
    f.readSources = async () => ({ items: [], limited: false }); await f.discover(); assert.equal(f.calendar.state('a', range).sources.length, 0); assert.deepEqual(f.calendar.state('a', range).selection.sourceIds, cmd.sourceIds);
  } finally { await f.close(); }
});
test('shutdown fences late cache writes and interrupted jobs never restart from their original request', async () => {
  const f = fixture(); let release!: (page: CalendarPage) => void; try {
    const sources = await f.discover(); f.readEvents = () => new Promise(r => { release = r; });
    const cmd = { ...f.command(), range, sourceIds: [sources[0].id] }, job = f.calendar.refresh('a', cmd); await until(() => !!release);
    const closing = f.calendar.close(); assert.equal(f.store.internalRead<CalendarJob>(`calendar:job:${job.id}`)?.state, 'interrupted'); release({ events: [], coverage: 'complete', pages: 1, skipped: 0 }); await closing;
    assert.equal(f.store.internalList('calendar:cache:').length, 0); await f.restart(); assert.equal(f.calendar.refresh('a', cmd).state, 'interrupted'); assert.equal(f.store.internalList('calendar:cache:').length, 0);
  } finally { await f.close(); }
});
