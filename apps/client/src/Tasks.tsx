import { ComposerMenu } from './ComposerMenu';
import { TaskFilters } from './TaskFilters';
import { SubtaskFields } from './SubtaskFields';
import { calendarCompletionTarget, type CalendarCompletion } from '../../../packages/domain/calendar-completion';
import { eventDates } from '../../../packages/domain/calendar-time';
import { useCalendarCompletion } from './useCalendarCompletion';
import { syncTaskSubtasks } from '../../../packages/domain/task-subtasks';
import { useEffect, useState, type ReactNode } from 'react';
import type { Entity, Snapshot, Task } from '../../../packages/domain/contracts';
import { dayInZone, nextDay, nextScheduled, type Routine } from '../../../packages/domain/tasks';
import { orderTaskView, taskDateLabel, taskSearch, cadenceGroup, cadenceGroups, inTaskDestination, taskDestinations, type TaskDestination, type TaskSort } from '../../../packages/domain/task-presentation';
import { Check, MoreHorizontal, Plus, RefreshCw, Search, X, Trash2, ChevronDown } from './icons';
import { Empty } from './ui';
import { RoutineEditor } from './RoutineEditor';
import type { useTaskActions } from './useTaskActions';
import { useDailyOrder } from './useDailyOrder';
import { useReorder } from './useReorder';
import { useTaskCalendar } from './useTaskCalendar';
import type { CalendarTaskRow } from './task-calendar-rows';
import { calendarWindowIdentity } from './calendar-window';
import { keepCalendarTarget, keepProviderCalendarTarget } from './calendar-target';
import { addDays } from '../../../packages/domain/calendar';
import { readLocal, saveLocal } from './api';

type NewRoutineDraft = Entity<Routine> & { quickSource?: { id: string; title: string } };
type Props = { openCalendar: () => void; routineTarget: { id: string; nonce: string } | null; clearRoutineTarget: () => void; snapshot: Snapshot; newTask: (defaults?: Partial<Task>) => void; editTask: (task: Entity<Task>) => void; changeStatus: (task: Entity<Task>, status: Task['status']) => void; refresh: () => Promise<void>; actions: ReturnType<typeof useTaskActions> };
export function Tasks({ snapshot, newTask, editTask, changeStatus, refresh, actions, openCalendar, routineTarget, clearRoutineTarget }: Props) {
  const [view, setView] = useState<TaskDestination>(() => { const kept = readLocal<string>('e3:task-view'); return kept === 'Upcoming' ? 'Scheduled' : kept === 'History' ? 'Completed' : taskDestinations.includes(kept as TaskDestination) ? kept as TaskDestination : 'Today'; });
  const [trash, setTrash] = useState(false), [calendarError, setCalendarError] = useState('');
  const [project, setProject] = useState('all'), [query, setQuery] = useState(''), [priority, setPriority] = useState('all'), [status, setStatus] = useState('all');
  const [sort, setSort] = useState<TaskSort>('planned'), [selecting, setSelecting] = useState(false), [selected, setSelected] = useState<string[]>([]), [limit, setLimit] = useState(50);
  const [expandedTasks, setExpandedTasks] = useState<string[]>([]);
  const toggleSubtasks = (id: string) => setExpandedTasks(current => current.includes(id) ? current.filter(key => key !== id) : [...current, id]);
  const disclosure = (id: string, title: string, checklist: Task['checklist']) => <button className="task-subtask-progress" title="Subtasks" aria-label={`Subtasks for ${title}`} aria-expanded={expandedTasks.includes(id)} aria-controls={`subtasks-${id}`} onClick={() => toggleSubtasks(id)}>{!!checklist?.length && <span>{checklist.filter(i => i.done).length}/{checklist.length}</span>}<ChevronDown size={16}/></button>;
  const [routine, setRoutine] = useState<NewRoutineDraft | null>(null);
  useEffect(() => { if (!routineTarget) return; const found = snapshot.routines?.find(r => r.id === routineTarget.id); if (found) setRoutine(found); else setCalendarError('This repeating task is no longer available.'); clearRoutineTarget(); }, [routineTarget?.nonce]);
  const quickKey = `e3:quick-task:${snapshot.epoch}:${snapshot.deviceId}`;
  const blankQuick = () => ({ id: `task:${crypto.randomUUID()}`, title: '' });
  const [quick, setQuick] = useState(() => readLocal<{ id: string; title: string }>(quickKey) ?? blankQuick()), [quickError, setQuickError] = useState('');
  const [clock, setClock] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const today = dayInZone(snapshot.layout.value.timezone, clock), tomorrow = nextDay(today);
  const all = [...snapshot.tasks, ...(snapshot.trashedTasks ?? [])], busy = actions.busy || actions.state.queue.length > 0;
  const scoped = all.filter(t => project === 'all' || (t.value.projectId ?? '') === project);
  const eligible = scoped.filter(t => (trash ? !!t.value.trashed : !t.value.trashed && (query.trim() || inTaskDestination(t, view, today, snapshot.layout.value.timezone))) && taskSearch(t.value, query, snapshot.projects.find(p => p.id === t.value.projectId)?.value.name) && (priority === 'all' || (t.value.priority ?? 'normal') === priority) && (status === 'all' || t.value.status === status));
  const daily = useDailyOrder(snapshot, today, refresh), canOrder = view === 'Today' && sort === 'planned' && !daily.kept && !busy && !query.trim() && !trash && eligible.every(t => daily.ids.includes(t.id));
  const ordered = orderTaskView(eligible, view === 'Completed' && sort === 'planned' ? 'newest' : sort, view === 'Today' ? daily.ids : []);
  const reorder = useReorder(ordered.map(t => t.id), ids => { if (!canOrder) return; const visible = new Set(ids); let index = 0; void daily.run(daily.ids.map(id => visible.has(id) ? ids[index++] : id)); }, 'daily-tasks');
  const byId = new Map(ordered.map(task => [task.id, task]));
  const rows = reorder.order.map(id => byId.get(id)).filter((task): task is Entity<Task> => !!task), shown = rows.slice(0, limit);
  const selectedTasks = rows.filter(t => selected.includes(t.id));
  const routines = (snapshot.routines ?? []).filter(r => status === 'all' && (project === 'all' || (r.value.projectId ?? '') === project) && (priority === 'all' || r.value.priority === priority) && (!query.trim() || taskSearch({ ...r.value, status: 'open', planned: '', due: '' }, query, snapshot.projects.find(p => p.id === r.value.projectId)?.value.name)));
  const resetSelection = () => { setSelected([]); setLimit(50); };
  const chooseView = (next: TaskDestination) => { setView(next); setTrash(false); saveLocal('e3:task-view', next); setSelected([]); setSelecting(false); setLimit(50); };
  const planDefaults = (): Partial<Task> => ({ projectId: project === 'all' || !project ? null : project, planned: view === 'Today' ? today : view === 'Scheduled' ? tomorrow : '', bucket: 'capture', timezone: snapshot.layout.value.timezone });
  const update = (task: Entity<Task>, patch: Partial<Task>, label: string) => actions.run([{ task, value: { ...task.value, ...patch } }], label);
  const plan = (task: Entity<Task>, date: string) => update(task, { planned: date, ...(!date ? { plannedTime: '', bucket: 'anytime' as const } : {}) }, date ? `Planned for ${taskDateLabel(date, today).toLowerCase()}` : 'Moved to Anytime');
  const newRoutine = () => { const next = readLocal<NewRoutineDraft>(`e3:new-routine:${snapshot.deviceId}`) ?? { id: `routine:${crypto.randomUUID()}`, revision: 0, deviceId: snapshot.deviceId, updatedAt: new Date().toISOString(), quickSource: quick, value: { title: quick.title.trim(), notes: '', kind: 'task' as const, state: 'active' as const, startsOn: today, timezone: snapshot.layout.value.timezone, cadence: 'daily' as const, weekdays: [1, 2, 3, 4, 5], projectId: project === 'all' || !project ? null : project, plannedTime: '', priority: 'normal' as const, estimateMinutes: 0 } }; saveLocal(`e3:new-routine:${snapshot.deviceId}`, next); setRoutine(next); };
  useEffect(() => { if (snapshot.tasks.some(t => t.id === quick.id)) { const next = blankQuick(); setQuick(next); saveLocal(quickKey, next); } }, [snapshot.tasks, quick.id, quickKey]);
  const quickTask = (): Entity<Task> => ({ id: quick.id, revision: 0, deviceId: snapshot.deviceId, updatedAt: new Date().toISOString(), value: { title: quick.title.trim(), notes: '', status: 'open', planned: '', due: '', ...planDefaults() } });
  const addQuick = async () => {
    if (!quick.title.trim() || busy) return;
    if (!saveLocal(quickKey, quick)) { setQuickError('Free browser storage before capturing this task.'); return; }
    setQuickError(''); const task = quickTask();
    // Resume richer writing or its pending receipt instead of submitting a title-only duplicate.
    if (readLocal(`e3:task-editor:${snapshot.deviceId}:${quick.id}`)) { editTask(task); return; }
    const keptRepeat = readLocal<NewRoutineDraft>(`e3:new-routine:${snapshot.deviceId}`);
    if (keptRepeat?.quickSource?.id === quick.id && keptRepeat.quickSource.title === quick.title) { setRoutine(keptRepeat); return; }
    await actions.run([{ task, value: task.value }], 'Task added');
  };
  const batch = async (action: string) => {
    const patch: Partial<Task> = action === 'complete' ? { status: 'done' } : action === 'reopen' ? { status: 'open' } : action === 'today' ? { planned: today } : action === 'tomorrow' ? { planned: tomorrow } : action === 'anytime' ? { planned: '', plannedTime: '', bucket: 'anytime' } : action === 'high' ? { priority: 'high' } : action === 'trash' ? { trashed: true } : { trashed: false };
    await actions.run(selectedTasks.map(task => ({ task, value: { ...task.value, ...patch } })), `${selectedTasks.length} tasks updated`); setSelected([]);
  };
  const renderTask = (item: Entity<Task>) => {
        const index = rows.findIndex(t => t.id === item.id);
        const t = item.value, finished = ['done', 'skipped'].includes(t.status), occurrence = snapshot.taskState?.occurrences.find(o => o.taskId === item.id);
        return <article className={`daily-task ${finished ? 'completed' : ''} ${selected.includes(item.id) ? 'task-selected' : ''}`} key={item.id} data-reorder-group="daily-tasks" data-reorder-item={item.id}>
          <div className="task-row">{selecting ? <label className="task-select"><input type="checkbox" aria-label={`Select ${t.title}`} checked={selected.includes(item.id)} onChange={e => setSelected(e.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))}/></label> : t.trashed ? <Trash2 size={19}/> : <button className={`check-button ${t.status === 'done' ? 'checked' : ''}`} disabled={busy} aria-label={`${finished ? 'Reopen' : 'Complete'} ${t.title}`} onClick={() => changeStatus(item, finished ? 'open' : 'done')}>{t.status === 'done' && <Check size={16}/>}</button>}
          <button className="task-open" title={t.title} {...(canOrder ? reorder.bind(item.id) : {})} onKeyDown={e => { if (canOrder && e.altKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); reorder.move(item.id, index + (e.key === 'ArrowUp' ? -1 : 1)); } }} onClick={() => { if (!reorder.suppressClick.current) editTask(item); }}><strong>{t.title}</strong>{view === 'Completed' && <small className="task-parent-label">Task</small>}{t.parentTaskId && <small className="task-parent-label">Part of {all.find(parent => parent.id === t.parentTaskId)?.value.title ?? 'saved parent task'}</small>}</button>
          {disclosure(item.id, t.title, t.checklist)}{view === 'Scheduled' && <span className="task-inline-note">{taskDateLabel(t.planned, today)}</span>}<details className="task-row-menu" onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}><summary aria-label={`Actions for ${t.title}`} title="Task actions"><MoreHorizontal size={20}/></summary><div onClick={e => { const menu = e.currentTarget.parentElement as HTMLDetailsElement; if ((e.target as HTMLElement).closest('button')) menu.open = false; }}>
            {t.trashed ? <button disabled={busy} onClick={() => void update(item, { trashed: false }, 'Task restored')}>Restore task</button> : <><button onClick={() => editTask(item)}>Edit details</button><button onClick={() => newTask({ parentTaskId: item.id, projectId: t.projectId, timezone: t.timezone ?? snapshot.layout.value.timezone })}>Add child task</button>{canOrder && <><button disabled={index === 0} onClick={() => reorder.move(item.id, index - 1)}>Move earlier</button><button disabled={index === rows.length - 1} onClick={() => reorder.move(item.id, index + 1)}>Move later</button></>}<button disabled={busy} onClick={() => void plan(item, today)}>Plan today</button><button disabled={busy} onClick={() => void plan(item, tomorrow)}>Plan tomorrow</button><button disabled={busy} onClick={() => void plan(item, '')}>Move to Anytime</button><button disabled={busy} onClick={() => void update(item, { priority: t.priority === 'high' ? 'normal' : 'high' }, 'Priority updated')}>{t.priority === 'high' ? 'Normal priority' : 'High priority'}</button>{occurrence && !finished && <button disabled={busy} onClick={() => changeStatus(item, 'skipped')}>Skip this occurrence</button>}<button onClick={() => newTask({ ...t, title: `${t.title} (copy)`.slice(0, 300), status: 'open', trashed: false, reminder: null, checklist: t.checklist?.map(i => ({ ...i, id: crypto.randomUUID(), done: false })), origin: undefined })}>Duplicate</button><button className="danger-text" disabled={busy} onClick={() => void update(item, { trashed: true }, 'Moved to Trash')}>Move to Trash</button></>}
          </div></details></div>
          {expandedTasks.includes(item.id) && <div id={`subtasks-${item.id}`}><SubtaskFields key={item.id} inline owner={item.id} value={t} snapshot={snapshot} disabled={busy || !!t.trashed} change={patch => actions.run([{ task: item, value: syncTaskSubtasks({ ...t, ...patch }, t) }], 'Subtasks updated')}/></div>}
        </article>;
  };
  const [calendarOffset, setCalendarOffset] = useState(0);
  const calendarFrom = view === 'Scheduled' ? addDays(today, calendarOffset * 60) : today;
  const calendar = useTaskCalendar(snapshot, calendarFrom, !trash && (view !== 'Completed' || !!query.trim()));
  const completion = useCalendarCompletion(snapshot, refresh);
  const matchesEvent = (row: CalendarTaskRow) => (project === 'all' || (row.projectId ?? '') === project) && priority === 'all' && (status === 'all' || (completion.value(calendarCompletionTarget(row.event)).done ? status === 'done' : status === 'open')) && (!query.trim() || taskSearch({ title: row.event.title, notes: row.event.notes ?? '', planned: '', due: '', status: 'open' }, query));
  const calendarRows = calendar.rows.filter(row => matchesEvent(row) && (view !== 'Today' || query.trim() || row.date <= today && row.last >= today));
  const dailyIds = new Set((snapshot.taskState?.occurrences ?? []).filter(o => snapshot.routines?.some(r => r.id === o.routineId && cadenceGroup(r.value) === 'Daily')).map(o => o.taskId));
  const showCalendar = async (row: CalendarTaskRow, saved?: CalendarCompletion) => {
    try {
      const { id } = await calendarWindowIdentity();
      if (row.localId) keepCalendarTarget(snapshot.deviceId, id, row.localId, row.originalDate);
      else {
        const source = calendar.state?.sources.find(s => s.id === row.event.sourceId);
        if (!source && !saved?.generation) throw Error('Refresh Calendar before opening this event.');
        keepProviderCalendarTarget(snapshot.deviceId, id, { epoch: snapshot.epoch, sourceId: row.event.sourceId, generation: source?.generation ?? saved!.generation!, eventId: row.event.id, date: row.date, range: saved?.range ?? calendar.state!.range });
      }
      openCalendar();
    } catch (error) { setCalendarError(error instanceof Error ? error.message : 'This calendar event could not open.'); }
  };
  const renderEvent = (row: CalendarTaskRow, kept?: CalendarCompletion) => {
    const target = calendarCompletionTarget(row.event), { done, saved } = completion.value(target), source = calendar.state?.sources.find(s => s.id === row.event.sourceId);
    const value: Task = { title: row.event.title, notes: row.event.notes ?? '', planned: row.date, due: '', status: done ? 'done' : 'open', checklist: saved?.checklist ?? [] };
    return <article className={`daily-task task-calendar-row ${done ? 'completed' : ''}`} key={row.key}><div className="task-row"><button className={`check-button ${done ? 'checked' : ''}`} aria-label={`${done ? 'Reopen' : 'Complete'} ${row.event.title}`} aria-pressed={done} disabled={completion.busy} onClick={() => void completion.run({ requestId: crypto.randomUUID(), epoch: snapshot.epoch, target, generation: source?.generation ?? kept?.generation, range: kept?.range ?? calendar.state!.range, expectedRevision: saved?.revision ?? 0, done: !done })}>{done && <Check size={16}/>}</button><button className="task-open" title={row.event.title} onClick={() => void showCalendar(row, kept ?? saved)}><strong>{row.event.title}</strong><small className="task-parent-label">Calendar Event</small></button>{disclosure(row.key, row.event.title, saved?.checklist)}<span className="task-inline-note">{row.date === today ? row.event.interval.kind === 'instant' ? new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit', timeZone: snapshot.layout.value.timezone }).format(new Date(row.event.interval.start)) : 'All day' : taskDateLabel(row.date, today)}</span></div>
      {expandedTasks.includes(row.key) && <div id={`subtasks-${row.key}`}><SubtaskFields key={row.key} inline owner={`calendar:${row.key}`} value={value} snapshot={snapshot} disabled={completion.busy} change={patch => { const next = syncTaskSubtasks({ ...value, ...patch }, value); return completion.run({ requestId: crypto.randomUUID(), epoch: snapshot.epoch, target, generation: source?.generation ?? kept?.generation, range: kept?.range ?? calendar.state!.range, expectedRevision: saved?.revision ?? 0, done: next.status === 'done', checklist: next.checklist }); }}/></div>}
    </article>;
  };
  const completedEvents = completion.records.filter(r => completion.value(r.target).done).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(record => {
    const dates = eventDates(record.event.interval, snapshot.layout.value.timezone);
    const row: CalendarTaskRow = { key: `${record.event.sourceId}:${record.event.id}`, event: { ...record.event, notes: '', location: '', status: 'confirmed' }, date: dates.first, last: dates.last, group: 'One-offs', localId: record.localId, originalDate: record.originalDate, projectId: record.projectId };
    return { record, row };
  }).filter(({ row }) => matchesEvent(row));
  const renderRoutine = (r: Entity<Routine>) => { const next = nextScheduled(r.value, dayInZone(r.value.timezone, clock)); return <article className="daily-task" key={r.id}><div className="task-row"><span className="task-kind-icon"><RefreshCw size={18}/></span><button className="task-open" title={r.value.title} onClick={() => setRoutine(r)}><strong>{r.value.title}</strong></button><span className="task-inline-note">{r.value.state === 'paused' ? 'Paused' : next ? taskDateLabel(next, today) : 'Finished'}</span></div></article>; };
  const group = (title: string, children: ReactNode[], collapsible = false) => children.length || !collapsible ? <section className="task-group" key={title} aria-label={title}>{collapsible ? <details open><summary><ChevronDown size={15}/><h2>{title}</h2><span className="count">{children.length}</span></summary>{children}</details> : <><div className="task-group-heading"><h2>{title}</h2><span className="count">{children.length}</span></div>{children}</>}</section> : null;
  const scheduledEvents = calendarRows.filter(row => row.last >= today && (row.event.interval.kind !== 'instant' || Date.parse(row.event.interval.end) >= clock));
  const seriesSeen = new Set<string>();
  const nextEvents = scheduledEvents.filter(row => { const id = row.repeatKey ?? (row.localId && row.group !== 'One-offs' ? row.localId : row.key); if (seriesSeen.has(id)) return false; seriesSeen.add(id); return true; });
  const global = query.trim().length > 0;
  return <main className="page-scroll tasks-page tasks-workspace" data-reorder-scroll>
    <div className="task-workspace-toolbar"><div className="task-heading"><h1>Tasks</h1><p>{new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(today + 'T12:00:00Z'))}</p></div>
    <nav className="task-primary-views" aria-label="Task views">{taskDestinations.map(name => <button key={name} aria-pressed={view === name} onClick={() => chooseView(name)}>{name}</button>)}</nav>
    <div className="task-search-tools"><label className="task-search"><Search size={18}/><input aria-label="Search tasks" placeholder="Search all tasks…" value={query} onChange={e => { setQuery(e.target.value); resetSelection(); }}/>{query && <button className="icon-button" aria-label="Clear task search" onClick={() => { setQuery(''); resetSelection(); }}><X size={15}/></button>}</label><TaskFilters snapshot={snapshot} project={project} status={status} priority={priority} sort={sort} trash={trash} selecting={selecting} setProject={value => { setProject(value); resetSelection(); }} setStatus={value => { setStatus(value); resetSelection(); }} setPriority={value => { setPriority(value); resetSelection(); }} setSort={setSort} setTrash={value => { setTrash(value); resetSelection(); }} setSelecting={value => { setSelecting(value); setSelected([]); }}/></div>
    </div>
    {(daily.error || daily.kept) && <div className="notice warning" role="status"><span>{daily.error || 'Your order is awaiting confirmation.'}</span><button disabled={daily.busy} onClick={() => daily.kept?.conflict ? daily.review() : void daily.run()}>{daily.kept?.conflict ? 'Review kept order' : 'Save kept order'}</button>{daily.kept?.conflict && <button onClick={daily.discard}>Use saved order</button>}</div>}
    {completion.error && <div className="notice warning" role="alert"><span>{completion.error}</span>{completion.pending && <button onClick={() => void completion.retry()}>Retry completion</button>}</div>}
    {(calendarError || calendar.error) && <p className="notice warning" role="alert">{calendarError || calendar.error}</p>}
    <section className="card task-board task-list" aria-label={trash ? 'Trash' : global ? 'Search results' : view}>
      {view !== 'Completed' && !trash && !global && <form className="task-quick-add" onSubmit={e => { e.preventDefault(); void addQuick(); }}><Plus size={18}/><input aria-label="Quick task title" placeholder={view === 'Today' ? 'Add a task for today…' : 'Add a task…'} maxLength={300} value={quick.title} disabled={busy} onChange={e => { const next = { ...quick, title: e.target.value }; setQuick(next); if (!saveLocal(quickKey, next)) setQuickError('This writing could not be saved on this device.'); }}/><button type="submit" disabled={busy || !quick.title.trim()}>Add</button><ComposerMenu label="Task creation options" icon={<ChevronDown size={14}/>} className="task-inline-create-options" align="right" placement="below" kind="menu">{close => <div className="task-filter-picker"><button type="button" role="menuitem" disabled={busy} onClick={() => { close(); editTask(quickTask()); }}>Task details</button><button type="button" role="menuitem" disabled={busy} onClick={() => { close(); newRoutine(); }}><RefreshCw size={16}/>Repeating task</button></div>}</ComposerMenu></form>}{quickError && <p role="alert">{quickError}</p>}
      {selecting && <div className="task-bulk"><label><input type="checkbox" aria-label="Select visible tasks" checked={shown.length > 0 && shown.every(t => selected.includes(t.id))} onChange={e => setSelected(e.target.checked ? shown.map(t => t.id) : [])}/>{selectedTasks.length} selected</label><select aria-label="Action for selected tasks" value="" disabled={busy || !selectedTasks.length} onChange={e => { if (e.target.value) void batch(e.target.value); }}><option value="">Choose action…</option>{trash ? <option value="restore">Restore tasks</option> : <><option value="complete">Complete</option><option value="reopen">Mark ready</option><option value="today">Plan today</option><option value="tomorrow">Plan tomorrow</option><option value="anytime">Move to Anytime</option><option value="high">High priority</option><option value="trash">Move to Trash</option></>}</select></div>}
      <span className="sr-only" role="status">{reorder.announcement}</span>
      {global || trash || view === 'Completed' ? group(trash ? 'Trash' : global ? 'Search results · all tasks' : 'Completed', [...shown.map(renderTask), ...(!trash && global ? routines.map(renderRoutine) : []), ...(!trash && global ? nextEvents.map(row => renderEvent(row)) : []), ...(!trash && (view === 'Completed' || global) ? completedEvents.filter(({ record }) => !global || !nextEvents.some(row => row.event.sourceId === record.target.sourceId && row.event.id === record.target.eventId)).slice(0, limit).map(({ row, record }) => renderEvent(row, record)) : [])]) : view === 'Today' ? <>
        {group('To-dos', [...shown.filter(t => !dailyIds.has(t.id)).map(renderTask), ...calendarRows.filter(e => e.group !== 'Daily').map(row => renderEvent(row))])}
        {group('Daily', [...shown.filter(t => dailyIds.has(t.id)).map(renderTask), ...calendarRows.filter(e => e.group === 'Daily').map(row => renderEvent(row))])}
      </> : <>
        {group('One-offs', [...shown.map(renderTask), ...nextEvents.filter(e => e.group === 'One-offs').map(row => renderEvent(row))], true)}
        {cadenceGroups.map(name => group(name, [...routines.filter(r => cadenceGroup(r.value) === name).map(renderRoutine), ...nextEvents.filter(e => e.group === name).map(row => renderEvent(row))], true))}
        {!rows.length && !routines.length && !calendarRows.length && <Empty title="Make room for what's ahead.">Add a scheduled task or a repeating routine.</Empty>}
      </>}
      {(rows.length > limit || view === 'Completed' && completedEvents.length > limit) && <button className="task-show-more" onClick={() => setLimit(limit + 50)}>Show 50 more · {Math.max(0, rows.length - limit) + (view === 'Completed' ? Math.max(0, completedEvents.length - limit) : 0)} remaining</button>}
    </section>
    {!trash && view === 'Scheduled' && <div className="task-calendar-range"><span>Calendar dates · {taskDateLabel(calendarFrom, today)}–{taskDateLabel(addDays(calendarFrom, 59), today)}</span><button aria-label="Previous calendar dates" disabled={!calendarOffset} onClick={() => setCalendarOffset(calendarOffset - 1)}>Previous</button><button aria-label="Next calendar dates" onClick={() => setCalendarOffset(calendarOffset + 1)}>Next</button></div>}
    {calendar.state && (calendar.state.eventsLimited || calendar.state.sources.some(s => s.selected && ['stale', 'unavailable'].includes(s.state))) && <p className="metadata">Some calendar dates are still syncing. <button className="text-button" onClick={openCalendar}>Open Calendar</button></p>}
    {routine && <RoutineEditor key={routine.id} routine={routine} snapshot={snapshot} close={() => setRoutine(null)} saved={() => { if (routine.quickSource?.id === quick.id && routine.quickSource.title === quick.title) { const next = blankQuick(); setQuick(next); saveLocal(quickKey, next); } setRoutine(null); void refresh(); }}/>}
  </main>;
}
