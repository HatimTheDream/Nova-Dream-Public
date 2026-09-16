import { z } from 'zod';
import type { CalendarEvent, CalendarPage } from '../../packages/domain/calendar.js';
import type { Provider } from '../../packages/domain/accounts.js';
import { dayInZone, localDate } from '../../packages/domain/tasks.js';
import { reminderInstant } from '../../packages/domain/reminders.js';
import { windowsZones } from './windows-zones.js';

const id = z.string().min(1).max(2000), text = z.string().max(10000);
const googleEndpoint = z.object({ date: localDate.optional(), dateTime: z.string().max(100).optional(), timeZone: z.string().max(100).optional() });
const graphEndpoint = z.object({ dateTime: z.string().max(100), timeZone: z.string().max(100) });
const googleEvent = z.object({ id, status: z.enum(['confirmed', 'tentative', 'cancelled']).default('confirmed'), summary: text.optional(), description: text.optional(), location: text.optional(), start: googleEndpoint, end: googleEndpoint, htmlLink: z.string().max(20000).optional(), etag: id.optional(), recurringEventId: id.optional(), originalStartTime: googleEndpoint.optional(), recurrence: z.array(z.string().max(5000)).max(100).optional() });
const graphEvent = z.object({ id, subject: text.nullable().optional(), bodyPreview: text.optional(), location: z.object({ displayName: text.optional() }).optional(), start: graphEndpoint, end: graphEndpoint, isAllDay: z.boolean(), isCancelled: z.boolean().optional(), showAs: z.string().optional(), webLink: z.string().max(20000).optional(), changeKey: id.optional(), seriesMasterId: id.nullable().optional(), originalStart: z.string().max(100).nullable().optional(), originalStartTimeZone: z.string().max(100).optional(), originalEndTimeZone: z.string().max(100).optional() });
export function ianaTimezone(value?: string): string | undefined {
  if (!value) return;
  const mapped = windowsZones[value] ?? value;
  try { return new Intl.DateTimeFormat('en', { timeZone: mapped }).resolvedOptions().timeZone; } catch { return; }
}
function instant(value: string, zone?: string): number {
  const date = value.slice(0, 10); localDate.parse(date);
  if (/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const time = Date.parse(value); if (Number.isFinite(time)) return time;
  }
  if (/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?$/.test(value)) {
    const timezone = ianaTimezone(zone); if (!timezone) throw new Error('Unrecognized event timezone');
    const result = reminderInstant({ date, time: value.slice(11, 16), timezone });
    if (result.instant !== null) return result.instant + Number(value.slice(17)) * 1000;
  }
  throw new Error('Unverified provider event time');
}
function webLink(value: string | undefined, provider: Provider) {
  if (!value) return;
  try { const u = new URL(value); const hosts = provider === 'google' ? ['calendar.google.com', 'www.google.com'] : ['outlook.office.com', 'outlook.office365.com', 'outlook.live.com']; if (u.protocol === 'https:' && !u.username && !u.password && !u.port && hosts.includes(u.hostname)) return u.href; } catch { /* Invalid links are not exposed. */ }
}
export function normalizeProviderEvent(provider: Provider, raw: unknown): CalendarEvent {
  if (provider === 'google') {
    const e = googleEvent.parse(raw); let interval: CalendarEvent['interval'];
    if (e.start.date && e.end.date && !e.start.dateTime && !e.end.dateTime) {
      if (e.end.date <= e.start.date) throw new Error('Invalid all-day interval');
      interval = { kind: 'date', start: e.start.date, end: e.end.date };
    } else if (e.start.dateTime && e.end.dateTime && !e.start.date && !e.end.date) {
      const start = instant(e.start.dateTime, e.start.timeZone), end = instant(e.end.dateTime, e.end.timeZone ?? e.start.timeZone); if (end <= start) throw new Error('Invalid timed interval');
      interval = { kind: 'instant', start: new Date(start).toISOString(), end: new Date(end).toISOString(), ...(ianaTimezone(e.start.timeZone) ? { timezone: ianaTimezone(e.start.timeZone) } : {}) };
    } else throw new Error('Incomplete event interval');
    return { id: e.id, providerId: e.id, title: e.summary || 'Busy', interval, status: e.status, notes: e.description ?? '', location: e.location ?? '', ...(webLink(e.htmlLink, provider) ? { webLink: webLink(e.htmlLink, provider) } : {}), ...(e.etag ? { revisionTag: e.etag } : {}), ...(e.recurringEventId ? { seriesId: e.recurringEventId } : {}), ...(e.originalStartTime ? { originalStart: e.originalStartTime.date ?? e.originalStartTime.dateTime } : {}), ...(e.recurrence ? { recurrence: e.recurrence } : {}), ...(e.start.timeZone ? { originalTimezone: e.start.timeZone } : {}) };
  }
  const e = graphEvent.parse(raw), start = instant(e.start.dateTime, e.start.timeZone), end = instant(e.end.dateTime, e.end.timeZone);
  if (end <= start) throw new Error('Invalid timed interval');
  const zone = ianaTimezone(e.originalStartTimeZone); let interval: CalendarEvent['interval'];
  if (e.isAllDay) {
    // UTC response times may be mid-afternoon for all-day events in another
    // zone. Recover the provider's civil dates, never truncate the UTC strings.
    if (!zone || (e.originalEndTimeZone && ianaTimezone(e.originalEndTimeZone) !== zone)) throw new Error('Unknown all-day timezone');
    const from = dayInZone(zone, start), to = dayInZone(zone, end); if (to <= from) throw new Error('Invalid all-day interval');
    interval = { kind: 'date', start: from, end: to };
  } else interval = { kind: 'instant', start: new Date(start).toISOString(), end: new Date(end).toISOString(), ...(zone ? { timezone: zone } : {}) };
  return { id: e.id, providerId: e.id, title: e.subject || 'Busy', interval, status: e.isCancelled ? 'cancelled' : e.showAs === 'tentative' ? 'tentative' : 'confirmed', notes: e.bodyPreview ?? '', location: e.location?.displayName ?? '', ...(webLink(e.webLink, provider) ? { webLink: webLink(e.webLink, provider) } : {}), ...(e.changeKey ? { revisionTag: e.changeKey } : {}), ...(e.seriesMasterId ? { seriesId: e.seriesMasterId } : {}), ...(e.originalStart ? { originalStart: e.originalStart } : {}), ...(e.originalStartTimeZone ? { originalTimezone: e.originalStartTimeZone } : {}) };
}
export type CalendarGet = (url: string, signal: AbortSignal) => Promise<unknown>;
/** Expanded occurrences for one source and bounded window, not a provider delta cursor. */
export async function readProviderCalendar(get: CalendarGet, provider: Provider, accountSubject: string, calendarId: string, start: string, end: string, signal?: AbortSignal): Promise<CalendarPage> {
  const encoded = encodeURIComponent(calendarId), base = provider === 'google' ? `https://www.googleapis.com/calendar/v3/calendars/${encoded}/events` : `https://graph.microsoft.com/v1.0/me/calendars/${encoded}/calendarView`;
  const first = new URL(base); first.search = new URLSearchParams(provider === 'google' ? { timeMin: start, timeMax: end, singleEvents: 'true', showDeleted: 'false', orderBy: 'startTime', maxResults: '250' } : { startDateTime: start, endDateTime: end, '$top': '250', '$select': 'id,subject,bodyPreview,location,start,end,isAllDay,isCancelled,showAs,webLink,changeKey,seriesMasterId,originalStart,originalStartTimeZone,originalEndTimeZone' }).toString();
  const abort = AbortSignal.any([AbortSignal.timeout(40000), ...(signal ? [signal] : [])]), visited = new Set<string>(), events = new Map<string, CalendarEvent>();
  let url = first.href, pages = 0, skipped = 0, partial = false, message: string | undefined;
  while (url && pages < 8) {
    if (visited.has(url)) { partial = true; message = 'The provider repeated a page. Some events may be missing.'; break; } visited.add(url);
    let raw: unknown;
    try { raw = await get(url, abort); } catch (error) { if (!pages || (error && typeof error === 'object' && 'code' in error && error.code === 'reconnect')) throw error; partial = true; message = 'A later page was unavailable. Previously read events are kept.'; break; }
    const parsed = (provider === 'google' ? z.object({ kind: z.literal('calendar#events'), items: z.array(z.unknown()).max(2500).default([]), nextPageToken: z.string().min(1).max(20000).optional() }) : z.object({ value: z.array(z.unknown()).max(1000), '@odata.nextLink': z.string().min(1).max(30000).optional() })).safeParse(raw);
    if (!parsed.success) { if (!pages) throw new Error('The provider event list could not be verified.'); partial = true; message = 'A later event page could not be verified.'; break; }
    pages++; const page = parsed.data as { items?: unknown[]; value?: unknown[]; nextPageToken?: string; '@odata.nextLink'?: string };
    for (const item of page.items ?? page.value ?? []) { try { const event = normalizeProviderEvent(provider, item); events.set(event.id, event); } catch { skipped++; partial = true; } }
    if (events.size >= 5000) { partial = true; message = 'This calendar window contains more events than can be shown at once.'; break; }
    url = '';
    if (provider === 'google' && page.nextPageToken) { const next = new URL(first); next.searchParams.set('pageToken', page.nextPageToken); url = next.href; }
    if (provider === 'microsoft' && page['@odata.nextLink']) {
      try {
        const next = new URL(page['@odata.nextLink']), paths = [first.pathname, `/v1.0/users/${encodeURIComponent(accountSubject)}/calendars/${encoded}/calendarView`];
        if (next.origin !== first.origin || next.username || next.password || next.hash || !paths.includes(next.pathname)) throw new Error('Unexpected continuation');
        url = next.href;
      } catch { partial = true; message = 'The provider continuation could not be verified. Some events may be missing.'; }
    }
  }
  if (url) { partial = true; message ??= 'More event pages are available. Narrow the date range to read more.'; }
  if (skipped) message = `${skipped} event${skipped === 1 ? '' : 's'} could not be verified. ${message ?? 'Other events remain available.'}`;
  return { events: [...events.values()].slice(0, 5000), coverage: partial ? 'partial' : 'complete', pages, skipped, ...(message ? { message } : {}) };
}
