import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptTaskConfirmation, type TaskEditorDraft } from '../apps/client/src/task-editor-confirmation';
import type { Entity, Task } from '../packages/domain/contracts';

const captured: Entity<Task> = { id: 'task:one', revision: 3, updatedAt: '', deviceId: 'fixture', value: { title: 'Launch', notes: '', status: 'open', planned: '', due: '' } };
const confirmed: Entity<Task> = { ...captured, revision: 4, value: { ...captured.value, origin: { kind: 'assignment', id: 'assignment:one', revision: 1 } } };
const draft: TaskEditorDraft = { value: captured.value, revision: 3, epoch: 'epoch' };

test('confirmed launch link supplies the revision for the next task save or result acceptance', () => {
  const next = adoptTaskConfirmation(draft, captured, confirmed, 'epoch');
  assert.equal(next.revision, 4);
  assert.deepEqual(next.value, confirmed.value);
});

test('confirmation preserves writing made while its response was in flight', () => {
  const writing = { ...draft, value: { ...draft.value, notes: 'Keep this writing', due: '2026-12-01' } };
  const next = adoptTaskConfirmation(writing, captured, confirmed, 'epoch');
  assert.equal(next.value.notes, 'Keep this writing');
  assert.equal(next.value.due, '2026-12-01');
  assert.deepEqual(next.value.origin, confirmed.value.origin);
  assert.equal(next.revision, 4);
});

test('reopening or replaying old confirmation never downgrades a newer draft or pending save', () => {
  for (const current of [
    { ...draft, revision: 5 },
    { ...draft, epoch: 'other' },
    { ...draft, pending: { kind: 'task' as const, requestId: 'original', epoch: 'epoch', entityId: captured.id, expectedRevision: 3, payload: draft.value } },
  ]) assert.equal(adoptTaskConfirmation(current, captured, confirmed, 'epoch'), current);
  assert.equal(adoptTaskConfirmation(draft, captured, { ...confirmed, id: 'task:other' }, 'epoch'), draft);
  assert.equal(adoptTaskConfirmation(draft, captured, { ...confirmed, revision: 3 }, 'epoch'), draft);
});
