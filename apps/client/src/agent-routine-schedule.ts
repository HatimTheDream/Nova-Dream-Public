import type { AgentRoutineValue } from '../../../packages/domain/agent-routines';

/** Recognize only exact everyday patterns; opening an editor never rewrites cron. */
export function routineScheduleFields(schedule: AgentRoutineValue['schedule']) {
  const match = schedule.kind === 'cron' ? /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/.exec(schedule.expression) : null;
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23) return { kind: schedule.kind, time: '09:00', weekday: '1' };
  return { kind: match[3] === '*' ? 'daily' : 'weekly', time: `${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')}`, weekday: match[3] === '*' ? '1' : match[3] };
}

export function routineCron(time: string, weekday = '*'): AgentRoutineValue['schedule'] {
  const [hour, minute] = time.split(':');
  return { kind: 'cron', expression: `${Number(minute)} ${Number(hour)} * * ${weekday}` };
}
