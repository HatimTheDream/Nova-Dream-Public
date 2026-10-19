import type { Entity, Snapshot, Task } from '../../../packages/domain/contracts';
import { inTaskDestination, isHistoricalDailyOccurrence, taskSearch, type TaskDestination, type TaskPresentationContext } from '../../../packages/domain/task-presentation';

export type TaskListScope = { destination: TaskDestination | 'Daily History' | 'Trash'; project: string; query: string; priority: string; status: string };

/** Global search includes saved history; the explicit history view searches only history. */
export function selectTaskList(snapshot: Snapshot, scope: TaskListScope, today: string, context: TaskPresentationContext): Entity<Task>[] {
  return [...snapshot.tasks, ...(snapshot.trashedTasks ?? [])].filter(task => {
    const value = task.value;
    if (scope.destination === 'Trash' ? !value.trashed : value.trashed) return false;
    if (scope.project !== 'all' && (value.projectId ?? '') !== scope.project) return false;
    if (scope.priority !== 'all' && (value.priority ?? 'normal') !== scope.priority) return false;
    if (scope.status !== 'all' && value.status !== scope.status) return false;
    if (!taskSearch(value, scope.query, snapshot.projects.find(project => project.id === value.projectId)?.value.name)) return false;
    if (scope.destination === 'Daily History') return isHistoricalDailyOccurrence(task, context);
    return scope.destination === 'Trash' || !!scope.query.trim() || inTaskDestination(task, scope.destination, today, snapshot.layout.value.timezone, context);
  });
}

export function taskListCountsMatches(scope: TaskListScope): boolean {
  return !!scope.query.trim() || ['Daily History', 'Completed', 'Trash'].includes(scope.destination);
}

export function taskListProjectCount(snapshot: Snapshot, scope: TaskListScope, project: string, today: string, context: TaskPresentationContext): number {
  const tasks = selectTaskList(snapshot, { ...scope, project }, today, context);
  return taskListCountsMatches(scope) ? tasks.length : tasks.filter(task => !['done', 'skipped'].includes(task.value.status)).length;
}

export function taskProgressLabel(statuses: readonly Task['status'][]): string {
  const done = statuses.filter(status => status === 'done').length, skipped = statuses.filter(status => status === 'skipped').length;
  return `${statuses.length - done - skipped} open · ${done} done${skipped ? ` · ${skipped} skipped` : ''}`;
}

/** An edited planning date cannot reorder or rename the original daily history. */
export function orderDailyHistory(tasks: Entity<Task>[], context: TaskPresentationContext): Entity<Task>[] {
  return [...tasks].sort((a, b) => (context.occurrences.get(b.id)?.date ?? '').localeCompare(context.occurrences.get(a.id)?.date ?? '') || a.id.localeCompare(b.id));
}
