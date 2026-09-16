import { assignEventColumns } from '../../../../packages/domain/calendar-layout';
import type { CalendarEvent } from './pages/Calendar/calendarTypes';

export function originalTimelineRows(events: CalendarEvent[], day: string, firstHour: number, lastHour: number, hourHeight: number) {
  const midnight = Date.parse(day + 'T00:00:00Z');
  const clock = (date: string, time: string) => (Date.parse(`${date}T${time}:00Z`) - midnight) / 3600000;
  return assignEventColumns(events.filter(event => !event.allDay && event.startTime).flatMap(event => {
    const start = clock(event.date, event.startTime!);
    let end = event.endTime ? clock(event.endDate || event.date, event.endTime) : start + 1;
    if (end <= start) end += 24;
    const from = Math.max(firstHour, start), to = Math.min(lastHour + 1, end);
    return to > from ? [{ event, top: (from - firstHour) * hourHeight, height: Math.max(44, (to - from) * hourHeight) }] : [];
  }));
}
