import { ProjectOptions } from './ProjectOptions';
import { TaskFamily } from './TaskFamily';
import { SubtaskFields } from './SubtaskFields';
import { syncTaskSubtasks } from '../../../packages/domain/task-subtasks';
import { TaskHistory } from './TaskHistory';
import { TaskAssistantWork } from './TaskAssistantWork';
import { adoptTaskConfirmation } from './task-editor-confirmation';
import { TaskWorkReview } from './TaskWorkReview';
import { workResultPayload } from '../../../packages/domain/task-work';
import { useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { AlertCircle, Save } from './icons';
import type { Command, Entity, Snapshot, Task } from '../../../packages/domain/contracts';
import { ApiError, commit, readLocal, saveLocal } from './api';
import { dayInZone, nextDay, statusNames } from '../../../packages/domain/tasks';
import { TaskDetailsShell } from './TaskDetailsShell';
import { confirmedTaskDraft, reopenedTaskConfirmation, type TaskSection } from './task-editor-navigation';
import type { TaskEditorDraft } from './task-editor-confirmation';
import './task-details.css';

export function TaskEditor({ task, snapshot, close, saved, openOrigin, openTask, newTask, section: initialSection = 'details', scroll = 0, sectionScroll, keepView, back, backLabel, navigationError, registerDeparture }: {
  task: Entity<Task>; snapshot: Snapshot; close(): void; saved(task: Entity<Task>, clean: boolean): void;
  openTask?(task: Entity<Task>): void; newTask?(defaults: Partial<Task>): void; openOrigin?(origin: NonNullable<Task['origin']>): void;
  section?: TaskSection; scroll?: number; keepView?(section: TaskSection, scroll: number): boolean; back?(): void; backLabel?: string; navigationError?: string;
  registerDeparture?(guard: () => boolean): () => void;
  sectionScroll?: Partial<Record<TaskSection, number>>;
}) {
  const key = `e3:task-editor:${snapshot.deviceId}:${task.id}`;
  const initial: TaskEditorDraft = task.value.trashed ? { value: task.value, revision: task.revision, epoch: snapshot.epoch } : readLocal<TaskEditorDraft>(key) ?? { value: task.value, revision: task.revision, epoch: snapshot.epoch };
  const [state, setState] = useState(initial); const ref = useRef(state);
  const [section, setSection] = useState<TaskSection>(initialSection), [historyOpen, setHistoryOpen] = useState(initialSection === 'history'), [storageError, setStorageError] = useState(false);
  const body = useRef<HTMLDivElement>(null), mounted = useRef(true), panelId = useId();
  const positions = useRef({ ...sectionScroll, [initialSection]: scroll });
  useEffect(() => { mounted.current = true; if (body.current) body.current.scrollTop = scroll; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (body.current) body.current.scrollTop = positions.current[section] ?? 0; }, [section]);
  const [reviewAttemptId, setReviewAttemptId] = useState<string | null>(null);
  const [confirmedTask, setConfirmedTask] = useState(task);
  const [launchPending, setLaunchPending] = useState(false); const launchPendingRef = useRef(false), saving = useRef(false);
  const dirty = JSON.stringify(state.value) !== JSON.stringify(confirmedTask.value);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(initial.epoch !== snapshot.epoch ? 'This draft belongs to an earlier workspace. Its original save is kept for review.' : ''); const [conflict, setConflict] = useState<Entity<Task> | null>(null); const [needsReview, setNeedsReview] = useState(initial.epoch !== snapshot.epoch);
  const persist = (next: typeof state) => { ref.current = next; setState(next); const kept = saveLocal(key, next); setStorageError(!kept); if (!kept) setError('Browser storage is full. Keep this window open until your edits can be kept.'); return kept; };
  useEffect(() => {
    const next = reopenedTaskConfirmation(ref.current, readLocal<TaskEditorDraft>(key));
    if (!next || !saveLocal(key, next.draft)) return;
    ref.current = next.draft; setState(next.draft); setConfirmedTask(next.confirmed);
    if (task.revision > next.confirmed.revision) { setNeedsReview(true); setConflict(task); setError('Your original save was confirmed. A newer host version is available; review it before saving again.'); }
    else setError('');
  }, [task, key]);
  const change = (patch: Partial<Task>) => { persist({ ...ref.current, value: syncTaskSubtasks({ ...ref.current.value, ...patch }, ref.current.value) }); };
  const retain = () => { if (!(task.value.trashed || persist(ref.current))) { setError('Free browser storage before leaving. Your latest edits are still in this window.'); return false; } return !keepView || keepView(section, body.current?.scrollTop ?? 0); };
  const departure = useRef(retain); departure.current = retain;
  useEffect(() => registerDeparture?.(() => departure.current()), [registerDeparture]);
  const navigate = (action: () => void) => { if (retain()) action(); };
  const keepAndClose = () => navigate(close);
  const selectSection = (next: TaskSection) => {
    positions.current[section] = body.current?.scrollTop ?? 0;
    if (keepView && (!keepView(section, positions.current[section]!) || !keepView(next, positions.current[next] ?? 0))) return false;
    setSection(next); if (next === 'history') setHistoryOpen(true); return true;
  };
  const submit = async () => {
    if (saving.current || launchPendingRef.current || busy || needsReview || task.value.trashed) return false;
    const acknowledged = reopenedTaskConfirmation(ref.current, readLocal<TaskEditorDraft>(key));
    if (acknowledged) {
      if (!saveLocal(key, acknowledged.draft)) { setError('Free browser storage to keep the original save confirmation. Your writing is still open.'); return false; }
      ref.current = acknowledged.draft; setState(acknowledged.draft); setConfirmedTask(acknowledged.confirmed);
      if (task.revision > acknowledged.confirmed.revision) { setNeedsReview(true); setConflict(task); setError('Your original save was confirmed. A newer host version is available; review it before saving again.'); }
      else setError('');
      saved(acknowledged.confirmed, acknowledged.clean && task.revision <= acknowledged.confirmed.revision); return true;
    }
    const command = ref.current.pending ?? { requestId: crypto.randomUUID(), epoch: ref.current.epoch, kind: 'task' as const, entityId: task.id, expectedRevision: ref.current.revision, payload: ref.current.value };
    if (!saveLocal(key, { ...ref.current, pending: command })) { setError('Cannot preserve the save request in this browser. Free browser storage before trying again.'); return false; }
    persist({ ...ref.current, pending: command }); saving.current = true; setBusy(true); setError('');
    try {
      const confirmed = await commit<Task>(command), retained = readLocal<TaskEditorDraft>(key);
      const next = confirmedTaskDraft(retained, command, confirmed) ?? (mounted.current ? reopenedTaskConfirmation(ref.current, retained) : undefined);
      // Only our still-matching original journal may adopt this acknowledgement.
      // The current editor may already be a child, or have newer writing for this task.
      if (!next) { saved(confirmed, false); return true; }
      if (!saveLocal(key, next.draft)) {
        if (mounted.current) setError('The host confirmed this save, but this browser could not keep the confirmation. Check the original save before leaving.');
        saved(confirmed, false); return false;
      }
      if (mounted.current) { ref.current = next.draft; setState(next.draft); setConfirmedTask(confirmed); }
      saved(confirmed, next.clean); return true;
    }
    catch (reason) {
      if (!mounted.current) return false;
      setError(reason instanceof Error ? reason.message : 'The host has not confirmed this save.');
      if (reason instanceof ApiError) {
        if (reason.code === 'revision_conflict' || reason.code === 'epoch_changed') { setNeedsReview(true); setConflict(reason.current as Entity<Task> ?? null); }
        else if (reason.code === 'task_work_changed') {
          const { workLink: proposal, ...writing } = ref.current.value;
          persist({ ...ref.current, value: { ...writing, ...(confirmedTask.value.workLink ? { workLink: confirmedTask.value.workLink } : {}) }, pending: undefined });
        }
        else if (reason.code === 'task_work_result_changed') {
          const { workResult: proposal, ...writing } = ref.current.value;
          persist({ ...ref.current, value: { ...writing, ...(confirmedTask.value.workResult ? { workResult: confirmedTask.value.workResult } : {}) }, pending: undefined });
        }
        else if (['validation', 'invalid_time', 'invalid_reminder_time', 'missing_project', 'invalid_dependency', 'dependency_open', 'checklist_open', 'invalid_occurrence', 'task_trashed', 'task_required', 'invalid_parent', 'task_has_children'].includes(reason.code)) persist({ ...ref.current, pending: undefined });
      }
      return false;
    } finally { saving.current = false; if (mounted.current) setBusy(false); }
  };
  const tabs: { id: TaskSection; label: string }[] = [{ id: 'details', label: 'Details' }, { id: 'dates', label: 'Dates & Reminders' }, { id: 'history', label: 'History' }];
  const locked = busy || launchPending || !!state.pending || !!task.value.trashed;
  const zones = (value?: string) => [...new Set([value ?? snapshot.layout.value.timezone, 'UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Asia/Tokyo'])];
  return <TaskDetailsShell title={task.revision ? 'Task Details' : 'Add Task'} close={keepAndClose}>
    <div className="task-details-return">{back && <button type="button" className="quiet" onClick={() => navigate(back)}>{backLabel ?? 'Back'}</button>}<span className="metadata">{task.revision ? `Saved Version ${confirmedTask.revision}` : 'New Task Draft'}</span></div>
    <div className="task-details-tabs" role="tablist" aria-label="Task Details Sections">{tabs.map((tab, index) => <button key={tab.id} type="button" role="tab" id={`${panelId}-tab-${tab.id}`} aria-controls={`${panelId}-${tab.id}`} aria-selected={section === tab.id} tabIndex={section === tab.id ? 0 : -1}
      onClick={() => selectSection(tab.id)} onKeyDown={event => {
        const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : -1;
        if (target < 0) return; event.preventDefault(); if (selectSection(tabs[target].id)) document.getElementById(`${panelId}-tab-${tabs[target].id}`)?.focus();
      }}>{tab.label}</button>)}</div>
    {navigationError && <p className="task-details-navigation-notice" role="alert">{navigationError}</p>}
    <form className="task-editor task-details-form" onInvalidCapture={event => {
      event.preventDefault(); const field = event.target as HTMLInputElement, target = field.closest<HTMLElement>('[data-task-section]')?.dataset.taskSection as TaskSection | undefined;
      setError(field.validationMessage || 'Review this field before saving.');
      const disclosure = field.closest('details'); if (disclosure) disclosure.open = true;
      if (target) flushSync(() => { setSection(target); if (target === 'history') setHistoryOpen(true); });
      requestAnimationFrame(() => field.focus());
    }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.requestSubmit(); } }} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="task-details-body" ref={body}>
        <section role="tabpanel" id={`${panelId}-details`} aria-labelledby={`${panelId}-tab-details`} data-task-section="details" hidden={section !== 'details'}>
          {task.value.origin && openOrigin && <div className="notice"><span>Linked {task.value.origin.kind} · Source Version {task.value.origin.revision}</span><button type="button" onClick={() => navigate(() => openOrigin(task.value.origin!))}>Open Source</button></div>}
          <fieldset disabled={locked}>
            <label>Title<input autoFocus={initialSection === 'details'} value={state.value.title} required maxLength={300} onChange={event => change({ title: event.target.value })} placeholder="A clear next step"/></label>
            <label>Notes<textarea rows={4} value={state.value.notes} maxLength={10000} onChange={event => change({ notes: event.target.value })} placeholder="Context, a useful link, or where to begin"/></label>
            <div className="form-grid"><label>Status<select value={state.value.status} onChange={event => change({ status: event.target.value as Task['status'] })}>{Object.entries(statusNames).filter(([status]) => status !== 'skipped' || snapshot.taskState?.occurrences.some(occurrence => occurrence.taskId === task.id)).map(([status, name]) => <option key={status} value={status}>{name}</option>)}</select></label><label>Priority<select value={state.value.priority ?? 'normal'} onChange={event => change({ priority: event.target.value as Task['priority'] })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></label></div>
            {(state.value.status === 'waiting' || state.value.status === 'blocked') && <label>Waiting On<input maxLength={1000} value={state.value.waitReason ?? ''} onChange={event => change({ waitReason: event.target.value })} placeholder="The next checkpoint or missing prerequisite"/></label>}
            <div className="form-grid"><label>Project<select value={state.value.projectId ?? ''} onChange={event => change({ projectId: event.target.value || null })}><option value="">Personal</option><ProjectOptions snapshot={snapshot} selected={state.value.projectId}/></select></label><label>Estimate (Minutes)<input type="number" min={0} max={1440} value={state.value.estimateMinutes || ''} onChange={event => change({ estimateMinutes: Number(event.target.value) })}/></label></div>
            {!state.value.planned && <label>Keep In<select value={state.value.bucket ?? 'capture'} onChange={event => change({ bucket: event.target.value as Task['bucket'] })}><option value="capture">Unsorted · Plan Later</option><option value="anytime">Anytime · No Planned Date</option></select></label>}
            <SubtaskFields owner={task.id} value={state.value} change={change} snapshot={snapshot}/>
            <TaskFamily task={task} value={state.value} snapshot={snapshot} change={change} openTask={openTask ? next => navigate(() => openTask(next)) : undefined} newTask={newTask ? defaults => navigate(() => newTask(defaults)) : undefined}/>
            <details className="task-more"><summary>Prerequisites & Source Links</summary><div className="task-detail-fields">
              <label>Add A Prerequisite<select value="" onChange={event => { if (event.target.value) change({ dependencies: [...(state.value.dependencies ?? []), event.target.value] }); }}><option value="">Choose A Task</option>{snapshot.tasks.filter(item => item.id !== task.id && !state.value.dependencies?.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.value.title}</option>)}</select></label>
              {state.value.dependencies?.map(id => <div className="task-dependency" key={id}><span>{snapshot.tasks.find(item => item.id === id)?.value.title ?? 'Unavailable Prerequisite'}</span><button type="button" aria-label={`Remove prerequisite ${snapshot.tasks.find(item => item.id === id)?.value.title ?? id}`} onClick={() => change({ dependencies: state.value.dependencies!.filter(item => item !== id) })}>Remove</button></div>)}
              {(state.value.sources ?? []).map((source, index) => <div className="source-edit" key={index}><label>Source Name<input required maxLength={100} value={source.label} onChange={event => change({ sources: state.value.sources!.map((item, n) => n === index ? { ...item, label: event.target.value } : item) })}/></label><label>Source URL<input type="url" required maxLength={2000} value={source.url} onChange={event => change({ sources: state.value.sources!.map((item, n) => n === index ? { ...item, url: event.target.value } : item) })}/></label>{/^https?:\/\//.test(source.url) && <a href={source.url} target="_blank" rel="noreferrer">Open Source</a>}<button type="button" onClick={() => change({ sources: state.value.sources!.filter((_, n) => n !== index) })}>Remove Source</button></div>)}
              <button type="button" disabled={(state.value.sources?.length ?? 0) >= 10} onClick={() => change({ sources: [...(state.value.sources ?? []), { label: '', url: '' }] })}>Add Source Link</button>
              <p className="metadata">Links keep their original addresses. Opening a link does not import its contents.</p>
            </div></details>
          </fieldset>
          <TaskAssistantWork taskId={task.id} key={`${snapshot.deviceId}:${snapshot.epoch}:${task.id}`} taskRevision={state.revision} value={state.value} snapshot={snapshot} dirty={dirty} saved={task.revision > 0 && !task.value.trashed} openOrigin={openOrigin ? origin => navigate(() => openOrigin(origin)) : undefined} blocked={busy || !!state.pending || needsReview || state.epoch !== snapshot.epoch || !!reviewAttemptId}
            onPendingChange={pending => { launchPendingRef.current = pending; setLaunchPending(pending); }}
            onTaskConfirmed={(entity, captured) => { const current = ref.current; const next = adoptTaskConfirmation(current, captured, entity, snapshot.epoch); if (next !== current && !persist(next)) return false; if (next.epoch !== snapshot.epoch || next.pending || next.revision < entity.revision) { setError('Review the kept task draft before continuing this Assistant request.'); return false; } setConfirmedTask(previous => entity.revision > previous.revision ? entity : previous); return true; }}
            onLinkWork={plan => { if (dirty || busy || launchPendingRef.current || ref.current.pending || needsReview) return; change({ workLink: { assignmentId: plan.id, assignmentRevision: plan.revision, taskRevision: ref.current.revision } }); void submit(); }} onReview={id => setReviewAttemptId(id)}/>
        </section>
        <section role="tabpanel" id={`${panelId}-dates`} aria-labelledby={`${panelId}-tab-dates`} data-task-section="dates" hidden={section !== 'dates'}>
          <fieldset disabled={locked}>
            <div className="form-grid"><label>Planned Date<input type="date" value={state.value.planned} onChange={event => change({ planned: event.target.value, plannedTime: event.target.value ? state.value.plannedTime : '' })}/><small>When you intend to work on it.</small></label><label>Deadline<input type="date" value={state.value.due} onChange={event => change({ due: event.target.value, dueTime: event.target.value ? state.value.dueTime : '' })}/><small>The actual deadline, if there is one.</small></label></div>
            <div className="task-date-shortcuts"><button type="button" onClick={() => change({ planned: dayInZone(snapshot.layout.value.timezone) })}>Today</button><button type="button" onClick={() => change({ planned: nextDay(dayInZone(snapshot.layout.value.timezone)) })}>Tomorrow</button><button type="button" onClick={() => change({ planned: '', plannedTime: '', bucket: 'anytime' })}>Anytime</button></div>
            <div className="form-grid"><label>Planned Time<input type="time" disabled={!state.value.planned} value={state.value.plannedTime ?? ''} onChange={event => change({ plannedTime: event.target.value, timezone: state.value.timezone ?? snapshot.layout.value.timezone })}/></label><label>Deadline Time<input type="time" disabled={!state.value.due} value={state.value.dueTime ?? ''} onChange={event => change({ dueTime: event.target.value, timezone: state.value.timezone ?? snapshot.layout.value.timezone })}/></label></div>
            <label>Task Timezone<select value={state.value.timezone ?? snapshot.layout.value.timezone} onChange={event => change({ timezone: event.target.value })}>{zones(state.value.timezone).map(zone => <option key={zone}>{zone}</option>)}</select></label>
            <section className="task-reminder-fields" aria-label="Reminder"><h3>Reminder</h3>{state.value.reminder ? <>
              <div className="form-grid"><label>Reminder Date<input required type="date" value={state.value.reminder.date} onChange={event => change({ reminder: { ...state.value.reminder!, date: event.target.value } })}/></label><label>Reminder Time<input required type="time" value={state.value.reminder.time} onChange={event => change({ reminder: { ...state.value.reminder!, time: event.target.value } })}/></label></div>
              <label>Reminder Timezone<select value={state.value.reminder.timezone} onChange={event => change({ reminder: { ...state.value.reminder!, timezone: event.target.value } })}>{zones(state.value.reminder.timezone).map(zone => <option key={zone}>{zone}</option>)}</select></label>
              <label>If Clocks Repeat This Time<select value={state.value.reminder.overlap ?? ''} onChange={event => change({ reminder: { ...state.value.reminder!, overlap: event.target.value as 'earlier' | 'later' || undefined } })}><option value="">Ask Me To Choose</option><option value="earlier">Earlier Occurrence</option><option value="later">Later Occurrence</option></select></label>
              <button type="button" onClick={() => change({ reminder: null })}>Remove Reminder</button>
            </> : <button type="button" onClick={() => change({ reminder: { date: state.value.planned || dayInZone(snapshot.layout.value.timezone), time: state.value.plannedTime || '09:00', timezone: state.value.timezone || snapshot.layout.value.timezone } })}>Add A Reminder</button>}
              <p className="metadata">Reminders are separate from the plan and deadline. The host keeps due alerts; device notifications need this app open and permission. Reopening a finished task does not rearm its old reminder.</p>
            </section>
          </fieldset>
        </section>
        <section role="tabpanel" id={`${panelId}-history`} aria-labelledby={`${panelId}-tab-history`} data-task-section="history" hidden={section !== 'history'}>
          <p className="metadata">Saved revisions of this exact task. Unsaved writing appears in Details and Dates & Reminders.</p>
          {task.revision > 0 ? historyOpen && <TaskHistory key={task.id} taskId={task.id}/> : <p>Save this task to begin its history.</p>}
        </section>
        {error && <div className="notice warning" role="alert"><AlertCircle size={18}/><div><p>{error}</p>{conflict && <p>Host version: <strong>{conflict.value.title}</strong> · {conflict.value.status}</p>}{needsReview && state.epoch === snapshot.epoch && <button type="button" onClick={() => { persist({ ...ref.current, revision: conflict?.revision ?? 0, epoch: snapshot.epoch, pending: undefined }); setNeedsReview(false); setError('Your proposal is ready for an explicit save.'); }}>Keep My Proposal For Review</button>}</div></div>}
      </div>
      <footer className="dialog-footer task-details-footer"><span className="metadata" role="status">{task.value.trashed ? 'Restore this task from Trash to edit it' : storageError ? 'Keep this window open · browser storage is full' : launchPending ? 'Checking the original Assistant request · edits paused' : state.pending ? 'Original save unconfirmed · edits paused' : dirty || !task.revision ? 'Draft kept on this device · not saved yet' : 'Saved on the host'}</span><button type="button" className="quiet" onClick={keepAndClose}>{task.value.trashed ? 'Close' : 'Keep For Later'}</button><button type="submit" className="primary" disabled={busy || launchPending || !!task.value.trashed || needsReview || !state.value.title.trim()}><Save size={17}/>{busy ? 'Saving…' : state.pending ? 'Check Save' : 'Save Task'}</button></footer>
    </form>
    {reviewAttemptId && <TaskWorkReview draftValue={ref.current.value} attemptId={reviewAttemptId} close={() => setReviewAttemptId(null)} pending={!!state.pending} saveError={error} acceptedAttemptId={confirmedTask.value.workResult?.attemptId} onAccept={async attempt => { if (saving.current || launchPendingRef.current || busy || needsReview) return false; if (!ref.current.pending) change({ workResult: workResultPayload(attempt, Date.now()) }); return submit(); }}/>}
  </TaskDetailsShell>;
}
