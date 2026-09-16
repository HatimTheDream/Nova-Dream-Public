import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../../packages/domain/contracts.js';
import { calendarRepeatSchema, type CalendarEvent, type CalendarRepeat, type LocalEventInput } from '../../packages/domain/calendar.js';
import { clockInZone, localEventInterval } from '../../packages/domain/calendar-time.js';
import { dayInZone } from '../../packages/domain/tasks.js';
import { reminderInstant } from '../../packages/domain/reminders.js';
import type { Provider } from '../../packages/domain/accounts.js';
import type { ProviderCalendarPrepare, ProviderCalendarTarget } from '../../packages/domain/calendar-write.js';
import { normalizeProviderEvent, ianaTimezone } from './provider-calendar.js';
import { htmlToText } from './dreamclaw/microsoft-mail.js';
import { ProviderError } from './providers.js';

export type CalendarRequest = (path: string, init?: RequestInit, emptyStatuses?: number[]) => Promise<unknown>;
export const CALENDAR_OPERATION_PROPERTY = 'String {6e051599-7049-43b6-8e11-b8d6ae6e26a4} Name Edition3CalendarOperation';
export const CALENDAR_DIGEST_PROPERTY = 'String {6e051599-7049-43b6-8e11-b8d6ae6e26a4} Name Edition3CalendarDigest';
const propertyQuery = "singleValueExtendedProperties($filter=id eq '" + CALENDAR_OPERATION_PROPERTY + "' or id eq '" + CALENDAR_DIGEST_PROPERTY + "')";
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const weekCodes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const ordinals: Record<number, string> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', [-1]: 'last' };
const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);
export const calendarFingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function fail(message: string): never { throw new ProviderError('invalid_response', message); }
const rawObject = z.object({ id: z.string().min(1).max(2000) }).passthrough();
export type ProviderEventSnapshot = {
  event: CalendarEvent; value: LocalEventInput; raw: Record<string, any>; etag: string; version: string;
  attendees: number; onlineMeeting: boolean; formattedDescription: boolean; repeating: boolean; recurrenceEditable: boolean;
};
export function calendarEventPath(provider: Provider, calendarId: string, eventId?: string) {
  const root = '/calendars/' + encodeURIComponent(calendarId) + '/events';
  return root + (eventId ? '/' + encodeURIComponent(eventId) : '');
}
const extended = (raw: Record<string, any>, id: string) => Array.isArray(raw.singleValueExtendedProperties)
  ? raw.singleValueExtendedProperties.find((item: any) => item?.id === id)?.value : undefined;
export function calendarOperationMarker(provider: Provider, raw: Record<string, any>) {
  return provider === 'google'
    ? { operation: raw.extendedProperties?.private?.edition3Operation, digest: raw.extendedProperties?.private?.edition3Digest }
    : { operation: extended(raw, CALENDAR_OPERATION_PROPERTY), digest: extended(raw, CALENDAR_DIGEST_PROPERTY) };
}
function overlap(instant: string, zone: string) {
  const date = dayInZone(zone, Date.parse(instant)), time = clockInZone(instant, zone);
  const candidates = (['earlier', 'later'] as const).map(side => ({ side, result: reminderInstant({ date, time, timezone: zone, overlap: side }) }));
  const target = Math.floor(Date.parse(instant) / 60000) * 60000;
  const candidate = candidates.find(item => item.result.instant === target);
  if (!candidate) fail('This event clock cannot be represented without changing its time. Open it in its provider.');
  return { date, time, ...(candidates[0].result.instant !== candidates[1].result.instant ? { overlap: candidate.side } : {}) };
}
/** Only patterns the original editor can represent are projected. Other provider
 * patterns remain in the full snapshot and survive unrelated field edits. */
function readRepeat(provider: Provider, raw: any, value: LocalEventInput): CalendarRepeat | undefined {
  let result: any;
  if (provider === 'google') {
    if (!Array.isArray(raw.recurrence) || raw.recurrence.length !== 1 || !/^RRULE:/.test(raw.recurrence[0])) return;
    const pieces = raw.recurrence[0].slice(6).split(';').map((part: string) => part.split('='));
    if (pieces.some((part: string[]) => part.length !== 2) || new Set(pieces.map((part: string[]) => part[0])).size !== pieces.length) return;
    const fields = Object.fromEntries(pieces);
    if (Object.keys(fields).some(key => !['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'COUNT', 'UNTIL', 'WKST'].includes(key))) return;
    const cadence = String(fields.FREQ).toLowerCase();
    if (!['daily', 'weekly', 'monthly', 'yearly'].includes(cadence) || fields.WKST && fields.WKST !== 'MO') return;
    result = { cadence, interval: Number(fields.INTERVAL ?? 1), weekdays: [] };
    if (cadence === 'weekly') {
      result.weekdays = fields.BYDAY ? fields.BYDAY.split(',').map((day: string) => weekCodes.indexOf(day)) : [new Date(value.start.date + 'T12:00:00Z').getUTCDay()];
      if (result.weekdays.some((day: number) => day < 0)) return;
    } else if (fields.BYDAY) {
      const match = /^(-1|[1-5])(SU|MO|TU|WE|TH|FR|SA)$/.exec(fields.BYDAY);
      if (!match || !['monthly', 'yearly'].includes(cadence)) return;
      result.monthPattern = 'weekday'; result.ordinal = Number(match[1]); result.weekday = weekCodes.indexOf(match[2]);
    }
    if (fields.BYMONTHDAY) { if (!/^\d{1,2}$/.test(fields.BYMONTHDAY)) return; result.monthDay = Number(fields.BYMONTHDAY); }
    if (fields.BYMONTH) { if (!/^\d{1,2}$/.test(fields.BYMONTH)) return; result.month = Number(fields.BYMONTH); }
    if (['monthly', 'yearly'].includes(cadence)) {
      result.monthPattern ??= 'date'; result.monthDay ??= Number(value.start.date.slice(8)); result.missingDay = 'skip';
      if (cadence === 'yearly') result.month ??= Number(value.start.date.slice(5, 7));
    }
    if (fields.COUNT) result.count = Number(fields.COUNT);
    if (fields.UNTIL) {
      if (/^\d{8}$/.test(fields.UNTIL)) result.endsOn = fields.UNTIL.slice(0, 4) + '-' + fields.UNTIL.slice(4, 6) + '-' + fields.UNTIL.slice(6, 8);
      else return; // An instant-based boundary is kept exactly unless explicitly replaced.
    }
  } else {
    const pattern = raw.recurrence?.pattern, range = raw.recurrence?.range;
    if (!pattern || !range || range.startDate !== value.start.date || range.recurrenceTimeZone && ianaTimezone(range.recurrenceTimeZone) !== value.timezone) return;
    const cadence = ({ daily: 'daily', weekly: 'weekly', absoluteMonthly: 'monthly', relativeMonthly: 'monthly', absoluteYearly: 'yearly', relativeYearly: 'yearly' } as Record<string, string>)[pattern.type];
    if (!cadence) return;
    result = { cadence, interval: pattern.interval, weekdays: [] };
    if (cadence === 'weekly') { if (pattern.firstDayOfWeek && pattern.firstDayOfWeek !== 'monday') return; result.weekdays = pattern.daysOfWeek?.map((day: string) => weekdays.indexOf(day)) ?? []; }
    if (pattern.type.startsWith('relative')) {
      if (pattern.daysOfWeek?.length !== 1) return;
      result.monthPattern = 'weekday'; result.ordinal = Number(Object.keys(ordinals).find(key => ordinals[Number(key)] === pattern.index)); result.weekday = weekdays.indexOf(pattern.daysOfWeek[0]);
    } else if (cadence === 'monthly' || cadence === 'yearly') {
      // Keep provider-owned month-end semantics exact; do not relabel them as
      // the local skip/last-day policy without a matching representation.
      if (pattern.dayOfMonth > 28) return;
      result.monthPattern = 'date'; result.monthDay = pattern.dayOfMonth; result.missingDay = 'skip';
    }
    if (cadence === 'yearly') result.month = pattern.month;
    if (range.type === 'endDate') result.endsOn = range.endDate;
    else if (range.type === 'numbered') result.count = range.numberOfOccurrences;
    else if (range.type !== 'noEnd') return;
  }
  const parsed = calendarRepeatSchema.safeParse(result); return parsed.success ? parsed.data : undefined;
}
export function inspectProviderEvent(provider: Provider, raw: unknown, expectedId?: string): ProviderEventSnapshot {
  const parsed = rawObject.safeParse(raw); if (!parsed.success) fail('The provider event could not be verified.');
  const source = parsed.data as Record<string, any>;
  if (expectedId && source.id !== expectedId) fail('The provider returned a different Calendar event.');
  const event = normalizeProviderEvent(provider, source);
  const version = provider === 'google' ? source.etag : source.changeKey;
  const etag = provider === 'google' ? source.etag : source['@odata.etag'];
  if (typeof version !== 'string' || !version || typeof etag !== 'string' || !/^(?:W\/)?"[^"\r\n]+"$/.test(etag)) fail('The event has no verified conditional-write version. Refresh it before editing.');
  const zone = ianaTimezone(provider === 'google' ? source.start?.timeZone : source.originalStartTimeZone ?? source.start?.timeZone);
  if (!zone && event.interval.kind !== 'date') fail('The original event timezone is unavailable. Review it in its provider.');
  const timezone = zone ?? 'UTC';
  const description = provider === 'google' ? source.description ?? '' : source.body?.content;
  if (typeof description !== 'string') fail('The complete event description was not returned. Refresh before editing.');
  const formattedDescription = provider === 'google' ? /<\/?[a-z][\s\S]*>/i.test(description) : String(source.body?.contentType).toLowerCase() === 'html';
  const notes = formattedDescription ? htmlToText(description) : description;
  if (notes.length > 10000) fail('This event description exceeds the editor limit. Its complete content stays in the provider.');
  const value: LocalEventInput = {
    title: event.title, notes, location: event.location, timezone, allDay: event.interval.kind === 'date',
    start: event.interval.kind === 'date' ? { date: event.interval.start, time: '00:00' } : overlap(event.interval.start, timezone),
    end: event.interval.kind === 'date' ? { date: event.interval.end, time: '00:00' } : overlap(event.interval.end, timezone),
    state: event.status === 'cancelled' ? 'cancelled' : 'confirmed', projectId: null, taskId: null, category: 'other',
    reminderMinutes: provider === 'google' ? source.reminders?.overrides?.find((item: any) => item.method === 'popup')?.minutes ?? 0 : source.isReminderOn ? source.reminderMinutesBeforeStart ?? 0 : 0,
    deliveryChannel: 'last',
  };
  const repeat = readRepeat(provider, source, value); if (repeat) value.repeat = repeat;
  const repeating = provider === 'google' ? Boolean(source.recurringEventId || source.recurrence?.length) : source.type === 'seriesMaster' || Boolean(source.seriesMasterId || source.recurrence);
  if (!Array.isArray(source.attendees ?? [])) fail('This event guest list could not be verified.');
  return { event, value, raw: source, etag, version, attendees: (source.attendees ?? []).length,
    onlineMeeting: provider === 'google' ? Boolean(source.conferenceData || source.hangoutLink) : Boolean(source.isOnlineMeeting || source.onlineMeeting),
    formattedDescription, repeating, recurrenceEditable: !repeating || Boolean(repeat) };
}
export async function readProviderCalendarEvent(request: CalendarRequest, provider: Provider, calendarId: string, target: ProviderCalendarTarget) {
  const read = async (id: string) => inspectProviderEvent(provider, await request(calendarEventPath(provider, calendarId, id) + (provider === 'microsoft' ? '?' + new URLSearchParams({ '$expand': propertyQuery }) : '')), id);
  const selected = await read(target.eventId);
  const seriesId = provider === 'google' ? selected.raw.recurringEventId : selected.raw.seriesMasterId;
  const isMaster = provider === 'google' ? Boolean(selected.raw.recurrence?.length) : selected.raw.type === 'seriesMaster';
  if (target.scope === 'event' && (seriesId || isMaster)) fail('Choose this occurrence or the entire series before editing a repeating event.');
  if (target.scope === 'occurrence') {
    if (!seriesId || seriesId !== target.seriesId || !target.originalStart || selected.event.originalStart !== target.originalStart) fail('This occurrence no longer matches the selected series and original time.');
  }
  if (target.scope === 'series') {
    if (seriesId) {
      if (target.seriesId !== seriesId) fail('This occurrence belongs to a different series.');
      const master = await read(seriesId);
      if (provider === 'google' ? !master.raw.recurrence?.length : master.raw.type !== 'seriesMaster') fail('The series master could not be verified.');
      return master;
    }
    if (!isMaster || target.seriesId && target.seriesId !== selected.event.id) fail('This selected event is not a series master.');
  }
  return selected;
}
export async function verifyCalendarReadAccess(request: CalendarRequest, provider: Provider, calendarId: string) {
  const path = provider === 'google' ? '/users/me/calendarList/' + encodeURIComponent(calendarId) : '/calendars/' + encodeURIComponent(calendarId) + '?$select=id,name,canEdit';
  const value: any = await request(path);
  if (value?.id !== calendarId) fail('The provider returned another Calendar destination.');
  if (provider === 'google' && !['owner', 'writer', 'reader'].includes(value.accessRole)) throw new ProviderError('permission', 'Calendar event access is unavailable. Reconnect the original account and review its permissions.');
  return { providerCanWrite: provider === 'google' ? ['owner', 'writer'].includes(value.accessRole) : value.canEdit === true };
}
export async function verifyCalendarWriteAccess(request: CalendarRequest, provider: Provider, calendarId: string) {
  if (!(await verifyCalendarReadAccess(request, provider, calendarId)).providerCanWrite) throw new ProviderError('permission', 'This Calendar is read-only. Keep the draft and choose a writable Calendar.');
}
export function providerRecurrence(provider: Provider, value: LocalEventInput) {
  const repeat = value.repeat; if (!repeat) return provider === 'google' ? [] : null;
  const day = repeat.monthDay ?? Number(value.start.date.slice(8)), month = repeat.month ?? Number(value.start.date.slice(5, 7));
  if (provider === 'google') {
    const rule = ['FREQ=' + repeat.cadence.toUpperCase(), 'INTERVAL=' + repeat.interval, 'WKST=MO'];
    if (repeat.cadence === 'weekly') rule.push('BYDAY=' + repeat.weekdays.map(day => weekCodes[day]).join(','));
    if (repeat.cadence === 'monthly' || repeat.cadence === 'yearly') {
      if (repeat.monthPattern === 'weekday') rule.push('BYDAY=' + repeat.ordinal + weekCodes[repeat.weekday!]);
      else if (repeat.missingDay === 'last-day' && day > 28) rule.push('BYMONTHDAY=' + day + ',-1', 'BYSETPOS=1');
      else rule.push('BYMONTHDAY=' + day);
      if (repeat.cadence === 'yearly') rule.push('BYMONTH=' + month);
    }
    if (repeat.count) rule.push('COUNT=' + repeat.count);
    if (repeat.endsOn) {
      if (value.allDay) rule.push('UNTIL=' + repeat.endsOn.replaceAll('-', ''));
      else {
        const end = reminderInstant({ date: repeat.endsOn, time: '23:59', timezone: value.timezone, overlap: 'later' });
        if (end.instant === null) fail('Choose a recurrence end date with a valid final clock time.');
        rule.push('UNTIL=' + new Date(end.instant).toISOString().replace(/[-:]/g, '').replace('.000Z', 'Z'));
      }
    }
    return ['RRULE:' + rule.join(';')];
  }
  let pattern: Record<string, unknown> = { type: repeat.cadence, interval: repeat.interval };
  if (repeat.cadence === 'weekly') Object.assign(pattern, { daysOfWeek: repeat.weekdays.map(day => weekdays[day]), firstDayOfWeek: 'monday' });
  if (repeat.cadence === 'monthly' || repeat.cadence === 'yearly') {
    const relative = repeat.monthPattern === 'weekday';
    if (relative && !ordinals[repeat.ordinal!]) fail('Outlook supports first through fourth or last weekday. Choose one of those patterns.');
    if (!relative && day > 28) fail('Review this month-end pattern in Outlook before saving; the local missing-day policy has no verified equivalent.');
    pattern = { type: (relative ? 'relative' : 'absolute') + (repeat.cadence === 'monthly' ? 'Monthly' : 'Yearly'), interval: repeat.interval,
      ...(relative ? { index: ordinals[repeat.ordinal!], daysOfWeek: [weekdays[repeat.weekday!]] } : { dayOfMonth: day }),
      ...(repeat.cadence === 'yearly' ? { month } : {}) };
  }
  return { pattern, range: { startDate: value.start.date, recurrenceTimeZone: value.timezone,
    ...(repeat.count ? { type: 'numbered', numberOfOccurrences: repeat.count } : repeat.endsOn ? { type: 'endDate', endDate: repeat.endsOn } : { type: 'noEnd' }) } };
}
export type CalendarProviderPlan = { path: string; method: 'POST' | 'PATCH' | 'DELETE'; body?: Record<string, unknown>; etag?: string; eventId?: string; changes: string[]; warnings: string[] };
/** Patch changed fields only; guests, meeting metadata, rich descriptions,
 * reminders and unsupported repeat patterns survive unrelated edits. */
export function planProviderCalendarWrite(provider: Provider, calendarId: string, input: ProviderCalendarPrepare, operationId: string, digest: string, previous?: ProviderEventSnapshot): CalendarProviderPlan {
  const create = input.action === 'create', changes: string[] = [], warnings: string[] = [];
  if (!create && !previous) fail('Open the original event before preparing its change.');
  if (previous && input.expectedVersion !== previous.version) fail('The event changed after it was opened. Review the current event and your kept proposal.');
  const eventId = previous?.event.id ?? (provider === 'google' ? 'e3' + operationId.replaceAll('-', '') : undefined);
  const path = calendarEventPath(provider, calendarId, create ? undefined : eventId) + (provider === 'google' ? '?sendUpdates=all' : '');
  if (previous?.attendees) warnings.push('The provider may notify ' + previous.attendees + ' existing guests about this change.');
  if (input.target?.scope === 'series') warnings.push('This change applies to the entire recurring series, including provider-managed exceptions.');
  if (input.action === 'delete') return { path, method: 'DELETE', eventId, etag: previous!.etag, changes: ['Delete ' + (input.target?.scope === 'series' ? 'the entire series' : 'this event')], warnings };
  const value = input.value!, timing = localEventInterval(value);
  if (!timing.interval) fail(timing.error!);
  const changed = (keys: (keyof LocalEventInput)[]) => create || keys.some(key => !same(value[key], previous!.value[key]));
  const body: Record<string, unknown> = {};
  if (changed(['category', 'projectId', 'taskId'])) changes.push('Nova Dream organization');
  if (value.deliveryChannel && value.deliveryChannel !== 'last') fail('Provider reminders use the connected Calendar. External reminder channels are not connected here.');
  if (!create && changed(['state'])) fail('Use the original Delete action to review cancellation or deletion in this provider.');
  if (changed(['title'])) { body[provider === 'google' ? 'summary' : 'subject'] = value.title; changes.push('Title'); }
  if (changed(['location'])) { body.location = provider === 'google' ? value.location : { displayName: value.location }; changes.push('Location'); }
  if (changed(['notes'])) {
    if (previous?.formattedDescription && !input.replaceDescription) fail('Review replacing the formatted description before changing its text.');
    if (previous?.onlineMeeting) fail('This description contains online-meeting details. Edit its notes in the provider to preserve the meeting connection.');
    body[provider === 'google' ? 'description' : 'body'] = provider === 'google' ? value.notes : { contentType: 'text', content: value.notes }; changes.push('Description');
    if (previous?.formattedDescription) warnings.push('The formatted description will be replaced with the reviewed plain text.');
  }
  if (changed(['start', 'end', 'allDay', 'timezone'])) {
    if (provider === 'google') {
      body.start = timing.interval.kind === 'date' ? { date: value.start.date } : { dateTime: timing.interval.start, timeZone: value.timezone };
      body.end = timing.interval.kind === 'date' ? { date: value.end.date } : { dateTime: timing.interval.end, timeZone: value.timezone };
    } else {
      body.isAllDay = value.allDay;
      body.start = { dateTime: value.start.date + 'T' + (value.allDay ? '00:00' : value.start.time) + ':00', timeZone: value.timezone };
      body.end = { dateTime: value.end.date + 'T' + (value.allDay ? '00:00' : value.end.time) + ':00', timeZone: value.timezone };
      if (!value.allDay && (value.start.overlap || value.end.overlap)) fail('Outlook cannot express this repeated wall time unambiguously through this edit. Choose an unambiguous time.');
    }
    changes.push('Date and time');
  }
  if (input.replaceReminder || changed(['reminderMinutes', 'allDayReminder'])) {
    if (value.allDayReminder) fail('This all-day host reminder must be planned separately from the provider reminder.');
    const minutes = value.reminderMinutes ?? 0;
    if (provider === 'google') body.reminders = { useDefault: false, overrides: minutes ? [{ method: 'popup', minutes }] : [] };
    else Object.assign(body, { isReminderOn: minutes > 0, reminderMinutesBeforeStart: minutes });
    changes.push('Reminder');
  }
  if (create || input.replaceRecurrence || changed(['repeat'])) {
    if (input.target?.scope === 'occurrence' && value.repeat) fail('A single occurrence cannot replace its series pattern.');
    if (previous?.repeating && !previous.recurrenceEditable && !input.replaceRecurrence) fail('Explicitly review replacing this provider repeat pattern.');
    if (input.target?.scope !== 'occurrence') { body.recurrence = providerRecurrence(provider, value); changes.push('Repeat pattern'); }
  }
  if (create && provider === 'google') body.id = eventId;
  if (create && provider === 'microsoft') body.transactionId = operationId;
  if (!create && !changes.length) fail('There are no provider event changes to save.');
  if (provider === 'google') body.extendedProperties = { private: { ...previous?.raw.extendedProperties?.private, edition3Operation: operationId, edition3Digest: digest } };
  else body.singleValueExtendedProperties = [{ id: CALENDAR_OPERATION_PROPERTY, value: operationId }, { id: CALENDAR_DIGEST_PROPERTY, value: digest }];
  return { path, method: create ? 'POST' : 'PATCH', body, etag: previous?.etag, eventId, changes, warnings };
}
export async function applyProviderCalendarPlan(request: CalendarRequest, provider: Provider, plan: CalendarProviderPlan) {
  const raw = await request(plan.path, { method: plan.method, ...(plan.etag ? { headers: { 'If-Match': plan.etag } } : {}), ...(plan.body ? { body: JSON.stringify(plan.body) } : {}) }, plan.method === 'DELETE' ? [204] : []);
  return plan.method === 'DELETE' ? undefined : inspectProviderEvent(provider, raw, plan.eventId);
}
export async function findCalendarOperation(request: CalendarRequest, provider: Provider, calendarId: string, operationId: string, digest: string, eventId?: string) {
  let raw: any;
  if (provider === 'google' || eventId) {
    const id = eventId ?? 'e3' + operationId.replaceAll('-', '');
    try { raw = await request(calendarEventPath(provider, calendarId, id) + (provider === 'microsoft' ? '?' + new URLSearchParams({ '$expand': propertyQuery }) : '')); }
    catch (error) { if (error instanceof ProviderError && error.code === 'not_found') return { state: 'absent' as const }; throw error; }
    if (raw?.id !== id) fail('The recovery read returned a different event.');
  } else {
    const query = new URLSearchParams({ '$filter': "singleValueExtendedProperties/any(ep: ep/id eq '" + CALENDAR_OPERATION_PROPERTY + "' and ep/value eq '" + z.uuid().parse(operationId) + "')", '$expand': propertyQuery, '$top': '2' });
    const result: any = await request(calendarEventPath(provider, calendarId) + '?' + query);
    if (!Array.isArray(result?.value) || result['@odata.nextLink'] || result.value.length > 1) fail('The Calendar recovery result is incomplete or ambiguous. Keep this operation for review.');
    if (!result.value.length) return { state: 'absent' as const };
    raw = result.value[0];
  }
  const marker = calendarOperationMarker(provider, raw);
  if (marker.operation !== operationId || marker.digest !== digest) return { state: 'different' as const };
  return { state: 'observed' as const, snapshot: inspectProviderEvent(provider, raw) };
}

/** A deleted Google event may remain as a minimal cancellation record. An
 * absent item alone is insufficient: 404 can also hide a lost Calendar ACL. */
export async function findCalendarDeletion(request: CalendarRequest, provider: Provider, calendarId: string, eventId: string) {
  let absent = false;
  try {
    const raw: any = await request(calendarEventPath(provider, calendarId, eventId));
    if (raw?.id !== eventId) fail('The recovery read returned a different event.');
    absent = provider === 'google' && raw.status === 'cancelled';
  } catch (error) {
    if (error instanceof ProviderError && (error.code === 'not_found' || provider === 'google' && error.responseStatus === 410)) absent = true;
    else throw error;
  }
  if (absent) await verifyCalendarReadAccess(request, provider, calendarId);
  return { state: absent ? 'absent' as const : 'present' as const };
}
