import { useEffect, useRef, useState } from 'react';
import { commandSchema, taskSchema, type Entity, type Snapshot, type Task } from '../../../packages/domain/contracts';
import { routineSchema } from '../../../packages/domain/tasks';
import { taskBlockers, taskSearch } from '../../../packages/domain/task-presentation';
import { taskProgressLabel } from './task-list-view';
import { Home as HomeIcon, Plus, Search, X } from './icons';
import { Dialog } from './ui';
import { TaskOccurrenceDetails } from './TaskOccurrenceDetails';
import { usePlanningClock } from './usePlanningClock';
import { retainedWindowId } from './useWorkspace';
import { mayLeaveHomeDraft, registerHomeDraftNavigation } from './home-draft-navigation';
import type { useTaskActions } from './useTaskActions';
import { homePlanChanges, homeQuickTask, homeTodayState, newHomePlan, readHomePlan, readHomeQuick, taskEstimate, type HomePlan, type HomeQuick } from './home-today-state';
import './home-today.css';

export type HomeTaskActions = ReturnType<typeof useTaskActions>;
function raw(key: string) { try { return localStorage.getItem(key); } catch { return undefined; } }
function persist(key: string, expected: string | null | undefined, value: unknown) {
 const encoded = JSON.stringify(value), current = localStorage.getItem(key);
 // A previous write may have succeeded even when its verification read failed.
 if (current === encoded) return encoded;
 if (expected === undefined) throw Error('Browser storage is unavailable. Keep this window open.');
 if (current !== expected) throw Error('This retained draft changed in another view. Your writing stays open; review it before replacing another version.');
 localStorage.setItem(key, encoded);
 if (localStorage.getItem(key) !== encoded) throw Error('The retained draft could not be verified. Keep this window open.');
 return encoded;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function retainedOwner(key: string) {
 const value = raw(key);
 if (value === undefined) throw Error('Retained task writing could not be checked. Your capture and original drafts are preserved; retry when browser storage is readable.');
 if (value === null) return undefined;
 try { const parsed: unknown = JSON.parse(value);if (parsed === null) return undefined;if (object(parsed)) return parsed; } catch { /* Preserve malformed original bytes. */ }
 throw Error('Retained task writing needs review. Your capture and original drafts are preserved; no task was added.');
}
function taskEditorOwner(value: Record<string, unknown>, taskId: string) {
 if (typeof value.epoch !== 'string' || !value.epoch || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !object(value.value)) return false;
 // Empty titles and unfinished date text still belong to the original editor.
 const draft = value.value;
 if (!['title', 'planned', 'due'].every(key => typeof draft[key] === 'string') || !taskSchema.safeParse({ ...draft, title: 'Retained task', planned: '', due: '' }).success) return false;
 if (value.pending !== undefined) {
  const parsed = commandSchema.safeParse(value.pending);
  if (!parsed.success || parsed.data.kind !== 'task' || parsed.data.entityId !== taskId || parsed.data.epoch !== value.epoch || parsed.data.expectedRevision !== value.revision) return false;
 }
 if (value.confirmation !== undefined) {
  const confirmation = value.confirmation;
  if (!object(confirmation) || typeof confirmation.requestId !== 'string' || !object(confirmation.task) || confirmation.task.id !== taskId || !Number.isSafeInteger(confirmation.task.revision) || !taskSchema.safeParse(confirmation.task.value).success) return false;
 }
 return true;
}
function newRoutineOwner(value: Record<string, unknown>) {
 if (typeof value.id !== 'string' || !value.id.startsWith('routine:') || value.revision !== 0 || typeof value.deviceId !== 'string' || typeof value.updatedAt !== 'string' || !object(value.value) || typeof value.value.title !== 'string' || !routineSchema.safeParse({ ...value.value, title: 'Retained routine' }).success) return false;
 return value.quickSource === undefined || (object(value.quickSource) && typeof value.quickSource.id === 'string' && typeof value.quickSource.title === 'string');
}
export function HomeToday({ snapshot, actions, editTask, openTasks, openLibrary, openIdeas }: {
 snapshot: Snapshot; actions?: HomeTaskActions; editTask: (task: Entity<Task>) => void;
 openTasks: () => void; openLibrary: () => void; openIdeas: () => void;
}) {
 const now = usePlanningClock(), today = homeTodayState(snapshot, now);
 const scope = `${snapshot.epoch}:${snapshot.deviceId}:${retainedWindowId}`, quickKey = `e3:quick-task:${snapshot.epoch}:${snapshot.deviceId}`, planKey = `e3:home-today-plan:${scope}`;
 const readQuick = () => { const original = raw(quickKey);return { scope, raw: original, value: original && original !== 'null' ? readHomeQuick(original) : { id: 'task:' + crypto.randomUUID(), title: '' } }; };
 const readPlan = () => { const original = raw(planKey);return { scope, raw: original, value: original && original !== 'null' ? readHomePlan(original) : newHomePlan(snapshot, Date.now()) }; };
 const [quick, setQuick] = useState(readQuick), [plan, setPlan] = useState(readPlan);
 const [adding, setAdding] = useState(false), [planning, setPlanning] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [limit, setLimit] = useState(50), [planLimit, setPlanLimit] = useState(50);
 const input = useRef<HTMLInputElement>(null), addTrigger = useRef<HTMLButtonElement>(null), flight = useRef(false);
 const unkept = useRef<Record<string, { kind: 'quick' | 'plan'; original: string | null | undefined; value: HomeQuick | HomePlan }>>({});
 const owner = useRef({ scope, mounted: true, snapshot, actions });owner.current = { ...owner.current, scope, snapshot, actions };
 useEffect(() => { owner.current.mounted = true;return () => { owner.current.mounted = false; }; }, [scope]);
 useEffect(() => registerHomeDraftNavigation(() => {
  if (!owner.current.mounted || !Object.keys(unkept.current).length) return true;
  setError('Keep this writing before leaving Home. Retry Keeping Writing after browser storage is available.');return false;
 }), []);
 useEffect(() => { if (quick.scope !== scope) { setQuick(readQuick());setPlan(readPlan());setAdding(false);setPlanning(false);setError('');setNotice(''); } }, [scope, quick.scope]);
 useEffect(() => { if (adding) input.current?.focus(); }, [adding]);
 const current = () => owner.current.mounted && owner.current.scope === scope;
 const busy = !actions || actions.busy || actions.state.queue.length > 0;
 const quickValue = quick.scope === scope ? quick.value : undefined, planValue = plan.scope === scope ? plan.value : undefined;
 const savedQuick = quickValue && snapshot.tasks.find(task => task.id === quickValue.id);
 const changeQuick = (value: HomeQuick) => {
  if (!current()) return false;
  try { const encoded = persist(quickKey, quick.raw, value);delete unkept.current[quickKey];setQuick({ scope, raw: encoded, value });setError('');return true; }
  catch (reason) { unkept.current[quickKey] = { kind: 'quick', original: quick.raw, value };setQuick(previous => ({ ...previous, value }));setError(reason instanceof Error ? reason.message : 'Your writing could not be kept. Keep this window open.');return false; }
 };
 const changePlan = (value: HomePlan) => {
  if (!current()) return false;
  try { const encoded = persist(planKey, plan.raw, value);delete unkept.current[planKey];setPlan({ scope, raw: encoded, value });setError('');return true; }
  catch (reason) { unkept.current[planKey] = { kind: 'plan', original: plan.raw, value };setPlan(previous => ({ ...previous, value }));setError(reason instanceof Error ? reason.message : 'Your plan could not be kept. Keep this window open.');return false; }
 };
 const retryKeeping = () => {
  if (!current()) return;
  try {
   for (const [key, kept] of Object.entries(unkept.current)) {
    // A workspace change must never redirect older writing into the new keys.
    const expected = kept.original === undefined && raw(key) === null ? null : kept.original;
    const encoded = persist(key, expected, kept.value);delete unkept.current[key];
    if (kept.kind === 'quick' && key === quickKey) setQuick({ scope, raw: encoded, value: kept.value as HomeQuick });
    if (kept.kind === 'plan' && key === planKey) setPlan({ scope, raw: encoded, value: kept.value as HomePlan });
   }
   setError('');setNotice('Writing kept on this device.');
  } catch (reason) { setError(reason instanceof Error ? reason.message : 'Keep this window open.'); }
 };
 const leave = (next: () => void) => { if (current() && mayLeaveHomeDraft()) next(); };
 const add = async () => {
  if (!quickValue || busy || flight.current || !current() || !quickValue.title.trim()) return;
  if (!changeQuick(quickValue)) return;
  const latest = owner.current.snapshot;
  const saved = latest.tasks.find(task => task.id === quickValue.id);
  if (saved) { leave(() => editTask(saved));return; }
  let task: Entity<Task>;
  try { task = homeQuickTask(quickValue, latest, Date.now()); }
  catch (reason) { setError((reason as Error).message);return; }
  try {
   const retainedEditor = retainedOwner(`e3:task-editor:${latest.deviceId}:${quickValue.id}`);
   if (retainedEditor) {
    if (!taskEditorOwner(retainedEditor, quickValue.id)) throw Error('The retained Task Details draft needs review. Its original writing and your capture are preserved; no task was added.');
    leave(() => editTask(task));return;
   }
   const routine = retainedOwner(`e3:new-routine:${latest.deviceId}`);
   if (routine && !newRoutineOwner(routine)) throw Error('The retained repeating-task draft needs review. Its original writing and your capture are preserved; no task was added.');
   if (object(routine?.quickSource) && routine.quickSource.id === quickValue.id && routine.quickSource.title === quickValue.title) { setNotice('A repeating-task draft already uses this capture. In Tasks, open Repeating Task from the capture options to continue it.');return; }
  } catch (reason) { setError(reason instanceof Error ? reason.message : 'Retained task writing could not be checked. Your original drafts are preserved.');return; }
  flight.current = true;setError('');
  try {
   const submitted = JSON.stringify(quickValue), success = await actions!.run([{ task, value: task.value }], 'Task added to today');
   if (!current()) return;
   if (success && raw(quickKey) === submitted) {
    const next = { id: 'task:' + crypto.randomUUID(), title: '' };
    const encoded = persist(quickKey, submitted, next);setQuick({ scope, raw: encoded, value: next });setNotice('Task added.');input.current?.focus();
   } else if (success) setNotice('Task added. Newer capture writing remains kept.');
  } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : 'The original task save remains available for review.'); }
  finally { flight.current = false; }
 };
 const applyPlan = async () => {
  if (!planValue || busy || flight.current || !current()) return;
  try {
   const changes = homePlanChanges(planValue, owner.current.snapshot, Date.now());
   if (!changes.length) { setNotice('No planning dates need to change.');return; }
   if (!changePlan(planValue)) return;
   flight.current = true;const submitted = JSON.stringify(planValue);
   const success = await actions!.run(changes, `Planning dates updated for ${planValue.date}`);
   if (!current()) return;
   if (success && raw(planKey) === submitted) {
    const next = newHomePlan(owner.current.snapshot, Date.now()), encoded = persist(planKey, submitted, next);
    setPlan({ scope, raw: encoded, value: next });setPlanning(false);setNotice('Planning dates updated. Deadlines are unchanged.');
   }
  } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : 'Review the original task changes.'); }
  finally { flight.current = false; }
 };
 const selected = today.candidates.filter(task => planValue?.changes.find(row => row.id === task.id)?.selected ?? task.value.planned === today.date);
 const selectedEstimate = taskEstimate(selected), totals = taskEstimate(today.tasks);
 const planRows = today.candidates.filter(task => taskSearch(task.value, planValue?.query ?? '', snapshot.projects.find(project => project.id === task.value.projectId)?.value.name));
 const togglePlan = (task: Entity<Task>, checked: boolean) => {
  if (!planValue || busy) return;
  const changes = [...planValue.changes.filter(row => row.id !== task.id), { id: task.id, revision: task.revision, selected: checked }];
  if (changes.length > 500) { setError('Apply at most 500 task changes at a time. Your current plan is kept.');return; }
  changePlan({ ...planValue, changes });
 };
 const row = (task: Entity<Task>) => {
  const finished = ['done', 'skipped'].includes(task.value.status), occurrence = today.context.occurrences.get(task.id), blockers = taskBlockers(task.value, snapshot.tasks);
  return <article className={`home-today-task${finished ? ' completed' : ''}`} key={task.id}>
   <label className="home-today-task-toggle"><input type="checkbox" checked={finished} disabled={busy} aria-label={`${finished ? 'Reopen' : 'Complete'} ${task.value.title}`} onChange={() => { if (!busy && current()) void actions!.run([{ task, value: { ...task.value, status: finished ? 'open' : 'done' } }], finished ? 'Task reopened' : 'Task completed'); }}/></label>
   <button className="home-today-task-open" onClick={() => leave(() => editTask(task))}><strong className="preserve-case">{task.value.title}</strong>
    {occurrence && <TaskOccurrenceDetails occurrence={occurrence} status={task.value.status}/>}
    {!occurrence && <small>{task.value.planned ? `Planned ${task.value.planned}` : task.value.bucket === 'anytime' ? 'Anytime · no planning date' : 'Unplanned'}{task.value.estimateMinutes ? ` · ${task.value.estimateMinutes} min` : ''}</small>}
    {(task.value.status === 'waiting' || task.value.status === 'blocked' || blockers.length > 0) && <small>{blockers.length ? `Waiting on ${blockers.join(', ')}` : task.value.waitReason || task.value.status}</small>}
    {task.value.due && <small>Deadline {task.value.due}{task.value.dueTime ? ` at ${task.value.dueTime}` : ''}</small>}
   </button>
  </article>;
 };
 const group = (title: string, rows: Entity<Task>[]) => <section className="home-today-group" aria-label={title}><header><h2>{title}</h2><span className="metadata">{taskProgressLabel(rows.map(task => task.value.status))}</span></header>
  {rows.slice(0, limit).map(row)}{!rows.length && <p className="metadata">{title === 'Daily Routines' ? 'No daily occurrences are due in this view. Past daily history stays in Tasks.' : 'No tasks in today’s view.'}</p>}
  {rows.length > limit && <button className="compact-action compact-utility" onClick={() => setLimit(value => value + 50)}>Show {Math.min(50, rows.length - limit)} More</button>}
 </section>;
 return <section className="home-today" aria-label="Today">
  <header className="home-today-heading"><div><p className="metadata">{new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: today.timezone }).format(now)}</p><h1 className="page-title">Today</h1><p>{new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric', timeZone: today.timezone }).format(now)}</p></div>
   <div className="compact-actions"><button className="compact-action compact-utility" disabled={!actions} onClick={() => { setPlanning(true);setPlanLimit(50); }}>Plan Today</button><button ref={addTrigger} className="primary compact-action compact-utility" onClick={() => setAdding(value => !value)} aria-expanded={adding}><Plus size={16}/>Add</button></div>
  </header>
  <p className="metadata">{taskProgressLabel(today.tasks.map(task => task.value.status))} · {totals.minutes} estimated minutes{totals.missing ? ` · ${totals.missing} without an estimate` : ''}</p>
  {adding && <form className="home-today-capture" onSubmit={event => { event.preventDefault();void add(); }}>
   <label className="sr-only" htmlFor="home-quick-title">Add a task for today</label><input id="home-quick-title" ref={input} maxLength={300} value={quickValue?.title ?? ''} disabled={busy || !quickValue} placeholder="Add a task for today…" onChange={event => { if (quickValue) changeQuick({ ...quickValue, title: event.target.value }); }}/>
   <button className="compact-action compact-utility" disabled={busy || !quickValue?.title.trim()}>{savedQuick ? 'Open Task' : 'Add'}</button><button type="button" className="compact-action compact-utility compact-icon" aria-label="Keep capture and close" onClick={() => { setAdding(false);addTrigger.current?.focus(); }}><X size={16}/></button>
  </form>}
  {adding && !quickValue && <p role="alert">The original capture cannot be read. It remains in browser storage; use Task Details for new writing.</p>}
  {adding && savedQuick && <div className="notice"><span>This capture already has a saved task. Your kept title remains available.</span><button disabled={busy} onClick={() => leave(() => editTask(savedQuick))}>Open Saved Task</button><button disabled={busy} onClick={() => { if (quickValue) changeQuick({ ...quickValue, id: 'task:' + crypto.randomUUID() }); }}>Use Title For A New Task</button></div>}
  {error && <p role="alert" className="notice warning">{error}</p>}{notice && <p role="status">{notice}</p>}
  {Object.keys(unkept.current).length > 0 && <div className="home-today-unkept"><button onClick={retryKeeping}>Retry Keeping Writing</button>{Object.entries(unkept.current).map(([kind, kept]) => <details key={kind}><summary>Writing awaiting browser storage</summary><pre className="home-source-text">{JSON.stringify(kept?.value, null, 2)}</pre></details>)}</div>}
  {group('To-Do', today.todo)}{group('Daily Routines', today.routines)}
  {today.overdue.length > 0 && <details className="home-today-overdue"><summary>{today.overdue.length} overdue {today.overdue.length === 1 ? 'deadline' : 'deadlines'}</summary><p className="metadata">These are saved deadlines, separate from planning dates.</p>{today.overdue.slice(0, limit).map(row)}{today.overdue.length > limit && <button onClick={() => setLimit(value => value + 50)}>Show More Deadlines</button>}</details>}
  <div className="home-today-continue"><button onClick={() => leave(openLibrary)}><HomeIcon size={18}/><span><strong>Library</strong><small>Return to saved sources and kept writing</small></span></button><button onClick={() => leave(openIdeas)}><span><strong>Ideas</strong><small>Continue saved directions and drafts</small></span></button><button onClick={() => leave(openTasks)}><span><strong>Tasks</strong><small>All tasks, schedules and daily history</small></span></button></div>
  {planning && <Dialog title="Plan Today" close={() => setPlanning(false)}>
   <p>Choose planning dates for ordinary tasks. Daily occurrences keep their original schedule. Unchecked tasks already planned today move to Anytime and may remain in today’s task view. Deadlines stay unchanged.</p>
   <p className="metadata">{selected.length} selected · {selectedEstimate.minutes} estimated minutes{selectedEstimate.missing ? ` · ${selectedEstimate.missing} without an estimate` : ''}</p>
   {!planValue ? <p role="alert">The kept plan cannot be read. Its original data remains in browser storage.</p> : <>
    {(planValue.date !== today.date || planValue.timezone !== today.timezone) && <p role="alert">This kept plan belongs to {planValue.date} in {planValue.timezone}. Start a fresh review before applying changes.</p>}
    <label className="search-input"><Search size={16}/><input type="search" maxLength={300} value={planValue.query} onChange={event => changePlan({ ...planValue, query: event.target.value })} placeholder="Find a task" aria-label="Find tasks to plan"/></label>
    <div className="home-today-plan-list">{planRows.slice(0, planLimit).map(task => <label key={task.id}><input type="checkbox" disabled={busy} checked={planValue.changes.find(row => row.id === task.id)?.selected ?? task.value.planned === today.date} onChange={event => togglePlan(task, event.target.checked)}/><span><strong className="preserve-case">{task.value.title}</strong><small>{task.value.planned ? `Planned ${task.value.planned}` : 'No planning date'}{task.value.estimateMinutes ? ` · ${task.value.estimateMinutes} min` : ' · no estimate'}</small></span></label>)}</div>
    {!planRows.length && <p>No matching ordinary tasks. Daily routines are scheduled by their original rules.</p>}
    {planRows.length > planLimit && <button onClick={() => setPlanLimit(value => value + 50)}>Show More ({planRows.length - planLimit} Remaining)</button>}
   </>}
   {error && <p role="alert">{error}</p>}{actions?.state.error && <p role="alert">{actions.state.error}</p>}
   {actions?.state.queue.length ? <p role="status">{actions.state.undo.length} changes confirmed; {actions.state.queue.length} original changes still await confirmation. Use Retry Task Changes to reconcile those exact requests.</p> : actions?.state.notice && <p role="status">{actions.state.notice}</p>}
   <div className="button-row"><button onClick={() => setPlanning(false)}>Keep For Later</button><button disabled={busy || !planValue} onClick={() => changePlan(newHomePlan(snapshot, Date.now()))}>Start Fresh Review</button><button className="primary" disabled={busy || !planValue || !planValue.changes.length} onClick={() => void applyPlan()}>Apply Planning Dates</button></div>
  </Dialog>}
 </section>;
}
