import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarSync } from '../apps/client/src/calendar-sync';
import { ApiError, type request } from '../apps/client/src/api';
import type { CalendarState } from '../packages/domain/calendar';
const range = { from: '2026-08-30', to: '2026-10-11', timezone: 'America/Los_Angeles' };
function fixture() {
  let time = 0;
  const state: CalendarState = { epoch: 'epoch', deviceId: 'device', eventsLimited: false, range, localEvents: [], events: [], jobs: [], selection: { revision: 0, sourceIds: [], showLocal: true, showTasks: false }, accountMessages: [], sources: ['work', 'personal', 'outlook', 'other'].map((id, i) => ({ id, accountId: i === 3 ? 'work' : id, generation: id + '-generation', provider: i === 2 ? 'microsoft' : 'google', calendarId: id, name: id, accountLabel: id, primary: i < 3, selected: false, state: 'stale', providerCanWrite: false })) };
  const calls: { path: string; body: any }[] = [];
  let conflict = false;
  const api = (async (path: string, body?: any, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (path.startsWith('calendar/state?')) return structuredClone(state);
    calls.push({ path, body }); assert.equal(body.epoch, 'epoch');
    if (path === 'calendar/selection') {
      if (conflict) { state.selection = { ...state.selection, revision: 3, sourceIds: ['other'] }; state.sources.forEach(s => { s.selected = s.id === 'other'; }); conflict = false; throw new ApiError('calendar_selection_changed', 'Another window changed it'); }
      assert.equal(body.expectedRevision, state.selection.revision);
      state.selection = { revision: state.selection.revision + 1, sourceIds: body.sourceIds, showLocal: body.showLocal, showTasks: body.showTasks };
      state.sources.forEach(s => { s.selected = body.sourceIds.includes(s.id); });
    } else if (path === 'calendar/sources') state.jobs = [{ id: 'discovery', deviceId: 'device', kind: 'sources', state: 'running', startedAt: new Date().toISOString(), sources: [] }];
    else assert.equal(path, 'calendar/refresh');
    return {};
  }) as typeof request;
  return { state, calls, sync: createCalendarSync('epoch', 'device', api, () => time), advance: () => { time += 60001; }, conflict: () => { conflict = true; } };
}

test('first opening selects the three primary calendars and loads events while preserving local/task choices', async () => {
  const f = fixture(); const state = await f.sync.load(range, false);
  assert.deepEqual(state.selection.sourceIds, ['work', 'personal', 'outlook']); assert.equal(state.selection.showTasks, false);
  assert.deepEqual(f.calls.map(c => c.path), ['calendar/selection', 'calendar/refresh']);
  assert.deepEqual(f.calls[1].body.sourceIds, ['work', 'personal', 'outlook']);
  await f.sync.load(range, false); assert.equal(f.calls.length, 2);
  f.advance(); await f.sync.load(range, false); assert.equal(f.calls.length, 3);
});

test('a deliberately empty selection stays empty across new openings, and calendar toggles use the saved revision', async () => {
  const f = fixture(); const state = await f.sync.load(range, false);
  for (const id of state.selection.sourceIds) await f.sync.select(structuredClone(f.state), id, false);
  const calls = f.calls.length; await f.sync.load(range, false); assert.equal(f.calls.length, calls);
  assert.deepEqual(f.state.selection.sourceIds, []);
  f.state.sources[0].state = 'unavailable';
  await assert.rejects(f.sync.select(f.state, 'work', true), /connection/);
});

test('discovery completes before initial selection and refreshes only current readable calendars', async () => {
  const f = fixture(), sources = f.state.sources;
  f.state.sources = []; f.state.accountMessages = [{ accountId: 'work', label: 'Work', limited: false, message: 'Find sources' }];
  await f.sync.load(range, false); await f.sync.load(range, false);
  assert.deepEqual(f.calls.map(c => c.path), ['calendar/sources']);
  f.state.jobs[0].state = 'completed'; f.state.sources = sources; f.state.sources[2].state = 'unavailable';
  await f.sync.load(range, false);
  assert.deepEqual(f.state.selection.sourceIds, ['work', 'personal']);
  assert.equal(f.calls.at(-1)!.path, 'calendar/refresh');
});

test('selection conflicts honor the other window and wrong workspace responses never trigger commands', async () => {
  const f = fixture(); f.conflict(); await f.sync.load(range, false);
  assert.deepEqual(f.calls.at(-1)!.body.sourceIds, ['other']);
  f.state.epoch = 'replacement'; const count = f.calls.length;
  await assert.rejects(f.sync.load(range, true), /Reconnect/); assert.equal(f.calls.length, count);
});

test('refresh follows month and account-generation changes, skips active jobs and allows an explicit retry', async () => {
  const f = fixture(); await f.sync.load(range, false);
  await f.sync.load({ ...range, from: '2026-09-27', to: '2026-11-08' }, false);
  assert.equal(f.calls.filter(c => c.path === 'calendar/refresh').length, 2);
  f.state.sources.forEach(s => { s.state = 'refreshing'; }); await f.sync.load(range, false); assert.equal(f.calls.length, 3);
  f.state.sources[0].state = 'stale'; f.state.sources[0].generation = 'replacement';
  await f.sync.load(range, false); assert.deepEqual(f.calls.at(-1)!.body.sourceIds, ['work']);
  await f.sync.load(range, true); assert.equal(f.calls.at(-1)!.path, 'calendar/refresh');
});
