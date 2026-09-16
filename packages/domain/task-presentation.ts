import type { Entity, Task } from './contracts.js';
import { dayInZone, sortTasks, type Routine } from './tasks.js';
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
export function inTaskDestination(task: Entity<Task>, destination: TaskDestination, today: string, timezone: string): boolean {
  if (task.value.trashed) return false;
  const t = task.value, finished = ['done', 'skipped'].includes(t.status);
  if (destination === 'Completed') return finished;
  if (destination === 'Scheduled') return t.planned > today;
  if (t.planned === today || t.status === 'active') return true;
  // Carry unfinished work forward; keep today's completion in place until tomorrow.
  return (!t.planned || t.planned < today) && (!finished || dayInZone(timezone, Date.parse(task.updatedAt)) === today);
}
