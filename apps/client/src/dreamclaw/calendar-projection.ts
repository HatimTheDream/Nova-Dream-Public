import type { CalendarState as HostCalendarState, CalendarDisplayEvent, LocalCalendarOccurrence, LocalEventInput } from '../../../../packages/domain/calendar';
import { addDays } from '../../../../packages/domain/calendar';
import { clockInZone, eventDates } from '../../../../packages/domain/calendar-time';
import type { CalendarEvent } from './pages/Calendar/calendarTypes';

export function localEditorValues(event: CalendarEvent, local: LocalCalendarOccurrence): CalendarEvent {
  const value = local.value;
  return { ...event, date: value.start.date, endDate: value.allDay ? addDays(value.end.date, -1) : value.end.date,
    startTime: value.allDay ? undefined : value.start.time, endTime: value.allDay ? undefined : value.end.time,
    allDay: value.allDay, title: value.title, location: value.location, notes: value.notes,
    category: value.category ?? 'other', reminderMinutes: value.reminderMinutes ?? 0, allDayReminder: value.allDayReminder, deliveryChannel: value.deliveryChannel ?? 'last',
    recurrence: value.repeat ? { freq: value.repeat.cadence, interval: value.repeat.interval, until: value.repeat.endsOn, count: value.repeat.count } : undefined };
}

export function projectCalendarEvent(event: CalendarDisplayEvent, state: HostCalendarState): CalendarEvent {
  const source = state.sources.find(source => source.id === event.sourceId);
  if (!source && !['local', 'tasks', 'content'].includes(event.sourceId)) throw new Error('This event’s calendar source is unavailable. Refresh the source list.');
  const local = event.sourceId === 'local' ? state.localEvents.find(local => local.id === event.id) : undefined;
  const alert = local && state.reminders?.items.find(item => item.eventId === local.eventId && item.originalDate === local.originalDate && item.state !== 'cancelled');
  const span = eventDates(event.interval, state.range.timezone);
  const id = `${event.sourceId}:${event.id}`;
  return {
    id, title: event.title, date: span.first, endDate: span.last, allDay: event.interval.kind === 'date',
    startTime: event.interval.kind === 'instant' ? clockInZone(event.interval.start, state.range.timezone) : undefined,
    endTime: event.interval.kind === 'instant' ? clockInZone(event.interval.end, state.range.timezone) : undefined,
    notes: [event.notes, event.warning].filter(Boolean).join('\n\n'), location: event.location,
    category: local?.value.category ?? event.workspaceCategory ?? (event.taskId || event.routineId ? 'work' : 'other'), source: event.contentId ? 'content' : event.taskId || event.routineId ? 'task' : event.sourceId === 'local' ? 'local' : source?.provider ?? 'local',
    externalId: event.providerId, sourceAccount: source?.accountId, calendarId: source?.calendarId,
    calendarName: source?.name, sourceUrl: event.webLink,
    sourceRoute: event.contentId ? `/content?item=${encodeURIComponent(event.contentId)}` : event.taskId ? `/tasks?task=${encodeURIComponent(event.taskId)}` : event.routineId ? `/tasks?routine=${encodeURIComponent(event.routineId)}` : undefined,
    readOnly: local ? Boolean(event.warning) : !source?.providerCanWrite || !source.accountCanWrite || source.state === 'unavailable' || Boolean(event.warning),
    recurringEventId: event.seriesId, recurrenceInstanceKey: event.originalStart,
    recurrence: local?.value.repeat ? { freq: local.value.repeat.cadence, interval: local.value.repeat.interval, until: local.value.repeat.endsOn, count: local.value.repeat.count } : local?.series?.value.repeat ? { freq: local.series.value.repeat.cadence, interval: local.series.value.repeat.interval } : undefined,
    reminderMinutes: local?.value.reminderMinutes ?? 0, allDayReminder: local?.value.allDayReminder, reminderStatus: alert ? alert.state : local?.value.reminderMinutes || local?.value.allDayReminder ? 'pending' : 'none', deliveryChannel: local?.value.deliveryChannel ?? 'last',
    status: event.status === 'cancelled' ? 'cancelled' : event.taskStatus === 'done' || event.taskStatus === 'skipped' ? 'completed' : 'scheduled',
    createdAt: local?.updatedAt ?? '', updatedAt: local?.updatedAt ?? '',
    writeToken: local ? JSON.stringify([state.epoch, local.eventId, local.originalDate, local.revision, local.overrideRevision, local.exceptionsRevision])
      : source ? JSON.stringify([state.epoch, source.id, source.generation, event.id, event.seriesId, event.originalStart]) : undefined,
  };
}

// Original view uses inclusive civil end dates; the host uses exclusive all-day
// ends and explicit timezone wall clocks. Existing advanced repeat/context fields
// must survive edits to the original modal's simpler fields.
export function calendarFormInput(event: Partial<CalendarEvent>, timezone: string, previous?: LocalEventInput): LocalEventInput {
  if (!event.date || !event.title) throw new Error('Add a title and date.');
  const allDay = event.allDay ?? false;
  const startTime = allDay ? '00:00' : event.startTime || '09:00';
  const endTime = allDay ? '00:00' : event.endTime || `${String((Number(startTime.slice(0, 2)) + 1) % 24).padStart(2, '0')}${startTime.slice(2)}`;
  const previousSpan = previous && previous.allDay === allDay ? Math.round((Date.parse(previous.end.date) - Date.parse(previous.start.date)) / 86400000) : undefined;
  const preservedEndDate = previousSpan !== undefined && !event.endDate ? addDays(event.date, Math.max(allDay ? 1 : endTime <= startTime ? 1 : 0, previousSpan)) : undefined;
  const endDate = preservedEndDate ?? (allDay ? addDays(event.endDate || event.date, 1) : event.endDate && event.endDate > event.date ? event.endDate : endTime <= startTime ? addDays(event.date, 1) : event.date);
  const input: LocalEventInput = {
    ...previous, allDayReminder: allDay ? event.allDayReminder === undefined ? previous?.allDayReminder : event.allDayReminder : null, title: event.title.trim(), notes: event.notes ?? '', location: event.location ?? '',
    category: event.category ?? previous?.category ?? 'other', reminderMinutes: event.reminderMinutes ?? previous?.reminderMinutes ?? 0, deliveryChannel: event.deliveryChannel ?? previous?.deliveryChannel ?? 'last',
    timezone: previous?.timezone ?? timezone, allDay,
    start: { date: event.date, time: startTime, ...(previous?.start.date === event.date && previous.start.time === startTime && previous.start.overlap ? { overlap: previous.start.overlap } : {}) },
    end: { date: endDate, time: endTime, ...(previous?.end.date === endDate && previous.end.time === endTime && previous.end.overlap ? { overlap: previous.end.overlap } : {}) },
    state: event.status === 'cancelled' ? 'cancelled' : 'confirmed', projectId: previous?.projectId ?? null, taskId: previous?.taskId ?? null,
  };
  if (!event.recurrence) delete input.repeat;
  else if (previous?.repeat?.cadence !== event.recurrence.freq) {
    input.repeat = { cadence: event.recurrence.freq, interval: event.recurrence.interval,
      weekdays: event.recurrence.freq === 'weekly' ? [new Date(event.date + 'T12:00:00Z').getUTCDay()] : [],
      ...(event.recurrence.until ? { endsOn: event.recurrence.until } : {}), ...(event.recurrence.count ? { count: event.recurrence.count } : {}) };
  }
  return input;
}
