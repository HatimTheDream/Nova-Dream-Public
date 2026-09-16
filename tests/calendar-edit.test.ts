import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { draftForCalendar, eventSaveCommand, reviewedEventDraft } from '../apps/client/src/calendar-edit.js';
import type { LocalCalendarDetail, LocalCalendarEvent } from '../packages/domain/calendar.js';
import { localOccurrence } from '../packages/domain/calendar-repeat.js';

function detail(): LocalCalendarDetail {
  const event: LocalCalendarEvent = { id: randomUUID(), deviceId: randomUUID(), revision: 2, updatedAt: '', isSeries: true, exceptionsRevision: 3, value: { title: 'Studio', notes: 'Keep my writing', location: '', allDay: false, timezone: 'America/Los_Angeles', start: { date: '2026-09-08', time: '09:00' }, end: { date: '2026-09-08', time: '10:00' }, state: 'confirmed', projectId: null, taskId: null, repeat: { cadence: 'weekly', interval: 1, weekdays: [2] } } };
  return { epoch: randomUUID(), event, occurrence: localOccurrence(event, [], '2026-09-15'), exceptionCount: 0, exceptions: [] };
}
test('occurrence commands keep master identity and original date when moved; a pending receipt never changes on reload', () => {
  const source = detail(), draft = draftForCalendar(source, 'occurrence');
  draft.value = { ...draft.value, start: { date: '2026-10-01', time: '14:00' }, end: { date: '2026-10-01', time: '15:00' } };
  const command = eventSaveCommand(draft, randomUUID());
  assert.equal(command.eventId, source.event.id); assert.equal(command.originalDate, '2026-09-15'); assert.equal(command.expectedRevision, 2); assert.equal(command.expectedOverrideRevision, 0); assert.equal(command.value.repeat, undefined);
  const reloaded = JSON.parse(JSON.stringify({ ...draft, pending: command }));
  assert.deepEqual(eventSaveCommand({ ...reloaded, epoch: randomUUID(), revision: 99 }, randomUUID()), command);
});
test('fresh conflict review retains writing and scope while updating both occurrence and series authority', () => {
  const source = detail(), draft = draftForCalendar(source, 'occurrence');
  draft.value = { ...draft.value, title: 'My kept title' }; draft.pending = eventSaveCommand(draft, randomUUID()); draft.review = true;
  const fresh = { ...source, epoch: randomUUID(), event: { ...source.event, revision: 4, exceptionsRevision: 9 }, occurrence: { ...source.occurrence!, revision: 4, overrideRevision: 7 } };
  const reviewed = reviewedEventDraft(draft, fresh), command = eventSaveCommand(reviewed, randomUUID());
  assert.equal(reviewed.value.title, 'My kept title'); assert.equal(reviewed.review, false); assert.equal(reviewed.pending, undefined); assert.equal(command.scope, 'occurrence'); assert.equal(command.originalDate, '2026-09-15'); assert.equal(command.expectedRevision, 4); assert.equal(command.expectedOverrideRevision, 7); assert.equal(command.epoch, fresh.epoch);
  const series = draftForCalendar(source, 'series'); series.exceptions = 'reset';
  const reviewedSeries = reviewedEventDraft(series, fresh), seriesCommand = eventSaveCommand(reviewedSeries, randomUUID());
  assert.equal(seriesCommand.exceptions, 'reset'); assert.equal(seriesCommand.expectedExceptionsRevision, 9); assert.equal(seriesCommand.originalDate, undefined); assert.deepEqual(reviewedSeries.value, series.value);
});
test('review cannot silently turn a removed occurrence or old single-event draft into an entire-series edit', () => {
  const source = detail(), occurrence = draftForCalendar(source, 'occurrence');
  assert.throws(() => reviewedEventDraft(occurrence, { ...source, occurrence: undefined }), /no longer belongs/);
  assert.throws(() => reviewedEventDraft(occurrence, { ...source, event: { ...source.event, value: { ...source.event.value, state: 'cancelled' } } }), /entire series is cancelled/);
  assert.throws(() => reviewedEventDraft({ ...occurrence, scope: 'event', originalDate: undefined }, source), /now a series/);
  assert.throws(() => reviewedEventDraft(occurrence, { ...source, event: { ...source.event, id: randomUUID() } }), /does not match/);
});
