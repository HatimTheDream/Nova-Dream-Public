import { homeQuickLinkSchema, type HomeWidget, type HomeWidgetType } from '../../../packages/domain/home-widgets';
import type { Draft, Entity, ModuleId, Task } from '../../../packages/domain/contracts';
import { dayInZone, statusNames } from '../../../packages/domain/tasks';
import { Check } from './icons';
import type { homeTaskState, HomeAttentionReason } from './home-task-state';
import { HomeWeatherWidget } from './HomeWeatherWidget';
import { HomeAppointmentWidget } from './HomeAppointmentWidget';
import { DailyRoutinesWidget } from './DailyRoutinesWidget';
import type { Snapshot } from '../../../packages/domain/contracts';

export type HomeActions = {
  open: (id: ModuleId) => void;
  openSettings: (tab: 'general' | 'accounts') => void;
  newTask: () => void;
  editTask: (task: Entity<Task>) => void;
  complete: (task: Entity<Task>) => void;
};
type Props = HomeActions & {
  id: HomeWidgetType; snapshot?: Snapshot; widget?: HomeWidget; now?: number; projectMissing?: boolean; customize?: () => void;
  state: ReturnType<typeof homeTaskState>;
  draft: Draft;
  dirty: boolean;
  draftStatus: string;
  time: string;
  date: string;
  timezone: string;
};
const reasonLabels: Record<HomeAttentionReason, string> = {
  waiting: 'Waiting', blocked: 'Blocked', 'past-plan': 'Plan needs review', overdue: 'Overdue deadline',
};
const emptyCopy = {
  empty: { title: 'No tasks yet', detail: 'Add a task to start planning your day.', action: 'Add Your First Task' },
  future: { title: 'Your next tasks are planned for later', detail: 'Open Tasks to see what is coming up.', action: 'Add A Task' },
  finished: { title: 'No unfinished tasks', detail: 'Show completed tasks to review them, or add your next task.', action: 'Add A Task' },
  'not-ready': { title: 'No tasks are ready right now', detail: 'Your tasks are planned for later, waiting, or blocked. Open Tasks to review them.', action: 'Add A Task' },
};

/** Widget content stays separate from layout, menus and reorder persistence. */
export function HomeWidgetContent({ id, snapshot, state, draft, dirty, draftStatus, time, date, timezone, widget, now = Date.now(), projectMissing, customize, open, openSettings, newTask, editTask, complete }: Props) {
  const { active, completed, attention, emptyState } = state;
  const size = widget?.size ?? 'square', compact = size === 'compact';
  const taskCapacity = { compact: 1, square: 2, wide: 3, large: 8 }[size];
  const attentionCapacity = compact ? 0 : size === 'large' ? 6 : size === 'square' && dirty ? 1 : 2;
  const view = widget?.settings?.view;
  const allTasks = view === 'all' ? state.ordered : view === 'ready' ? state.ready : view === 'attention' ? state.ordered.filter(task => attention.some(item => item.task.id === task.id)) : view === 'upcoming' ? state.ordered.filter(task => !['done', 'skipped'].includes(task.value.status) && task.value.planned > dayInZone(timezone, now)) : state.tasks;
  const limit = Math.min(widget?.settings?.limit ?? (id === 'attention' ? 3 : 5), id === 'attention' ? attentionCapacity : taskCapacity);
  const tasks = allTasks.slice(0, limit);
  const hasDraft = Boolean(draft.text.trim() || draft.attachments.length);
  const copy = emptyCopy[emptyState];
  if (projectMissing) return <div className="home-content"><h3>Project unavailable</h3>{!compact && <p>This widget keeps its original project filter. Choose another project in its settings.</p>}<div className="home-actions"><button className="home-action" onClick={customize}>Customize Widget</button></div></div>;
  if (id === 'clock') return <div className="home-clock-content"><time className="home-clock-time" dateTime={new Date(now).toISOString()}>{time}</time><p>{date}</p><p className="metadata">{timezone.replaceAll('_', ' ')}</p></div>;
  if (id === 'weather' && widget) return <HomeWeatherWidget widget={widget} customize={customize ?? (() => {})}/>;
  if (id === 'daily-routines' && snapshot && widget) return <DailyRoutinesWidget snapshot={snapshot} widget={widget} now={now} openTasks={() => open('tasks')} editTask={editTask}/>;
  if (id === 'next-appointment' && snapshot) return <HomeAppointmentWidget epoch={snapshot.epoch} deviceId={snapshot.deviceId} timezone={timezone} now={now} size={size} openCalendar={() => open('calendar')}/>;
  if (id === 'next-action') {
    const routineTaskIds = new Set(snapshot?.taskState?.occurrences.map(occurrence => occurrence.taskId) ?? []);
    const task = state.ready.find(item => !routineTaskIds.has(item.id));
    return <div className="home-content">{task ? <>{!compact && <p className="metadata">Ready to work on</p>}<h3 title={task.value.title}>{task.value.title}</h3>{!compact && <p className="home-two-lines">{statusNames[task.value.status]}{task.value.planned ? ` · Planned ${task.value.planned}` : ''}{task.value.due ? ` · Due ${task.value.due}` : ''}</p>}<div className="home-actions"><button className="home-action" onClick={() => editTask(task)}>Open Task</button></div></> : <><h3>No ready task right now</h3>{!compact && <p>Waiting, blocked, future, and prerequisite work stays out of this widget.</p>}<div className="home-actions"><button className="home-action" onClick={() => open('tasks')}>Review Tasks</button></div></>}</div>;
  }
  if (id === 'note') return <div className="home-content"><p className="home-note-text">{widget?.settings?.text || (compact ? 'Keep a thought close by.' : 'Add a reminder, an idea, or a few words you want to keep nearby.')}</p><div className="home-actions"><button className="home-action" onClick={customize}>{widget?.settings?.text ? 'Open Note' : 'Write A Note'}</button></div></div>;
  if (id === 'links') {
    const links = (widget?.settings?.links ?? []).filter(link => homeQuickLinkSchema.safeParse(link).success);
    return <div className="home-content">{links.length ? <ul className="home-link-list">{links.slice(0, taskCapacity).map(link => <li key={link.id}><a href={link.url} target="_blank" rel="noopener noreferrer" title={link.label}><strong>{link.label}</strong>{!compact && <span>{new URL(link.url).hostname}</span>}</a></li>)}</ul> : <p className="home-two-lines">{compact ? 'Keep useful websites close.' : 'Keep your frequently used websites together. Links open in a new tab.'}</p>}<div className="home-actions"><button className="home-action" onClick={customize}>{links.length > taskCapacity ? `All ${links.length} links` : 'Edit links'}</button></div></div>;
  }
  if (id === 'welcome') {
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: timezone }).format(now);
    const month = new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: timezone }).format(now);
    const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', timeZone: timezone }).format(now);
    const city = timezone.split('/').at(-1)!.replaceAll('_', ' ');
    return <div className="home-day">
      <div className="home-day-main">
        <div className="home-day-calendar"><p className="home-day-weekday">{weekday}</p><time className="home-day-date" dateTime={dayInZone(timezone, now)} aria-label={date}><span>{month}</span><strong>{day}</strong></time></div>
        <time className="home-day-time" dateTime={new Date(now).toISOString()}>{time}</time>
      </div>
      {!compact && <><dl className="home-day-stats"><div><dt>Ready Tasks</dt><dd>{state.ready.length}</dd></div><div><dt>Need Review</dt><dd>{attention.length}</dd></div></dl>
        <div className="home-day-actions"><button className="home-action" onClick={() => open('tasks')}>Open Tasks</button><button className="home-timezone" onClick={() => openSettings('general')} title={`Change timezone: ${timezone.replaceAll('_', ' ')}`} aria-label={`Change timezone: ${timezone.replaceAll('_', ' ')}`}>{city}</button></div></>}
    </div>;
  }
  if (id === 'next') return <div className="home-content">
    {tasks.length > 0 && !compact && active.length > 0 && <p className="home-task-summary">{active.length} open {active.length === 1 ? 'task' : 'tasks'} · {completed} completed</p>}
    {tasks.length ? <div className="task-list">{tasks.map(task => <div className={`task-row ${task.value.status === 'done' ? 'completed' : ''}`} key={task.id}>
      <button className={`check-button ${task.value.status === 'done' ? 'checked' : ''}`} aria-label={`${['done', 'skipped'].includes(task.value.status) ? 'Reopen' : 'Complete'} ${task.value.title}`} onClick={() => complete(task)}>{task.value.status === 'done' && <Check size={15}/>}</button>
      <button className="task-open" title={task.value.title} onClick={() => editTask(task)}><strong>{task.value.title}</strong>{!compact && <span>{statusNames[task.value.status]}{task.value.planned ? ` · Planned ${task.value.planned}` : ''}{task.value.due ? ` · Due ${task.value.due}` : ''}</span>}</button>
    </div>)}</div> : <><h3>{view && view !== 'ready' ? 'No matching tasks' : copy.title}</h3>{!compact && <p>{view && view !== 'ready' ? 'Adjust its filters or open Tasks to see the rest of your work.' : copy.detail}</p>}<button className="home-action" onClick={newTask}>{compact ? 'Add A Task' : copy.action}</button></>}
    {(tasks.length > 0 || !compact) && <div className="home-actions"><button className="home-action" onClick={() => open('tasks')}>Open Tasks</button>{allTasks.length > limit && <span className="metadata home-more-count" title={`Showing ${limit} of ${allTasks.length} matching tasks`} aria-label={`Showing ${limit} of ${allTasks.length} matching tasks`}>{allTasks.length - limit} more</span>}</div>}
  </div>;
  if (id === 'draft') return <div className="home-content">
    {(!compact || !dirty) && <h3 className={compact ? 'home-single-line' : undefined} title={hasDraft ? draft.title : undefined}>{hasDraft ? draft.title : 'Start a conversation'}</h3>}
    {!compact && <p className="home-draft-excerpt">{draft.text.trim() ? draft.text : hasDraft ? 'Your attached files are ready for a message.' : 'Bring a question, plan, or task to Assistant.'}</p>}
    {!compact && draft.attachments.length > 0 && <p className="metadata">{draft.attachments.length} {draft.attachments.length === 1 ? 'attachment' : 'attachments'}</p>}
    {dirty && <p className={`home-save-notice${compact ? ' home-single-line' : ''}`} role="status" title={draftStatus}>{draftStatus}</p>}
    <div className="home-actions"><button className="home-action" onClick={() => open('assistant')}>{hasDraft ? 'Continue Draft' : 'Open Assistant'}</button></div>
  </div>;
  if (id === 'attention' && compact) return <div className="home-content">
    {dirty ? <p className="home-save-notice home-single-line" role="status" title={draftStatus}>{draftStatus}</p> : <h3>{attention.length ? `${attention.length} ${attention.length === 1 ? 'task needs' : 'tasks need'} review` : 'No tasks need review'}</h3>}
    <div className="home-actions"><button className="home-action" onClick={() => open('tasks')} aria-label={attention.length ? `Open Tasks: ${attention.length} to review` : undefined}>{dirty && attention.length ? `${attention.length} to review` : 'Open Tasks'}</button>{dirty && <button className="home-action" onClick={() => open('assistant')}>Review Draft</button>}</div>
  </div>;
  if (id === 'attention') return <div className="home-content">
    {dirty && <div className="home-draft-review"><p className="home-save-notice" role="status" title={draftStatus}>{draftStatus}</p><button className="home-action" onClick={() => open('assistant')}>Review Draft</button></div>}
    {attention.length > 0 ? <>
      {!(size === 'wide' && dirty) && <p className="home-attention-count">{attention.length} {attention.length === 1 ? 'task needs' : 'tasks need'} review</p>}
      <ul className="home-attention-list">{attention.slice(0, limit).map(({ task, reasons }) => <li key={task.id}><button onClick={() => editTask(task)} aria-label={`Review ${task.value.title}: ${reasons.map(reason => reasonLabels[reason]).join(', ')}`}><strong>{task.value.title}</strong><span>{reasons.map(reason => reasonLabels[reason]).join(' · ')}</span></button></li>)}</ul>
      <div className="home-actions"><button className="home-action" onClick={() => open('tasks')} aria-label={size === 'wide' && dirty ? `Open Tasks: ${attention.length} to review` : undefined}>Open Tasks</button>{attention.length > limit && <span className="metadata home-more-count" title={`${attention.length - limit} more ${attention.length - limit === 1 ? 'task' : 'tasks'} to review`} aria-label={`${attention.length - limit} more ${attention.length - limit === 1 ? 'task' : 'tasks'} to review`}>{attention.length - limit} more</span>}</div>
    </> : <><h3>No tasks need review</h3><p>Overdue, blocked, waiting, and missed-plan tasks appear here.</p></>}
  </div>;
  return <div className="home-content">{!compact && <p>Start something new or manage your connections.</p>}<div className="home-quick-actions">
    <button className="home-action" onClick={newTask}>Add A Task</button>
    <button className="home-action" onClick={() => open('assistant')}>{hasDraft ? 'Continue Draft' : 'Open Assistant'}</button>
    {!compact && <button className="home-action" onClick={() => openSettings('accounts')}>Manage Connections</button>}
  </div></div>;
}
