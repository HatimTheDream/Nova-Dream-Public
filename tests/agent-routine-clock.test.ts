import test from 'node:test';
import assert from 'node:assert/strict';
import { intervalClock, routineWithClock } from '../apps/client/src/agent-routine-clock.js';
import type { AgentRoutineValue } from '../packages/domain/agent-routines.js';
import { nextAgentRun } from '../apps/service/agent-schedule.js';

const routine = (anchor = '2026-09-10T03:42:18.257Z', timezone = 'America/Los_Angeles'): AgentRoutineValue => ({
  name: 'Review work', assignmentId: 'plan', assignmentRevision: 1, projectRevision: null,
  schedule: { kind: 'every', anchor, minutes: 60 }, timezone, missed: 'skip', enabled: false, archived: false,
});

test('display uses the selected timezone; an unedited saved anchor keeps exact precision', () => {
  const value = routine();
  assert.deepEqual(intervalClock(value), { date: '2026-09-09', time: '20:42' });
  assert.equal(routineWithClock(value), value);
  assert.deepEqual(intervalClock({ ...value, timezone: 'Asia/Tokyo' }), { date: '2026-09-10', time: '12:42' });
});

test('edited date and clock resolve independently of browser timezone and survive retained JSON drafts', () => {
  const draft = JSON.parse(JSON.stringify({ value: routine(), intervalStart: { date: '2026-09-12', time: '09:15' } }));
  const value = routineWithClock(draft.value, draft.intervalStart);
  assert.equal(value.schedule.kind === 'every' && value.schedule.anchor, '2026-09-12T16:15:00.000Z');
  assert.equal(nextAgentRun(value, Date.parse('2026-09-12T16:15:00Z')), Date.parse('2026-09-12T17:15:00Z'));
});

test('a repeated first time needs an explicit side and saved later times recover that side', () => {
  const wall = { date: '2026-11-01', time: '01:30' };
  assert.throws(() => routineWithClock(routine(), wall), /occurs twice/);
  const early = routineWithClock(routine(), { ...wall, overlap: 'earlier' });
  const late = routineWithClock(routine(), { ...wall, overlap: 'later' });
  assert.equal(early.schedule.kind === 'every' && early.schedule.anchor, '2026-11-01T08:30:00.000Z');
  assert.equal(late.schedule.kind === 'every' && late.schedule.anchor, '2026-11-01T09:30:00.000Z');
  assert.deepEqual(intervalClock(late), { ...wall, overlap: 'later' });
  assert.deepEqual(intervalClock(routine('2026-11-01T08:30:59.999Z')), { ...wall, overlap: 'earlier' });
});

test('gaps and incomplete retained writing cannot silently submit the previous anchor', () => {
  assert.throws(() => routineWithClock(routine(), { date: '2026-03-08', time: '02:30' }), /does not exist/);
  assert.throws(() => routineWithClock(routine(), { date: '', time: '09:00' }), /valid first/);
  assert.throws(() => routineWithClock({ ...routine(), timezone: 'America/' }, { date: '2026-09-12', time: '09:00' }), /valid first/);
  assert.deepEqual(intervalClock(routine('invalid')), { date: '', time: '' });
});

test('changing timezone with a retained local clock keeps the requested first wall time', () => {
  const value = routine(), clock = intervalClock(value);
  const changed = routineWithClock({ ...value, timezone: 'Asia/Kolkata' }, clock);
  assert.equal(changed.schedule.kind === 'every' && changed.schedule.anchor, '2026-09-09T15:12:00.000Z');
  const once = { ...value, schedule: { kind: 'once' as const, date: '2026-09-12', time: '09:00' } };
  assert.equal(routineWithClock(once, clock), once);
});
