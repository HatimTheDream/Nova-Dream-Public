import { useEffect, useState } from 'react';
import type { LocalCalendarDetail, LocalCalendarOccurrence } from '../../../packages/domain/calendar';
import { request } from './api';
import { draftForCalendar, type EventDraft } from './calendar-edit';
import { Dialog } from './ui';
import type { CalendarEvent } from './dreamclaw/pages/Calendar/calendarTypes';

export function ProviderCalendarEditScope({ event, close, choose }: { event: CalendarEvent; close(): void; choose(scope: 'occurrence' | 'series'): void }) {
  return <Dialog title="Edit repeating event" close={close}><div className="calendar-scope"><p><strong>{event.title}</strong></p>
    <div className="calendar-scope-option"><button onClick={() => choose('occurrence')}>This occurrence</button><p>{event.date} · {event.allDay ? 'All day' : event.startTime}</p><p className="metadata">Only this date. The original provider occurrence is checked before editing.</p></div>
    <div className="calendar-scope-option"><button onClick={() => choose('series')}>Entire series</button><p>Open the original provider series and its complete repeat pattern.</p><p className="metadata">Saving or deleting applies to the entire series. You will review guest notifications before confirming.</p></div>
  </div></Dialog>;
}

export function CalendarEditScope({ event, epoch, close, choose }: { event: LocalCalendarOccurrence; epoch: string; close: () => void; choose: (draft: EventDraft) => void }) {
  const [detail, setDetail] = useState<LocalCalendarDetail>(), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true; const controller = new AbortController(); setDetail(undefined); setError('');
    void request<LocalCalendarDetail>(`calendar/local/${event.eventId}?${new URLSearchParams(event.originalDate ? { originalDate: event.originalDate } : {})}`, undefined, controller.signal).then(result => { if (alive) { if (result.epoch === epoch) setDetail(result); else setError('The host changed. Check the current event before editing.'); } }).catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : 'The event could not be checked. Try again.'); });
    return () => { alive = false; controller.abort(); };
  }, [event.eventId, event.originalDate, epoch, retry]);
  const occurrence = detail?.occurrence;
  return <Dialog title="Edit repeating event" close={close}><div className="calendar-scope"><p><strong>{detail?.event.value.title ?? event.value.title}</strong></p>{!detail && !error && <p role="status">Checking the current series…</p>}{error && <p className="field-error" role="alert">{error}</p>}{detail && <>
    <div className="calendar-scope-option"><button disabled={!occurrence || detail.event.value.state === 'cancelled'} onClick={() => choose(draftForCalendar(detail, 'occurrence'))}>This occurrence</button><p>{occurrence ? `${occurrence.value.start.date} · ${occurrence.value.allDay ? 'All day' : occurrence.value.start.time} · ${occurrence.value.timezone.replaceAll('_', ' ')}` : 'This date is no longer in the series.'}</p>{occurrence && occurrence.originalDate !== occurrence.value.start.date && <p className="metadata">Originally scheduled for {occurrence.originalDate}.</p>}{detail.event.value.state === 'cancelled' && <p className="metadata">Restore the entire series before editing an occurrence.</p>}</div>
    <div className="calendar-scope-option"><button onClick={() => choose(draftForCalendar(detail, 'series'))}>Entire series</button><p>All dates in this series, beginning {detail.event.value.start.date}.</p><p className="metadata">{detail.exceptionCount ? `${detail.exceptionCount} individually adjusted date${detail.exceptionCount === 1 ? '' : 's'}. Choose whether to keep or reset them in the editor.` : 'No individually adjusted dates.'}</p></div>
  </>}{error && <button onClick={() => setRetry(n => n + 1)}>Check again</button>}</div></Dialog>;
}
