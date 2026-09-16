import type { AgentRoutineValue } from '../../../packages/domain/agent-routines';
import { reminderInstant, reminderSchema, type ReminderSpec } from '../../../packages/domain/reminders';
import { dayInZone } from '../../../packages/domain/tasks';

export type RoutineClock = Pick<ReminderSpec, 'date' | 'time' | 'overlap'>;

/** Display an existing instant without changing its precision or saved offset. */
export function intervalClock(value: AgentRoutineValue): RoutineClock {
  if (value.schedule.kind !== 'every') return { date: '', time: '' };
  try {
    const instant = Date.parse(value.schedule.anchor);
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: value.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
    const wall = { date: dayInZone(value.timezone, instant), time: `${parts.find(p => p.type === 'hour')!.value}:${parts.find(p => p.type === 'minute')!.value}` };
    const { choices } = reminderInstant({ ...wall, timezone: value.timezone });
    return choices.length > 1 ? { ...wall, overlap: Math.abs(choices[0] - instant) < 60000 ? 'earlier' : 'later' } : wall;
  } catch { return { date: '', time: '' }; }
}

/** Resolve only an explicitly edited clock. Unchanged schedules retain exact bytes. */
export function routineWithClock(value: AgentRoutineValue, clock?: RoutineClock): AgentRoutineValue {
  if (value.schedule.kind !== 'every' || !clock) return value;
  const parsed = reminderSchema.safeParse({ ...clock, timezone: value.timezone });
  if (!parsed.success) throw new Error('Choose a valid first date, time, and timezone.');
  const resolved = reminderInstant(parsed.data);
  if (resolved.instant === null) throw new Error(resolved.problem === 'overlap'
    ? 'This first time occurs twice. Choose the earlier or later occurrence.'
    : 'This first time does not exist in this timezone. Choose another time.');
  return { ...value, schedule: { ...value.schedule, anchor: new Date(resolved.instant).toISOString() } };
}
