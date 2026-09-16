import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import { addDays, localEventInputSchema, type LocalCalendarDetail, type LocalCalendarEvent, type LocalEventInput } from '../../../packages/domain/calendar';
import { reminderInstant } from '../../../packages/domain/reminders';
import { localEventInterval } from '../../../packages/domain/calendar-time';
import { ApiError, request } from './api';
import { Dialog } from './ui';
import { CalendarRepeatEditor } from './CalendarRepeatEditor';
import { repeatProblem } from '../../../packages/domain/calendar-repeat';
import { eventSaveCommand, reviewedEventDraft, type EventDraft } from './calendar-edit';
export type { EventDraft } from './calendar-edit';

export function LocalEventEditor({ initial, snapshot, persist, close, saved }: { initial: EventDraft; snapshot: Snapshot; persist: (draft: EventDraft) => boolean; close: () => void; saved: () => void }) {
  const [draft, setDraft] = useState(initial), ref = useRef(draft), mounted = useRef(true), busyRef = useRef(false);
  const [busy, setBusy] = useState(false), [storageError, setStorageError] = useState('');
  const keep = (next: EventDraft) => { ref.current = next; setDraft(next); const ok = persist(next); if (!ok) setStorageError('Browser storage is full. Keep this window open until your save is confirmed.'); else setStorageError(''); return ok; };
  const change = (value: Partial<LocalEventInput>) => keep({ ...ref.current, value: { ...ref.current.value, ...value }, error: undefined });
  const submit = async () => {
    if (busyRef.current || ref.current.review) return;
    const current = ref.current, command = eventSaveCommand(current, crypto.randomUUID());
    if (!keep({ ...current, pending: command, error: undefined })) return;
    busyRef.current = true; setBusy(true);
    try { await request<LocalCalendarEvent>('calendar/local', command); if (mounted.current) saved(); }
    catch (error) {
      if (!mounted.current) return;
      const next = { ...ref.current, error: error instanceof Error ? error.message : 'The event save is unconfirmed. Reconcile the original request.' };
      if (error instanceof ApiError) {
        if (['calendar_event_changed', 'calendar_occurrence_changed', 'calendar_scope_required', 'calendar_series_cancelled', 'epoch_changed'].includes(error.code)) { next.review = true; next.current = error.current as unknown as LocalCalendarEvent; }
        else if (['validation', 'calendar_time', 'calendar_repeat', 'calendar_exception_policy', 'calendar_exception_limit', 'missing_project', 'calendar_task_changed'].includes(error.code)) next.pending = undefined;
      }
      keep(next);
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  useEffect(() => { mounted.current = true; if (ref.current.pending && !ref.current.review) void submit(); return () => { mounted.current = false; }; }, []);
  const review = async () => {
    if (busyRef.current) return; busyRef.current = true; setBusy(true);
    const kept = ref.current;
    try {
      const detail = await request<LocalCalendarDetail>(`calendar/local/${kept.id}${kept.originalDate ? '?' + new URLSearchParams({ originalDate: kept.originalDate }) : ''}`);
      if (mounted.current) keep(reviewedEventDraft(ref.current, detail));
    } catch (reason) { if (mounted.current) keep({ ...ref.current, error: reason instanceof Error ? reason.message : 'The current event could not be checked. Your fields are kept.' }); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const v = draft.value, timing = localEventInterval(v), parsed = localEventInputSchema.safeParse(v), repeatError = parsed.success ? repeatProblem(parsed.data) : undefined, locked = busy || !!draft.pending || !!draft.review;
  const repeated = (which: 'start' | 'end') => { try { return reminderInstant({ ...v[which], timezone: v.timezone, overlap: undefined }).problem === 'overlap'; } catch { return false; } };
  return <Dialog title={draft.scope === 'occurrence' ? 'Edit this occurrence' : draft.scope === 'series' && draft.revision ? 'Edit entire series' : draft.revision ? 'Local event' : 'New event'} close={close}><form className="calendar-editor" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <p className="metadata">Saved in your Edition 3 calendar{v.taskId ? ' as a task block. The task’s deadline stays separate.' : '.'}</p>
    {draft.scope === 'occurrence' && <p className="metadata">Only the occurrence originally scheduled for {draft.originalDate} will change. Moving its date keeps that identity.</p>}
    <fieldset disabled={locked}><label>Event title<input autoFocus required maxLength={300} value={v.title} onChange={e => change({ title: e.target.value })} placeholder="Make room for something good"/></label>
    <label className="calendar-check"><input type="checkbox" checked={v.allDay} onChange={e => change({ allDay: e.target.checked, end: { ...v.end, date: e.target.checked && v.end.date <= v.start.date ? addDays(v.start.date, 1) : v.end.date } })}/>All day</label>
    <div className="form-grid">{(['start', 'end'] as const).map(which => <div className="calendar-endpoint" key={which}><label>{which === 'start' ? 'Starts on' : v.allDay ? 'Through' : 'Ends on'}<input type="date" required value={which === 'end' && v.allDay ? addDays(v.end.date, -1) : v[which].date} onChange={e => { if (e.target.value) change({ [which]: { ...v[which], date: which === 'end' && v.allDay ? addDays(e.target.value, 1) : e.target.value, overlap: undefined } }); }}/></label>{!v.allDay && <><label>{which === 'start' ? 'Start time' : 'End time'}<input type="time" required value={v[which].time} onChange={e => change({ [which]: { ...v[which], time: e.target.value, overlap: undefined } })}/></label>{repeated(which) && <label>{which === 'start' ? 'Start occurrence' : 'End occurrence'}<select value={v[which].overlap ?? ''} onChange={e => change({ [which]: { ...v[which], overlap: e.target.value || undefined } })}><option value="">Ask me to choose</option><option value="earlier">Earlier occurrence</option><option value="later">Later occurrence</option></select><small>This time occurs twice because clocks go back.</small></label>}</>}</div>)}</div>
    <label>Event timezone<input list="calendar-timezones" required value={v.timezone} onChange={e => change({ timezone: e.target.value, start: { ...v.start, overlap: undefined }, end: { ...v.end, overlap: undefined } })}/><datalist id="calendar-timezones">{[...new Set([snapshot.layout.value.timezone, 'UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Asia/Tokyo'])].map(t => <option key={t} value={t}/>)}</datalist><small>All-day events keep their dates in every viewing timezone.</small></label>
    {draft.scope !== 'occurrence' && <CalendarRepeatEditor value={v} change={change}/>}
    {draft.scope === 'series' && draft.revision > 0 && <div className="calendar-series-scope"><strong>This change applies to the entire series</strong><p>{draft.detail?.exceptionCount ?? 0} individually adjusted dates.</p><label>Adjusted occurrences<select value={draft.exceptions ?? 'keep'} onChange={e => keep({ ...ref.current, exceptions: e.target.value as 'keep' | 'reset', error: undefined })}><option value="keep">Keep changes</option><option value="reset">Reset changes</option></select></label><p className="metadata">{draft.exceptions === 'reset' ? 'Individual moves, edits and cancellations will be removed from the active schedule. Dates no longer in the repeat rule will disappear. Their saved history is retained.' : 'Individual moves, edits and cancellations stay as they are, including dates no longer in the repeat rule.'}</p>{!!draft.detail?.exceptions.length && <details><summary>Review adjusted dates</summary><ul className="calendar-exception-list">{draft.detail.exceptions.map(item => <li key={item.originalDate}><strong>{item.originalDate}</strong> → {item.start.date} {item.start.time} · {item.title}{item.state === 'cancelled' ? ' · Cancelled' : ''}</li>)}</ul>{draft.detail.exceptionCount > draft.detail.exceptions.length && <p className="metadata">Showing the first {draft.detail.exceptions.length} of {draft.detail.exceptionCount} adjusted dates. This choice applies to all of them.</p>}</details>}</div>}
    <div className="form-grid"><label>Project<select value={v.projectId ?? ''} onChange={e => change({ projectId: e.target.value || null, taskId: null })}><option value="">No Project</option>{snapshot.projects.map(p => <option key={p.id} value={p.id}>{p.value.name}</option>)}</select></label><label>Task block<select value={v.taskId ?? ''} onChange={e => change({ taskId: e.target.value || null })}><option value="">No linked task</option>{snapshot.tasks.filter(t => (t.value.projectId ?? null) === v.projectId).map(t => <option key={t.id} value={t.id}>{t.value.title}</option>)}</select></label></div>
    <label>Location<input maxLength={1000} value={v.location} onChange={e => change({ location: e.target.value })}/></label><label>Notes<textarea rows={4} maxLength={10000} value={v.notes} onChange={e => change({ notes: e.target.value })}/></label>
    {draft.revision > 0 && <label>Event status<select value={v.state} onChange={e => change({ state: e.target.value as LocalEventInput['state'] })}><option value="confirmed">Scheduled</option><option value="cancelled">Cancelled</option></select><small>Cancelled events remain available to restore.</small></label>}</fieldset>
    {!timing.interval && <p className="field-error">{timing.error}</p>}{repeatError && <p className="field-error">{repeatError}</p>}{(draft.error || storageError) && <p className="field-error" role="alert">{storageError || draft.error}</p>}
    {draft.review && <div className="notice"><div><strong>Your event needs review</strong>{draft.current && <details><summary>View current event</summary><pre className="conflict-copy">{JSON.stringify(draft.current.value, null, 2)}</pre></details>}<p>Your fields are kept. Review them before saving against the current version.</p><div className="button-row"><button type="button" disabled={busy} onClick={() => void review()}>{busy ? 'Checking…' : 'Review my kept event'}</button><button type="button" disabled={busy} onClick={() => keep({ id: crypto.randomUUID(), epoch: snapshot.epoch, revision: 0, value: ref.current.value, scope: ref.current.value.repeat ? 'series' : 'event' })}>Keep as a separate new event</button></div></div></div>}
    <div className="dialog-footer"><button type="button" onClick={close}>Keep for later</button><button className="primary" disabled={busy || draft.review || (!draft.pending && (!parsed.success || !timing.interval || !!repeatError))}>{busy ? 'Saving…' : draft.pending ? 'Reconcile save' : draft.scope === 'occurrence' ? 'Save occurrence' : draft.scope === 'series' || v.repeat ? 'Save series' : 'Save event'}</button></div>
  </form></Dialog>;
}
