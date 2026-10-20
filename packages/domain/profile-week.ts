import { z } from 'zod';
import type { Entity, Task } from './contracts.js';
import { dayInZone, localDate, type TaskEvent } from './tasks.js';
import { profileTaskCredits, questPeriod, type ProgressHistoryPage } from './profile-progression.js';

export const profileTimezoneSchema = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true; } catch { return false; }
}, 'Choose a valid Home Timezone.');
export const profileWeekStartSchema = localDate.refine(day => new Date(`${day}T12:00:00Z`).getUTCDay() === 1, 'A week starts on Monday.');
export const profileWeekIdentitySchema = z.object({ start: profileWeekStartSchema, timezone: profileTimezoneSchema }).strict();
export type ProfileWeekIdentity = z.infer<typeof profileWeekIdentitySchema>;
export type ProfileWeekState = {
  epoch: string; identity: ProfileWeekIdentity; homeTimezone: string; currentWeek: string; today: string;
  days: { day: string; count: number; activityCount: number }[];
};
export type ProfileDayEntry = TaskEvent & { title: string; available: boolean; trashed: boolean; transition: 'completed' | 'reopened' | 'completed-again' };
export type ProfileDayPage = {
  epoch: string; revision: number; identity: ProfileWeekIdentity; day: string; head: string | null; entries: ProfileDayEntry[]; next: string | null; total: number;
};
export type ProfileHistoryState = { epoch: string; revision: number; head: string | null; page: ProgressHistoryPage };
export const shiftProfileDay = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export const sameProfileWeek = (a: ProfileWeekIdentity, b: ProfileWeekIdentity) => a.start === b.start && a.timezone === b.timezone;

/** Actual transitions include legacy zero-credit work; trash-only changes are not completions. */
export function profileCompletionActivity(tasks: Entity<Task>[], events: TaskEvent[]): ProfileDayEntry[] {
  const taskMap = new Map(tasks.map(task => [task.id, task])), completed = new Set<string>();
  const ledger = [...new Map(events.map(event => [event.id, event])).values()]
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  const activity: ProfileDayEntry[] = [];
  for (const event of ledger) {
    if (event.to !== 'done' && event.from !== 'done' || event.to === event.from) continue;
    const task = taskMap.get(event.taskId), transition = event.to !== 'done' ? 'reopened' : completed.has(event.taskId) ? 'completed-again' : 'completed';
    activity.push({ ...event, title: task?.value.title ?? 'Task unavailable', available: !!task, trashed: !!task?.value.trashed, transition });
    if (event.to === 'done') completed.add(event.taskId);
  }
  return activity.reverse();
}
export function buildProfileWeek(tasks: Entity<Task>[], events: TaskEvent[], identity: ProfileWeekIdentity, homeTimezone: string, now: number, epoch: string): ProfileWeekState {
  const { credited } = profileTaskCredits(events, identity.timezone), activity = profileCompletionActivity(tasks, events);
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = shiftProfileDay(identity.start, i);
    return { day, count: credited.filter(task => task.day === day).length, activityCount: activity.filter(event => dayInZone(identity.timezone, Date.parse(event.at)) === day).length };
  });
  return { epoch, identity, homeTimezone, currentWeek: questPeriod('weekly', homeTimezone, now).start, today: dayInZone(homeTimezone, now), days };
}
export function buildProfileDay(tasks: Entity<Task>[], events: TaskEvent[], identity: ProfileWeekIdentity, day: string, epoch: string, before?: string, revision = 0): ProfileDayPage | undefined {
  const activity = profileCompletionActivity(tasks, events).filter(event => dayInZone(identity.timezone, Date.parse(event.at)) === day);
  const cursor = before ? activity.findIndex(event => event.id === before) : -1;
  if (before && cursor < 0) return undefined;
  const start = cursor + 1, entries = activity.slice(start, start + 50);
  return { epoch, revision, identity, day, head: activity[0]?.id ?? null, entries, next: start + entries.length < activity.length ? entries.at(-1)!.id : null, total: activity.length };
}
