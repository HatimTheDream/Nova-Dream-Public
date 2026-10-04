import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCalendarSync } from '../apps/client/src/calendar-sync';
import type { request } from '../apps/client/src/api';
import { CalendarService } from '../apps/service/calendar';
import { accountCapabilities } from '../apps/service/providers';
import { Store } from '../apps/service/store';
import type { AccountsState, ConnectedAccount } from '../packages/domain/accounts';
import { addDays, type CalendarJob, type CalendarPage, type CalendarRange } from '../packages/domain/calendar';
import { dayStart } from '../packages/domain/calendar-time';

const today = '2026-09-19';
const homeRange: CalendarRange = { from: today, to: addDays(today, 30), timezone: 'America/Los_Angeles' };
const monthRange: CalendarRange = { ...homeRange, from: '2026-08-30', to: '2026-10-11' };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'nova-home-calendar-sync-'));
  const store = new Store(directory), device = 'home-calendar-device';
  let now = Date.parse('2026-09-19T18:00:00Z'), title = 'Saved appointment';
  let hold: Promise<void> | undefined, release: (() => void) | undefined;
  const accounts: ConnectedAccount[] = (['google', 'microsoft'] as const).map(provider => ({
    id: `${provider}-account`, provider, subject: `${provider}-subject`, label: provider,
    email: `${provider}@example.test`, revision: 1, generation: randomUUID(), state: 'connected', scopes: [],
    capabilities: { ...accountCapabilities(provider, []), calendarRead: true },
    connectedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  }));
  const reads: { accountId: string; from: string; to: string }[] = [];
  const commands: { path: string; body: unknown }[] = [];
  const calendar = new CalendarService(store, {
    state: (): AccountsState => ({ accounts, clients: [], attempts: [], probes: [] }),
    async calendarSources(accountId) {
      return { items: [{ id: `${accountId}-calendar`, name: accountId, primary: true, providerCanWrite: false }], limited: false };
    },
    async calendarEvents(accountId, _generation, _calendarId, from, to): Promise<CalendarPage> {
      reads.push({ accountId, from, to });
      await hold;
      return { coverage: 'complete', pages: 1, skipped: 0, events: [
        { id: `${accountId}-near`, title, interval: { kind: 'date', start: '2026-09-20', end: '2026-09-21' }, status: 'confirmed', notes: '', location: '' },
        { id: `${accountId}-far`, title: 'Beyond the current month grid', interval: { kind: 'date', start: '2026-10-15', end: '2026-10-16' }, status: 'confirmed', notes: '', location: '' },
      ] };
    },
  }, () => now);
  const command = () => ({ requestId: randomUUID(), epoch: store.epoch });
  const api = (async (path: string, body?: unknown, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (path.startsWith('calendar/state?')) {
      return calendar.state(device, Object.fromEntries(new URLSearchParams(path.slice(path.indexOf('?') + 1))));
    }
    commands.push({ path, body });
    if (path === 'calendar/sources') return calendar.discover(device, body);
    if (path === 'calendar/selection') return calendar.select(device, body);
    if (path === 'calendar/refresh') return calendar.refresh(device, body);
    throw Error(`Unexpected Calendar API route: ${path}`);
  }) as typeof request;
  const settle = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (store.internalList<CalendarJob>('calendar:job:').every(job => job.state !== 'running')) return;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.fail('The isolated calendar refresh did not settle');
  };
  const resume = () => { release?.(); release = undefined; hold = undefined; };
  return {
    calendar, store, device, reads, commands, command, settle,
    sync: createCalendarSync(store.epoch, device, api, () => now),
    async selectPrimary() {
      calendar.discover(device, command()); await settle();
      const source = calendar.state(device, homeRange).sources.find(item => item.provider === 'google')!;
      calendar.select(device, { ...command(), expectedRevision: 0, sourceIds: [source.id], showLocal: false, showTasks: false });
      return source;
    },
    pauseReads() { hold = new Promise(resolve => { release = resolve; }); },
    resume,
    advance(milliseconds: number) { now += milliseconds; },
    changeTitle(value: string) { title = value; },
    async close() { resume(); await calendar.close(); store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('Home refreshes its full next-30-days range when the saved Calendar month stops earlier, without reading hidden calendars', async () => {
  const f = fixture();
  try {
    const selected = await f.selectPrimary();
    f.calendar.refresh(f.device, { ...f.command(), range: monthRange, sourceIds: [selected.id] });
    await f.settle();
    assert.equal(f.calendar.state(f.device, monthRange).sources.find(source => source.selected)?.state, 'ready');
    const before = f.calendar.state(f.device, homeRange);
    assert.equal(before.sources.find(source => source.selected)?.state, 'stale');
    assert.equal(before.sources.find(source => source.selected)?.cache, undefined);

    f.pauseReads();
    const loading = await f.sync.load(homeRange, false);
    assert.equal(loading.sources.find(source => source.selected)?.state, 'refreshing');
    await f.sync.load(homeRange, false);
    assert.equal(f.reads.length, 2, 'A running Home refresh is not dispatched twice');
    assert.deepEqual(f.commands.map(item => item.path), ['calendar/refresh']);
    assert.deepEqual((f.commands[0].body as { range: CalendarRange }).range, homeRange);
    assert.deepEqual((f.commands[0].body as { sourceIds: string[] }).sourceIds, [selected.id]);
    assert.deepEqual(f.reads[1], {
      accountId: selected.accountId,
      from: new Date(dayStart(homeRange.from, homeRange.timezone) - 36 * 3600000).toISOString(),
      to: new Date(dayStart(homeRange.to, homeRange.timezone) + 36 * 3600000).toISOString(),
    });

    f.resume(); await f.settle();
    const refreshed = await f.sync.load(homeRange, false);
    assert.equal(refreshed.sources.find(source => source.selected)?.state, 'ready');
    assert.deepEqual(refreshed.events.map(event => event.id), [`${selected.accountId}-near`, `${selected.accountId}-far`]);
    assert.deepEqual(refreshed.selection, before.selection);
    assert.ok(f.reads.every(read => read.accountId === selected.accountId));
    assert.equal(f.reads.length, 2, 'A fresh Home cache does not need another provider read');
  } finally { await f.close(); }
});

test('Home replaces an expired provider cache and returns to ready without requiring Calendar to be opened', async () => {
  const f = fixture();
  try {
    const selected = await f.selectPrimary();
    await f.sync.load(homeRange, false); await f.settle();
    const first = await f.sync.load(homeRange, false);
    const firstCheck = first.sources.find(source => source.selected)?.cache?.checkedAt;
    assert.equal(first.sources.find(source => source.selected)?.state, 'ready');
    assert.equal(f.reads.length, 1);

    f.advance(300001); f.changeTitle('Updated appointment');
    assert.equal(f.calendar.state(f.device, homeRange).sources.find(source => source.selected)?.state, 'stale');
    await f.sync.load(homeRange, false); await f.settle();
    const refreshed = await f.sync.load(homeRange, false);
    assert.equal(refreshed.sources.find(source => source.selected)?.state, 'ready');
    assert.notEqual(refreshed.sources.find(source => source.selected)?.cache?.checkedAt, firstCheck);
    assert.equal(refreshed.events.find(event => event.id === `${selected.accountId}-near`)?.title, 'Updated appointment');
    assert.deepEqual(refreshed.selection, first.selection);
    assert.equal(f.reads.length, 2);
    assert.ok(f.reads.every(read => read.accountId === selected.accountId));
  } finally { await f.close(); }
});

test('Home preserves an explicitly empty calendar selection instead of restoring primary calendars', async () => {
  const f = fixture();
  try {
    const selected = await f.selectPrimary();
    const state = f.calendar.state(f.device, homeRange);
    await f.sync.select(state, selected.id, false);
    const hidden = f.calendar.state(f.device, homeRange).selection;
    const refreshed = await f.sync.load(homeRange, false);
    assert.deepEqual(refreshed.selection, hidden);
    assert.deepEqual(refreshed.selection.sourceIds, []);
    assert.ok(refreshed.sources.every(source => !source.selected));
    assert.equal(f.reads.length, 0);
    assert.deepEqual(f.commands.map(item => item.path), ['calendar/selection']);
  } finally { await f.close(); }
});
