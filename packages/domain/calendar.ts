import { z } from 'zod';
import type { CalendarReminderState } from './calendar-reminders.js';
export const allDayReminderSchema = z.object({ daysBefore: z.number().int().min(0).max(28), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), overlap: z.enum(['earlier', 'later']).optional() }).strict();
import { localDate, timezone } from './tasks.js';
import type { Provider } from './accounts.js';

export const calendarRangeSchema = z.object({ from: localDate, to: localDate, timezone }).strict().refine(v => v.to > v.from && Date.parse(v.to) - Date.parse(v.from) <= 62 * 86400000, 'Choose a calendar window of at most 62 days.');
export type CalendarRange = z.infer<typeof calendarRangeSchema>;
export type EventInterval = { kind: 'date'; start: string; end: string } | { kind: 'instant'; start: string; end: string; timezone?: string };
export type CalendarEvent = {
  id: string; title: string; interval: EventInterval; status: 'confirmed' | 'tentative' | 'cancelled';
  notes: string; location: string; webLink?: string; providerId?: string; seriesId?: string; originalStart?: string;
  revisionTag?: string; recurrence?: string[]; originalTimezone?: string;
  workspaceCategory?: 'work' | 'personal' | 'health' | 'social' | 'education' | 'other';
};
export type CalendarPage = { events: CalendarEvent[]; coverage: 'complete' | 'partial'; pages: number; skipped: number; message?: string };
export type CalendarSourceRef = { id: string; accountId: string; generation: string; provider: Provider; calendarId: string; name: string; accountLabel: string; timezone?: string; primary: boolean; providerCanWrite: boolean; accountCanWrite?: boolean };
export type CalendarCache = { sourceId: string; generation: string; range: CalendarRange; events: CalendarEvent[]; coverage: 'complete' | 'partial'; checkedAt: string; lastCompleteAt?: string; message?: string };
export type CalendarSelection = { revision: number; sourceIds: string[]; showLocal: boolean; showTasks: boolean };
export type CalendarSourceState = CalendarSourceRef & { selected: boolean; state: 'ready' | 'refreshing' | 'stale' | 'unavailable'; message?: string; cache?: Omit<CalendarCache, 'events'> };
export const calendarSelectionSchema = z.object({ requestId: z.uuid(), epoch: z.uuid(), expectedRevision: z.number().int().nonnegative(), sourceIds: z.array(z.string().min(1).max(100)).max(50).refine(ids => new Set(ids).size === ids.length), showLocal: z.boolean(), showTasks: z.boolean() }).strict();
export const calendarRefreshSchema = z.object({ requestId: z.uuid(), epoch: z.uuid(), range: calendarRangeSchema, sourceIds: z.array(z.string().min(1).max(100)).max(50).refine(ids => new Set(ids).size === ids.length) }).strict();
export type CalendarJob = { id: string; deviceId: string; kind: 'sources' | 'events'; range?: CalendarRange; state: 'running' | 'completed' | 'partial' | 'interrupted'; startedAt: string; sources: { id: string; generation: string; state: 'waiting' | 'running' | 'completed' | 'partial' | 'failed'; message?: string }[] };
export type LocalCalendarEvent = { id: string; deviceId: string; revision: number; updatedAt: string; value: LocalEventInput; isSeries?: boolean; exceptionsRevision?: number };
export type CalendarException = { id: string; eventId: string; originalDate: string; revision: number; updatedAt: string; deviceId: string; retired: boolean; value: LocalEventInput };
export type LocalCalendarOccurrence = LocalCalendarEvent & { eventId: string; originalDate?: string; overrideRevision: number; series?: LocalCalendarEvent; problem?: string; excluded?: boolean; cancelledBySeries?: boolean };
export type LocalCalendarDetail = { mailSource?: import('./calendar-followups.js').MailCalendarSource; epoch: string; event: LocalCalendarEvent; occurrence?: LocalCalendarOccurrence; exceptionCount: number; exceptions: { originalDate: string; start: LocalEventInput['start']; title: string; state: LocalEventInput['state'] }[] };
export const calendarRepeatSchema = z.object({ cadence: z.enum(['daily', 'weekly', 'monthly', 'yearly']), interval: z.number().int().min(1).max(100), weekdays: z.array(z.number().int().min(0).max(6)).max(7).refine(v => new Set(v).size === v.length), endsOn: localDate.optional(), count: z.number().int().min(1).max(1000).optional(), monthDay: z.number().int().min(1).max(31).optional(), month: z.number().int().min(1).max(12).optional(), missingDay: z.enum(['skip', 'last-day']).optional(), monthPattern: z.enum(['date', 'weekday']).optional(), ordinal: z.union([z.literal(-1), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(), weekday: z.number().int().min(0).max(6).optional() }).strict().refine(v => !v.count || !v.endsOn, 'Choose an end date or a number of occurrences, not both.').refine(v => v.cadence !== 'weekly' || v.weekdays.length > 0, 'Choose at least one weekday.');
export type CalendarRepeat = z.infer<typeof calendarRepeatSchema>;
const wallEndpoint = z.object({ date: localDate, time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), overlap: z.enum(['earlier', 'later']).optional() }).strict();
export const localEventInputSchema = z.object({ title: z.string().trim().min(1).max(300), notes: z.string().max(10000), location: z.string().max(1000), timezone, allDay: z.boolean(), start: wallEndpoint, end: wallEndpoint, state: z.enum(['confirmed', 'cancelled']), projectId: z.string().max(100).nullable(), taskId: z.string().max(100).nullable(), repeat: calendarRepeatSchema.optional(), category: z.enum(['work', 'personal', 'health', 'social', 'education', 'other']).optional(), allDayReminder: allDayReminderSchema.nullable().optional(), reminderMinutes: z.number().int().min(0).max(40320).optional(), deliveryChannel: z.enum(['last', 'telegram', 'discord', 'imessage', 'googlechat', 'matrix', 'bluebubbles', 'whatsapp', 'signal', 'slack']).optional() }).strict();
export type LocalEventInput = z.infer<typeof localEventInputSchema>;
export const localEventCommandSchema = z.object({ requestId: z.uuid(), epoch: z.uuid(), eventId: z.uuid(), expectedRevision: z.number().int().nonnegative(), value: localEventInputSchema, scope: z.enum(['event', 'occurrence', 'series']).optional(), originalDate: localDate.optional(), expectedOverrideRevision: z.number().int().nonnegative().optional(), expectedExceptionsRevision: z.number().int().nonnegative().optional(), exceptions: z.enum(['keep', 'reset']).optional() }).strict();
export type CalendarDisplayEvent = CalendarEvent & { sourceId: string; taskId?: string; routineId?: string; taskStatus?: 'open' | 'active' | 'waiting' | 'blocked' | 'done' | 'skipped'; contentId?: string; warning?: string };
export type CalendarState = { epoch: string; deviceId: string; eventsLimited: boolean; reminders?: CalendarReminderState; range: CalendarRange; selection: CalendarSelection; sources: CalendarSourceState[]; localEvents: LocalCalendarOccurrence[]; events: CalendarDisplayEvent[]; jobs: CalendarJob[]; accountMessages: { accountId: string; label: string; message: string; limited: boolean }[] };

export function addDays(day: string, delta: number) { return new Date(Date.parse(day + 'T12:00:00Z') + delta * 86400000).toISOString().slice(0, 10); }
export function calendarWindow(day: string, view: 'month' | 'week' | 'day'): { from: string; to: string } {
  const weekday = (date: string) => (new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7;
  if (view === 'day') return { from: day, to: addDays(day, 1) };
  if (view === 'week') { const from = addDays(day, -weekday(day)); return { from, to: addDays(from, 7) }; }
  const first = day.slice(0, 8) + '01', from = addDays(first, -weekday(first)); return { from, to: addDays(from, 42) };
}
