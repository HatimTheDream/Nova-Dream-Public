import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, Fault } from '../apps/service/store';
import { startServer } from '../apps/service/http';
import { CalendarWriteService } from '../apps/service/calendar-write';
import { Providers, ProviderError } from '../apps/service/providers';
import { providerCalendarPrepareSchema } from '../packages/domain/calendar-write';
import type { ProviderCalendarPrepare, ProviderCalendarReview } from '../packages/domain/calendar-write';
import type { Provider } from '../packages/domain/accounts';
import type { LocalEventInput } from '../packages/domain/calendar';
import { inspectProviderEvent, planProviderCalendarWrite, readProviderCalendarEvent, providerRecurrence, findCalendarOperation, findCalendarDeletion, applyProviderCalendarPlan, CALENDAR_OPERATION_PROPERTY, CALENDAR_DIGEST_PROPERTY, type CalendarRequest } from '../apps/service/provider-calendar-write';

const value = (): LocalEventInput => ({ title: 'Workshop planning', notes: 'Keep the complete plan.', location: 'Studio', timezone: 'America/Los_Angeles', allDay: false, start: { date: '2026-09-10', time: '10:00' }, end: { date: '2026-09-10', time: '11:00' }, state: 'confirmed', projectId: null, taskId: null, category: 'other', reminderMinutes: 30, deliveryChannel: 'last' });
function event(provider: Provider, id = 'original-event'): any {
  return provider === 'google' ? { id, etag: '"v1"', status: 'confirmed', summary: 'Workshop planning', description: 'Keep the complete plan.', location: 'Studio', start: { dateTime: '2026-09-10T17:00:00Z', timeZone: 'America/Los_Angeles' }, end: { dateTime: '2026-09-10T18:00:00Z', timeZone: 'America/Los_Angeles' }, attendees: [], reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] } }
    : { id, '@odata.etag': 'W/"v1"', changeKey: 'v1', type: 'singleInstance', subject: 'Workshop planning', bodyPreview: 'Keep the complete plan.', body: { contentType: 'text', content: 'Keep the complete plan.' }, location: { displayName: 'Studio' }, start: { dateTime: '2026-09-10T17:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-09-10T18:00:00', timeZone: 'UTC' }, originalStartTimeZone: 'America/Los_Angeles', originalEndTimeZone: 'America/Los_Angeles', isAllDay: false, isCancelled: false, attendees: [], isReminderOn: true, reminderMinutesBeforeStart: 30 };
}
function fixture(t: TestContext, provider: Provider) {
  const dir = mkdtempSync(join(tmpdir(), 'e3-calendar-write-')); let store = new Store(dir);
  const source = { id: 'source', accountId: provider + '-account', generation: randomUUID(), provider, calendarId: 'original/calendar', name: 'Original Calendar', accountLabel: 'Studio', primary: true, providerCanWrite: true };
  const account = { id: source.accountId, provider, generation: source.generation, state: 'connected', capabilities: { calendarRead: true, calendarWrite: true } };
  const data = new Map<string, any>([['original-event', event(provider)]]), writes: any[] = [], reads: string[] = [];
  let loss = false, denied = false, unreadable = false, rejected = false, changedViews = 0, afterWrite: (() => void) | undefined;
  const request: CalendarRequest = async (path, init = {}) => {
    const url = new URL('https://fixture.invalid' + path), method = init.method ?? 'GET';
    if (method === 'GET') {
      reads.push(path);
      if (url.pathname.includes('/calendarList/') || !url.pathname.includes('/events')) {
        if (unreadable) throw new ProviderError('not_found', 'Calendar access unavailable');
        return { id: source.calendarId, accessRole: denied ? 'reader' : 'owner', canEdit: !denied };
      }
      if (url.pathname.endsWith('/events')) {
        const filter = url.searchParams.get('$filter') ?? '', id = filter.match(/ep\/value eq '([^']+)'/)?.[1];
        return { value: [...data.values()].filter(item => item.singleValueExtendedProperties?.some((p: any) => p.id === CALENDAR_OPERATION_PROPERTY && p.value === id)) };
      }
      const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
      const found = data.get(id); if (!found) throw new ProviderError('not_found', 'Missing event', undefined, 404);
      return structuredClone(found);
    }
    if (rejected) throw new ProviderError('invalid_response', 'Precondition failed', undefined, 412);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const id = method === 'POST' ? body.id ?? 'created-' + randomUUID() : decodeURIComponent(url.pathname.split('/').at(-1)!);
    const previous = data.get(id);
    if (method !== 'POST') assert.equal(new Headers(init.headers).get('If-Match'), provider === 'google' ? previous.etag : previous['@odata.etag']);
    if (method === 'DELETE') data.delete(id);
    else {
      const next = { ...event(provider, id), ...previous, ...body, id };
      if (provider === 'google') next.etag = '"v' + (writes.length + 2) + '"';
      else { next.changeKey = 'v' + (writes.length + 2); next['@odata.etag'] = 'W/"' + next.changeKey + '"'; next.originalStartTimeZone = next.start.timeZone === 'UTC' ? next.originalStartTimeZone : next.start.timeZone; next.originalEndTimeZone = next.originalStartTimeZone; }
      data.set(id, next);
    }
    writes.push({ path, method, id, body }); afterWrite?.();
    if (loss) throw new ProviderError('unavailable', 'Response lost after provider effect');
    return method === 'DELETE' ? null : structuredClone(data.get(id));
  };
  const accounts: any = { state: () => ({ accounts: [account] }), calendarOperation: async (id: string, generation: string, capabilities: string[], _signal: AbortSignal, run: any) => {
    const check = () => { if (id !== account.id || generation !== account.generation || account.state !== 'connected') throw new Fault(409, 'account_changed', 'Connection changed'); if (capabilities.some(key => !(account.capabilities as any)[key])) throw new ProviderError('permission', 'Missing permission'); };
    check(); return run(account, request, check);
  } };
  const calendar = { resolveSource(_device: string, id: string, generation: string) { assert.equal(id, source.id); assert.equal(generation, account.generation); return { ...source, generation }; }, providerChanged() { changedViews++; } };
  let service = new CalendarWriteService(store, accounts, calendar);
  t.after(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const input = (action: ProviderCalendarPrepare['action'] = 'create', writerId = randomUUID()) => providerCalendarPrepareSchema.parse({ requestId: randomUUID(), epoch: store.epoch, writerId, sourceId: source.id, generation: account.generation, action,
    ...(action === 'create' ? {} : { target: { sourceId: source.id, generation: account.generation, eventId: 'original-event', scope: 'event' }, expectedVersion: provider === 'google' ? '"v1"' : 'v1' }), ...(action === 'delete' ? {} : { value: { ...value(), title: action === 'update' ? 'Revised workshop' : value().title } }) });
  const confirm = (review: ProviderCalendarReview, extra = {}) => ({ requestId: randomUUID(), epoch: store.epoch, operationId: review.id, expectedRevision: review.revision, digest: review.digest!, decision: 'confirm', ...extra });
  return { source, data, writes, reads, account, input, confirm, request, calendar, get store() { return store; }, get service() { return service; }, get changedViews() { return changedViews; },
    setLoss(v: boolean) { loss = v; }, setDenied(v: boolean) { denied = v; }, setUnreadable(v: boolean) { unreadable = v; }, setRejected(v: boolean) { rejected = v; }, afterWrite(run: () => void) { afterWrite = run; },
    async restart() { await service.close(); store.close(); store = new Store(dir); service = new CalendarWriteService(store, accounts, calendar); } };
}
for (const provider of ['google', 'microsoft'] as const) {
  test(provider + ': lost Calendar access cannot turn an uncertain deletion into an observed success', async t => {
    const f = fixture(t, provider), proposed = await f.service.prepare('device', f.input('delete'));
    f.setLoss(true); assert.equal((await f.service.confirm('device', f.confirm(proposed))).state, 'unknown');
    f.setUnreadable(true); await f.restart();
    const command = { requestId: randomUUID(), epoch: f.store.epoch, operationId: proposed.id };
    assert.equal((await f.service.reconcile('device', command)).state, 'unknown');
    f.setUnreadable(false); f.setDenied(true); f.account.capabilities.calendarWrite = false; f.account.generation = randomUUID();
    assert.equal((await f.service.reconcile('device', { ...command, requestId: randomUUID() })).state, 'observed');
    assert.equal(f.writes.length, 1);
  });
  test(provider + ': opening a kept event reads current Calendar permissions even when its source cache says writable', async t => {
    const f = fixture(t, provider); f.setDenied(true);
    const current = await f.service.open('device', { epoch: f.store.epoch, target: f.input('update').target });
    assert.equal(current.source.providerCanWrite, false); assert.equal(current.value.title, value().title);
    assert.equal(f.writes.length, 0);
  });
  test(provider + ': Nova Dream category survives provider cache refresh and service restart without replacing native fields', async t => {
    const f = fixture(t, provider), input = f.input('update');
    input.value = { ...value(), category: 'education' };
    const proposed = await f.service.prepare('device', input);
    assert.equal(proposed.state, 'review'); assert.deepEqual(proposed.changes, ['Nova Dream organization']);
    const saved = await f.service.confirm('device', f.confirm(proposed));
    assert.equal(saved.state, 'confirmed'); assert.equal(f.writes[0].body.summary, undefined); assert.equal(f.writes[0].body.subject, undefined);
    const beforeRestart = await f.service.open('device', { epoch: f.store.epoch, target: input.target });
    assert.equal(beforeRestart.value.category, 'education'); assert.equal(beforeRestart.value.notes, value().notes);
    await f.restart();
    const afterRestart = await f.service.open('device', { epoch: f.store.epoch, target: input.target });
    assert.equal(afterRestart.value.category, 'education'); assert.equal(f.writes.length, 1);
  });
  test(provider + ': an already saved new-event writer cannot create a duplicate from a cloned proposal', async t => {
    const f = fixture(t, provider), input = f.input(), proposed = await f.service.prepare('device', input);
    await f.service.confirm('device', f.confirm(proposed));
    await f.restart();
    await assert.rejects(f.service.prepare('device', { ...input, requestId: randomUUID(), value: { ...input.value!, title: 'Different clone writing' } }), (error: unknown) => error instanceof Fault && error.code === 'calendar_writer_saved');
    assert.equal(f.writes.length, 1);
  });
  test(provider + ': explicit reminder replacement distinguishes None from preserved original defaults', () => {
    const raw = event(provider);
    if (provider === 'google') raw.reminders = { useDefault: true };
    else { raw.isReminderOn = false; raw.reminderMinutesBeforeStart = 0; }
    const base = inspectProviderEvent(provider, raw), input = providerCalendarPrepareSchema.parse({ requestId: randomUUID(), epoch: randomUUID(), writerId: randomUUID(), sourceId: 'source', generation: randomUUID(), action: 'create', value: value() });
    input.action = 'update'; input.expectedVersion = base.version; input.value = { ...base.value, title: 'Change only title' };
    const kept = planProviderCalendarWrite(provider, 'calendar', input, randomUUID(), 'a'.repeat(64), base);
    assert.equal(kept.body?.reminders, undefined); assert.equal(kept.body?.isReminderOn, undefined);
    input.replaceReminder = true;
    const replaced = planProviderCalendarWrite(provider, 'calendar', input, randomUUID(), 'b'.repeat(64), base);
    if (provider === 'google') assert.deepEqual(replaced.body?.reminders, { useDefault: false, overrides: [] });
    else assert.equal(replaced.body?.isReminderOn, false);
  });
  test(provider + ': original event content is preserved by a title-only conditional patch', () => {
    const raw = event(provider);
    if (provider === 'google') Object.assign(raw, { description: '<p>Keep <b>formatted</b> notes.</p>', conferenceData: { conferenceId: 'room' }, attendees: [{ email: 'guest@example.test' }], recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'EXDATE:20260914T170000Z'] });
    else Object.assign(raw, { body: { contentType: 'html', content: '<p>Keep <b>formatted</b> notes.</p>' }, isOnlineMeeting: true, attendees: [{ emailAddress: { address: 'guest@example.test' } }], recurrence: { pattern: { type: 'relativeMonthly', interval: 1, daysOfWeek: ['monday', 'tuesday'], index: 'first' }, range: { startDate: '2026-09-10', type: 'noEnd' } } });
    const base = inspectProviderEvent(provider, raw), input = providerCalendarPrepareSchema.parse({ requestId: randomUUID(), epoch: randomUUID(), writerId: randomUUID(), sourceId: 'source', generation: randomUUID(), action: 'create', value: value() });
    input.action = 'update'; input.expectedVersion = base.version; input.value = { ...base.value, title: 'Only the title changes' };
    const plan = planProviderCalendarWrite(provider, 'calendar', input, randomUUID(), 'a'.repeat(64), base);
    assert.equal(plan.etag, base.etag); assert.deepEqual(plan.changes, ['Title']); assert.equal(plan.body?.attendees, undefined); assert.equal(plan.body?.body, undefined); assert.equal(plan.body?.description, undefined); assert.equal(plan.body?.recurrence, undefined); assert.equal(plan.body?.reminders, undefined); assert.equal(plan.body?.isReminderOn, undefined); assert.equal(plan.warnings.length, 1);
    input.value.notes = 'Replace notes'; input.replaceDescription = true; assert.throws(() => planProviderCalendarWrite(provider, 'calendar', input, randomUUID(), 'a'.repeat(64), base), /online-meeting/);
  });
  test(provider + ': review, exact save receipt, restart and retained provider event produce only one create', async t => {
    const f = fixture(t, provider), input = f.input(), review = await f.service.prepare('device', input);
    assert.equal(review.state, 'review'); assert.equal(f.writes.length, 0); assert.deepEqual(JSON.parse(JSON.stringify(await f.service.prepare('device', input))), JSON.parse(JSON.stringify(review)));
    const confirm = f.confirm(review); const saved = await f.service.confirm('device', confirm);
    assert.equal(saved.state, 'confirmed'); assert.equal(f.writes.length, 1); assert.equal(saved.event?.title, value().title);
    assert.deepEqual(JSON.parse(JSON.stringify(await f.service.confirm('device', confirm))), JSON.parse(JSON.stringify(saved))); await f.restart(); assert.deepEqual(JSON.parse(JSON.stringify(await f.service.confirm('device', confirm))), JSON.parse(JSON.stringify(saved))); assert.equal(f.writes.length, 1);
    assert.equal(f.store.snapshot('device').tasks.length, 0); assert.equal(f.store.internalList('calendar:local:').length, 0);
  });
  test(provider + ': unknown creation is reconciled with its saved provider marker and never replayed', async t => {
    const f = fixture(t, provider), command = f.input(), review = await f.service.prepare('device', command), confirm = f.confirm(review); f.setLoss(true);
    const unknown = await f.service.confirm('device', confirm); assert.equal(unknown.state, 'unknown'); assert.equal(f.writes.length, 1);
    await assert.rejects(f.service.prepare('device', { ...command, requestId: randomUUID() }), /unfinished/);
    await f.restart(); f.setLoss(false); assert.equal((await f.service.confirm('device', confirm)).state, 'unknown');
    // Reconciliation may use a newly authenticated connection to the same
    // account identity; the old operation itself never gains new write authority.
    f.account.generation = randomUUID();
    const found = await f.service.reconcile('device', { requestId: randomUUID(), epoch: f.store.epoch, operationId: review.id });
    assert.equal(found.state, 'observed'); assert.equal(f.writes.length, 1); assert.equal(found.event?.title, command.value?.title);
  });
  test(provider + ': intervening event edits and provider precondition failures cannot overwrite current work', async t => {
    const f = fixture(t, provider), review = await f.service.prepare('device', f.input('update'));
    const original = f.data.get('original-event'); original[provider === 'google' ? 'summary' : 'subject'] = 'Another writer changed this';
    const conflict = await f.service.confirm('device', f.confirm(review)); assert.equal(conflict.state, 'conflict'); assert.equal(f.writes.length, 0);
    f.data.set('original-event', event(provider)); const second = await f.service.prepare('device', f.input('update')); f.setRejected(true);
    assert.equal((await f.service.confirm('device', f.confirm(second))).state, 'conflict'); assert.equal(f.writes.length, 0);
  });
  test(provider + ': guest acknowledgement, fresh source permission and cross-writer reservations precede dispatch', async t => {
    const f = fixture(t, provider); f.data.get('original-event').attendees = [{}]; const input = f.input('update'), review = await f.service.prepare('device', input);
    await assert.rejects(f.service.prepare('another-device', f.input('delete')), /unfinished/);
    await assert.rejects(f.service.confirm('device', f.confirm(review)), /guests/); assert.equal(f.writes.length, 0);
    f.setDenied(true); const result = await f.service.confirm('device', f.confirm(review, { acknowledgeNotifications: true }));
    assert.equal(result.state, 'failed'); assert.equal(f.writes.length, 0);
  });
  test(provider + ': acknowledged writes remain confirmed through a late disconnect or view refresh failure', async t => {
    const f = fixture(t, provider), review = await f.service.prepare('device', f.input('update'));
    f.afterWrite(() => { f.account.generation = randomUUID(); }); f.calendar.providerChanged = () => { throw Error('Calendar cache unavailable'); };
    const result = await f.service.confirm('device', f.confirm(review)); assert.equal(result.state, 'confirmed'); assert.equal(f.writes.length, 1); assert.match(result.detail!, /Refresh Calendar/);
  });
  test(provider + ': unknown deletion records only observed absence, and operation access stays owned', async t => {
    const f = fixture(t, provider), review = await f.service.prepare('device', f.input('delete')); f.setLoss(true);
    assert.equal((await f.service.confirm('device', f.confirm(review))).state, 'unknown'); f.setLoss(false);
    await assert.rejects(f.service.reconcile('other', { requestId: randomUUID(), epoch: f.store.epoch, operationId: review.id }), /unavailable/);
    await assert.rejects(f.service.reconcile('device', { requestId: randomUUID(), epoch: randomUUID(), operationId: review.id }), /workspace recovery/);
    const observed = await f.service.reconcile('device', { requestId: randomUUID(), epoch: f.store.epoch, operationId: review.id }); assert.equal(observed.state, 'observed'); assert.match(observed.detail!, /not which client/); assert.equal(f.writes.length, 1);
  });
}
test('Google minimal cancellation records recover uncertain single and occurrence deletions after restart', async t => {
  const f = fixture(t, 'google'), input = f.input('delete');
  const proposed = await f.service.prepare('device', input); f.setLoss(true);
  assert.equal((await f.service.confirm('device', f.confirm(proposed))).state, 'unknown');
  f.data.set('original-event', { id: 'original-event', status: 'cancelled' }); await f.restart();
  const observed = await f.service.reconcile('device', { requestId: randomUUID(), epoch: f.store.epoch, operationId: proposed.id });
  assert.equal(observed.state, 'observed'); assert.equal(f.writes.length, 1);
  const requests: string[] = [];
  const occurrence: CalendarRequest = async path => {
    requests.push(path);
    return path.includes('/calendarList/') ? { id: 'calendar', accessRole: 'reader' }
      : { id: 'occurrence', status: 'cancelled', recurringEventId: 'master', originalStartTime: { date: '2026-09-10' } };
  };
  assert.equal((await findCalendarDeletion(occurrence, 'google', 'calendar', 'occurrence')).state, 'absent');
  assert.equal(requests.length, 2);
});

test('deletion recovery requires exact identity and readable Calendar; Google Gone never applies to Outlook', async () => {
  for (const code of [404, 410]) {
    const request: CalendarRequest = async path => {
      if (path.includes('/calendarList/')) return { id: 'calendar', accessRole: 'reader' };
      throw new ProviderError(code === 404 ? 'not_found' : 'unavailable', 'Gone', undefined, code);
    };
    assert.equal((await findCalendarDeletion(request, 'google', 'calendar', 'exact-event')).state, 'absent');
  }
  await assert.rejects(findCalendarDeletion(async () => { throw new ProviderError('unavailable', 'Gone', undefined, 410); }, 'microsoft', 'calendar', 'exact-event'), /Gone/);
  await assert.rejects(findCalendarDeletion(async () => ({ id: 'another-event', status: 'cancelled' }), 'google', 'calendar', 'exact-event'), /different event/);
  await assert.rejects(findCalendarDeletion(async path => path.includes('/calendarList/') ? { id: 'calendar', accessRole: 'freeBusyReader' } : { id: 'exact-event', status: 'cancelled' }, 'google', 'calendar', 'exact-event'), /event access/);
  assert.equal((await findCalendarDeletion(async () => ({ id: 'exact-event', isCancelled: true }), 'microsoft', 'calendar', 'exact-event')).state, 'present');
});

test('provider clocks preserve all-day dates, original overlap side, unchanged seconds and explicit repeat meaning', () => {
  const raw = event('google'); raw.start = { dateTime: '2026-11-01T09:15:20Z', timeZone: 'America/Los_Angeles' }; raw.end = { dateTime: '2026-11-01T10:15:20Z', timeZone: 'America/Los_Angeles' };
  const base = inspectProviderEvent('google', raw); assert.equal(base.value.start.overlap, 'later'); assert.equal(base.value.start.time, '01:15');
  const input: any = { action: 'update', expectedVersion: base.version, value: { ...base.value, title: 'Title only' } };
  const patch = planProviderCalendarWrite('google', 'calendar', input, randomUUID(), 'a'.repeat(64), base); assert.equal(patch.body?.start, undefined); assert.equal(patch.body?.end, undefined);
  const allDay = { ...value(), allDay: true, start: { date: '2026-09-10', time: '00:00' }, end: { date: '2026-09-12', time: '00:00' } };
  const google = planProviderCalendarWrite('google', 'calendar', { action: 'create', value: allDay } as any, randomUUID(), 'b'.repeat(64));
  assert.deepEqual(google.body?.start, { date: '2026-09-10' }); assert.deepEqual(google.body?.end, { date: '2026-09-12' });
  const repeating: LocalEventInput = { ...value(), repeat: { cadence: 'weekly', interval: 2, weekdays: [1, 3], count: 8 } };
  assert.deepEqual(providerRecurrence('google', repeating), ['RRULE:FREQ=WEEKLY;INTERVAL=2;WKST=MO;BYDAY=MO,WE;COUNT=8']);
  assert.deepEqual(providerRecurrence('microsoft', repeating), { pattern: { type: 'weekly', interval: 2, daysOfWeek: ['monday', 'wednesday'], firstDayOfWeek: 'monday' }, range: { type: 'numbered', startDate: '2026-09-10', recurrenceTimeZone: 'America/Los_Angeles', numberOfOccurrences: 8 } });
  assert.throws(() => providerRecurrence('microsoft', { ...value(), repeat: { cadence: 'monthly', interval: 1, weekdays: [], monthDay: 31, missingDay: 'skip' } }), /month-end/);
});
test('series reads bind the exact original occurrence and verified master instead of guessing from a title', async () => {
  const instance = event('google', 'instance'); instance.recurringEventId = 'master'; instance.originalStartTime = instance.start;
  const master = event('google', 'master'); master.recurrence = ['RRULE:FREQ=WEEKLY;BYDAY=TH'];
  const request: CalendarRequest = async path => path.includes('/instance') ? instance : master;
  const target = { sourceId: 'source', generation: randomUUID(), eventId: 'instance', scope: 'occurrence' as const, seriesId: 'master', originalStart: instance.start.dateTime };
  assert.equal((await readProviderCalendarEvent(request, 'google', 'calendar', target)).event.id, 'instance');
  assert.equal((await readProviderCalendarEvent(request, 'google', 'calendar', { ...target, scope: 'series' })).event.id, 'master');
  await assert.rejects(readProviderCalendarEvent(request, 'google', 'calendar', { ...target, seriesId: 'other' }), /selected series/);
  await assert.rejects(readProviderCalendarEvent(request, 'google', 'calendar', { ...target, scope: 'event' }), /Choose this occurrence/);
});
test('ambiguous recovery, foreign markers and missing conditional versions never establish an accepted save', async () => {
  const id = randomUUID(), digest = 'b'.repeat(64), raw = event('google', 'e3' + id.replaceAll('-', ''));
  assert.equal((await findCalendarOperation(async () => raw, 'google', 'calendar', id, digest)).state, 'different');
  await assert.rejects(findCalendarOperation(async () => ({ value: [event('microsoft'), event('microsoft', 'other')] }), 'microsoft', 'calendar', id, digest), /ambiguous/);
  await assert.rejects(findCalendarOperation(async () => ({ value: [], '@odata.nextLink': 'https://foreign.invalid' }), 'microsoft', 'calendar', id, digest), /incomplete/);
  const microsoft = event('microsoft'); delete microsoft['@odata.etag']; assert.throws(() => inspectProviderEvent('microsoft', microsoft), /conditional-write version/);
});
test('Calendar transport sends the exact bounded provider path and conditional header with no credential redirect', async () => {
  const calls: { url: string; init: RequestInit }[] = [], controller = new AbortController(), providers = new Providers((async (input: any, init: RequestInit = {}) => {
    calls.push({ url: String(input), init }); return new Response(JSON.stringify(event('microsoft')), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch);
  const request = providers.calendarRequest('microsoft', 'fixture-token', controller.signal);
  await request('/calendars/original%2Fcalendar/events/original-event', { method: 'PATCH', headers: { 'If-Match': 'W/"v1"' }, body: '{"subject":"Revised"}' });
  assert.equal(calls[0].url, 'https://graph.microsoft.com/v1.0/me/calendars/original%2Fcalendar/events/original-event'); assert.equal(calls[0].init.redirect, 'error');
  assert.equal(new Headers(calls[0].init.headers).get('If-Match'), 'W/"v1"'); assert.match(new Headers(calls[0].init.headers).get('Prefer')!, /ImmutableId/);
  assert.throws(() => request('//foreign.invalid/event'), /Invalid Calendar/); assert.throws(() => request('/calendars/x/../../me'), /Invalid Calendar/);
});
test('the real HTTP Calendar write flow uses authenticated origin checks and a retained explicit confirmation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'e3-calendar-write-http-')), providerEvents = new Map<string, any>(); let effects = 0;
  const providers = new Providers((async (input: any, init: RequestInit = {}) => {
    const url = new URL(String(input)), method = init.method ?? 'GET';
    if (url.pathname.endsWith('/calendarList')) return Response.json({ kind: 'calendar#calendarList', items: [{ id: 'test-calendar', summary: 'Original Calendar', accessRole: 'owner', timeZone: 'America/Los_Angeles' }] });
    if (url.pathname.endsWith('/calendarList/test-calendar')) return Response.json({ id: 'test-calendar', accessRole: 'owner' });
    if (method === 'POST' && url.pathname.endsWith('/events')) {
      const body = JSON.parse(String(init.body)), result = { ...event('google', body.id), ...body, etag: '"saved"' }; effects++; providerEvents.set(body.id, result); return Response.json(result, { status: 201 });
    }
    throw Error('Unexpected fixture request: ' + method + ' ' + url.pathname);
  }) as typeof fetch);
  const server = await startServer({ directory, port: 0, providers });
  try {
    const session = await fetch(server.origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Edition3-Client': '1' }, body: '{}' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0], snapshot: any = await session.json();
    const generation = randomUUID(), id = 'google-fixture', configuration = { provider: 'google', clientId: 'fixture.apps.googleusercontent.com' };
    const scopes = ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'];
    server.store.internalWrite('accounts:item:' + id, { id, generation, provider: 'google', subject: 'fixture-user', email: 'studio@example.test', label: 'Studio', state: 'connected', scopes, capabilities: { calendarRead: true, calendarWrite: true } });
    server.store.internalWrite('accounts:credential:' + id, { generation, configuration, tokens: { accessToken: 'isolated-fixture', expiresAt: Date.now() + 3600000, scopes } });
    const job = server.calendar.discover(snapshot.deviceId, { requestId: randomUUID(), epoch: server.store.epoch });
    for (let i = 0; i < 100 && server.store.internalRead<any>('calendar:job:' + job.id)?.state === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const state = server.calendar.state(snapshot.deviceId, { from: '2026-09-01', to: '2026-10-01', timezone: 'America/Los_Angeles' });
    assert.equal(state.sources.length, 1);
    const command = { requestId: randomUUID(), epoch: server.store.epoch, writerId: randomUUID(), sourceId: state.sources[0].id, generation, action: 'create', value: value() };
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(server.origin + '/api/calendar/write/' + path, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', 'X-Edition3-Client': '1', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post('prepare', command, { cookie: '' })).status, 401);
    assert.equal((await post('prepare', command, { origin: 'https://foreign.example' })).status, 403);
    assert.equal((await post('prepare', command, { 'X-Edition3-Client': '' })).status, 403);
    const prepared = await post('prepare', command); assert.equal(prepared.status, 200); assert.equal(prepared.headers.get('cache-control'), 'no-store');
    const review: any = await prepared.json(); assert.equal(review.state, 'review'); assert.equal(effects, 0);
    const confirm = { requestId: randomUUID(), epoch: server.store.epoch, operationId: review.id, expectedRevision: review.revision, digest: review.digest, decision: 'confirm' };
    const result: any = await (await post('confirm', confirm)).json(); assert.equal(result.state, 'confirmed'); assert.equal(effects, 1); assert.deepEqual(await (await post('confirm', confirm)).json(), result); assert.equal(effects, 1);
    assert.equal(providerEvents.get(result.event.id).summary, value().title);
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
});
