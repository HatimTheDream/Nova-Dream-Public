import type { Entity, Layout, Snapshot, Task } from '../../../packages/domain/contracts';
import { reminderInstant } from '../../../packages/domain/reminders';
import { dayInZone, inTaskView, sortTasks } from '../../../packages/domain/tasks';
import { completedToday, isHistoricalDailyOccurrence, taskBlockers, taskPlanningDay, taskPresentationContext } from '../../../packages/domain/task-presentation';

export type HomeAttentionReason = 'waiting' | 'blocked' | 'past-plan' | 'overdue';
export type HomeEmptyState = 'empty' | 'finished' | 'future' | 'not-ready' | 'routine-history';

function pastDeadline(task: Task, homeTimezone: string, today: string, now: number): boolean {
  if (!task.due) return false;
  if (!task.dueTime) return task.due < today;
  const timezone = task.timezone ?? homeTimezone;
  const deadlineToday = timezone === homeTimezone ? today : dayInZone(timezone, now);
  if (task.due !== deadlineToday) return task.due < deadlineToday;
  const deadline = reminderInstant({ date: task.due, time: task.dueTime, timezone });
  // An ambiguous deadline is past only after both possible instants. A missing
  // civil time becomes overdue after its date, without inventing a shifted time.
  const instant = deadline.instant ?? deadline.choices.at(-1);
  return instant !== undefined && instant < now;
}

export function homeTaskState(snapshot: Pick<Snapshot, 'tasks' | 'taskState' | 'routines'>, layout: Pick<Layout, 'timezone' | 'showCompleted'>, now: number, dependencyTasks = snapshot.tasks) {
  const today = dayInZone(layout.timezone, now);
  const context = taskPresentationContext(snapshot.taskState, snapshot.routines, now);
  const saved = snapshot.tasks.filter(task => inTaskView(task.value, 'All', today));
  const active = saved.filter(task => !inTaskView(task.value, 'History', today) && !isHistoricalDailyOccurrence(task, context));
  const order = snapshot.taskState?.orders?.find(order => order.date === today && order.timezone === layout.timezone)?.taskIds;
  const ready = sortTasks(active.filter(task => ['open', 'active'].includes(task.value.status) && (!task.value.planned || task.value.planned <= taskPlanningDay(task, today, context)) && taskBlockers(task.value, dependencyTasks).length === 0), order);
  const ordered = sortTasks(saved.filter(task => inTaskView(task.value, 'History', today) || !isHistoricalDailyOccurrence(task, context)), order);
  const upcoming = ordered.filter(task => !['done', 'skipped'].includes(task.value.status) && inTaskView(task.value, 'Upcoming', taskPlanningDay(task, today, context)));
  const todayCompleted = saved.filter(task => completedToday(task, today, layout.timezone, context));
  const tasks = layout.showCompleted ? ordered : sortTasks([...ready, ...todayCompleted], order);
  const completed = saved.filter(task => task.value.status === 'done').length;
  const attention: { task: Entity<Task>; reasons: HomeAttentionReason[] }[] = [];
  for (const task of active) {
    const reasons: HomeAttentionReason[] = [];
    if (task.value.status === 'waiting' || task.value.status === 'blocked') reasons.push(task.value.status);
    if (inTaskView(task.value, 'Review', taskPlanningDay(task, today, context))) reasons.push('past-plan');
    if (pastDeadline(task.value, layout.timezone, today, now)) reasons.push('overdue');
    if (reasons.length) attention.push({ task, reasons });
  }
  const missedDaily = saved.some(task => !inTaskView(task.value, 'History', today) && isHistoricalDailyOccurrence(task, context));
  const emptyState: HomeEmptyState = !saved.length ? 'empty' : !active.length ? missedDaily ? 'routine-history' : 'finished' : active.every(task => inTaskView(task.value, 'Upcoming', taskPlanningDay(task, today, context))) ? 'future' : 'not-ready';
  return { saved, active, tasks, ready, ordered, upcoming, completed, attention, emptyState };
}
