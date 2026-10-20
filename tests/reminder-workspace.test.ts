import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ReminderActionController, matchingReminderReturn, pendingReminderActions, readReminderAction, readReminderView, reminderActionKey, reminderPage, reminderViewKey, snoozeMinutes, type ReminderActionJournal, type ReminderCommand, type ReminderScope } from '../apps/client/src/reminder-workspace';
import type { WorkspaceReminder } from '../apps/client/src/reminder-items';

const scope: ReminderScope = { epoch: randomUUID(), deviceId: 'device', windowId: 'window' };
const reminder = (patch: Partial<WorkspaceReminder> = {}): WorkspaceReminder => ({ id: randomUUID(), revision: 1, taskId: 'task:original', taskRevision: 1, spec: { date: '2026-10-20', time: '09:00', timezone: 'Asia/Tokyo' }, state: 'missed', snoozes: 0, dueAt: 123, ...patch } as WorkspaceReminder);
const snoozed = (r: WorkspaceReminder): WorkspaceReminder => ({ ...r, state: 'scheduled', revision: r.revision + 1, snoozes: r.snoozes + 1, dueAt: 987654 });
function fixture(send: (route: string, command: ReminderCommand) => Promise<WorkspaceReminder>, refresh = async () => {}) {
  const records = new Map<string, unknown>(); let full = false, current = scope;
  const storage = { read: (key: string) => records.get(key), write(key: string, value: unknown) { if (full) return false; records.set(key, structuredClone(value)); return true; } };
  return { records, storage, full: (value: boolean) => { full = value; }, epoch: (epoch: string) => { current = { ...scope, epoch }; }, controller: (id: string) => new ReminderActionController(scope, id, storage, () => current, send, refresh) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

test('all history pages and ordinary scheduled records remain reachable with stable ties', () => {
  const items = Array.from({ length: 73 }, () => reminder({ state: 'dismissed', dueAt: 123 }));
  const actual = [0, 1, 2, 3].flatMap(page => reminderPage(items, 'history', page).items.map(r => r.id));
  assert.equal(new Set(actual).size, 73); assert.deepEqual(actual, [...actual].sort());
  const future = reminder({ state: 'scheduled' }), later = reminder({ state: 'scheduled', snoozes: 1 });
  assert.deepEqual(reminderPage([future, later], 'scheduled', 0).items, [future]);
  assert.deepEqual(reminderPage([future, later], 'snoozed', 0).items, [later]);
  assert.equal(reminderPage(items, 'history', 999).page, 3);
});
test('view retention keeps exact return identity, tab, page, scroll and raw custom text in its own epoch', () => {
  const view = { ...readReminderView(undefined, scope), tab: 'history' as const, positions: { history: { page: 2, scroll: 371 } }, durations: { row: '12.5' }, original: { ...scope, token: randomUUID(), reminderId: randomUUID(), kind: 'calendar' as const, id: 'event', originalDate: '2026-10-19', from: 'home' as const } };
  const read = readReminderView(JSON.parse(JSON.stringify(view)), scope); assert.deepEqual(read, view);
  assert.ok(matchingReminderReturn(view.original, scope, read));
  assert.equal(matchingReminderReturn({ ...view.original, originalDate: '2026-10-20' }, scope, read), false);
  assert.equal(readReminderView(view, { ...scope, epoch: randomUUID() }).tab, 'due');
  assert.notEqual(reminderViewKey(scope), reminderViewKey({ ...scope, windowId: 'other-window' }));
});
test('custom snooze requires integer elapsed minutes 1 through1440', () => {
  assert.equal(snoozeMinutes('1'), 1); assert.equal(snoozeMinutes('1440'), 1440); assert.equal(snoozeMinutes(' 60 '), 60);
  for (const input of ['', '0', '1441', '1.5', '-1', '1e2', 'hello']) assert.equal(snoozeMinutes(input), undefined, input);
});
test('double click sends once and an unknown result checks the byte-identical original command', async () => {
  const r = reminder(), wait = deferred<WorkspaceReminder>(), sent: ReminderCommand[] = [];
  const f = fixture(async (_route, command) => { sent.push(command); return wait.promise; }); const c = f.controller(r.id);
  const first = c.run(r, 'snooze', 17); assert.equal(await c.run(r, 'dismiss'), false); assert.equal(sent.length, 1);
  wait.resolve(snoozed(r)); assert.equal(await first, true); assert.equal(sent[0].minutes, 17);
  let calls = 0; const u = fixture(async (_route, command) => { sent.push(command); if (++calls === 1) throw Error('Reply lost'); return snoozed(r); });
  const pending = u.controller(r.id); assert.equal(await pending.run(r, 'snooze', 31), false); const original = structuredClone(sent.at(-1));
  assert.equal(await pending.run(r, 'dismiss'), true); assert.deepEqual(sent.at(-1), original);
});
test('confirmed host response survives failed refresh and modal-controller reattachment without another POST', async () => {
  const r = reminder(); let posts = 0, fail = true;
  const f = fixture(async () => { posts++; return snoozed(r); }, async () => { if (fail) throw Error('Refresh unavailable'); });
  const c = f.controller(r.id); assert.equal(await c.run(r, 'snooze', 10), false); assert.equal(c.confirmed?.dueAt, 987654);
  c.observe(() => {}); fail = false; assert.equal(await c.run(), true); assert.equal(posts, 1);
  const reopened = f.controller(r.id); assert.equal(await reopened.run(), true); assert.equal(posts, 1);
});
test('action A success cannot falsely confirm action B after B becomes uncertain', async () => {
  const r = reminder(), a = snoozed(r), b = snoozed(a), sent: ReminderCommand[] = []; let count = 0;
  const f = fixture(async (_route, command) => { sent.push(structuredClone(command)); if (++count === 1) return a; if (count === 2) throw Error('Lost B response'); return b; });
  const c = f.controller(r.id); assert.equal(await c.run(r, 'snooze', 10), true); assert.equal(await c.run(a, 'snooze', 60), false);
  assert.equal(c.confirmed, undefined); assert.equal((f.records.get(reminderActionKey(scope, r.id)) as ReminderActionJournal).confirmed, undefined);
  assert.equal(await c.run(a), true); assert.equal(sent.length, 3); assert.deepEqual(sent[1], sent[2]); assert.notEqual(sent[0].requestId, sent[1].requestId);
});
test('a late A response does not rewrite a newer B journal or supply its confirmation', async () => {
  const r = reminder(), wait = deferred<WorkspaceReminder>(), f = fixture(async () => wait.promise), c = f.controller(r.id);
  const first = c.run(r, 'snooze', 10), key = reminderActionKey(scope, r.id);
  const original = f.records.get(key) as ReminderActionJournal;
  const newer = { ...original, command: { ...original.command, requestId: randomUUID(), minutes: 60 } };
  f.records.set(key, structuredClone(newer)); wait.resolve(snoozed(r)); await first;
  assert.deepEqual(f.records.get(key), newer); assert.equal(c.confirmed, undefined);
});
test('legacy uncertain snooze uses original command without inventing captured prior snooze count', async () => {
  const r = reminder(), result = snoozed(r), current = { ...result, revision: 5, snoozes: 4 }, command: ReminderCommand = { requestId: randomUUID(), epoch: scope.epoch, reminderId: r.id, expectedRevision: 1, action: 'snooze', minutes: 10 };
  let actual: ReminderCommand | undefined; const f = fixture(async (_route, cmd) => { actual = cmd; return result; });
  f.records.set(reminderActionKey(scope, r.id), command); assert.equal(await f.controller(r.id).run(current), true); assert.deepEqual(actual, command);
});

for (const originalDate of [undefined, '2026-10-19']) test(`Calendar ${originalDate ? 'occurrence' : 'one-off'} confirms and reloads its exact original snooze`, async () => {
  const r = { id: randomUUID(), revision: 1, eventId: 'event:original', originalDate, eventRevision: 3, overrideRevision: 0, title: 'Original event', sourceFingerprint: 'source', sourceDueAt: 123,
    spec: { date: '2026-10-20', time: '09:00', timezone: 'UTC' }, dueAt: 123, state: 'missed', snoozes: 0 } as WorkspaceReminder;
  let posts = 0; const f = fixture(async (route, command) => { assert.equal(route, 'calendar/reminders/action'); assert.equal(command.reminderId, r.id); posts++; return snoozed(r); });
  assert.equal(await f.controller(r.id).run(r, 'snooze', 11), true);
  const stored = readReminderAction(f.records.get(reminderActionKey(scope, r.id)), r.id);
  assert.ok(stored?.confirmed); assert.equal('eventId' in stored.confirmed && stored.confirmed.originalDate, originalDate);
  assert.equal(await f.controller(r.id).run(), true); assert.equal(posts, 1);
  assert.equal(readReminderAction({ ...stored, confirmed: { ...stored.confirmed, originalDate: '2026-10-21' } }, r.id), undefined);
});
test('malformed confirmations, wrong source/date and wrong controller identity refuse without dispatch', async () => {
  const r = reminder(), command: ReminderCommand = { requestId: randomUUID(), epoch: scope.epoch, reminderId: r.id, expectedRevision: 1, action: 'snooze', minutes: 10 };
  const original: ReminderActionJournal = { format: 1, command, route: 'tasks', original: r, captured: true };
  assert.equal(readReminderAction({ ...original, confirmed: { ...snoozed(r), taskId: 'task:different' } }, r.id), undefined);
  assert.equal(readReminderAction({ ...original, confirmed: { ...snoozed(r), revision: 1 } }, r.id), undefined);
  assert.equal(readReminderAction({ ...original, confirmed: { ...snoozed(r), revision: 3 } }, r.id), undefined);
  assert.equal(readReminderAction({ ...original, captured: false, confirmed: snoozed(r) }, r.id), undefined);
  assert.equal(readReminderAction({ ...original, confirmed: { ...snoozed(r), state: 'dismissed' } }, r.id), undefined);
  let sends = 0; const f = fixture(async () => { sends++; return snoozed(r); });
  assert.equal(await f.controller(r.id).run(reminder(), 'dismiss'), false); assert.equal(sends, 0);
});
test('storage refusal and replaced epoch preserve original pending action and cannot dispatch', async () => {
  const r = reminder(); let sends = 0; const f = fixture(async () => { sends++; return snoozed(r); }), c = f.controller(r.id);
  f.full(true); assert.equal(await c.run(r, 'snooze', 10), false); assert.equal(sends, 0);
  f.full(false); f.epoch(randomUUID()); assert.equal(await c.run(r, 'dismiss'), false); assert.equal(sends, 0);
});
test('host success with full local storage remains bound in memory and is retained later without re-POST', async () => {
  const r = reminder(); let posts = 0; const f = fixture(async () => { posts++; f.full(true); return snoozed(r); }), c = f.controller(r.id);
  assert.equal(await c.run(r, 'snooze', 10), false); assert.equal(c.confirmed?.id, r.id); f.full(false);
  assert.equal(await c.run(r), true); assert.equal(posts, 1);
});
test('pending discovery retains missing originals, changed groups and old epoch records', () => {
  const r = reminder(), f = fixture(async () => r), key = reminderActionKey(scope, r.id), command = { requestId: randomUUID(), epoch: scope.epoch, reminderId: r.id, expectedRevision: 1, action: 'dismiss' };
  f.records.set(key, { format: 1, route: 'tasks', command, original: r });
  assert.equal(pendingReminderActions(f.storage, [key], scope, []).length, 1);
  assert.equal(pendingReminderActions(f.storage, [key], scope, [{ ...r, state: 'dismissed' }]).length, 1);
  f.records.set(key, { ...command, epoch: randomUUID() }); assert.equal(pendingReminderActions(f.storage, [key], scope, []).length, 1);
});
