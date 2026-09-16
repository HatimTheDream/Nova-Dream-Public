import type { z } from 'zod';
import type { localEventCommandSchema, LocalCalendarDetail, LocalCalendarEvent, LocalEventInput } from '../../../packages/domain/calendar';
import type { ProviderCalendarEditable, ProviderCalendarPrepare, ProviderCalendarReview, providerCalendarConfirmSchema } from '../../../packages/domain/calendar-write';
import type { CalendarSourceRef } from '../../../packages/domain/calendar';
import type { CalendarGroupPrepare, CalendarGroupReview, CalendarGroupAction } from '../../../packages/domain/calendar-groups';

export type ProviderEventDraft = {
  writerId: string; source: CalendarSourceRef; editable?: ProviderCalendarEditable;
  prepare?: ProviderCalendarPrepare; operation?: ProviderCalendarReview;
  confirmation?: z.infer<typeof providerCalendarConfirmSchema>;
  replaceDescription?: boolean; replaceRecurrence?: boolean;
  current?: ProviderCalendarEditable;
  separateProposal?: boolean;
  group?: { prepare: CalendarGroupPrepare; operation?: CalendarGroupReview; command?: CalendarGroupAction; otherSelection?: boolean };
};

export type OriginalCalendarForm = { title: string; date: string; startTime: string; endTime: string; allDay: boolean; location: string; notes: string; category: NonNullable<LocalEventInput['category']>; reminder: number; allDayReminder?: LocalEventInput['allDayReminder']; recurrence: '' | NonNullable<LocalEventInput['repeat']>['cadence']; deliveryChannel: NonNullable<LocalEventInput['deliveryChannel']>; destinationId: string };
export type EventDraft = { subtaskTarget?: { sourceId: string; eventId: string; originalStart?: string }; provider?: ProviderEventDraft; id: string; epoch: string; revision: number; value: LocalEventInput; scope?: 'event' | 'occurrence' | 'series'; originalDate?: string; overrideRevision?: number; exceptionsRevision?: number; exceptions?: 'keep' | 'reset'; detail?: LocalCalendarDetail; pending?: z.infer<typeof localEventCommandSchema>; review?: boolean; current?: LocalCalendarEvent; error?: string; originalForm?: OriginalCalendarForm };
export function draftForCalendar(detail: LocalCalendarDetail, scope: 'event' | 'occurrence' | 'series'): EventDraft {
  const event = detail.event, occurrence = detail.occurrence;
  if (scope === 'occurrence' && !occurrence?.originalDate) throw new Error('This occurrence is no longer in the series. Your calendar has been refreshed.');
  return { id: event.id, epoch: detail.epoch, revision: event.revision, value: scope === 'occurrence' ? occurrence!.value : event.value, scope, ...(scope === 'occurrence' ? { originalDate: occurrence!.originalDate, overrideRevision: occurrence!.overrideRevision } : {}), ...(scope === 'series' ? { exceptionsRevision: event.exceptionsRevision ?? 0, exceptions: 'keep' as const } : {}), detail };
}
export function eventSaveCommand(draft: EventDraft, requestId: string): z.infer<typeof localEventCommandSchema> {
  if (draft.pending) return draft.pending;
  const scope = draft.scope === 'occurrence' ? 'occurrence' : draft.scope === 'series' || draft.value.repeat ? 'series' : 'event';
  return { requestId, epoch: draft.epoch, eventId: draft.id, expectedRevision: draft.revision, value: draft.value, scope, ...(scope === 'occurrence' ? { originalDate: draft.originalDate, expectedOverrideRevision: draft.overrideRevision } : {}), ...(scope === 'series' ? { expectedExceptionsRevision: draft.exceptionsRevision ?? 0, exceptions: draft.exceptions ?? 'keep' } : {}) };
}
/** A review rebases authority only. The user's fields and chosen scope remain unchanged. */
export function reviewedEventDraft(draft: EventDraft, detail: LocalCalendarDetail): EventDraft {
  if (detail.event.id !== draft.id) throw new Error('The returned event does not match this draft. Keep your writing and check again.');
  const scope = draft.scope ?? (draft.value.repeat ? 'series' : 'event');
  if (scope === 'event' && (detail.event.isSeries || detail.event.value.repeat)) throw new Error('This event is now a series. Keep your writing as a separate event, or finish it before reopening the series.');
  if (scope === 'occurrence' && (!detail.occurrence || detail.occurrence.originalDate !== draft.originalDate)) throw new Error('This occurrence no longer belongs to the current schedule. Your writing can be kept as a separate event.');
  if (scope === 'occurrence' && detail.event.value.state === 'cancelled') throw new Error('The entire series is cancelled. Restore the series before changing an occurrence, or keep your writing as a separate event.');
  return { ...draft, epoch: detail.epoch, revision: detail.event.revision, overrideRevision: detail.occurrence?.overrideRevision, exceptionsRevision: detail.event.exceptionsRevision ?? 0, detail, pending: undefined, review: false, current: undefined, error: undefined };
}

export const calendarDraftKey = (draft: EventDraft) => JSON.stringify([...(draft.provider ? [draft.provider.source.id] : []), draft.id, draft.scope ?? (draft.value.repeat ? 'series' : 'event'), draft.originalDate ?? null]);
