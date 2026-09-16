import type { CalendarEvent } from '@dreamclaw/pages/Calendar/calendarTypes';

export type CalendarDeleteScope = 'event' | 'series' | 'schedule';

export interface CalendarSeriesChoice {
  seriesId: string;
  weekday: string;
  weekdayIndex: number;
  title: string;
  time: string;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function calendarSeriesId(event: Pick<CalendarEvent, 'id' | 'externalId' | 'recurringEventId' | 'recurrence'>): string | undefined {
  return event.recurringEventId || (event.recurrence ? event.externalId || event.id : undefined);
}

export function calendarScheduleLabel(title: string): string {
  const trimmed = String(title || '').trim();
  const separator = trimmed.search(/\s*(?::|\s[-–—|/]\s)\s*/u);
  return separator > 1 ? trimmed.slice(0, separator).trim() : trimmed;
}

function calendarScheduleKey(title: string): string {
  return calendarScheduleLabel(title).toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

function calendarOwnerKey(event: Pick<CalendarEvent, 'source' | 'sourceAccount' | 'calendarId'>): string {
  return [event.source, event.sourceAccount || '', event.calendarId || '']
    .join('\u0000');
}

function weekdayForDate(date: string): { weekday: string; weekdayIndex: number } {
  const parsed = new Date(`${date}T12:00:00Z`);
  const weekdayIndex = Number.isNaN(parsed.getTime()) ? 7 : parsed.getUTCDay();
  const weekday = WEEKDAYS[weekdayIndex] || 'Recurring date';
  return { weekday, weekdayIndex };
}

/**
 * Builds an explicit, bounded set of provider series visible with the selected event.
 * Matching never crosses a provider account or calendar. The title family is used only
 * to offer choices to the user; destructive requests contain exact provider IDs.
 */
export function relatedCalendarSeries(events: CalendarEvent[], target: CalendarEvent, limit = 31): CalendarSeriesChoice[] {
  const targetSeriesId = calendarSeriesId(target);
  if (!targetSeriesId) return [];
  const ownerKey = calendarOwnerKey(target);
  const scheduleKey = calendarScheduleKey(target.title);
  const maximum = Number.isFinite(limit) ? Math.min(31, Math.max(1, Math.floor(limit))) : 31;
  const choices = new Map<string, CalendarSeriesChoice>([[targetSeriesId, { seriesId: targetSeriesId, ...weekdayForDate(target.date), title: target.title, time: target.allDay ? 'All day' : target.startTime || 'Time not shown' }]]);

  for (const event of events) {
    if (choices.size >= maximum) break;
    if (event.readOnly || calendarOwnerKey(event) !== ownerKey || calendarScheduleKey(event.title) !== scheduleKey) continue;
    const seriesId = calendarSeriesId(event);
    if (!seriesId || choices.has(seriesId)) continue;
    const weekday = weekdayForDate(event.date);
    choices.set(seriesId, { seriesId, ...weekday, title: event.title, time: event.allDay ? 'All day' : event.startTime || 'Time not shown' });
  }

  return Array.from(choices.values()).sort((left, right) => left.weekdayIndex - right.weekdayIndex);
}

export function matchesCalendarDeletion(
  candidate: Pick<CalendarEvent, 'id' | 'externalId' | 'recurringEventId' | 'recurrence'>,
  targetId: string,
  seriesIds: readonly string[],
  scope: CalendarDeleteScope,
): boolean {
  if (scope === 'event') return candidate.id === targetId;
  const candidateSeriesId = calendarSeriesId(candidate);
  return Boolean(candidateSeriesId && seriesIds.includes(candidateSeriesId));
}
