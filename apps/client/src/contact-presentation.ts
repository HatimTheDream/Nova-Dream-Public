import type { Entity, Task } from '../../../packages/domain/contracts';
import type { Contact } from '../../../packages/domain/workspace-records';
import { dayInZone } from '../../../packages/domain/tasks';
import { clockInZone } from '../../../packages/domain/calendar-time';
import { contactDestination } from '../../../packages/domain/contacts';

export function contactFamily(id: string, contacts: readonly Entity<Contact>[]) {
  const all = [...contacts];
  return all.filter(person => person.id === id || contactDestination(person.id, all) === id).map(person => person.id);
}

/** Return original entities, including follow-ups from a combined contact's history. */
export function contactFollowUps(id: string, contacts: readonly Entity<Contact>[], tasks: readonly Entity<Task>[]) {
  const family = new Set(contactFamily(id, contacts));
  return tasks.filter(task => !task.value.trashed && task.value.origin?.kind === 'contact' && family.has(task.value.origin.id));
}

export function openContactFollowUps(id: string, contacts: readonly Entity<Contact>[], tasks: readonly Entity<Task>[]) {
  const date = (task: Entity<Task>) => [task.value.planned, task.value.due].filter(Boolean).sort()[0] || '9999-12-31';
  return contactFollowUps(id, contacts, tasks).filter(task => task.value.status !== 'done' && task.value.status !== 'skipped')
    .sort((a, b) => date(a).localeCompare(date(b)) || a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
}

export const activityFilters = { all: 'All', notes: 'Notes & Calls', email: 'Email', meetings: 'Meetings', tasks: 'Tasks' } as const;
export type ActivityFilter = keyof typeof activityFilters;
export function inActivityFilter(type: string, filter: ActivityFilter) {
  return filter === 'all' || (filter === 'notes' ? ['note', 'call', 'message'].includes(type) : type === ({ email: 'email', meetings: 'meeting', tasks: 'task' } as const)[filter]);
}

/** Build once for a directory render, not once per visible person. */
export function contactsWithOpenFollowUps(contacts: Entity<Contact>[], tasks: readonly Entity<Task>[]) {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (task.value.trashed || task.value.status === 'done' || task.value.status === 'skipped' || task.value.origin?.kind !== 'contact') continue;
    ids.add(task.value.origin.id); ids.add(contactDestination(task.value.origin.id, contacts));
  }
  return ids;
}

export function contactDeadlineOverdue(task: Task, planningTimezone: string, now: number) {
  if (!task.due || task.trashed || task.status === 'done' || task.status === 'skipped') return false;
  const timezone = task.timezone || planningTimezone, today = dayInZone(timezone, now);
  return task.due < today || (task.due === today && !!task.dueTime && task.dueTime < clockInZone(new Date(now).toISOString(), timezone));
}
