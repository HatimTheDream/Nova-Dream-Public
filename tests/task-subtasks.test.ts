import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store';
import { syncTaskSubtasks } from '../packages/domain/task-subtasks';
import type { Entity, Task } from '../packages/domain/contracts';

test('subtasks complete the parent atomically; parent check/uncheck synchronizes every child and earned credit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-subtasks-')); let store = new Store(directory);
  try {
    let task: Entity<Task> = { id: `task:${randomUUID()}`, revision: 0, deviceId: 'a', updatedAt: '', value: { title: 'Plan the workshop', notes: '', planned: '', due: '', status: 'open', checklist: ['Choose the audience', 'Write the invitation'].map(text => ({ id: randomUUID(), text, done: false })) } };
    const save = (patch: Partial<Task>) => { const command = { requestId: randomUUID(), epoch: store.epoch, kind: 'task' as const, entityId: task.id, expectedRevision: task.revision, payload: { ...task.value, ...patch } }; task = store.mutate('a', command) as Entity<Task>; assert.deepEqual(store.mutate('a', command), task); return task; };
    save({}); save({ checklist: task.value.checklist!.map((step, i) => ({ ...step, done: !i })) });
    assert.equal(task.value.status, 'open'); assert.equal(store.snapshot('b').taskState?.earnedXp, 0);
    save({ checklist: task.value.checklist!.map(step => ({ ...step, done: true })) });
    assert.equal(task.value.status, 'done'); assert.equal(store.snapshot('b').taskState?.earnedXp, 10);
    save({ checklist: task.value.checklist!.map((step, i) => ({ ...step, done: !!i })) });
    assert.equal(task.value.status, 'open'); assert.deepEqual(task.value.checklist?.map(s => s.done), [false, true]); assert.equal(store.snapshot('b').taskState?.earnedXp, 0);
    save({ status: 'done' }); assert.ok(task.value.checklist!.every(s => s.done));
    store.close(); store = new Store(directory); assert.equal(store.snapshot('b').tasks[0].value.status, 'done');
    save({ status: 'open' }); assert.ok(task.value.checklist!.every(s => !s.done));
    save({ status: 'done' }); save({ checklist: [...task.value.checklist!, { id: randomUUID(), text: 'Reserve the room', done: false }] });
    assert.equal(task.value.status, 'open'); assert.deepEqual(task.value.checklist?.map(s => s.done), [true, true, false]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('empty subtasks do not finish a task and unrelated edits preserve partial progress', () => {
  const base: Task = { title: 'Write', notes: '', status: 'active', planned: '', due: '', checklist: [] };
  assert.equal(syncTaskSubtasks(base, base).status, 'active');
  const partial = { ...base, checklist: [{ id: randomUUID(), text: 'Outline', done: true }, { id: randomUUID(), text: 'Draft', done: false }] };
  assert.equal(syncTaskSubtasks({ ...partial, notes: 'Keep going' }, partial).status, 'active');
  assert.deepEqual(syncTaskSubtasks({ ...partial, notes: 'Keep going' }, partial).checklist, partial.checklist);
});

test('automatic parent completion cannot bypass prerequisites or overwrite a concurrent revision', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-subtasks-')), store = new Store(directory);
  try {
    const value: Task = { title: 'Prerequisite', notes: '', status: 'open', planned: '', due: '' };
    const put = (id: string, payload: Task, revision = 0) => store.mutate('a', { requestId: randomUUID(), epoch: store.epoch, kind: 'task', entityId: id, expectedRevision: revision, payload }) as Entity<Task>;
    const parent = put(`task:${randomUUID()}`, value);
    const child = put(`task:${randomUUID()}`, { ...value, title: 'Dependent', dependencies: [parent.id], checklist: [{ id: randomUUID(), text: 'Finish', done: false }] });
    assert.throws(() => put(child.id, { ...child.value, checklist: child.value.checklist!.map(s => ({ ...s, done: true })) }, 1), /prerequisite/);
    assert.equal(store.snapshot('b').tasks.find(t => t.id === child.id)?.value.checklist?.[0].done, false);
    put(child.id, { ...child.value, notes: 'Newer writing' }, 1);
    assert.throws(() => put(child.id, { ...child.value, status: 'done' }, 1), /newer version/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
