import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProviderEvent, readProviderCalendar, ianaTimezone } from '../apps/service/provider-calendar.js';
import { Providers, ProviderError } from '../apps/service/providers.js';
import { calendarWindow, calendarRangeSchema } from '../packages/domain/calendar.js';
const google = { id: 'g-event', summary: 'Planning', start: { dateTime: '2026-09-08T09:00:00-07:00', timeZone: 'America/Los_Angeles' }, end: { dateTime: '2026-09-08T10:00:00-07:00' }, etag: 'etag-one', recurringEventId: 'series-one', originalStartTime: { dateTime: '2026-09-08T09:00:00-07:00' } };
const graph = { id: 'm-event', subject: 'Planning', start: { dateTime: '2026-11-01T07:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-02T08:00:00.0000000', timeZone: 'UTC' }, isAllDay: true, originalStartTimeZone: 'Pacific Standard Time', originalEndTimeZone: 'Pacific Standard Time', changeKey: 'change-one', seriesMasterId: 'series-two' };

test('Google timed instances retain instant, series and revision identity; all-day dates remain exclusive civil intervals', () => {
  const e = normalizeProviderEvent('google', google); assert.deepEqual(e.interval, { kind: 'instant', start: '2026-09-08T16:00:00.000Z', end: '2026-09-08T17:00:00.000Z', timezone: 'America/Los_Angeles' }); assert.equal(e.seriesId, 'series-one'); assert.equal(e.revisionTag, 'etag-one');
  const allDay = normalizeProviderEvent('google', { id: 'trip', start: { date: '2026-09-08' }, end: { date: '2026-09-11' }, description: '<script>fixture</script>' });
  assert.deepEqual(allDay.interval, { kind: 'date', start: '2026-09-08', end: '2026-09-11' }); assert.equal(allDay.notes, '<script>fixture</script>');
  assert.throws(() => normalizeProviderEvent('google', { ...google, start: { dateTime: '2026-09-08T24:00:00Z' } }));
  assert.throws(() => normalizeProviderEvent('google', { ...google, start: { dateTime: '2026-11-01T01:30:00', timeZone: 'America/Los_Angeles' } }));
});
test('Graph all-day normalization uses original Windows timezone across a 25-hour day and rejects unknown custom zones', () => {
  const e = normalizeProviderEvent('microsoft', graph); assert.deepEqual(e.interval, { kind: 'date', start: '2026-11-01', end: '2026-11-02' }); assert.equal(e.revisionTag, 'change-one'); assert.equal(e.seriesId, 'series-two'); assert.equal(ianaTimezone('Nepal Standard Time'), 'Asia/Katmandu');
  assert.throws(() => normalizeProviderEvent('microsoft', { ...graph, originalStartTimeZone: 'tzone://Microsoft/Custom' }));
  const timed = normalizeProviderEvent('microsoft', { ...graph, isAllDay: false }); assert.equal(timed.interval.kind, 'instant');
});
test('Google pagination retains valid rows and explicitly reports malformed rows without claiming complete coverage', async () => {
  const seen: URL[] = [];
  const page = await readProviderCalendar(async url => { const u = new URL(url); seen.push(u); return u.searchParams.has('pageToken') ? { kind: 'calendar#events', items: [{ ...google, id: 'second' }] } : { kind: 'calendar#events', items: [google, { id: 'bad' }], nextPageToken: 'opaque-next' }; }, 'google', 'subject', 'private/calendar', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z');
  assert.equal(page.events.length, 2); assert.equal(page.pages, 2); assert.equal(page.skipped, 1); assert.equal(page.coverage, 'partial'); assert.equal(seen[0].searchParams.get('singleEvents'), 'true'); assert.equal(seen[0].searchParams.get('orderBy'), 'startTime'); assert.ok(seen[0].pathname.includes('private%2Fcalendar')); assert.equal(seen[1].searchParams.get('timeMin'), seen[0].searchParams.get('timeMin'));
});
test('Graph event reads request immutable IDs and UTC response times, with verified same-source continuation', async () => {
  const seen: { url: string; headers: Headers }[] = [];
  const providers = new Providers((async (input, init) => { const url = String(input); seen.push({ url, headers: new Headers(init?.headers) }); return new Response(JSON.stringify(url.includes('$skiptoken=') ? { value: [{ ...graph, id: 'second' }] } : { value: [graph], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users/subject/calendars/cal/calendarView?$skiptoken=opaque' })); }) as typeof fetch);
  const page = await providers.calendarEvents('microsoft', 'fixture-token', 'subject', 'cal', '2026-11-01T00:00:00Z', '2026-11-08T00:00:00Z');
  assert.equal(page.coverage, 'complete'); assert.equal(page.events.length, 2); assert.ok(seen.every(r => r.headers.get('prefer') === 'IdType="ImmutableId", outlook.timezone="UTC"')); assert.ok(seen.every(r => r.headers.get('authorization') === 'Bearer fixture-token'));
});
test('hostile or cross-source Graph continuation never receives another provider request', async () => {
  for (const next of ['https://evil.example/v1.0/me/calendars/cal/calendarView', 'https://graph.microsoft.com/v1.0/me/calendars/other/calendarView', 'https://user@graph.microsoft.com/v1.0/me/calendars/cal/calendarView', 'https://graph.microsoft.com/v1.0/me/messages']) {
    let calls = 0; const page = await readProviderCalendar(async () => { calls++; return { value: [graph], '@odata.nextLink': next }; }, 'microsoft', 'subject', 'cal', '2026-11-01T00:00:00Z', '2026-11-08T00:00:00Z'); assert.equal(calls, 1); assert.equal(page.coverage, 'partial'); assert.equal(page.events.length, 1);
  }
});
test('repeated pages stop, later transport failures remain partial, and lost authorization propagates for reconnect', async () => {
  let calls = 0; const repeated = await readProviderCalendar(async () => { calls++; return { kind: 'calendar#events', items: [google], nextPageToken: 'same' }; }, 'google', 'subject', 'cal', '2026-09-01T00:00:00Z', '2026-09-08T00:00:00Z'); assert.equal(calls, 2); assert.equal(repeated.coverage, 'partial');
  for (const reconnect of [false, true]) {
    let count = 0; const read = () => readProviderCalendar(async () => { if (count++) throw new ProviderError(reconnect ? 'reconnect' : 'unavailable', 'Sanitized fixture'); return { kind: 'calendar#events', items: [google], nextPageToken: 'next' }; }, 'google', 'subject', 'cal', '2026-09-01T00:00:00Z', '2026-09-08T00:00:00Z');
    if (reconnect) await assert.rejects(read, { code: 'reconnect' }); else assert.equal((await read()).coverage, 'partial');
  }
});
test('calendar navigation uses stable Gregorian dates and bounded read windows', () => {
  assert.deepEqual(calendarWindow('2026-09-08', 'week'), { from: '2026-09-07', to: '2026-09-14' }); assert.deepEqual(calendarWindow('2026-09-08', 'month'), { from: '2026-08-31', to: '2026-10-12' });
  assert.equal(calendarRangeSchema.safeParse({ from: '2026-02-30', to: '2026-03-01', timezone: 'UTC' }).success, false); assert.equal(calendarRangeSchema.safeParse({ from: '2026-01-01', to: '2026-12-01', timezone: 'UTC' }).success, false);
});

test('local calendar timing rejects gaps, requires a repeated-time choice, and preserves exclusive all-day dates', async () => {
  const { localEventInterval, dayStart, overlapsRange } = await import('../packages/domain/calendar-time.js');
  const event = { title: 'Local fixture', notes: '', location: '', timezone: 'America/Los_Angeles', allDay: false, start: { date: '2026-11-01', time: '01:30' }, end: { date: '2026-11-01', time: '02:30' }, state: 'confirmed' as const, projectId: null, taskId: null };
  assert.match(localEventInterval(event).error!, /occurs twice/);
  const early = localEventInterval({ ...event, start: { ...event.start, overlap: 'earlier' as const } }).interval!, late = localEventInterval({ ...event, start: { ...event.start, overlap: 'later' as const } }).interval!;
  assert.equal(Date.parse(late.start) - Date.parse(early.start), 3600000);
  assert.match(localEventInterval({ ...event, start: { date: '2026-03-08', time: '02:30' }, end: { date: '2026-03-08', time: '04:00' } }).error!, /does not exist/);
  assert.equal(dayStart('2026-11-02', event.timezone) - dayStart('2026-11-01', event.timezone), 25 * 3600000);
  assert.equal(dayStart('2011-12-30', 'Pacific/Apia'), dayStart('2011-12-31', 'Pacific/Apia'));
  assert.equal(overlapsRange({ kind: 'date', start: '2026-09-08', end: '2026-09-09' }, { from: '2026-09-09', to: '2026-09-10', timezone: 'Asia/Tokyo' }), false);
});

test('day placement separates repeated hours and allocates overlap columns without colliding short controls', async () => {
  const { dayEventLayout } = await import('../packages/domain/calendar-layout.js');
  const start = Date.parse('2026-11-01T07:00:00Z'), end = Date.parse('2026-11-02T08:00:00Z');
  const event = (id: string, from: string, to: string) => ({ id, sourceId: 'local', title: id, notes: '', location: '', status: 'confirmed' as const, interval: { kind: 'instant' as const, start: from, end: to } });
  const rows = dayEventLayout([event('early','2026-11-01T08:30:00Z','2026-11-01T08:35:00Z'),event('late','2026-11-01T09:30:00Z','2026-11-01T09:35:00Z'),event('overlap','2026-11-01T08:32:00Z','2026-11-01T08:34:00Z')], start, end);
  assert.equal(rows.find(r => r.event.id === 'late')!.top - rows.find(r => r.event.id === 'early')!.top, 64);
  assert.equal(rows.find(r => r.event.id === 'early')!.columns, 2); assert.equal(rows.find(r => r.event.id === 'late')!.columns, 1);
  assert.ok(rows.every(r => r.height >= 44));
});

test('Graph single appointments with a null recurring-original start remain valid events', async () => {
  const appointment = { ...graph, isAllDay: false, seriesMasterId: null, originalStart: null };
  const event = normalizeProviderEvent('microsoft', appointment);
  assert.equal(event.interval.kind, 'instant'); assert.equal(event.seriesId, undefined); assert.equal(event.originalStart, undefined);
  const page = await readProviderCalendar(async () => ({ value: [appointment] }), 'microsoft', 'subject', 'cal', '2026-11-01T00:00:00Z', '2026-11-08T00:00:00Z');
  assert.equal(page.coverage, 'complete'); assert.equal(page.skipped, 0); assert.equal(page.events.length, 1);
  assert.throws(() => normalizeProviderEvent('microsoft', { ...appointment, start: null }));
});
