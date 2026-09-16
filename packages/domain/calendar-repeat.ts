import { addDays, type CalendarException, type CalendarRange, type LocalCalendarEvent, type LocalCalendarOccurrence, type LocalEventInput } from './calendar.js';
import { clockInZone, dayStart, localEventInterval, overlapsRange } from './calendar-time.js';
import { reminderInstant } from './reminders.js';
import { dayInZone, nextScheduled, scheduled, type Routine } from './tasks.js';

function schedule(value: LocalEventInput): Routine {
  return { title: value.title, notes: '', kind: 'task', state: 'active', startsOn: value.start.date, timezone: value.timezone, projectId: value.projectId, plannedTime: value.start.time, priority: 'normal', estimateMinutes: 0, ...value.repeat! };
}
const spanDays = (v: LocalEventInput) => Math.round((Date.parse(v.end.date) - Date.parse(v.start.date)) / 86400000);
export function repeatProblem(value: LocalEventInput): string | undefined {
  if (!value.repeat) return;
  if (value.repeat.endsOn && value.repeat.endsOn < value.start.date) return 'The repeat end must be on or after the first event.';
  if (!scheduled(schedule(value), value.start.date)) return 'The first event date must match the repeat rule. Choose a matching start date or adjust the rule.';
}
function exactDuration(value: LocalEventInput) { const interval = localEventInterval(value).interval; return interval?.kind === 'instant' ? Date.parse(interval.end) - Date.parse(interval.start) : undefined; }
export function occurrenceValue(value: LocalEventInput, date: string, duration = exactDuration(value)): LocalEventInput {
  const { repeat, ...fields } = value;
  const start = { ...value.start, date };
  if (!value.allDay && duration !== undefined) {
    const resolved = reminderInstant({ ...start, timezone: value.timezone });
    if (resolved.instant !== null) {
      const instant = resolved.instant + duration, end = { date: dayInZone(value.timezone, instant), time: clockInZone(new Date(instant).toISOString(), value.timezone) };
      const matches = reminderInstant({ ...end, timezone: value.timezone }).choices;
      return { ...fields, start, end: { ...end, ...(matches.length > 1 ? { overlap: instant === matches[0] ? 'earlier' as const : 'later' as const } : {}) } };
    }
  }
  return { ...fields, start, end: { ...value.end, date: addDays(date, spanDays(value)) } };
}
function occurrence(master: LocalCalendarEvent, date: string | undefined, override?: CalendarException, projected?: LocalEventInput): LocalCalendarOccurrence {
  const effective = override?.retired ? undefined : override;
  const value = effective?.value ?? projected ?? (date ? occurrenceValue(master.value, date) : master.value), cancelledBySeries = !!date && master.value.state === 'cancelled' && value.state !== 'cancelled';
  const timing = localEventInterval(value);
  const excluded = !!date && !effective && !value.allDay && reminderInstant({ ...value.start, timezone: value.timezone }).problem === 'gap';
  return { id: date ? `${master.id}@${date}` : master.id, eventId: master.id, deviceId: effective?.deviceId ?? master.deviceId, revision: master.revision, updatedAt: effective?.updatedAt ?? master.updatedAt, value: cancelledBySeries ? { ...value, state: 'cancelled' } : value, overrideRevision: override?.revision ?? 0, ...(date ? { originalDate: date, series: master } : {}), ...(timing.error ? { problem: timing.error } : {}), ...(excluded ? { excluded: true } : {}), ...(cancelledBySeries ? { cancelledBySeries: true } : {}) };
}
/** Bounded expansion with stable original-date identity; moved exceptions retain that identity. */
export function expandLocalCalendar(master: LocalCalendarEvent, exceptions: CalendarException[], range: CalendarRange, limit = 2000): { occurrences: LocalCalendarOccurrence[]; limited: boolean } {
  const bounds = { start: dayStart(range.from, range.timezone), end: dayStart(range.to, range.timezone) };
  const visible = (event: LocalCalendarOccurrence) => {
    const { interval } = localEventInterval(event.value);
    // An unresolved time remains a review item on its civil date, never a fake instant.
    return interval ? overlapsRange(interval, range, bounds) : event.value.start.date >= range.from && event.value.start.date < range.to;
  };
  const active = exceptions.filter(e => !e.retired), byDate = new Map(exceptions.map(e => [e.originalDate, e]));
  const result = new Map<string, LocalCalendarOccurrence>(); let limited = false;
  const add = (event: LocalCalendarOccurrence) => { if (visible(event)) { if (result.has(event.id) || result.size < limit) result.set(event.id, event); else limited = true; } };
  const series = master.isSeries || !!master.value.repeat;
  if (!master.value.repeat) {
    const date = series ? master.value.start.date : undefined; add(occurrence(master, date, date ? byDate.get(date) : undefined));
  } else {
    const routine = schedule(master.value), count = master.value.repeat.count, duration = exactDuration(master.value);
    // With COUNT, earlier valid starts determine membership. Without COUNT, jump to the visible window, allowing long events and timezone offsets.
    const earliest = addDays(range.from, -Math.max(0, spanDays(master.value)) - 2);
    let date: string | null = count || earliest <= master.value.start.date ? master.value.start.date : nextScheduled(routine, addDays(earliest, -1));
    let generated = 0, scanned = 0;
    const through = addDays(range.to, 2);
    while (date && date < through && (!count || generated < count)) {
      if (++scanned > 10000) { limited = true; break; }
      const original = occurrenceValue(master.value, date, duration), invalidStart = !original.allDay && reminderInstant({ ...original.start, timezone: original.timezone }).problem === 'gap';
      // Nonexistent starts are excluded from the recurrence count, while a visible review item lets the owner create an explicit exception.
      if (!invalidStart) generated++;
      add(occurrence(master, date, byDate.get(date), original));
      if (limited) break;
      date = nextScheduled(routine, date);
    }
  }
  // Existing exceptions are retained even when a changed series rule no longer generates their old dates.
  for (const override of active) add(occurrence(master, override.originalDate, override));
  return { occurrences: [...result.values()].sort((a, b) => a.value.start.date.localeCompare(b.value.start.date) || a.value.start.time.localeCompare(b.value.start.time) || a.id.localeCompare(b.id)), limited };
}
export function localOccurrence(master: LocalCalendarEvent, exceptions: CalendarException[], originalDate?: string): LocalCalendarOccurrence | undefined {
  if (!originalDate) return !master.isSeries && !master.value.repeat ? occurrence(master, undefined) : undefined;
  const override = exceptions.find(e => e.originalDate === originalDate && !e.retired);
  if (override) return occurrence(master, originalDate, override);
  const range = { from: originalDate, to: addDays(originalDate, 1), timezone: master.value.timezone };
  return expandLocalCalendar(master, exceptions, range).occurrences.find(e => e.originalDate === originalDate);
}
