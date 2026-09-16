import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, Fault } from '../apps/service/store';
import { CalendarWriteService } from '../apps/service/calendar-write';
import { CalendarGroups } from '../apps/service/calendar-groups';
import { ProviderError } from '../apps/service/providers';
import { calendarGroupPrepareSchema, type CalendarGroupReview } from '../packages/domain/calendar-groups';
import type { Provider } from '../packages/domain/accounts';

function fixture(t: TestContext, provider: Provider = 'google') {
  const directory = mkdtempSync(join(tmpdir(), 'e3-calendar-groups-')); let store = new Store(directory), now = Date.now();
  const source = { id: 'source', accountId: provider + '-account', generation: randomUUID(), provider, calendarId: 'exact-calendar', name: 'Classes', accountLabel: 'Studio', primary: true, providerCanWrite: true, accountCanWrite: true };
  const account = { id: source.accountId, provider, generation: source.generation, state: 'connected', capabilities: { calendarRead: true, calendarWrite: true } };
  const events = new Map<string, any>();
  for (const id of ['a-monday', 'b-tuesday', 'c-wednesday']) events.set(id, provider === 'google'
    ? { id, etag: '"v1"', summary: 'Classes: ' + id, status: 'confirmed', start: { dateTime: '2026-09-14T17:00:00Z', timeZone: 'America/Los_Angeles' }, end: { dateTime: '2026-09-14T18:00:00Z', timeZone: 'America/Los_Angeles' }, recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'], reminders: { useDefault: true }, attendees: [] }
    : { id, '@odata.etag': 'W/"v1"', changeKey: 'v1', subject: 'Classes: ' + id, type: 'seriesMaster', body: { contentType: 'text', content: 'Original series notes' }, start: { dateTime: '2026-09-14T17:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-09-14T18:00:00', timeZone: 'UTC' }, originalStartTimeZone: 'America/Los_Angeles', originalEndTimeZone: 'America/Los_Angeles', isAllDay: false, isCancelled: false, attendees: [], recurrence: { pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'] }, range: { type: 'numbered', startDate: '2026-09-14', numberOfOccurrences: 4 } } });
  const effects: string[] = [], reads: string[] = [], lose = new Set<string>(), reject = new Set<string>(); let afterEffect: ((id: string) => Promise<void>) | undefined;
  const accounts: any = { state: () => ({ accounts: [account] }), calendarOperation: async (id: string, generation: string, capabilities: string[], _signal: AbortSignal, run: any) => {
    const check = () => { if (id !== account.id || generation !== account.generation || account.state !== 'connected') throw new Fault(409, 'account_changed', 'Reconnect the account'); if (capabilities.some(key => !(account.capabilities as any)[key])) throw new ProviderError('permission', 'Missing permission'); };
    check(); return run(account, async (path: string, init: RequestInit = {}) => {
      const url = new URL('https://fixture.invalid' + path), id = decodeURIComponent(url.pathname.split('/').at(-1)!);
      if (!url.pathname.includes('/events')) return { id: source.calendarId, accessRole: 'owner', canEdit: true };
      if (!init.method || init.method === 'GET') { reads.push(id); const value = events.get(id); if (!value) throw new ProviderError('not_found', 'Absent event'); return structuredClone(value); }
      assert.equal(init.method, 'DELETE');
      const value = events.get(id); assert.equal(new Headers(init.headers).get('If-Match'), provider === 'google' ? value?.etag : value?.['@odata.etag']);
      if (reject.has(id)) throw new ProviderError('invalid_response', 'Intervening provider edit', undefined, 412);
      if (provider === 'google') events.set(id, { id, status: 'cancelled' }); else events.delete(id);
      effects.push(id); await afterEffect?.(id);
      if (lose.has(id)) throw new ProviderError('unavailable', 'Lost deletion response'); return null;
    }, check);
  } };
  const calendar: any = { resolveSource(_device: string, id: string, generation: string) { assert.equal(id, source.id); if (generation !== account.generation) throw new Fault(409, 'calendar_source_changed', 'Refresh Calendar'); return { ...source, generation, accountCanWrite: account.capabilities.calendarWrite }; }, providerChanged() {} };
  let writes = new CalendarWriteService(store, accounts, calendar, () => now), groups = new CalendarGroups(store, accounts, calendar, writes, () => now);
  t.after(async () => { await groups.close(); await writes.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const prepare = (seriesIds = [...events.keys()]) => ({ requestId: randomUUID(), epoch: store.epoch, writerId: randomUUID(), sourceId: source.id, generation: account.generation, seriesIds, label: 'Classes' });
  const command = (review: CalendarGroupReview, action: 'confirm' | 'cancel' | 'review', extra = {}) => ({ requestId: randomUUID(), epoch: store.epoch, operationId: review.id, expectedRevision: review.revision, digest: review.digest, action, ...extra });
  const read = (review: CalendarGroupReview) => groups.read('device', { requestId: randomUUID(), epoch: store.epoch, operationId: review.id });
  return { advanceTime(ms: number) { now += ms; }, directory, source, account, events, effects, reads, lose, reject, prepare, command, read, get store() { return store; }, get groups() { return groups; }, get writes() { return writes; }, afterEffect(run: (id: string) => Promise<void>) { afterEffect = run; },
    async restart() { await groups.close(); await writes.close(); store.close(); store = new Store(directory); writes = new CalendarWriteService(store, accounts, calendar, () => now); groups = new CalendarGroups(store, accounts, calendar, writes, () => now); } };
}

for (const provider of ['google', 'microsoft'] as const) {
  test(provider + ': exact grouped review deletes only selected masters and receipts survive restart', async t => {
    const f = fixture(t, provider), input = f.prepare(['c-wednesday', 'a-monday']);
    const review = await f.groups.prepare('device', input); assert.equal(review.state, 'review'); assert.equal(f.effects.length, 0); assert.deepEqual(review.items.map(item => item.seriesId), ['a-monday', 'c-wednesday']);
    assert.equal((await f.groups.prepare('device', input)).id, review.id);
    await assert.rejects(f.groups.action('device', { ...f.command(review, 'confirm'), digest: 'a'.repeat(64) }), /Review every/);
    const command = f.command(review, 'confirm'), saved = await f.groups.action('device', command);
    assert.equal(saved.state, 'confirmed'); assert.equal(saved.closed, true); assert.deepEqual(f.effects, ['a-monday', 'c-wednesday']);
    await f.restart(); assert.equal((await f.groups.action('device', command)).state, 'confirmed'); assert.equal(f.effects.length, 2);
    assert.equal(f.events.get('b-tuesday')[provider === 'google' ? 'status' : 'type'], provider === 'google' ? 'confirmed' : 'seriesMaster');
    assert.equal(f.store.snapshot('device').tasks.length, 0);
  });
  test(provider + ': an uncertain middle deletion stops the group and read-only recovery never replays completed effects', async t => {
    const f = fixture(t, provider), review = await f.groups.prepare('device', f.prepare()), command = f.command(review, 'confirm'); f.lose.add('b-tuesday');
    const partial = await f.groups.action('device', command);
    assert.equal(partial.state, 'partial'); assert.deepEqual(f.effects, ['a-monday', 'b-tuesday']); assert.deepEqual(partial.items.map(item => item.operation?.state), ['confirmed', 'unknown', 'review']);
    await assert.rejects(f.groups.action('device', f.command(partial, 'review')), /uncertain/);
    await f.restart(); f.account.generation = randomUUID(); f.account.capabilities.calendarWrite = false;
    assert.equal((await f.groups.action('device', command)).state, 'partial'); assert.equal(f.effects.length, 2);
    const checked = await f.groups.reconcile('device', { requestId: randomUUID(), epoch: f.store.epoch, operationId: review.id });
    assert.equal(checked.items[1].operation?.state, 'observed'); assert.equal(f.effects.length, 2);
    // The remaining old connection is not silently rebound for a write.
    const failed = await f.groups.action('device', f.command(checked, 'confirm'));
    assert.equal(failed.state, 'partial'); assert.equal(f.effects.length, 2);
    f.account.capabilities.calendarWrite = true;
    const refreshed = await f.groups.action('device', f.command(failed, 'review'));
    assert.equal(refreshed.state, 'review'); assert.equal(refreshed.source.generation, f.account.generation); assert.equal(refreshed.round, 2);
    const done = await f.groups.action('device', f.command(refreshed, 'confirm')); assert.equal(done.state, 'confirmed'); assert.deepEqual(f.effects, ['a-monday', 'b-tuesday', 'c-wednesday']);
  });
  test(provider + ': keeping the remainder after a conflict closes the group with exact partial results', async t => {
    const f = fixture(t, provider), review = await f.groups.prepare('device', f.prepare()); f.reject.add('b-tuesday');
    const partial = await f.groups.action('device', f.command(review, 'confirm')); assert.equal(partial.state, 'partial'); assert.deepEqual(f.effects, ['a-monday']);
    const kept = await f.groups.action('device', f.command(partial, 'cancel')); assert.equal(kept.closed, true); assert.equal(kept.state, 'partial'); assert.equal(kept.items[2].operation?.state, 'cancelled');
    await f.restart(); assert.equal(f.read(kept).closed, true); assert.equal(f.effects.length, 1);
  });
}

test('group guest acknowledgement and per-series reservations remain enforced against single-event writers', async t => {
  const f = fixture(t); f.events.get('a-monday').attendees = [{ email: 'guest@example.test' }];
  const review = await f.groups.prepare('device', f.prepare());
  await assert.rejects(f.groups.action('device', f.command(review, 'confirm')), /guests/); assert.equal(f.effects.length, 0);
  const editable = await f.writes.open('another-device', { epoch: f.store.epoch, target: { sourceId: f.source.id, generation: f.source.generation, eventId: 'a-monday', seriesId: 'a-monday', scope: 'series' } });
  await assert.rejects(f.writes.prepare('another-device', { requestId: randomUUID(), epoch: f.store.epoch, writerId: randomUUID(), sourceId: f.source.id, generation: f.source.generation, action: 'delete', target: editable.target, expectedVersion: editable.version }), /unfinished/);
  const kept = await f.groups.action('device', f.command(review, 'cancel')); assert.equal(kept.state, 'cancelled'); assert.equal(f.effects.length, 0);
});

test('group recovery locates a child admitted before its parent saved the returned identity', async t => {
  const f = fixture(t), review = await f.groups.prepare('device', f.prepare(['a-monday']));
  const key = 'calendar-group:operation:' + review.id, head = f.store.internalRead<any>(key);
  delete head.children[0].operationId; head.review.state = 'preparing'; head.review.items = [];
  f.store.internalWrite(key, head); await f.restart();
  const recovered = f.read(review); assert.equal(recovered.state, 'review'); assert.equal(recovered.items[0].operation?.id, review.items[0].operation?.id); assert.equal(f.effects.length, 0);
});

test('a missing selected master retains the complete selection and cancels other unapplied reviews', async t => {
  const f = fixture(t), review = await f.groups.prepare('device', f.prepare(['a-monday', 'missing-master']));
  assert.equal(review.state, 'partial'); assert.equal(review.items.length, 2); assert.match(review.items[1].error!, /Absent/);
  assert.equal(f.read(review).revision, review.revision); assert.equal(f.read(review).revision, review.revision);
  await assert.rejects(f.groups.action('device', f.command(review, 'confirm')), /Review every/);
  const kept = await f.groups.action('device', f.command(review, 'cancel')); assert.equal(kept.state, 'cancelled'); assert.equal(kept.items[0].operation?.state, 'cancelled'); assert.equal(f.effects.length, 0);
});

test('group requests are bounded, duplicate-free, epoch-bound and private to their owning device', async t => {
  const f = fixture(t); assert.equal(calendarGroupPrepareSchema.safeParse(f.prepare(['a', 'a'])).success, false); assert.equal(calendarGroupPrepareSchema.safeParse(f.prepare(Array.from({ length: 32 }, (_, i) => String(i)))).success, false);
  const review = await f.groups.prepare('device', f.prepare(['a-monday']));
  assert.throws(() => f.groups.read('another-device', { requestId: randomUUID(), epoch: f.store.epoch, operationId: review.id }), /unavailable/);
  await assert.rejects(f.groups.action('device', { ...f.command(review, 'confirm'), epoch: randomUUID() }), /workspace recovery/); assert.equal(f.effects.length, 0);
});


test('expired grouped reviews can be refreshed explicitly without dropping selected patterns', async t => {
  const f = fixture(t), review = await f.groups.prepare('device', f.prepare()); f.advanceTime(31 * 60000);
  const expired = await f.groups.action('device', f.command(review, 'confirm'));
  assert.equal(expired.state, 'partial'); assert.match(expired.items[0].error!, /fresh review/); assert.equal(f.effects.length, 0);
  const fresh = await f.groups.action('device', f.command(expired, 'review'));
  assert.equal(fresh.state, 'review'); assert.equal(fresh.items.length, 3); assert.equal(fresh.round, 2);
  assert.equal((await f.groups.action('device', f.command(fresh, 'confirm'))).state, 'confirmed'); assert.equal(f.effects.length, 3);
});

test('only guests on remaining patterns need acknowledgement when continuing a partial group', async t => {
  const f = fixture(t); f.events.get('a-monday').attendees = [{ email: 'guest@example.test' }]; f.reject.add('b-tuesday');
  const first = await f.groups.prepare('device', f.prepare());
  const partial = await f.groups.action('device', f.command(first, 'confirm', { acknowledgeNotifications: true }));
  f.reject.clear(); const remaining = await f.groups.action('device', f.command(partial, 'review'));
  assert.equal((await f.groups.action('device', f.command(remaining, 'confirm'))).state, 'confirmed'); assert.equal(f.effects.length, 3);
});

test('service close drains the current deletion but does not start remaining series or replay them on restart', async t => {
  const f = fixture(t); let started!: () => void, release!: () => void;
  const starting = new Promise<void>(resolve => { started = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  f.afterEffect(async id => { if (id === 'a-monday') { started(); await held; } });
  const review = await f.groups.prepare('device', f.prepare()), command = f.command(review, 'confirm');
  const pending = f.groups.action('device', command); await starting;
  const closing = f.groups.close(); release(); await closing; await pending; await f.restart();
  const recovered = await f.groups.action('device', command);
  assert.deepEqual(f.effects, ['a-monday']); assert.equal(recovered.items[0].operation?.state, 'confirmed'); assert.equal(recovered.items[1].operation?.state, 'review');
});

test('keeping remaining patterns survives uncertain-result recovery without needing the same decision twice', async t => {
  const f = fixture(t), first = await f.groups.prepare('device', f.prepare()); f.lose.add('b-tuesday');
  const partial = await f.groups.action('device', f.command(first, 'confirm'));
  const kept = await f.groups.action('device', f.command(partial, 'cancel')); assert.equal(kept.closed, false); assert.equal(kept.items[2].operation?.state, 'cancelled');
  await f.restart();
  const observed = await f.groups.reconcile('device', { requestId: randomUUID(), epoch: f.store.epoch, operationId: first.id });
  assert.equal(observed.closed, true); assert.equal(observed.state, 'partial'); assert.deepEqual(f.effects, ['a-monday', 'b-tuesday']);
});
