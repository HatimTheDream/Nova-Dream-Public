import type { CalendarDisplayEvent, CalendarRepeat, CalendarState } from '../../../packages/domain/calendar';
import { eventDates } from '../../../packages/domain/calendar-time';
import { cadenceGroup, type CadenceGroup } from '../../../packages/domain/task-presentation';
export type CalendarTaskRow = { key: string; event: CalendarDisplayEvent; date: string; last: string; group: CadenceGroup | 'One-offs'; repeatKey?: string; projectId?: string | null; localId?: string; originalDate?: string };
export const calendarSeriesKey = (sourceId: string, generation: string, seriesId: string) => JSON.stringify([sourceId, generation, seriesId]);
export function calendarTaskRows(state: CalendarState, repeats: Map<string, Pick<CalendarRepeat, 'cadence' | 'interval'> | undefined>): CalendarTaskRow[] {
  return state.events.flatMap(event => {
    if (['tasks', 'content'].includes(event.sourceId) || event.status === 'cancelled') return [];
    const local = state.localEvents.find(item => event.sourceId === 'local' && item.id === event.id);
    const source = state.sources.find(item => item.id === event.sourceId);
    if (!local && (!source || !source.selected)) return [];
    const repeatKey = source && event.seriesId ? calendarSeriesKey(source.id, source.generation, event.seriesId) : undefined;
    const repeat = local?.value.repeat ?? local?.series?.value.repeat ?? (repeatKey ? repeats.get(repeatKey) : undefined);
    const dates = eventDates(event.interval, state.range.timezone);
    return [{ key: `${event.sourceId}:${event.id}`, event, date: dates.first, last: dates.last, group: repeat ? cadenceGroup(repeat) : event.seriesId ? 'Custom' : 'One-offs', repeatKey, projectId: local?.value.projectId, localId: local?.eventId, originalDate: local?.originalDate }];
  });
}
