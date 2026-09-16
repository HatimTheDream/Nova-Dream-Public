import type { CalendarEvent, CalendarSourceRef, LocalEventInput } from '../../packages/domain/calendar.js';
import type { ProviderCalendarReview } from '../../packages/domain/calendar-write.js';
import type { Store } from './store.js';

// Shared-workspace organization is read from the acknowledged operation itself.
// A crash between acknowledgement and cache refresh cannot lose these fields.
export function calendarProviderContexts(store: Store) {
  const heads = store.internalList<{ review: ProviderCalendarReview }>('calendar-write:operation:')
    .map(head => head.review).filter(review => ['confirmed', 'observed'].includes(review.state) && review.action !== 'delete' && review.value)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return (source: CalendarSourceRef, event: CalendarEvent): Partial<LocalEventInput> => {
  const value = heads.find(review => review.source.accountId === source.accountId && review.source.provider === source.provider && review.source.calendarId === source.calendarId
      && (review.event?.id === event.id || review.target?.eventId === event.id || review.target?.scope === 'series' && review.target.eventId === event.seriesId))?.value;
  return value ? { category: value.category ?? 'other', projectId: value.projectId, taskId: value.taskId } : {};
  };
}
export function calendarProviderContext(store: Store, source: CalendarSourceRef, event: CalendarEvent) { return calendarProviderContexts(store)(source, event); }
