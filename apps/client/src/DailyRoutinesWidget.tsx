import type { Entity, Snapshot, Task } from '../../../packages/domain/contracts';
import type { HomeWidget } from '../../../packages/domain/home-widgets';
import { cadenceGroup, taskBlockers } from '../../../packages/domain/task-presentation';
import { dayInZone, sortTasks } from '../../../packages/domain/tasks';

export function dailyRoutineTasks(snapshot: Pick<Snapshot, 'tasks' | 'routines' | 'taskState' | 'layout'>, now: number): Entity<Task>[] {
  const dailyIds = new Set((snapshot.routines ?? []).filter(routine => cadenceGroup(routine.value) === 'Daily').map(routine => routine.id));
  const todayOccurrences = new Map((snapshot.taskState?.occurrences ?? [])
    .filter(occurrence => dailyIds.has(occurrence.routineId) && occurrence.date === dayInZone(occurrence.timezone, now))
    .map(occurrence => [occurrence.taskId, occurrence]));
  const eligible = snapshot.tasks.filter(task => {
    const occurrence = todayOccurrences.get(task.id);
    if (!occurrence || task.value.trashed || !['open', 'active'].includes(task.value.status)) return false;
    if (task.value.planned > dayInZone(task.value.timezone ?? occurrence.timezone, now)) return false;
    return taskBlockers(task.value, snapshot.tasks).length === 0;
  });
  const timezone = snapshot.layout.value.timezone, date = dayInZone(timezone, now);
  const order = snapshot.taskState?.orders?.find(item => item.date === date && item.timezone === timezone)?.taskIds;
  return sortTasks(eligible, order);
}

export function DailyRoutinesWidget({ snapshot, widget, now = Date.now(), openTasks, editTask }: {
  snapshot: Snapshot;
  widget: HomeWidget;
  now?: number;
  openTasks: () => void;
  editTask?: (task: Entity<Task>) => void;
}) {
  const compact = widget.size === 'compact';
  const capacity = compact ? 1 : widget.size === 'large' ? 6 : widget.size === 'wide' ? 3 : 2;
  const tasks = dailyRoutineTasks(snapshot, now), visible = tasks.slice(0, Math.min(widget.settings?.limit ?? 5, capacity));
  return <div className={`home-content home-daily-routines${compact ? ' home-daily-compact' : ''}`}>
    {tasks.length ? <>{!compact && <p>{tasks.length} daily {tasks.length === 1 ? 'routine' : 'routines'} ready</p>}<ol>{visible.map(task => <li key={task.id}>{editTask ? <button className="home-routine-open" title={task.value.title} onClick={() => editTask(task)}><strong>{task.value.title}</strong>{!compact && task.value.plannedTime && <span>{task.value.plannedTime}</span>}</button> : <div title={task.value.title}><strong>{task.value.title}</strong>{!compact && task.value.plannedTime && <span>{task.value.plannedTime}</span>}</div>}</li>)}</ol></> : compact ? <p>No daily routines ready.</p> : <><h3>No daily routines ready right now</h3><p>Open Tasks to review your daily routines or add a repeating task.</p></>}
    <div className="home-actions home-routine-footer">{tasks.length > visible.length && <span className="metadata">{tasks.length - visible.length} more</span>}<button className="home-action" onClick={openTasks}>Open Tasks</button></div>
  </div>;
}