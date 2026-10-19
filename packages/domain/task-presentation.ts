import type { Entity, Task } from './contracts.js';
import { dayInZone, sortTasks, type Occurrence, type Routine, type TaskEvent, type TaskPresentation, type TaskState } from './tasks.js';
export type TaskSort = 'planned' | 'priority' | 'deadline' | 'newest' | 'title';
export function taskSearch(task: Task, query: string, project = '') {
  const text = [task.title, task.notes, task.waitReason, project, ...(task.checklist ?? []).map(i => i.text), ...(task.sources ?? []).map(s => s.label)].join(' ').toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/).every(word => text.includes(word));
}
export function orderTaskView(tasks: Entity<Task>[], sort: TaskSort, daily: string[] = []) {
  const priorities = { high: 0, normal: 1, low: 2 };
  if (sort === 'planned') return sortTasks(tasks, daily);
  return [...tasks].sort((a, b) => (sort === 'priority' ? priorities[a.value.priority ?? 'normal'] - priorities[b.value.priority ?? 'normal'] : sort === 'deadline' ? (a.value.due || '9999').localeCompare(b.value.due || '9999') || (a.value.dueTime || '99').localeCompare(b.value.dueTime || '99') : sort === 'newest' ? b.updatedAt.localeCompare(a.updatedAt) : a.value.title.localeCompare(b.value.title)) || a.id.localeCompare(b.id));
}
export function taskBlockers(task: Task, tasks: Entity<Task>[]) {
  return (task.dependencies ?? []).flatMap(id => { const target = tasks.find(t => t.id === id); return !target || target.value.trashed || target.value.status !== 'done' ? [target?.value.title ?? 'Unavailable prerequisite'] : []; });
}
export function taskDateLabel(date: string, today: string) {
  if (!date) return '';
  const delta = Math.round((Date.parse(date + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86400000);
  if (delta === 0) return 'Today'; if (delta === 1) return 'Tomorrow'; if (delta === -1) return 'Yesterday';
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', ...(date.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
}

export const taskDestinations = ['Today', 'Scheduled', 'Completed'] as const;
export type TaskDestination = typeof taskDestinations[number];
export const cadenceGroups = ['Daily', 'Weekly', 'Every two weeks', 'Monthly', 'Yearly', 'Custom'] as const;
export type CadenceGroup = typeof cadenceGroups[number];
export function cadenceGroup(rule: Pick<Routine, 'cadence' | 'interval'>): CadenceGroup {
  const n = rule.interval ?? 1;
  if (rule.cadence === 'weekly' && n === 2) return 'Every two weeks';
  return n === 1 ? ({ daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' } as const)[rule.cadence] : 'Custom';
}
export type TaskPresentationContext = { occurrences: ReadonlyMap<string, Occurrence>; presentation: Readonly<Record<string, TaskPresentation>>; now: number };

/** Resolve original recurrence, never the series' subsequently edited cadence. */
export function taskPresentationProjection(occurrences: readonly Occurrence[], events: readonly TaskEvent[], resolveRoutine: (id: string, revision: number) => Entity<Routine> | undefined): Record<string, TaskPresentation> {
  const presentation: Record<string, TaskPresentation> = {}, revisions = new Map<string, Entity<Routine> | undefined>();
  for (const occurrence of occurrences) {
    const key = JSON.stringify([occurrence.routineId, occurrence.templateRevision]);
    if (!revisions.has(key)) revisions.set(key, resolveRoutine(occurrence.routineId, occurrence.templateRevision));
    const original = revisions.get(key), interval = original?.value.interval ?? 1;
    if (original?.id === occurrence.routineId && original.revision === occurrence.templateRevision && ['daily', 'weekly', 'monthly', 'yearly'].includes(original.value.cadence) && Number.isInteger(interval) && interval >= 1) {
      presentation[occurrence.taskId] = { recurrence: { cadence: original.value.cadence, interval } };
    }
  }
  const latest = new Map<string, TaskEvent>();
  for (const event of events) {
    if (event.action || event.from === event.to || !['done', 'skipped'].includes(event.to) || !Number.isFinite(Date.parse(event.at))) continue;
    const key = JSON.stringify([event.taskId, event.to]), previous = latest.get(key);
    // Saved revisions order genuine transitions even if the clock moves backward.
    // Legacy unversioned events have only their recorded timestamp as a fallback.
    const revision = (item: TaskEvent) => {
      const suffix = item.id.startsWith(item.taskId + ':') ? item.id.slice(item.taskId.length + 1) : '';
      const value = /^\d+$/.test(suffix) ? Number(suffix) : 0;
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    };
    if (!previous || revision(event) > revision(previous) || (revision(event) === revision(previous) && (Date.parse(event.at) > Date.parse(previous.at) || Date.parse(event.at) === Date.parse(previous.at) && event.id > previous.id))) latest.set(key, event);
  }
  for (const event of latest.values()) {
    const item = presentation[event.taskId] ??= {};
    if (event.to === 'done') item.completedAt = event.at; else item.skippedAt = event.at;
  }
  return presentation;
}

/** Legacy snapshots may use a current routine only when its exact revision matches. */
export function taskPresentationContext(state?: TaskState, routines: readonly Entity<Routine>[] = [], now = Date.now()): TaskPresentationContext {
  const occurrences = state?.occurrences ?? [], current = new Map(routines.map(routine => [routine.id, routine]));
  const presentation = state?.presentation ?? taskPresentationProjection(occurrences, state?.events ?? [], (id, revision) => {
    const routine = current.get(id); return routine?.revision === revision ? routine : undefined;
  });
  return { occurrences: new Map(occurrences.map(occurrence => [occurrence.taskId, occurrence])), presentation, now };
}

export function isDailyOccurrence(task: Entity<Task>, context?: TaskPresentationContext): boolean {
  const recurrence = context?.presentation[task.id]?.recurrence;
  return !!context?.occurrences.has(task.id) && recurrence?.cadence === 'daily' && recurrence.interval === 1;
}

/** Daily occurrence dates belong to the original rule's timezone, not the viewer's. */
export function taskPlanningDay(task: Entity<Task>, today: string, context?: TaskPresentationContext): string {
  const occurrence = context?.occurrences.get(task.id);
  if (!context || !occurrence || !isDailyOccurrence(task, context)) return today;
  try { return dayInZone(occurrence.timezone, context.now); } catch { return today; }
}

export function isCurrentDailyOccurrence(task: Entity<Task>, context?: TaskPresentationContext): boolean {
  const occurrence = context?.occurrences.get(task.id);
  if (!context || !occurrence || !isDailyOccurrence(task, context)) return false;
  try { return occurrence.date === dayInZone(occurrence.timezone, context.now); } catch { return false; }
}

/** Chronology only: status and a later edit to planned never change original history. */
export function isHistoricalDailyOccurrence(task: Entity<Task>, context?: TaskPresentationContext): boolean {
  const occurrence = context?.occurrences.get(task.id);
  if (!context || !occurrence || !isDailyOccurrence(task, context)) return false;
  try { return occurrence.date < dayInZone(occurrence.timezone, context.now); } catch { return false; }
}

/** Existing Completed includes both done and skipped; use each real transition. */
export function completedToday(task: Entity<Task>, today: string, timezone: string, context?: TaskPresentationContext): boolean {
  if (task.value.trashed) return false;
  const item = context?.presentation[task.id], at = task.value.status === 'done' ? item?.completedAt : task.value.status === 'skipped' ? item?.skippedAt : undefined;
  return !!at && Number.isFinite(Date.parse(at)) && dayInZone(timezone, Date.parse(at)) === today;
}

export function isTaskCarryForward(task: Entity<Task>, today: string, context?: TaskPresentationContext): boolean {
  return !task.value.trashed && !['done', 'skipped'].includes(task.value.status) && !!task.value.planned && task.value.planned < taskPlanningDay(task, today, context) && !isHistoricalDailyOccurrence(task, context);
}

export function inTaskDestination(task: Entity<Task>, destination: TaskDestination, today: string, timezone: string, context?: TaskPresentationContext): boolean {
  if (task.value.trashed) return false;
  const t = task.value, finished = ['done', 'skipped'].includes(t.status);
  if (destination === 'Completed') return finished;
  if (!finished && isHistoricalDailyOccurrence(task, context)) return false;
  const planningDay = taskPlanningDay(task, today, context);
  if (destination === 'Scheduled') return t.planned > planningDay;
  if (finished) return completedToday(task, today, timezone, context);
  if (isCurrentDailyOccurrence(task, context)) return !t.planned || t.planned <= planningDay;
  if (t.planned === planningDay || t.status === 'active') return true;
  // Carry ordinary work forward; edits never stand in for a completion event.
  return (!t.planned || t.planned < planningDay) && !finished;
}
