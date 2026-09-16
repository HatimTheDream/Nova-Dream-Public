import { Cron } from 'croner';
import type { AgentRoutineValue } from '../../packages/domain/agent-routines.js';
import { reminderInstant } from '../../packages/domain/reminders.js';
import { Fault } from './store.js';

// Croner evaluates dates only. The durable Nova Dream occurrence journal owns
// scheduling and admission; no library timers or predecessor jobs are created.
function cron(value: AgentRoutineValue) {
  if (value.schedule.kind !== 'cron') throw new Error('Expected cron schedule');
  if (value.schedule.expression.split(/\s+/).length !== 5) throw new Fault(400, 'routine_schedule', 'Use a five-field cron expression: minute hour day month weekday.');
  try { return new Cron(value.schedule.expression, { timezone: value.timezone, paused: true, mode: '5-part' }); }
  catch { throw new Fault(400, 'routine_schedule', 'This cron expression is invalid. Review the schedule.'); }
}
export function onceAt(value: AgentRoutineValue) {
  if (value.schedule.kind !== 'once') throw new Error('Expected one-time schedule');
  const resolved = reminderInstant({ ...value.schedule, timezone: value.timezone });
  if (resolved.instant === null) throw new Fault(400, 'routine_schedule', resolved.problem === 'overlap' ? 'This time occurs twice. Choose the earlier or later occurrence.' : 'This local time does not exist. Choose another time.');
  return resolved.instant;
}
export function nextAgentRun(value: AgentRoutineValue, after: number): number | null {
  if (value.schedule.kind === 'once') { const at = onceAt(value); return at > after ? at : null; }
  if (value.schedule.kind === 'every') {
    const anchor = Date.parse(value.schedule.anchor), step = value.schedule.minutes * 60000;
    const next = anchor + Math.max(0, Math.floor((after - anchor) / step) + 1) * step;
    return Number.isFinite(next) && next <= 8640000000000000 ? next : null;
  }
  const job = cron(value); try { return job.nextRun(new Date(after))?.getTime() ?? null; } finally { job.stop(); }
}
export function latestAgentRun(value: AgentRoutineValue, at: number, first: number): number {
  if (value.schedule.kind === 'once') return first;
  if (value.schedule.kind === 'every') { const step = value.schedule.minutes * 60000; return first + Math.floor((at - first) / step) * step; }
  const job = cron(value); try { return Math.max(first, job.previousRuns(1, new Date(at + 1))[0]?.getTime() ?? first); } finally { job.stop(); }
}
