import { ProjectOptions } from './ProjectOptions';
import { useEffect, useRef, useState } from 'react';
import type { Command, Entity, Snapshot } from '../../../packages/domain/contracts';
import { dayInZone, nextScheduled, routineSchema, type Routine } from '../../../packages/domain/tasks';
import { ApiError, commit, readLocal, saveLocal } from './api';
import { Dialog } from './ui';
import { Save } from './icons';
import { confirmedRoutineDraft, reopenedRoutineConfirmation, routineConfirmation, routineResponseDraft, rejectedRoutineDraft, reviewedRoutineDraft, routineDraftKey, routineDraftProblem, type RoutineEditorDraft } from './routine-editor-confirmation';

export function RoutineEditor({ routine, snapshot, close, saved, occurrenceTitle, navigationError, registerDeparture }: {
  routine: Entity<Routine>; snapshot: Snapshot; close(): void; saved(routine: Entity<Routine>, clean: boolean): void;
  occurrenceTitle?: string; navigationError?: string; registerDeparture?(guard: () => boolean): () => void;
}) {
  const key = routineDraftKey(snapshot.deviceId, routine.id);
  const [state, setState] = useState<RoutineEditorDraft>(() => readLocal<RoutineEditorDraft>(key) ?? { value: routine.value, revision: routine.revision, epoch: snapshot.epoch });
  const ref = useRef(state), mounted = useRef(true), saving = useRef(false), latest = useRef(snapshot); latest.current = snapshot;
  const response = useRef<{ command: Command; routine: Entity<Routine> } | undefined>(undefined);
  const rejected = useRef<Command | undefined>(undefined);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [review, setReview] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const persist = (next: RoutineEditorDraft) => { ref.current = next; setState(next); const kept = saveLocal(key, next); if (!kept) setError('Browser storage is full. Keep this window open.'); return kept; };
  const keepResolution = (next: RoutineEditorDraft) => {
    if (!saveLocal(key, next)) { setError('Free browser storage before adopting this review. The original request and writing are still kept.'); return false; }
    ref.current = next; setState(next); return true;
  };
  const adopt = (next: NonNullable<ReturnType<typeof confirmedRoutineDraft>>, notify: boolean) => {
    if (!saveLocal(key, next.draft)) { if (mounted.current) setError('The host confirmed this save, but this browser could not keep its response. Check the original save before leaving.'); return false; }
    const host = latest.current.routines?.find(item => item.id === routine.id), newer = !!host && host.revision > next.confirmed.revision;
    if (mounted.current) { ref.current = next.draft; setState(next.draft); setReview(newer); setError(newer ? 'Your original save was confirmed. A newer saved schedule is available; review it before saving again.' : ''); }
    if (!routine.revision && readLocal<Entity<Routine>>(`e3:new-routine:${snapshot.deviceId}`)?.id === routine.id) {
      try { localStorage.removeItem(`e3:new-routine:${snapshot.deviceId}`); } catch { /* The confirmed journal remains authoritative. */ }
    }
    if (notify) saved(next.confirmed, mounted.current && next.clean && !newer && latest.current.epoch === next.draft.epoch);
    return true;
  };
  useEffect(() => { const next = reopenedRoutineConfirmation(ref.current, readLocal<RoutineEditorDraft>(key)); if (next) adopt(next, false); }, [routine, key, snapshot.epoch]);
  const change = (patch: Partial<Routine>) => persist({ ...ref.current, value: { ...ref.current.value, ...patch } });
  const retainedConflict = (retained: RoutineEditorDraft | undefined) => !!retained && (retained.epoch !== ref.current.epoch
    || retained.revision > ref.current.revision || !!retained.pending && JSON.stringify(retained.pending) !== JSON.stringify(ref.current.pending));
  const knownResponse = () => !!ref.current.pending && !!response.current && JSON.stringify(ref.current.pending) === JSON.stringify(response.current.command);
  const retain = () => {
    const retained = readLocal<RoutineEditorDraft>(key);
    const next = reopenedRoutineConfirmation(ref.current, retained) ?? (response.current && routineResponseDraft(ref.current, retained, response.current.command, response.current.routine));
    if (next && !adopt(next, false)) return false;
    if (!next && (retainedConflict(retained) || knownResponse())) { setError('Another kept proposal or save needs review. Both the journal and this window are unchanged.'); return false; }
    if (persist(ref.current)) return true;
    setError('Free browser storage before leaving. Your latest schedule edits are still in this window.'); return false;
  };
  const departure = useRef(retain); departure.current = retain;
  useEffect(() => registerDeparture?.(() => departure.current()), [registerDeparture]);
  const keepAndClose = () => { if (retain()) close(); };
  const submit = async () => {
    if (saving.current || busy) return;
    const retained = readLocal<RoutineEditorDraft>(key);
    const acknowledged = reopenedRoutineConfirmation(ref.current, retained) ?? (response.current && routineResponseDraft(ref.current, retained, response.current.command, response.current.routine));
    if (acknowledged) { adopt(acknowledged, true); return; }
    if (retainedConflict(retained) || knownResponse()) { setError('Another kept proposal or save needs review. Both the journal and this window are unchanged.'); return; }
    const problem = routineDraftProblem(ref.current, routine.id, snapshot.epoch, snapshot.routines?.find(item => item.id === routine.id), !!routine.revision || !!occurrenceTitle);
    if (problem || review) { setError(problem || 'Review your kept proposal before saving again.'); return; }
    const command: Command = ref.current.pending ?? { requestId: crypto.randomUUID(), epoch: ref.current.epoch, kind: 'routine', entityId: routine.id, expectedRevision: ref.current.revision, payload: ref.current.value };
    if (!saveLocal(key, { ...ref.current, pending: command })) { setError('Free browser storage before saving this series.'); return; }
    persist({ ...ref.current, pending: command }); saving.current = true; setBusy(true); setError('');
    try {
      const confirmed = await commit<Routine>(command), retained = readLocal<RoutineEditorDraft>(key);
      if (routineConfirmation(command, confirmed)) response.current = { command, routine: confirmed };
      const next = routineResponseDraft(ref.current, retained, command, confirmed) ?? (mounted.current ? reopenedRoutineConfirmation(ref.current, retained) : undefined);
      if (next) adopt(next, true);
      else { if (mounted.current) setError('This response could not confirm the kept schedule request. The original save is preserved.'); saved(confirmed, false); }
    }
    catch (reason) {
      if (!mounted.current) return;
      setError(reason instanceof Error ? reason.message : 'The save is not confirmed.');
      if (reason instanceof ApiError) {
        if (['revision_conflict', 'epoch_changed'].includes(reason.code)) { rejected.current = command; setReview(true); }
        else if (['validation', 'invalid_routine', 'missing_project', 'routine_identity', 'schedule_catching_up', 'routine_past', 'routine_limit'].includes(reason.code)) {
          const next = rejectedRoutineDraft(ref.current, readLocal<RoutineEditorDraft>(key), command);
          if (next) keepResolution(next);
          else setError('The original save was rejected, but another kept proposal or request now owns the journal. Both are preserved for review.');
        }
      }
    } finally { saving.current = false; if (mounted.current) setBusy(false); }
  };
  const v = state.value, host = snapshot.routines?.find(r => r.id === routine.id);
  const problem = routineDraftProblem(state, routine.id, snapshot.epoch, host, !!routine.revision || !!occurrenceTitle);
  const canReview = (review || !!problem && !state.pending) && state.epoch === snapshot.epoch && !!host && host.id === routine.id && host.revision >= state.revision;
  const reviewProposal = () => {
    const next = host && reviewedRoutineDraft(ref.current, readLocal<RoutineEditorDraft>(key), routine.id, snapshot.epoch, host, rejected.current);
    if (!next) { setError('Another kept proposal or request changed before this review. Both are preserved; nothing was rebased.'); return; }
    if (keepResolution(next)) { setReview(false); setError('Review your proposal before saving again.'); }
  };
  const parsed = routineSchema.safeParse(v);
  const next = parsed.success ? nextScheduled(parsed.data, routine.revision ? dayInZone(v.timezone) : new Date(Date.parse(`${v.startsOn}T12:00:00Z`) - 86400000).toISOString().slice(0, 10)) : null;
  return <Dialog title={occurrenceTitle ? 'Edit Future Schedule' : routine.revision ? 'Habit & repeat details' : 'Build a rhythm'} close={keepAndClose}>{occurrenceTitle && <div><button type="button" className="quiet" onClick={keepAndClose}>Back To This Occurrence</button><p className="metadata">{occurrenceTitle}. This schedule changes future occurrences after today in {routine.value.timezone.replaceAll('_', ' ')}. This occurrence, its checklist, children, dates and history stay unchanged.</p></div>}{navigationError && <p role="alert">{navigationError}</p>}<form onSubmit={e => { e.preventDefault(); void submit(); }}><fieldset disabled={busy || !!state.pending}><label>Name<input autoFocus required maxLength={300} value={v.title} onChange={e => change({ title: e.target.value })} placeholder="Read a chapter, review the week…"/></label><label>Notes<textarea rows={2} maxLength={10000} value={v.notes} onChange={e => change({ notes: e.target.value })}/></label><div className="form-grid"><label>Type<select disabled={!!routine.revision} value={v.kind} onChange={e => change({ kind: e.target.value as Routine['kind'] })}><option value="habit">Habit</option><option value="task">Repeating task</option></select></label><label>Series state<select value={v.state} onChange={e => change({ state: e.target.value as Routine['state'] })}><option value="active">Active</option><option value="paused">Paused</option></select></label></div><div className="form-grid"><label>Start date<input type="date" required disabled={!!routine.revision} min={dayInZone(v.timezone)} value={v.startsOn} onChange={e => change({ startsOn: e.target.value })}/></label><label>Timezone<select disabled={!!routine.revision} value={v.timezone} onChange={e => change({ timezone: e.target.value })}>{[...new Set([v.timezone, snapshot.layout.value.timezone, 'UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Asia/Tokyo'])].map(zone => <option key={zone}>{zone}</option>)}</select></label></div><div className="form-grid"><label>Repeat<select value={v.cadence} onChange={e => change({ cadence: e.target.value as Routine['cadence'], ...(!['monthly', 'yearly'].includes(e.target.value) ? { monthDays: undefined } : {}) })}><option value="daily">Every day</option><option value="weekly">Days of the week</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label><label>Planned time<input type="time" value={v.plannedTime} onChange={e => change({ plannedTime: e.target.value })}/><small>A plan, without a deadline.</small></label></div>{v.cadence === 'weekly' && <div className="weekday-options" aria-label="Repeat on">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => <button key={day} type="button" aria-pressed={v.weekdays.includes(i)} onClick={() => change({ weekdays: v.weekdays.includes(i) ? v.weekdays.filter(d => d !== i) : [...v.weekdays, i] })}>{day}</button>)}</div>}<div className="form-grid"><label>Every<input type="number" min={1} max={100} required value={v.interval ?? 1} onChange={e => change({ interval: Number(e.target.value) })}/><small>{v.cadence === 'daily' ? 'days' : v.cadence === 'weekly' ? 'Monday-based weeks' : v.cadence === 'monthly' ? 'months' : 'years'}</small></label><label>End date (optional)<input type="date" min={v.startsOn} value={v.endsOn ?? ''} onChange={e => change({ endsOn: e.target.value || undefined })}/></label></div>
    {['monthly', 'yearly'].includes(v.cadence) && <><div className="form-grid">{v.cadence === 'yearly' && <label>Month<select value={v.month ?? Number(v.startsOn.slice(5, 7))} onChange={e => change({ month: Number(e.target.value) })}>{Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, i, 1)))}</option>)}</select></label>}<label>On<select value={v.monthDays ? 'dates' : v.monthPattern ?? 'date'} onChange={e => change(e.target.value === 'dates' ? { monthPattern: 'date', monthDays: [v.monthDay ?? Number(v.startsOn.slice(8))], monthDay: undefined } : { monthPattern: e.target.value as Routine['monthPattern'], monthDays: undefined })}><option value="date">Day of the month</option><option value="dates">Several days of the month</option><option value="weekday">Weekday of the month</option></select></label></div>{v.monthPattern === 'weekday' ? <div className="form-grid"><label>Which week<select value={v.ordinal ?? 1} onChange={e => change({ ordinal: Number(e.target.value) as Routine['ordinal'] })}>{[[1, 'First'], [2, 'Second'], [3, 'Third'], [4, 'Fourth'], [5, 'Fifth'], [-1, 'Last']].map(([n, label]) => <option key={n} value={n}>{label}</option>)}</select></label><label>Weekday<select value={v.weekday ?? new Date(`${v.startsOn}T12:00:00Z`).getUTCDay()} onChange={e => change({ weekday: Number(e.target.value) })}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, i) => <option key={day} value={i}>{day}</option>)}</select></label></div> : <>{v.monthDays && <fieldset className="monthday-field"><legend>Days of the month</legend><div className="weekday-options monthday-options">{[...Array.from({ length: 31 }, (_, i) => i + 1), -1].map(day => <button type="button" key={day} aria-label={day === -1 ? "Last day of the month" : `Day ${day}`} aria-pressed={v.monthDays!.includes(day)} onClick={() => change({ monthDays: v.monthDays!.includes(day) ? v.monthDays!.filter(d => d !== day) : [...v.monthDays!, day].sort((a, b) => a - b) })}>{day === -1 ? "Last" : day}</button>)}</div>{!v.monthDays.length && <small role="status">Choose at least one day.</small>}</fieldset>}<div className="form-grid">{!v.monthDays && <label>Day<input required type="number" min={1} max={31} value={v.monthDay ?? Number(v.startsOn.slice(8, 10))} onChange={e => change({ monthDay: Number(e.target.value) })}/></label>}<label>If a numbered date is missing<select value={v.missingDay ?? 'skip'} onChange={e => change({ missingDay: e.target.value as Routine['missingDay'] })}><option value="skip">Skip that date</option><option value="last-day">Use its last day</option></select></label></div></>}</>}
    <div className="form-grid"><label>Reminder time (optional)<input type="time" value={v.reminderTime ?? ''} onChange={e => change({ reminderTime: e.target.value })}/></label>{v.reminderTime && <label>If clocks repeat this time<select value={v.reminderOverlap ?? ''} onChange={e => change({ reminderOverlap: e.target.value as Routine['reminderOverlap'] || undefined })}><option value="">Keep for review</option><option value="earlier">Earlier occurrence</option><option value="later">Later occurrence</option></select></label>}</div><p className="metadata">{next ? `Next scheduled: ${next}` : parsed.success ? 'No next date matches this rule.' : 'Complete the schedule fields to preview the next date.'} A reminder at a skipped clock time stays visible for review.</p>
    <div className="form-grid"><label>Project<select value={v.projectId ?? ''} onChange={e => change({ projectId: e.target.value || null })}><option value="">Personal</option><ProjectOptions snapshot={snapshot} selected={v.projectId}/></select></label><label>Estimate (minutes)<input type="number" min={0} max={1440} value={v.estimateMinutes || ''} onChange={e => change({ estimateMinutes: Number(e.target.value) })}/></label></div><label>Priority<select value={v.priority} onChange={e => change({ priority: e.target.value as Routine['priority'] })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></label></fieldset>
    <p className="metadata">Each scheduled day keeps its own history. Pausing stops new occurrences after today; resuming begins with the next scheduled day. Existing and missed steps stay available.</p>
    {(error || problem) && <div className="notice warning" role="alert"><div><p>{error || problem}</p>{canReview && <><p>Current host: {host?.value.title ?? 'Unavailable'} · {host?.value.state ?? 'Review needed'}</p><button type="button" onClick={reviewProposal}>Review my kept proposal</button></>}</div></div>}
    {!!routine.revision && <details><summary>Series history</summary><ul className="task-history">{snapshot.taskState?.routineEvents.filter(e => e.routineId === routine.id).map(e => <li key={e.id}>{e.state === 'paused' ? 'Paused' : 'Active'} · {new Date(e.at).toLocaleString()} · revision {e.revision}</li>)}</ul></details>}
    <div className="dialog-footer"><span className="metadata">{state.pending ? 'Checking original save' : 'Draft kept on this device'}</span><button type="button" onClick={keepAndClose}>{occurrenceTitle ? 'Back To This Occurrence' : 'Keep for later'}</button><button type="submit" className="primary" disabled={busy || review || !!problem || (!state.pending && !parsed.success)}><Save size={17}/>{busy ? 'Saving…' : state.pending ? 'Reconcile save' : 'Save series'}</button></div></form></Dialog>;
}
