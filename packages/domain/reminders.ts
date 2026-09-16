import { z } from 'zod';
import { clockTime, localDate, timezone } from './tasks.js';
export const reminderSchema = z.object({ date: localDate, time: clockTime.refine(v => !!v), timezone, overlap: z.enum(['earlier', 'later']).optional() }).strict();
export type ReminderSpec = z.infer<typeof reminderSchema>;
export type ReminderRecord = { id: string; revision: number; spec: ReminderSpec; dueAt: number | null; state: 'scheduled' | 'ready' | 'missed' | 'unavailable' | 'dismissed' | 'cancelled'; reason?: string; seenAt?: number; snoozes: number; notification?: { attemptId: string; clientId: string; deviceId: string; at: number; state: 'claimed' | 'shown' | 'unavailable' | 'unknown' } };
export type Reminder = ReminderRecord & { taskId: string; taskRevision: number };
export type NotificationAttempt = NonNullable<Reminder['notification']> & { reminderId: string; taskId: string; dueAt: number | null; snoozes: number };
export const reminderWindowMs = 5 * 60_000;
const common = { requestId: z.string().uuid(), epoch: z.string().uuid(), reminderId: z.string().uuid() };
export const reminderActionSchema = z.object({ ...common, expectedRevision: z.number().int().positive(), action: z.enum(['seen', 'dismiss', 'snooze']), minutes: z.number().int().min(1).max(1440).optional() }).strict().refine(v => v.action !== 'snooze' || v.minutes !== undefined);
export const reminderDeliverySchema = z.object({ ...common, clientId: z.string().uuid(), action: z.enum(['claim', 'shown', 'unavailable']), attemptId: z.string().uuid().optional() }).strict().refine(v => v.action === 'claim' || !!v.attemptId);
const formatters = new Map<string, Intl.DateTimeFormat>();
function wallParts(instant: number, zone: string): string {
  let formatter = formatters.get(zone); if (!formatter) { formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); formatters.set(zone, formatter); }
  const parts = formatter.formatToParts(instant), part = (key: string) => parts.find(p => p.type === key)!.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
}
/** Resolve a wall-clock time without letting Date silently choose a DST side or shift a gap. */
export function reminderInstant(spec: ReminderSpec): { instant: number | null; problem?: 'gap' | 'overlap'; choices: number[] } {
  const wall = `${spec.date}T${spec.time}:00`, naive = Date.parse(wall + 'Z'), offsets = new Set<number>();
  // Probe both sides of the date. This includes half-hour transitions and skipped civil days.
  for (let hours = -48; hours <= 48; hours += 6) { const sample = naive + hours * 3600000; offsets.add(Date.parse(wallParts(sample, spec.timezone) + 'Z') - sample); }
  const choices = [...offsets].map(offset => naive - offset).filter(time => wallParts(time, spec.timezone) === wall).sort((a, b) => a - b);
  if (!choices.length) return { instant: null, problem: 'gap', choices };
  if (choices.length > 1 && !spec.overlap) return { instant: null, problem: 'overlap', choices };
  return { instant: choices[spec.overlap === 'later' ? choices.length - 1 : 0], choices };
}
export const reminderLabels: Record<Reminder['state'], string> = { scheduled: 'Scheduled', ready: 'Ready to review', missed: 'Time passed without confirmed display', unavailable: 'Time needs review', dismissed: 'Dismissed', cancelled: 'Cancelled' };
