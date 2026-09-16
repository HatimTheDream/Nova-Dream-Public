import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store';
import { invalidTaskParents, taskDescendants } from '../packages/domain/task-family';
import type { Entity, Task } from '../packages/domain/contracts';

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'e3-task-family-')); let store = new Store(join(root, 'original'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const create = (title: string, parentTaskId?: string) => store.mutate('owner', { requestId: randomUUID(), epoch: store.epoch, kind: 'task', entityId: `task:${randomUUID()}`, expectedRevision: 0, payload: { title, notes: '', status: 'open', planned: '', due: '', ...(parentTaskId ? { parentTaskId } : {}) } }) as Entity<Task>;
  const edit = (task: Entity<Task>, patch: Partial<Task>) => store.mutate('owner', { requestId: randomUUID(), epoch: store.epoch, kind: 'task', entityId: task.id, expectedRevision: task.revision, payload: { ...task.value, ...patch } }) as Entity<Task>;
  return { root, get store() { return store; }, create, edit, restart() { store.close(); store = new Store(join(root, 'original')); } };
}
test('separate children keep their plan, notes and completion; parent moves cannot create loops or orphans', t => {
  const f = fixture(t); let parent = f.create('Parent'), child = f.create('Child', parent.id), leaf = f.create('Leaf', child.id);
  child = f.edit(child, { planned: '2026-10-01', notes: 'Separate detail' });
  parent = f.edit(parent, { status: 'done' });
  assert.equal(f.store.readEntity('task', child.id)!.value.status, 'open');
  assert.equal(f.store.profileProgress().earnedXp, 10);
  assert.throws(() => f.edit(parent, { parentTaskId: leaf.id }), /own children/);
  assert.throws(() => f.edit(child, { parentTaskId: child.id }), /own children/);
  assert.throws(() => f.edit(child, { parentTaskId: 'task:missing' }), /available parent/);
  assert.throws(() => f.edit(parent, { trashed: true }), /children/);
  assert.deepEqual(taskDescendants(f.store.snapshot('owner').tasks, parent.id), new Set([child.id, leaf.id]));
  leaf = f.edit(leaf, { trashed: true }); child = f.edit(child, { trashed: true }); parent = f.edit(parent, { trashed: true });
  assert.throws(() => f.edit(child, { trashed: false }), /available parent/);
  parent = f.edit(parent, { trashed: false }); child = f.edit(child, { trashed: false }); leaf = f.edit(leaf, { trashed: false });
  f.restart(); assert.equal(f.store.readEntity('task', child.id)!.value.parentTaskId, parent.id);
  assert.equal(f.store.readEntity('task', child.id)!.value.notes, 'Separate detail');
  assert.equal(f.store.readEntity('task', child.id)!.value.planned, '2026-10-01');
  assert.equal(f.store.readEntity('task', leaf.id)!.value.parentTaskId, child.id);
});
test('backup and recovery verify complete task families before creating a recovered directory', t => {
  const f = fixture(t), parent = f.create('Parent'), child = f.create('Child', parent.id);
  const snapshot = f.store.captureBackup('0.70.0', { status: 'not-configured', notes: [] });
  for (const change of ['missing', 'cycle', 'trashed'] as const) {
    const bad = structuredClone(snapshot), p = bad.entities.find(entity => entity.id === parent.id)!, c = bad.entities.find(entity => entity.id === child.id)!;
    if (change === 'missing') (c.value as Task).parentTaskId = 'task:missing';
    if (change === 'cycle') (p.value as Task).parentTaskId = child.id;
    if (change === 'trashed') (p.value as Task).trashed = true;
    const destination = join(f.root, change); assert.throws(() => Store.restoreBackup(destination, bad), /task parent/); assert.equal(existsSync(destination), false);
  }
  const restored = Store.restoreBackup(join(f.root, 'recovered'), snapshot);
  try { restored.activateRecoveredLocal(); assert.equal(restored.readEntity('task', child.id)!.value.parentTaskId, parent.id); assert(restored.recoveryEffectsPaused); } finally { restored.close(); }
});
test('parent validation handles large trees without recursion and preserves invalid descendants', () => {
  const tasks = Array.from({ length: 12000 }, (_, n) => ({ id: `task:${n}`, value: { title: String(n), notes: '', planned: '', due: '', status: 'open' as const, ...(n ? { parentTaskId: `task:${n - 1}` } : {}) } }));
  assert.equal(invalidTaskParents(tasks).size, 0);
  tasks[0].value.parentTaskId = 'task:11999'; assert.equal(invalidTaskParents(tasks).size, tasks.length);
  tasks[0].value.parentTaskId = 'task:missing'; assert.equal(invalidTaskParents(tasks).size, tasks.length);
});
