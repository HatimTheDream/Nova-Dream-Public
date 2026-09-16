import type { Snapshot, Task } from './contracts.js';
import type { CalendarDisplayEvent, CalendarRange } from './calendar.js';
import { addDays } from './calendar.js';
import { dayStart, overlapsRange } from './calendar-time.js';
import { reminderInstant } from './reminders.js';
import { dayInZone, scheduled, type Routine } from './tasks.js';

/** Read-only projections use the same occurrence IDs as the routine materializer. */
export function taskCalendarEvents(workspace: Snapshot, range: CalendarRange, now = Date.now()): CalendarDisplayEvent[] {
  const events: CalendarDisplayEvent[] = [], bounds = { start: dayStart(range.from, range.timezone), end: dayStart(range.to, range.timezone) };
  const known = new Set([...workspace.tasks, ...(workspace.trashedTasks ?? [])].map(task => task.id));
  const project = (id: string, t: Pick<Task, 'title' | 'notes' | 'planned' | 'plannedTime' | 'timezone' | 'estimateMinutes' | 'status'>, routineId?: string) => {
    if (!t.planned) return;
    const time = t.plannedTime ? reminderInstant({ date: t.planned, time: t.plannedTime, timezone: t.timezone ?? range.timezone }) : undefined;
    const interval = time?.instant != null ? { kind: 'instant' as const, start: new Date(time.instant).toISOString(), end: new Date(time.instant + (t.estimateMinutes || 30) * 60000).toISOString(), timezone: t.timezone ?? range.timezone } : { kind: 'date' as const, start: t.planned, end: addDays(t.planned, 1) };
    if (overlapsRange(interval, range, bounds)) events.push({ id, ...(routineId ? { routineId } : { taskId: id }), taskStatus: t.status, sourceId: 'tasks', title: t.title, notes: t.notes, location: '', status: 'confirmed', interval, ...(time?.instant === null ? { warning: 'The planned time needs review because clocks change.' } : {}) });
  };
  workspace.tasks.forEach(task => project(task.id, task.value));
  for (const routine of workspace.routines ?? []) {
    const r: Routine = routine.value, today = dayInZone(r.timezone, now);
    if (r.state !== 'active') continue;
    for (let date = addDays(range.from, -1); date <= range.to; date = addDays(date, 1)) {
      const id = `task:occ:${routine.id.slice('routine:'.length)}:${date}`;
      if (date <= today || known.has(id) || !scheduled(r, date)) continue;
      project(id, { ...r, planned: date, status: 'open' }, routine.id);
    }
  }
  return events;
}
