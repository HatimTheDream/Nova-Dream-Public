import test from 'node:test';
import assert from 'node:assert/strict';
import { nextAppointment } from '../apps/client/src/HomeAppointmentWidget';
import type { CalendarDisplayEvent } from '../packages/domain/calendar';

const now = Date.parse('2026-09-19T18:00:00Z');
const event = (id: string, patch: Partial<CalendarDisplayEvent> = {}): CalendarDisplayEvent => ({
  id, sourceId: 'calendar:fixture', title: id, notes: '', location: '', status: 'confirmed',
  interval: { kind: 'instant', start: '2026-09-19T19:00:00Z', end: '2026-09-19T20:00:00Z' }, ...patch,
});

test('Next appointment excludes cancelled, synthetic, unresolved and completed calendar items', () => {
  const eligible = event('Actual appointment');
  const excluded = [event('Cancelled', { status: 'cancelled' }), event('Task', { sourceId: 'tasks' }), event('Content plan', { sourceId: 'content' }), event('Invalid occurrence', { warning: 'Choose a valid start time' }), event('Completed', { taskStatus: 'done' })];
  assert.equal(nextAppointment(excluded, 'UTC', now), undefined);
  assert.equal(nextAppointment([...excluded, eligible], 'UTC', now)?.event, eligible);
});

test('An ongoing appointment remains visible until its exact end and precedes later appointments', () => {
  const ongoing = event('Ongoing', { interval: { kind: 'instant', start: '2026-09-19T17:30:00Z', end: '2026-09-19T18:30:00Z' } });
  const ended = event('Ended', { interval: { kind: 'instant', start: '2026-09-19T17:00:00Z', end: '2026-09-19T18:00:00Z' } });
  const upcoming = event('Upcoming');
  assert.equal(nextAppointment([upcoming, ended, ongoing], 'UTC', now)?.event, ongoing);
  assert.equal(nextAppointment([ongoing, upcoming], 'UTC', Date.parse('2026-09-19T18:30:00Z'))?.event, upcoming);
  assert.equal(nextAppointment([ended], 'UTC', now), undefined);
});

test('All-day appointment boundaries follow the Home timezone, including short DST days', () => {
  const allDay = event('All day', { interval: { kind: 'date', start: '2026-09-18', end: '2026-09-19' } });
  const beforeLocalMidnight = Date.parse('2026-09-19T06:59:59Z');
  assert.equal(nextAppointment([allDay], 'America/Los_Angeles', beforeLocalMidnight)?.event, allDay);
  assert.equal(nextAppointment([allDay], 'UTC', beforeLocalMidnight), undefined);
  assert.equal(nextAppointment([allDay], 'America/Los_Angeles', Date.parse('2026-09-19T07:00:00Z')), undefined);
  const shortDay = event('DST day', { interval: { kind: 'date', start: '2026-03-08', end: '2026-03-09' } });
  const selected = nextAppointment([shortDay], 'America/Los_Angeles', Date.parse('2026-03-09T06:59:00Z'))!;
  assert.equal(selected.end - selected.start, 23 * 60 * 60 * 1000);
  assert.equal(nextAppointment([shortDay], 'America/Los_Angeles', Date.parse('2026-03-09T07:00:00Z')), undefined);
});

test('An ongoing all-day event remains the current appointment ahead of a later timed meeting', () => {
  const allDay = event('Today event', { interval: { kind: 'date', start: '2026-09-19', end: '2026-09-20' } });
  assert.equal(nextAppointment([event('Later meeting'), allDay], 'America/Los_Angeles', now)?.event, allDay);
});

test('Appointment ordering uses instants and stable identities without reordering saved input', () => {
  const first = event('a'), tie = event('b'), later = event('later', { interval: { kind: 'instant', start: '2026-09-19T13:00:00-07:00', end: '2026-09-19T14:00:00-07:00' } });
  const events = [later, tie, first], before = structuredClone(events);
  assert.equal(nextAppointment(events, 'Asia/Tokyo', now)?.event, first);
  assert.deepEqual(events, before);
  const tentative = event('Tentative', { status: 'tentative' });
  assert.equal(nextAppointment([tentative], 'UTC', now)?.event.status, 'tentative');
});

test('Invalid and reversed event intervals cannot replace a valid upcoming appointment', () => {
  const valid = event('Valid');
  const invalid = [
    event('Unreadable', { interval: { kind: 'instant', start: 'invalid', end: '2026-09-19T20:00:00Z' } }),
    event('Reversed', { interval: { kind: 'instant', start: '2026-09-19T18:30:00Z', end: '2026-09-19T18:15:00Z' } }),
    event('Empty', { interval: { kind: 'instant', start: '2026-09-19T18:30:00Z', end: '2026-09-19T18:30:00Z' } }),
  ];
  assert.equal(nextAppointment([...invalid, valid], 'UTC', now)?.event, valid);
});
