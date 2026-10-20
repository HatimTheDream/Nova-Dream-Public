import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Entity, Task } from '../packages/domain/contracts.js';
import type { TaskEvent } from '../packages/domain/tasks.js';
import { buildProfileProgress } from '../packages/domain/profile-progression.js';
import { buildProfileDay, buildProfileWeek, profileCompletionActivity, profileWeekIdentitySchema } from '../packages/domain/profile-week.js';
import { ProfileWeek, profileReadQuery } from '../apps/service/profile-week.js';
import { Store } from '../apps/service/store.js';
import { phoneRouteAllowed } from '../apps/service/phone-policy.js';

const task: Entity<Task> = { id: 'task:original', revision: 7, deviceId: 'original', updatedAt: '2026-10-12T12:00:00Z', value: { title: 'Original Task', notes: 'Keep all writing', status: 'done', planned: '', due: '' } };
function event(revision: number, at: string, from: Task['status'] | null, to: Task['status'], xpDelta: number, taskId = task.id): TaskEvent {
  return { id: `${taskId}:${revision}`, taskId, at, from, to, xpDelta };
}
const now = Date.parse('2026-10-20T12:00:00Z');

test('current credit stays on first completion while actual reopening and re-completion stay on their real days', () => {
  const ledger = [event(2, '2026-10-05T12:00:00Z', 'open', 'done', 10), event(3, '2026-10-06T12:00:00Z', 'done', 'open', -10), event(4, '2026-10-12T12:00:00Z', 'open', 'done', 10)];
  const first = { start: '2026-10-05', timezone: 'UTC' }, later = { start: '2026-10-12', timezone: 'UTC' };
  const original = structuredClone({ task, ledger });
  assert.equal(buildProfileWeek([task], ledger, first, 'UTC', now, 'epoch').days[0].count, 1);
  const week = buildProfileWeek([task], ledger, later, 'UTC', now, 'epoch');
  assert.equal(week.days[0].count, 0); assert.equal(week.days[0].activityCount, 1);
  const activity = buildProfileDay([task], ledger, later, later.start, 'epoch')!;
  assert.equal(activity.entries[0].transition, 'completed-again'); assert.equal(activity.entries[0].id, ledger[2].id);
  assert.equal(buildProfileProgress([task], ledger, [], 'UTC', now, 'epoch').earnedXp, 10);
  assert.deepEqual({ task, ledger }, original);
  const reopened = ledger.slice(0, 2);
  assert.equal(buildProfileWeek([task], reopened, first, 'UTC', now, 'epoch').days[0].count, 0);
  assert.equal(buildProfileDay([task], reopened, first, '2026-10-06', 'epoch')!.entries[0].transition, 'reopened');
});

test('zero-credit legacy transitions remain activity but trash-only changes do not become another finish', () => {
  const ledger = [event(1, '2026-10-05T12:00:00Z', null, 'open', 0), event(2, '2026-10-05T13:00:00Z', 'open', 'done', 0),
    { ...event(3, '2026-10-05T14:00:00Z', 'done', 'done', 0), action: 'trash' as const }, event(4, '2026-10-06T12:00:00Z', 'done', 'open', 0),
    event(5, '2026-10-06T13:00:00Z', 'open', 'done', 0)];
  assert.deepEqual(profileCompletionActivity([task], ledger).map(row => [row.id, row.transition, row.xpDelta]), [
    [ledger[4].id, 'completed-again', 0], [ledger[3].id, 'reopened', 0], [ledger[1].id, 'completed', 0]
  ]);
  const week = buildProfileWeek([task], ledger, { start: '2026-10-05', timezone: 'UTC' }, 'UTC', now, 'epoch');
  assert.equal(week.days.reduce((sum, row) => sum + row.count, 0), 0);
  assert.deepEqual(week.days.slice(0, 2).map(row => row.activityCount), [1, 2]);
  assert.equal(buildProfileProgress([task], ledger, [], 'UTC', now, 'epoch').history.total, 0);
});

test('week dates use the exact selected timezone across year and DST boundaries', () => {
  const identity = { start: '2025-12-29', timezone: 'Asia/Tokyo' };
  const ledger = [event(1, '2025-12-31T16:00:00Z', 'open', 'done', 10)];
  const week = buildProfileWeek([], ledger, identity, 'America/Los_Angeles', Date.parse('2025-12-31T16:01:00Z'), 'epoch');
  assert.equal(week.days[3].day, '2026-01-01'); assert.equal(week.days[3].count, 1);
  assert.equal(week.today, '2025-12-31'); assert.equal(week.homeTimezone, 'America/Los_Angeles');
  const dst = buildProfileWeek([], [event(2, '2026-03-08T09:59:00Z', 'open', 'done', 10)], { start: '2026-03-02', timezone: 'America/Los_Angeles' }, 'UTC', now, 'epoch');
  assert.equal(dst.days[6].day, '2026-03-08'); assert.equal(dst.days[6].activityCount, 1);
  assert.equal(profileWeekIdentitySchema.safeParse({ start: '2026-03-08', timezone: 'UTC' }).success, false);
  assert.equal(profileWeekIdentitySchema.safeParse({ start: '2026-03-02', timezone: 'Not/A_Zone' }).success, false);
});

test('complete activity uses original unique IDs beyond 500 events, with exact day cursor and unavailable original', () => {
  const ledger = Array.from({ length: 541 }, (_, i) => event(i + 1, '2026-10-05T12:00:00Z', i % 2 ? 'done' : 'open', i % 2 ? 'open' : 'done', i % 2 ? -10 : 10));
  const identity = { start: '2026-10-05', timezone: 'UTC' };
  const ids = new Set<string>(); let cursor: string | undefined;
  do {
    const page = buildProfileDay([], [...ledger, ledger[0]], identity, identity.start, 'epoch', cursor)!;
    assert.equal(page.total, 541); assert(page.entries.every(row => !row.available && row.title === 'Task unavailable'));
    for (const row of page.entries) { assert(!ids.has(row.id)); ids.add(row.id); }
    cursor = page.next ?? undefined;
  } while (cursor);
  assert.equal(ids.size, 541);
  assert.equal(buildProfileDay([], ledger, identity, identity.start, 'epoch', 'missing'), undefined);
  assert.equal(buildProfileDay([], ledger, identity, '2026-10-06', 'epoch', ledger[0].id), undefined);
});

test('service reads the complete ledger and preserves every saved field and original history receipt', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-profile-week-')), store = new Store(directory, () => now);
  try {
    const saved = store.mutate('owner', { requestId: randomUUID(), epoch: store.epoch, kind: 'task', entityId: `task:${randomUUID()}`, expectedRevision: 0,
      payload: { ...task.value, status: 'open' } }) as Entity<Task>;
    for (let i = 1; i <= 541; i++) store.internalWrite(`tasks:event:${saved.id}:${i}`, event(i, '2026-10-05T12:00:00Z', i % 2 ? 'open' : 'done', i % 2 ? 'done' : 'open', i % 2 ? 10 : -10, saved.id));
    const capture = () => { const { id: _id, createdAt: _at, ...data } = store.captureBackup('test', { status: 'not-configured', notes: [] }); return data; };
    const before = capture(), reader = new ProfileWeek(store, () => now), identity = { start: '2026-10-05', timezone: 'UTC' };
    assert.equal(reader.state(identity).days[0].count, 1);
    assert.equal(reader.day({ ...identity, day: identity.start }).total, 541);
    const history = reader.history({}); assert.equal(history.epoch, store.epoch); assert.equal(history.page.total, 541);
    assert.equal(reader.history({ before: history.page.next }).page.entries.length, 50);
    assert.throws(() => reader.day({ ...identity, day: identity.start, before: 'missing' }), /Reload this day/);
    assert.throws(() => reader.day({ ...identity, day: '2026-10-12' }), /Choose a day/);
    assert.throws(() => reader.state({ start: identity.start }), /Keep the week/);
    assert.throws(() => reader.state({ ...identity, owner: 'other' }));
    store.setUpdateMaintenanceHeld(true); assert.equal(reader.state(identity).days[0].count, 1);
    assert.deepEqual(capture(), before);
    assert.throws(() => profileReadQuery(new URLSearchParams('start=2026-10-05&start=2026-10-12')), /one value/);
    let clockReads = 0;
    const midnight = new ProfileWeek(store, () => ++clockReads === 1 ? Date.parse('2026-10-18T23:59:59.999Z') : Date.parse('2026-10-19T00:00:00Z'));
    const boundary = midnight.state({});
    assert.equal(clockReads, 1); assert.equal(boundary.identity.start, '2026-10-12');
    assert.equal(boundary.currentWeek, '2026-10-12'); assert.equal(boundary.today, '2026-10-18');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('phone scope adds only the three exact read routes and no mutation or alternate path', () => {
  for (const path of ['/api/profile/week', '/api/profile/week/activity', '/api/profile/week/history']) {
    assert(phoneRouteAllowed(path, 'GET')); assert(!phoneRouteAllowed(path, 'POST'));
    assert(!phoneRouteAllowed(path + '/', 'GET')); assert(!phoneRouteAllowed(path + '/delete', 'GET'));
  }
});
