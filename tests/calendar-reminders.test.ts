import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store';
import { CalendarService } from '../apps/service/calendar';
import { calendarAlarm } from '../packages/domain/calendar-reminders';
import type { LocalCalendarEvent, LocalEventInput } from '../packages/domain/calendar';
import { formForDraft, valueForDraft } from '../apps/client/src/dreamclaw/calendar-editor';
import { startServer } from '../apps/service/http';
function fixture(t: TestContext, initial = '2026-09-10T09:00:00Z') {
  const directory = mkdtempSync(join(tmpdir(), 'e3-calendar-reminders-')); let now = Date.parse(initial), store = new Store(directory, () => now);
  const accounts = { state: () => ({ accounts: [], probes: [] }), calendarSources: async () => { throw Error('No provider Calendar call'); }, calendarEvents: async () => { throw Error('No provider Calendar call'); } } as any;
  let calendar = new CalendarService(store, accounts, () => now);
  t.after(async () => { await calendar.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const value: LocalEventInput = { title: 'Original Calendar event', notes: 'Keep notes', location: '', timezone: 'UTC', allDay: false, start: { date: '2026-09-10', time: '10:00' }, end: { date: '2026-09-10', time: '11:00' }, state: 'confirmed', projectId: null, taskId: null, reminderMinutes: 30, deliveryChannel: 'last' };
  return { directory, value, get store() { return store; }, get calendar() { return calendar; }, at(instant: string) { now = Date.parse(instant); },
    save(v: LocalEventInput = value, prior?: LocalCalendarEvent, extra = {}) { return calendar.saveLocal('owner', { requestId: randomUUID(), epoch: store.epoch, eventId: prior?.id ?? randomUUID(), expectedRevision: prior?.revision ?? 0, value: v, scope: v.repeat || prior?.isSeries ? 'series' : 'event', ...(prior?.isSeries ? { expectedExceptionsRevision: prior.exceptionsRevision ?? 0, exceptions: 'keep' } : {}), ...extra }); },
    items() { return calendar.reminders.state().items; },
    async restart() { await calendar.close(); store.close(); store = new Store(directory, () => now); calendar = new CalendarService(store, accounts, () => now); },
  };
}
test('original Calendar alarms save atomically, preserve snooze and dismissal across harmless edits, move and cancel exactly', t => {
  const f = fixture(t); let event = f.save(), item = f.items()[0]; assert.equal(item.state, 'scheduled'); assert.equal(item.dueAt, Date.parse('2026-09-10T09:30Z'));
  f.at('2026-09-10T09:30Z'); item = f.items()[0]; assert.equal(item.state, 'ready');
  const cmd = { requestId: randomUUID(), epoch: f.store.epoch, reminderId: item.id, expectedRevision: item.revision, action: 'snooze', minutes: 10 };
  const snoozed = f.calendar.reminders.act('owner', cmd);
  event = f.save({ ...event.value, title: 'Revised title', notes: 'Revised notes' }, event);
  item = f.items()[0]; assert.equal(item.id, snoozed.id); assert.equal(item.dueAt, snoozed.dueAt); assert.equal(item.snoozes, 1); assert.equal(item.title, 'Revised title');
  assert.deepEqual(f.calendar.reminders.act('owner', cmd), snoozed);
  assert.throws(() => f.calendar.reminders.act('other', cmd), /different work/);
  assert.throws(() => f.calendar.reminders.act('owner', { ...cmd, minutes: 20 }), /different work/);
  f.calendar.reminders.act('owner', { ...cmd, requestId: randomUUID(), expectedRevision: item.revision, action: 'dismiss' });
  event = f.save({ ...event.value, title: 'Still dismissed' }, event); assert.equal(f.items()[0].state, 'dismissed');
  event = f.save({ ...event.value, start: { date: '2026-09-10', time: '12:00' }, end: { date: '2026-09-10', time: '13:00' } }, event);
  const live = f.items().filter(item => item.state === 'scheduled'); assert.equal(live.length, 1); assert.notEqual(live[0].id, item.id);
  event = f.save({ ...event.value, state: 'cancelled' }, event); assert.equal(f.items().filter(item => !['dismissed', 'cancelled'].includes(item.state)).length, 0);
  assert.equal(f.store.snapshot('owner').tasks.length, 0); assert.equal(f.store.internalList('tasks:focus:').length, 0);
});
test('notification claim ownership, unknown outcomes and late receipts cannot overwrite a newer snooze', async t => {
  const f = fixture(t); f.save(); f.at('2026-09-10T09:30Z'); let item = f.items()[0];
  const claim = { requestId: randomUUID(), epoch: f.store.epoch, reminderId: item.id, clientId: randomUUID(), action: 'claim' };
  item = f.calendar.reminders.deliver('owner', claim); const attempt = item.notification!;
  assert.throws(() => f.calendar.reminders.deliver('other', { ...claim, requestId: randomUUID() }), /already exists/);
  f.at('2026-09-10T09:30:21Z'); item = f.items()[0]; assert.equal(item.notification?.state, 'unknown');
  const snooze = { requestId: randomUUID(), epoch: f.store.epoch, reminderId: item.id, expectedRevision: item.revision, action: 'snooze', minutes: 10 };
  const later = f.calendar.reminders.act('owner', snooze); await f.restart(); assert.deepEqual(f.calendar.reminders.act('owner', snooze), later);
  const report = { ...claim, requestId: randomUUID(), attemptId: attempt.attemptId, action: 'shown' };
  assert.throws(() => f.calendar.reminders.deliver('other', report), /different attempt/);
  assert.deepEqual(f.calendar.reminders.deliver('owner', report), later);
  const state = f.calendar.reminders.state(); assert.equal(state.attempts[0].state, 'shown'); assert.equal(state.items[0].notification, undefined); assert.equal(state.items[0].snoozes, 1);
});
test('recurring alarms catch up through downtime in bounded windows and preserve original identities after moved exceptions', async t => {
  const f = fixture(t); let event = f.save({ ...f.value, repeat: { cadence: 'daily', interval: 1, weekdays: [] } });
  const before = f.items(); assert.equal(before.length, 30);
  f.at('2027-01-10T09:31Z'); await f.restart(); let state = f.calendar.reminders.state(); assert.equal(state.catchingUp, true); assert.ok(state.items.some(item => item.state === 'missed'));
  for (let i = 0; i < 5; i++) { f.at(`2027-01-10T09:${String(32 + i).padStart(2, '0')}Z`); state = f.calendar.reminders.state(); }
  assert.equal(state.catchingUp, false); assert.equal(new Set(state.items.map(item => `${item.eventId}:${item.originalDate}`)).size, state.items.length);
  const date = '2027-01-10', old = state.items.find(item => item.originalDate === date)!;
  const occurrence = f.calendar.readLocal(event.id, date).occurrence!;
  f.save({ ...occurrence.value, start: { date: '2027-01-12', time: '14:00' }, end: { date: '2027-01-12', time: '15:00' } }, event, { scope: 'occurrence', originalDate: date, expectedOverrideRevision: 0 });
  state = f.calendar.reminders.state(); const moved = state.items.find(item => item.originalDate === date && item.state === 'scheduled')!;
  assert.equal(moved.eventId, event.id); assert.equal(moved.originalDate, date); assert.equal(moved.dueAt, Date.parse('2027-01-12T13:30Z')); assert.equal(state.items.find(item => item.id === old.id)?.state, 'cancelled');
  event = f.calendar.readLocal(event.id).event;
  f.save({ ...event.value, state: 'cancelled' }, event); assert.equal(f.items().filter(item => !['dismissed', 'cancelled'].includes(item.state)).length, 0);
});
test('all-day reminders retain explicit civil dates and review DST gaps and overlaps; timed offsets use elapsed time', t => {
  const f = fixture(t); const allDay = { ...f.value, allDay: true, timezone: 'America/Los_Angeles', start: { date: '2026-11-01', time: '00:00' }, end: { date: '2026-11-02', time: '00:00' }, reminderMinutes: 0, allDayReminder: { daysBefore: 0, time: '01:30' } };
  assert.equal(calendarAlarm(allDay)?.dueAt, null);
  assert.equal(calendarAlarm({ ...allDay, allDayReminder: { ...allDay.allDayReminder, overlap: 'earlier' } })?.dueAt, Date.parse('2026-11-01T08:30Z'));
  assert.equal(calendarAlarm({ ...allDay, allDayReminder: { ...allDay.allDayReminder, overlap: 'later' } })?.dueAt, Date.parse('2026-11-01T09:30Z'));
  const gap = { ...allDay, start: { date: '2027-03-14', time: '00:00' }, end: { date: '2027-03-15', time: '00:00' }, allDayReminder: { daysBefore: 0, time: '02:30' } };
  f.save(gap); assert.equal(f.items()[0].state, 'unavailable'); assert.match(f.items()[0].reason!, /does not exist/);
  assert.equal(calendarAlarm({ ...allDay, allDayReminder: { daysBefore: 1, time: '09:00' } })?.dueAt, Date.parse('2026-10-31T16:00Z'));
  const timed = { ...f.value, timezone: 'America/Los_Angeles', start: { date: '2026-11-01', time: '01:15', overlap: 'later' as const }, reminderMinutes: 30 };
  assert.equal(calendarAlarm(timed)?.dueAt, Date.parse('2026-11-01T08:45Z')); assert.equal(calendarAlarm(timed)?.spec.overlap, 'earlier');
});
test('all-day original modal fields retain their reminder through a journal, removal and conversion to timed events', t => {
  const f = fixture(t), value = { ...f.value, allDay: true, allDayReminder: { daysBefore: 2, time: '09:15', overlap: 'later' as const } };
  const draft = { id: randomUUID(), epoch: f.store.epoch, revision: 0, value }; const form = JSON.parse(JSON.stringify(formForDraft(draft)));
  assert.deepEqual(valueForDraft(draft, form).allDayReminder, value.allDayReminder);
  assert.equal(valueForDraft(draft, { ...form, allDayReminder: null }).allDayReminder, null);
  assert.equal(valueForDraft(draft, { ...form, allDay: false, startTime: '10:00', endTime: '11:00' }).allDayReminder, null);
});
test('moving a claimed event retains the original notification outcome without dispatching its replacement early', t => {
  const f = fixture(t); let event = f.save(); f.at('2026-09-10T09:30Z'); let item = f.items()[0];
  const claim = { requestId: randomUUID(), epoch: f.store.epoch, reminderId: item.id, clientId: randomUUID(), action: 'claim' };
  item = f.calendar.reminders.deliver('owner', claim);
  event = f.save({ ...event.value, start: { date: '2026-09-11', time: '10:00' }, end: { date: '2026-09-11', time: '11:00' } }, event);
  f.calendar.reminders.deliver('owner', { ...claim, requestId: randomUUID(), action: 'shown', attemptId: item.notification!.attemptId });
  const items = f.items(); assert.equal(items.find(r => r.id === item.id)?.state, 'cancelled'); const replacement = items.find(r => r.id !== item.id)!; assert.equal(replacement.notification, undefined);
  assert.throws(() => f.calendar.reminders.deliver('owner', { ...claim, requestId: randomUUID(), reminderId: replacement.id }), /in-app review/);
});
test('private HTTP snapshot and reminder actions require credentials, origins and exact immutable receipts', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'e3-calendar-reminders-http-'));
  const host = await startServer({ directory, port: 0, version: 'test' });
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }); });
  const session = await fetch(host.origin + '/api/session', { method: 'POST', headers: { Origin: host.origin, 'X-Edition3-Client': '1' } });
  assert.equal(session.status, 200);
  const headers = { Origin: host.origin, Cookie: session.headers.get('set-cookie')!.split(';')[0], 'X-Edition3-Client': '1', 'Content-Type': 'application/json' };
  const denied = await fetch(host.origin + '/api/snapshot');
  assert.equal(denied.status, 401); assert.equal(denied.headers.get('x-nova-body-bytes'), null);
  const response = await fetch(host.origin + '/api/snapshot', { headers }), text = await response.text();
  assert.equal(Number(response.headers.get('x-nova-body-bytes')), Buffer.byteLength(text));
  const snap = JSON.parse(text) as any;
  assert.ok(snap.calendarReminders);
  const start = new Date(Math.floor(Date.now() / 60000) * 60000 + 5 * 60000), end = new Date(start.getTime() + 3600000);
  const value = { title: 'HTTP Calendar alarm', notes: '', location: '', timezone: 'UTC', allDay: false, start: { date: start.toISOString().slice(0,10), time: start.toISOString().slice(11,16) }, end: { date: end.toISOString().slice(0,10), time: end.toISOString().slice(11,16) }, state: 'confirmed', projectId: null, taskId: null, reminderMinutes: 5 };
  const saved = await fetch(host.origin + '/api/calendar/local', { method: 'POST', headers, body: JSON.stringify({ requestId: randomUUID(), epoch: snap.epoch, eventId: randomUUID(), expectedRevision: 0, value, scope: 'event' }) }); assert.equal(saved.status, 200);
  const item = (await (await fetch(host.origin + '/api/snapshot', { headers })).json() as any).calendarReminders.items[0]; assert.equal(item.state, 'ready');
  const command = { requestId: randomUUID(), epoch: snap.epoch, reminderId: item.id, expectedRevision: item.revision, action: 'dismiss' };
  const action = await fetch(host.origin + '/api/calendar/reminders/action', { method: 'POST', headers, body: JSON.stringify(command) }); assert.equal(action.status, 200); assert.equal(action.headers.get('cache-control'), 'no-store'); const result = await action.json();
  assert.deepEqual(await (await fetch(host.origin + '/api/calendar/reminders/action', { method: 'POST', headers, body: JSON.stringify(command) })).json(), result);
  assert.equal((await fetch(host.origin + '/api/calendar/reminders/action', { method: 'POST', headers: { ...headers, Origin: 'https://wrong.example' }, body: '{}' })).status, 403);
});
