import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { routineCron, routineScheduleFields } from '../apps/client/src/agent-routine-schedule';
import { nextAgentRun } from '../apps/service/agent-schedule';
import type { AgentRoutineValue } from '../packages/domain/agent-routines';

test('everyday schedule controls represent exact saved daily and weekly cron without mutating it', () => {
  const daily = { kind: 'cron' as const, expression: '05 09 * * *' };
  const weekly = { kind: 'cron' as const, expression: '30 16 * * 1' };
  assert.deepEqual(routineScheduleFields(daily), { kind: 'daily', time: '09:05', weekday: '1' });
  assert.deepEqual(routineScheduleFields(weekly), { kind: 'weekly', time: '16:30', weekday: '1' });
  assert.equal(daily.expression, '05 09 * * *');
  assert.equal(weekly.expression, '30 16 * * 1');
  assert.deepEqual(routineCron('16:30', '1'), weekly);
  assert.deepEqual(routineCron('00:00', '0'), { kind: 'cron', expression: '0 0 * * 0' });
});

test('custom cron semantics and non-cron schedules are never reduced to a daily or weekly choice', () => {
  for (const expression of ['0 9 * * 1-5', '*/15 9 * * *', '0 9 1 * *', '0 9 * * MON', '0 9 * * 7', '0 24 * * *', '60 9 * * *', '0 9 * * * extra']) {
    const schedule = { kind: 'cron' as const, expression };
    assert.equal(routineScheduleFields(schedule).kind, 'cron', expression);
    assert.equal(schedule.expression, expression);
  }
  assert.equal(routineScheduleFields({ kind: 'once', date: '2026-09-22', time: '09:00' }).kind, 'once');
  assert.equal(routineScheduleFields({ kind: 'every', minutes: 60, anchor: '2026-09-22T09:00:00.000Z' }).kind, 'every');
});

test('a weekly control edit retains local wall time through a daylight-saving transition', () => {
  const value: AgentRoutineValue = { name: 'Weekly review', assignmentId: 'assignment:fixture', assignmentRevision: 1, projectRevision: null, timezone: 'America/Los_Angeles', schedule: routineCron('09:00', '1'), missed: 'skip', enabled: false, archived: false };
  assert.equal(new Date(nextAgentRun(value, Date.parse('2026-03-07T18:00Z'))!).toISOString(), '2026-03-09T16:00:00.000Z');
  assert.equal(new Date(nextAgentRun(value, Date.parse('2026-10-31T18:00Z'))!).toISOString(), '2026-11-02T17:00:00.000Z');
});
