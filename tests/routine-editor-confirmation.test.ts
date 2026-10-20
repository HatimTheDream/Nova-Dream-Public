import test from 'node:test';
import assert from 'node:assert/strict';
import type { Command, Entity } from '../packages/domain/contracts';
import type { Routine } from '../packages/domain/tasks';
import { confirmedRoutineDraft, reopenedRoutineConfirmation, routineResponseDraft, rejectedRoutineDraft, reviewedRoutineDraft, routineDraftProblem, type RoutineEditorDraft } from '../apps/client/src/routine-editor-confirmation';

const value: Routine = { title: 'Daily walk', notes: '', kind: 'task', state: 'active', startsOn: '2026-03-07', timezone: 'UTC', cadence: 'daily', interval: 1, weekdays: [], projectId: null, plannedTime: '', priority: 'normal', estimateMinutes: 0 };
const routine: Entity<Routine> = { id: 'routine:00000000-0000-4000-8000-000000000001', revision: 2, deviceId: 'device', updatedAt: '', value };
const command: Command = { requestId: 'original-request', epoch: 'epoch', kind: 'routine', entityId: routine.id, expectedRevision: 2, payload: { ...value, title: 'Future walk' } };
const draft: RoutineEditorDraft = { epoch: 'epoch', revision: 2, value: command.payload as Routine, pending: command };
const confirmed: Entity<Routine> = { ...routine, revision: 3, value: command.payload as Routine };

test('routine acknowledgement preserves newer writing and stores the exact original response', () => {
  const stored = { ...draft, value: { ...draft.value, notes: 'Newer local writing', interval: 3 } };
  const next = confirmedRoutineDraft(stored, command, confirmed)!;
  assert.equal(next.clean, false); assert.equal(next.draft.revision, 3); assert.equal(next.draft.value.notes, stored.value.notes);
  assert.equal(next.draft.value.interval, 3); assert.equal(next.draft.pending, undefined);
  assert.deepEqual(next.draft.confirmation, { command, routine: confirmed }); assert.equal(stored.pending, command);
  assert.equal(confirmedRoutineDraft(draft, command, confirmed)!.clean, true);
});

test('wrong series, epoch, request, revision, payload or unbound confirmation cannot clear a routine command', () => {
  for (const stored of [{ ...draft, epoch: 'old' }, { ...draft, revision: 1 }, { ...draft, pending: { ...command, requestId: 'newer' } }]) assert.equal(confirmedRoutineDraft(stored, command, confirmed), undefined);
  for (const reply of [{ ...confirmed, id: 'routine:other' }, { ...confirmed, revision: 4 }, { ...confirmed, value: { ...confirmed.value, interval: 50 } }]) assert.equal(confirmedRoutineDraft(draft, command, reply), undefined);
  const retained = confirmedRoutineDraft(draft, command, confirmed)!.draft;
  assert.equal(reopenedRoutineConfirmation(draft, retained)!.confirmed, confirmed);
  for (const wrong of [{ ...retained, epoch: 'old' }, { ...retained, confirmation: { command: { ...command, entityId: 'routine:other' }, routine: confirmed } }, { ...retained, confirmation: { command, routine: { ...confirmed, value } } }]) assert.equal(reopenedRoutineConfirmation(draft, wrong), undefined);
});

test('known response survives later host revisions while foreign epoch and missing saved series remain blocked', () => {
  const retained = confirmedRoutineDraft(draft, command, confirmed)!.draft;
  const known = reopenedRoutineConfirmation(draft, retained)!;
  assert.equal(known.confirmed.revision, 3);
  assert.match(routineDraftProblem(known.draft, routine.id, 'epoch', { ...routine, revision: 4 }), /newer saved schedule/);
  assert.match(routineDraftProblem(draft, routine.id, 'new-epoch', routine), /earlier workspace/);
  assert.match(routineDraftProblem(draft, routine.id, 'epoch'), /unavailable/);
  assert.equal(routineDraftProblem(draft, routine.id, 'epoch', { ...routine, revision: 4 }), ''); // Reconcile the original request, not a replacement.
  assert.match(routineDraftProblem({ ...draft, pending: { ...command, entityId: 'routine:other' } }, routine.id, 'epoch', routine), /does not match/);
});

test('reopened response composes retained and in-memory writing, refusing conflicting proposals or a different command', () => {
  const retained = confirmedRoutineDraft({ ...draft, value: { ...draft.value, notes: 'Kept elsewhere' } }, command, confirmed)!.draft;
  const next = reopenedRoutineConfirmation({ ...draft, value: { ...draft.value, interval: 4 } }, retained)!;
  assert.equal(next.draft.value.notes, 'Kept elsewhere'); assert.equal(next.draft.value.interval, 4); assert.equal(next.clean, false);
  assert.equal(reopenedRoutineConfirmation({ ...draft, value: { ...draft.value, notes: 'Different in-memory writing' } }, retained), undefined);
  const local = { ...draft, value: { ...draft.value, notes: 'Local write failed' } };
  assert.equal(routineResponseDraft(local, undefined, command, confirmed)!.draft.value.notes, local.value.notes);
  assert.equal(routineResponseDraft(local, { ...draft, pending: { ...command, requestId: 'another' } }, command, confirmed), undefined);
});

test('definite rejection and explicit review join exact original command and preserve both newer proposals', () => {
  const local = { ...draft, value: { ...draft.value, interval: 4 } }, kept = { ...draft, value: { ...draft.value, notes: 'Kept writing' } };
  const rejected = rejectedRoutineDraft(local, kept, command)!;
  assert.equal(rejected.pending, undefined); assert.equal(rejected.value.interval, 4); assert.equal(rejected.value.notes, 'Kept writing');
  const reviewed = reviewedRoutineDraft(local, kept, routine.id, 'epoch', confirmed, command)!;
  assert.equal(reviewed.revision, 3); assert.equal(reviewed.value.notes, 'Kept writing'); assert.equal(reviewed.value.interval, 4);
  for (const other of [{ ...kept, pending: { ...command, requestId: 'newer' } }, { ...kept, epoch: 'different' }, { ...kept, revision: 9 }]) {
    assert.equal(rejectedRoutineDraft(local, other, command), undefined); assert.equal(reviewedRoutineDraft(local, other, routine.id, 'epoch', confirmed, command), undefined);
  }
  assert.equal(rejectedRoutineDraft({ ...local, value: { ...local.value, notes: 'Conflicting writing' } }, kept, command), undefined);
  assert.equal(reviewedRoutineDraft(local, kept, routine.id, 'different', confirmed, command), undefined);
  assert.equal(reviewedRoutineDraft(local, kept, 'routine:other', 'epoch', confirmed, command), undefined);
  assert.equal(reviewedRoutineDraft(local, kept, routine.id, 'epoch', confirmed), undefined);
  assert.equal(reviewedRoutineDraft(rejected, { ...rejected, value: { ...rejected.value, notes: 'Changed since shown' } }, routine.id, 'epoch', confirmed), undefined);
});
