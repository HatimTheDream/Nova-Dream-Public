import { z } from 'zod';
import type { Entity, Task } from './contracts.js';
import type { NotificationAttempt, Reminder } from './reminders.js';

export const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
export const timezone = z.string().max(80).refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } });
export const clockTime = z.string().regex(/^$|^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const routineSchema = z.object({
  title: z.string().trim().min(1).max(300), notes: z.string().max(10000),
  kind: z.enum(['task', 'habit']), state: z.enum(['active', 'paused']),
  startsOn: localDate, timezone, cadence: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(100).optional(), endsOn: localDate.optional(),
  monthDay: z.number().int().min(1).max(31).optional(), month: z.number().int().min(1).max(12).optional(),
  monthDays: z.array(z.union([z.literal(-1), z.number().int().min(1).max(31)])).min(1).max(32).refine(v => new Set(v).size === v.length).optional(),
  missingDay: z.enum(['skip', 'last-day']).optional(),
  monthPattern: z.enum(['date', 'weekday']).optional(), ordinal: z.union([z.literal(-1), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(), weekday: z.number().int().min(0).max(6).optional(),
  reminderTime: clockTime.optional(), reminderOverlap: z.enum(['earlier', 'later']).optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(0).max(7).refine(v => new Set(v).size === v.length),
  projectId: z.string().max(100).nullable(), plannedTime: clockTime,
  priority: z.enum(['low', 'normal', 'high']), estimateMinutes: z.number().int().min(0).max(1440),
}).strict().refine(v => !v.endsOn || v.endsOn >= v.startsOn, 'The end date must not precede the start.').refine(v => v.cadence !== 'weekly' || v.weekdays.length > 0, 'Choose at least one weekday.')
  .refine(v => !v.monthDays || (['monthly', 'yearly'].includes(v.cadence) && v.monthPattern !== 'weekday' && v.monthDay === undefined), 'Choose one monthly date rule.');
export type Routine = z.infer<typeof routineSchema>;
export type Occurrence = { taskId: string; routineId: string; templateRevision: number; date: string; timezone: string; kind: Routine['kind'] };
export type TaskEvent = { id: string; taskId: string; at: string; from: Task['status'] | null; to: Task['status']; xpDelta: number; action?: 'trash' | 'restore' };
export type RoutineEvent = { id: string; routineId: string; at: string; state: Routine['state']; revision: number };
export type Focus = { taskId: string; revision: number; deviceId: string; clientId: string; running: boolean; elapsedMs: number; lastPulse: number };
export type TaskState = { occurrences: Occurrence[]; events: TaskEvent[]; routineEvents: RoutineEvent[]; focus: Focus[]; earnedXp: number; orders?: DailyOrder[]; reminders?: Reminder[]; reminderAttempts?: NotificationAttempt[] };
export const focusSchema = z.object({ requestId: z.string().uuid(), epoch: z.string().uuid(), taskId: z.string().max(100), expectedRevision: z.number().int().nonnegative(), clientId: z.string().uuid(), action: z.enum(['start', 'pulse', 'pause']) }).strict();
export type FocusCommand = z.infer<typeof focusSchema>;
export const focusLeaseMs = 30_000;
export function focusElapsed(focus: Focus, now: number): number { return focus.elapsedMs + (focus.running ? Math.max(0, Math.min(focusLeaseMs, now - focus.lastPulse)) : 0); }
export function dayInZone(timezone: string, now = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)!.value).join('-');
}
export function nextDay(day: string): string { return new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10); }
const dayNumber = (day: string) => Math.floor(Date.parse(`${day}T12:00:00Z`) / 86400000);
const weekdayOf = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
function datesInMonth(routine: Routine, last: number): number[] {
  // Last day (-1) and a numbered date can resolve to the same occurrence.
  const wanted = routine.monthDays ?? [routine.monthDay ?? Number(routine.startsOn.slice(8, 10))];
  return [...new Set(wanted.map(date => date === -1 ? last : routine.missingDay === 'last-day' ? Math.min(date, last) : date))].filter(date => date <= last).sort((a, b) => a - b);
}
export function scheduled(routine: Routine, day: string): boolean {
  if (day < routine.startsOn || (routine.endsOn && day > routine.endsOn)) return false;
  const interval = routine.interval ?? 1;
  if (routine.cadence === 'daily') return (dayNumber(day) - dayNumber(routine.startsOn)) % interval === 0;
  if (routine.cadence === 'weekly') {
    // Monday-based calendar weeks; startsOn still excludes earlier days in week one.
    const week = (date: string) => dayNumber(date) - (weekdayOf(date) + 6) % 7;
    return ((week(day) - week(routine.startsOn)) / 7) % interval === 0 && routine.weekdays.includes(weekdayOf(day));
  }
  const [year, month, date] = day.split('-').map(Number), [startYear, startMonth] = routine.startsOn.split('-').map(Number);
  if (routine.cadence === 'monthly' && ((year - startYear) * 12 + month - startMonth) % interval !== 0) return false;
  if (routine.cadence === 'yearly' && ((year - startYear) % interval !== 0 || month !== (routine.month ?? startMonth))) return false;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (routine.monthPattern === 'weekday') return weekdayOf(day) === (routine.weekday ?? weekdayOf(routine.startsOn)) && ((routine.ordinal ?? 1) === -1 ? date + 7 > last : Math.ceil(date / 7) === (routine.ordinal ?? 1));
  return datesInMonth(routine, last).includes(date);
}
export function nextScheduled(routine: Routine, after: string): string | null {
  let first = nextDay(after); if (first < routine.startsOn) first = routine.startsOn;
  if (routine.endsOn && first > routine.endsOn) return null;
  const interval = routine.interval ?? 1;
  if (routine.cadence === 'daily') {
    const steps = Math.ceil((dayNumber(first) - dayNumber(routine.startsOn)) / interval);
    const date = new Date(Date.parse(`${routine.startsOn}T12:00:00Z`) + steps * interval * 86400000).toISOString().slice(0, 10);
    return scheduled(routine, date) ? date : null;
  }
  if (routine.cadence === 'weekly') { for (let i = 0, day = first; i <= interval * 7; i++, day = nextDay(day)) if (scheduled(routine, day)) return day; return null; }
  const [sy, sm] = routine.startsOn.split('-').map(Number), [fy, fm] = first.split('-').map(Number);
  const yearly = routine.cadence === 'yearly', startPeriod = yearly ? sy : sy * 12 + sm - 1, firstPeriod = yearly ? fy : fy * 12 + fm - 1;
  let period = startPeriod + Math.ceil((firstPeriod - startPeriod) / interval) * interval;
  // Gregorian dates repeat within 400 years; skip whole periods instead of scanning every day.
  for (let i = 0; i <= (yearly ? 400 : 4800); i++, period += interval) {
    const year = yearly ? period : Math.floor(period / 12), month = yearly ? routine.month ?? sm : period % 12 + 1;
    if (year > Math.min(9999, fy + 400)) return null;
    const prefix = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-`;
    if (routine.endsOn && prefix + '01' > routine.endsOn) return null;
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const weekday = routine.weekday ?? weekdayOf(routine.startsOn), ordinal = routine.ordinal ?? 1;
    const dates = routine.monthPattern === 'weekday' ? [ordinal === -1 ? last - (weekdayOf(prefix + String(last)) - weekday + 7) % 7 : 1 + (weekday - weekdayOf(prefix + '01') + 7) % 7 + (ordinal - 1) * 7] : datesInMonth(routine, last);
    for (const date of dates) if (date >= 1 && date <= last) { const day = prefix + String(date).padStart(2, '0'); if (day >= first && scheduled(routine, day)) return day; }
  }
  return null;
}
export type DailyOrder = { date: string; timezone: string; revision: number; taskIds: string[] };
export const dailyOrderSchema = z.object({ requestId: z.string().uuid(), epoch: z.string().uuid(), date: localDate, timezone, expectedRevision: z.number().int().nonnegative(), taskIds: z.array(z.string().min(1).max(100)).max(5000).refine(v => new Set(v).size === v.length) }).strict();
export type DailyOrderCommand = z.infer<typeof dailyOrderSchema>;
export const taskViews = ['All', 'Capture', 'Today', 'Upcoming', 'Anytime', 'Waiting', 'Review', 'History', 'Trash'] as const;
export type TaskView = typeof taskViews[number];
export const taskHistorySchema = z.object({ taskId: z.string().min(1).max(100), beforeRevision: z.number().int().positive().optional() }).strict();
export type TaskHistory = { versions: Entity<Task>[]; beforeRevision: number | null };
export const statusNames: Record<Task['status'], string> = { open: 'Ready', active: 'In progress', waiting: 'Waiting', blocked: 'Blocked', done: 'Completed', skipped: 'Skipped' };
export function inTaskView(task: Task, view: TaskView, today: string): boolean {
  if (view === 'Trash') return !!task.trashed;
  if (task.trashed) return false;
  if (view === 'All') return true;
  const finished = task.status === 'done' || task.status === 'skipped';
  if (view === 'History') return finished;
  // Planning lists retain their completed rows; completion never erases the plan.
  if (view === 'Today') return task.planned === today || task.status === 'active';
  if (view === 'Upcoming') return task.planned > today;
  if (view === 'Capture') return !task.planned && (task.status === 'open' || finished) && task.bucket !== 'anytime';
  if (view === 'Anytime') return !task.planned && (task.status === 'open' || finished) && task.bucket === 'anytime';
  if (finished) return false;
  if (view === 'Waiting') return task.status === 'waiting' || task.status === 'blocked';
  if (view === 'Review') return !!task.planned && task.planned < today;
  return false;
}
export function sortTasks(tasks: Entity<Task>[], order: string[] = []): Entity<Task>[] {
  const ranks = new Map(order.map((id, index) => [id, index]));
  const priority = { high: 0, normal: 1, low: 2 };
  return [...tasks].sort((a, b) => ((ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity) || 0) || (a.value.planned || '9999').localeCompare(b.value.planned || '9999') || (a.value.plannedTime || '99').localeCompare(b.value.plannedTime || '99') || priority[a.value.priority ?? 'normal'] - priority[b.value.priority ?? 'normal'] || a.id.localeCompare(b.id));
}
