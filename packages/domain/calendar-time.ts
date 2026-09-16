import type { CalendarRange, EventInterval, LocalEventInput } from './calendar.js';
import { addDays } from './calendar.js';
import { reminderInstant } from './reminders.js';
import { dayInZone, localDate } from './tasks.js';

export function localEventInterval(event: LocalEventInput): { interval?: EventInterval; error?: string } {
  if (!localDate.safeParse(event.start.date).success || !localDate.safeParse(event.end.date).success) return { error: 'Choose valid start and end dates.' };
  if (event.allDay) return event.end.date > event.start.date ? { interval: { kind: 'date', start: event.start.date, end: event.end.date } } : { error: 'The all-day end must be after the first day.' };
  try { new Intl.DateTimeFormat('en', { timeZone: event.timezone }); } catch { return { error: 'Choose a valid IANA timezone, such as America/Los_Angeles.' }; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event.start.date) || !/^\d{4}-\d{2}-\d{2}$/.test(event.end.date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(event.start.time) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(event.end.time)) return { error: 'Choose complete start and end dates and times.' };
  const start = reminderInstant({ ...event.start, timezone: event.timezone }), end = reminderInstant({ ...event.end, timezone: event.timezone });
  for (const [label, result] of [['Start', start], ['End', end]] as const) if (result.instant === null) return { error: result.problem === 'gap' ? `${label} time does not exist in this timezone because clocks change. Choose another time.` : `${label} time occurs twice. Choose its earlier or later occurrence.` };
  if (end.instant! <= start.instant!) return { error: 'End must be after start.' };
  return { interval: { kind: 'instant', start: new Date(start.instant!).toISOString(), end: new Date(end.instant!).toISOString(), timezone: event.timezone } };
}
/** First available instant of a civil day, including midnight gaps and skipped dates. */
export function dayStart(date: string, timezone: string): number {
  for (let day = 0; day < 3; day++) {
    const current = addDays(date, day);
    for (let hour = 0; hour < 24; hour++) {
      const result = reminderInstant({ date: current, time: `${String(hour).padStart(2, '0')}:00`, timezone, overlap: 'earlier' });
      if (result.instant !== null) {
        if (!hour) return result.instant;
        let before = result.instant - 3600000, after = result.instant;
        while (after - before > 1) { const middle = Math.floor((before + after) / 2); if (dayInZone(timezone, middle) >= current) after = middle; else before = middle; }
        return after;
      }
    }
  }
  throw new Error('This calendar date has no verified time boundary.');
}
export function overlapsRange(interval: EventInterval, range: CalendarRange, bounds = { start: dayStart(range.from, range.timezone), end: dayStart(range.to, range.timezone) }): boolean {
  return interval.kind === 'date' ? interval.start < range.to && interval.end > range.from : Date.parse(interval.start) < bounds.end && Date.parse(interval.end) > bounds.start;
}
export function eventDates(interval: EventInterval, timezone: string): { first: string; last: string } {
  return interval.kind === 'date' ? { first: interval.start, last: addDays(interval.end, -1) } : { first: dayInZone(timezone, Date.parse(interval.start)), last: dayInZone(timezone, Date.parse(interval.end) - 1) };
}
export function clockInZone(iso: string, timezone: string): string { return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)); }
