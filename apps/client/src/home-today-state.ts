import type { Entity, Snapshot, Task } from '../../../packages/domain/contracts';
import { dayInZone, sortTasks } from '../../../packages/domain/tasks';
import { inTaskDestination, isDailyOccurrence, isHistoricalDailyOccurrence, taskPresentationContext } from '../../../packages/domain/task-presentation';
import { homeTaskState } from './home-task-state';
import type { TaskChange } from './task-actions';

type Source = Pick<Snapshot, 'epoch' | 'deviceId' | 'tasks' | 'taskState' | 'routines' | 'layout'>;
export function homeTodayState(snapshot: Source, now: number) {
 const timezone = snapshot.layout.value.timezone, date = dayInZone(timezone, now);
 const context = taskPresentationContext(snapshot.taskState, snapshot.routines, now);
 const order = snapshot.taskState?.orders?.find(row => row.date === date && row.timezone === timezone)?.taskIds ?? [];
 const tasks = sortTasks(snapshot.tasks.filter(task => inTaskDestination(task, 'Today', date, timezone, context)), order);
 const routines = tasks.filter(task => isDailyOccurrence(task, context)), todo = tasks.filter(task => !isDailyOccurrence(task, context));
 const overdue = homeTaskState(snapshot, { timezone, showCompleted: true }, now).attention.filter(row => row.reasons.includes('overdue')).map(row => row.task);
 const candidates = sortTasks(snapshot.tasks.filter(task => !task.value.trashed && !['done', 'skipped'].includes(task.value.status) && !isDailyOccurrence(task, context) && !isHistoricalDailyOccurrence(task, context) && (!context.occurrences.has(task.id) || !!context.presentation[task.id]?.recurrence)), order);
 return { date, timezone, context, tasks, todo, routines, overdue, candidates };
}
export function taskEstimate(tasks: readonly Entity<Task>[]) {
 const unfinished = tasks.filter(task => !['done', 'skipped'].includes(task.value.status));
 return { minutes: unfinished.reduce((sum, task) => sum + (task.value.estimateMinutes ?? 0), 0), missing: unfinished.filter(task => !task.value.estimateMinutes).length };
}
export type HomePlan = { format: 1; epoch: string; deviceId: string; date: string; timezone: string; query: string; changes: { id: string; revision: number; selected: boolean }[] };
export function newHomePlan(snapshot: Source, now: number): HomePlan {
 const { date, timezone } = homeTodayState(snapshot, now);
 return { format: 1, epoch: snapshot.epoch, deviceId: snapshot.deviceId, date, timezone, query: '', changes: [] };
}
export function readHomePlan(raw: string | null): HomePlan | undefined {
 if (raw === null || raw === 'null') return;
 try {
  if (raw.length > 256000) return;
  const value = JSON.parse(raw);
  if (!value || value.format !== 1 || typeof value.epoch !== 'string' || typeof value.deviceId !== 'string' || typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) || typeof value.timezone !== 'string' || typeof value.query !== 'string' || value.query.length > 300 || !Array.isArray(value.changes) || value.changes.length > 500) return;
  if (!value.changes.every((row: unknown) => !!row && typeof row === 'object' && 'id' in row && typeof row.id === 'string' && /^[a-zA-Z0-9:_-]{1,100}$/.test(row.id) && 'revision' in row && Number.isSafeInteger(row.revision) && Number(row.revision) > 0 && 'selected' in row && typeof row.selected === 'boolean')) return;
  if (new Set(value.changes.map((row: { id: string }) => row.id)).size !== value.changes.length) return;
  return value;
 } catch { return; }
}
/** Build only explicitly reviewed ordinary-task changes. The existing queue owns dispatch/retry. */
export function homePlanChanges(plan: HomePlan, snapshot: Source, now: number): TaskChange[] {
 const current = homeTodayState(snapshot, now);
 if (plan.epoch !== snapshot.epoch || plan.deviceId !== snapshot.deviceId || plan.date !== current.date || plan.timezone !== current.timezone) throw Error('The workspace, day or planning timezone changed. Review a fresh plan before applying it.');
 if (plan.changes.length > 500) throw Error('Choose at most 500 task changes in one plan.');
 return plan.changes.flatMap(change => {
  const task = current.candidates.find(row => row.id === change.id);
  if (!task || task.revision !== change.revision) throw Error('A selected task changed or is no longer available. Review the current task before applying this plan.');
  if (change.selected) return task.value.planned === plan.date ? [] : [{ task, value: { ...task.value, planned: plan.date } }];
  return task.value.planned !== plan.date ? [] : [{ task, value: { ...task.value, planned: '', plannedTime: '', bucket: 'anytime' as const } }];
 });
}
export type HomeQuick = { id: string; title: string };
export function readHomeQuick(raw: string | null): HomeQuick | undefined {
 if (raw === null || raw === 'null') return;
 try { const value = JSON.parse(raw);return value && /^task:[a-f0-9-]{36}$/.test(value.id) && typeof value.title === 'string' && value.title.length <= 300 ? { id: value.id, title: value.title } : undefined; } catch { return; }
}
export function homeQuickTask(quick: HomeQuick, snapshot: Source, now: number): Entity<Task> {
 if (!quick.title.trim()) throw Error('Enter a task title.');
 if (snapshot.tasks.some(task => task.id === quick.id)) throw Error('This capture already has a saved task. Open it before creating another task.');
 const { date, timezone } = homeTodayState(snapshot, now);
 return { id: quick.id, revision: 0, deviceId: snapshot.deviceId, updatedAt: new Date(now).toISOString(), value: { title: quick.title.trim(), notes: '', status: 'open', planned: date, due: '', bucket: 'capture', timezone } };
}
