import { addDays, type LocalCalendarOccurrence, type LocalEventInput } from './calendar.js';
import { clockInZone } from './calendar-time.js';
import { dayInZone } from './tasks.js';
import { reminderInstant, type ReminderRecord, type ReminderSpec } from './reminders.js';

export type CalendarReminder = ReminderRecord & { eventId: string; originalDate?: string; eventRevision: number; overrideRevision: number; title: string; sourceFingerprint: string; sourceDueAt: number | null };
export type CalendarNotificationAttempt = NonNullable<ReminderRecord['notification']> & { reminderId: string; eventId: string; originalDate?: string; dueAt: number | null; snoozes: number };
export type CalendarReminderState = { items: CalendarReminder[]; attempts: CalendarNotificationAttempt[]; catchingUp: boolean; message?: string };
export type CalendarAlarm = { dueAt: number | null; spec: ReminderSpec; reason?: string };

function wallSpec(instant: number, timezone: string): ReminderSpec {
  const spec = { date: dayInZone(timezone, instant), time: clockInZone(new Date(instant).toISOString(), timezone), timezone };
  const { choices } = reminderInstant(spec);
  return { ...spec, ...(choices.length > 1 ? { overlap: instant === choices[0] ? 'earlier' as const : 'later' as const } : {}) };
}
/** Before-start offsets are elapsed minutes; all-day reminders are explicit civil clock times. */
export function calendarAlarm(value: LocalEventInput): CalendarAlarm | undefined {
  const reminder = value.allDay ? value.allDayReminder && { kind: 'all-day' as const, ...value.allDayReminder } : value.reminderMinutes ? { kind: 'before-start' as const, minutesBefore: value.reminderMinutes } : undefined;
  if (!reminder) return;
  if (value.allDay !== (reminder.kind === 'all-day')) throw new Error('The reminder does not match this event type.');
  if (reminder.kind === 'all-day') {
    const spec: ReminderSpec = { date: addDays(value.start.date, -reminder.daysBefore), time: reminder.time, timezone: value.timezone, ...(reminder.overlap ? { overlap: reminder.overlap } : {}) };
    const resolved = reminderInstant(spec);
    return { spec, dueAt: resolved.instant, ...(resolved.instant === null ? { reason: resolved.problem === 'gap' ? 'This reminder time does not exist in the event timezone. Review its date and time.' : 'This reminder time occurs twice. Choose the earlier or later time.' } : {}) };
  }
  const start: ReminderSpec = { ...value.start, timezone: value.timezone }, resolved = reminderInstant(start);
  if (resolved.instant === null) return { dueAt: null, spec: start, reason: 'The event start needs a valid clock time before its reminder can be calculated. Review this occurrence.' };
  const dueAt = resolved.instant - reminder.minutesBefore * 60000;
  return { dueAt, spec: wallSpec(dueAt, value.timezone) };
}
/** Does not include title/notes or an active snooze, so harmless edits cannot rearm an alert. */
export function calendarAlarmFingerprint(event: LocalCalendarOccurrence, alarm: CalendarAlarm) {
  return JSON.stringify({ eventId: event.eventId, originalDate: event.originalDate, dueAt: alarm.dueAt, spec: alarm.spec, allDay: event.value.allDay });
}
