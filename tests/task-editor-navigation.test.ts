import test from 'node:test';
import assert from 'node:assert/strict';
import type { Command, Entity, Snapshot, Task } from '../packages/domain/contracts';
import { TaskNavigationController, confirmedTaskDraft, readTaskNavigation, resumableNewTask, taskDraftKey, taskNavigationKey } from '../apps/client/src/task-editor-navigation';

const task = (id: string, revision = 2): Entity<Task> => ({ id: `task:${id}`, revision, deviceId: 'device', updatedAt: '', value: { title: id, notes: '', status: 'open', planned: '', due: '' } });
function fixture() {
  const parent = task('parent'), other = task('other');
  const snapshot = { epoch: 'epoch', deviceId: 'device', tasks: [parent, other], trashedTasks: [] } as unknown as Snapshot;
  const scope = { epoch: snapshot.epoch, deviceId: snapshot.deviceId, windowId: 'window' };
  const values = new Map<string, unknown>(); let reject: (key: string) => boolean = () => false, counter = 0;
  const storage = { read: (key: string) => structuredClone(values.get(key)), write: (key: string, value: unknown) => { if (reject(key)) return false; values.set(key, structuredClone(value)); return true; } };
  const create = () => new TaskNavigationController(scope, storage, () => snapshot, () => `identity-${++counter}`);
  return { parent, other, snapshot, scope, values, storage, create, controller: create(), fail: (predicate: typeof reject) => { reject = predicate; } };
}

test('parent-child navigation restores exact task IDs, section, scroll and original origin after reload', () => {
  const f = fixture(), c = f.controller, origin = { route: 'home' as const, label: 'Home' };
  assert.equal(c.open(f.parent, origin), true); c.view('dates', 220);
  assert.equal(c.child({ parentTaskId: f.parent.id }), true); const childId = c.selected!.id;
  const journal = f.storage.read(taskDraftKey('device', childId)) as any;
  journal.value.notes = 'Child writing'; journal.pending = { requestId: 'same-command', payload: journal.value };
  f.storage.write(taskDraftKey('device', childId), journal); c.view('history', 64);
  const reload = f.create(); assert.equal(reload.selected!.id, childId); assert.equal(reload.frame!.section, 'history');
  assert.equal(reload.back(), true); assert.deepEqual(reload.frame, { taskId: f.parent.id, section: 'dates', scroll: 220, sectionScroll: { dates: 220 } });
  assert.equal(reload.child({ parentTaskId: f.parent.id }), true); assert.equal(reload.selected!.id, childId);
  assert.deepEqual(reload.state!.origin, origin); assert.deepEqual(f.storage.read(taskDraftKey('device', childId)), journal);
  assert.equal(JSON.stringify(reload.state).includes('Child writing'), false);
});

test('navigation storage failure never replaces the current or kept pointer', () => {
  const f = fixture(), c = f.controller; c.open(f.parent, { route: 'tasks', label: 'Tasks' });
  const before = structuredClone(c.state), persisted = f.storage.read(taskNavigationKey(f.scope));
  f.fail(key => key === taskNavigationKey(f.scope));
  assert.equal(c.open(f.other, { route: 'home', label: 'Home' }), false); assert.deepEqual(c.state, before);
  assert.equal(c.close(), false); assert.equal(c.view('dates', 2), false); assert.deepEqual(f.storage.read(taskNavigationKey(f.scope)), persisted);
});

test('a failed child reference write retries the original initial draft identity without creating a second child', () => {
  const f = fixture(), c = f.controller; c.open(f.parent, { route: 'tasks', label: 'Tasks' });
  f.fail(key => key === taskNavigationKey(f.scope)); assert.equal(c.child({ parentTaskId: f.parent.id }), false);
  const keptKeys = [...f.values.keys()].filter(key => key.startsWith('e3:task-editor:')); assert.equal(keptKeys.length, 1);
  assert.equal(c.selected!.id, f.parent.id); f.fail(() => false); assert.equal(c.child({ parentTaskId: f.parent.id }), true);
  assert.equal(taskDraftKey('device', c.selected!.id), keptKeys[0]);
});

test('new-task draft storage refusal leaves the parent and all saved tasks unchanged', () => {
  const f = fixture(), c = f.controller; c.open(f.parent, { route: 'tasks', label: 'Tasks' }); const before = structuredClone(c.state);
  f.fail(key => key.startsWith('e3:task-editor:')); assert.equal(c.child({ parentTaskId: f.parent.id }), false);
  assert.deepEqual(c.state, before); assert.equal(f.snapshot.tasks.length, 2);
});

test('a saved child is not reused as another unsaved child even before a refreshed snapshot', () => {
  const f = fixture(), c = f.controller; c.open(f.parent, { route: 'tasks', label: 'Tasks' }); c.child({ parentTaskId: f.parent.id });
  const child = c.selected!, token = c.state!.token, confirmed = { ...child, revision: 1 };
  f.storage.write(taskDraftKey('device', child.id), { epoch: 'epoch', revision: 1, value: child.value });
  assert.equal(c.acknowledged(confirmed, token, true), true); assert.equal(c.selected!.id, f.parent.id);
  c.child({ parentTaskId: f.parent.id }); assert.notEqual(c.selected!.id, child.id);
});

test('resuming a child whose parent was edited keeps its original ID and relationship with an explicit notice', () => {
  const f = fixture(), c = f.controller; c.open(f.parent, { route: 'tasks', label: 'Tasks' }); c.child({ parentTaskId: f.parent.id });
  const id = c.selected!.id, journal = f.storage.read(taskDraftKey('device', id)) as any;
  journal.value.parentTaskId = f.other.id; journal.value.notes = 'Keep this changed relationship'; f.storage.write(taskDraftKey('device', id), journal);
  c.back(); assert.equal(c.child({ parentTaskId: f.parent.id }), true); assert.equal(c.selected!.id, id);
  assert.equal(c.selected!.value.parentTaskId, f.other.id); assert.match(c.error, /different parent/);
  assert.equal(c.state!.frames.at(-2)!.taskId, f.parent.id); assert.deepEqual(f.storage.read(taskDraftKey('device', id)), journal);
});

test('late saves cannot close a child or a newly reopened instance of the same task', () => {
  const f = fixture(), c = f.controller; c.open(f.parent, { route: 'tasks', label: 'Tasks' }); const originalToken = c.state!.token;
  c.child({ parentTaskId: f.parent.id }); const child = c.selected!.id;
  assert.equal(c.acknowledged({ ...f.parent, revision: 3 }, originalToken, true), false); assert.equal(c.selected!.id, child);
  c.open(f.parent, { route: 'home', label: 'Home' }); assert.equal(c.acknowledged({ ...f.parent, revision: 3 }, originalToken, true), false);
  assert.equal(c.state!.active, true); assert.equal(c.acknowledged({ ...f.parent, revision: 3 }, c.state!.token, false), false);
});

test('workspace epoch changes retain the old journal and refuse navigation or draft resurrection', () => {
  const f = fixture(), c = f.controller; c.open(f.parent, { route: 'tasks', label: 'Tasks' }); c.child({ parentTaskId: f.parent.id });
  const before = structuredClone([...f.values]); f.snapshot.epoch = 'replacement';
  assert.equal(c.selected, undefined); assert.equal(c.close(), false); assert.deepEqual([...f.values], before);
  assert.equal(readTaskNavigation(c.state, { ...f.scope, epoch: 'replacement' }), undefined);
});

test('missing saved parent is never resurrected from its retained journal', () => {
  const f = fixture(), c = f.controller; c.open(f.parent, { route: 'tasks', label: 'Tasks' });
  f.storage.write(taskDraftKey('device', f.parent.id), { epoch: 'epoch', revision: 2, value: f.parent.value }); c.child({ parentTaskId: f.parent.id });
  f.snapshot.tasks = []; assert.equal(c.back(), false); assert.notEqual(c.selected!.id, f.parent.id); assert.match(c.error, /unavailable/);
});

test('matching acknowledgment advances confirmed revision without replacing newer writing for the same task', () => {
  const captured = task('parent'), payload = { ...captured.value, title: 'Sent title' };
  const command = { requestId: 'original', epoch: 'epoch', kind: 'task', entityId: captured.id, expectedRevision: 2, payload } as Command;
  const stored = { epoch: 'epoch', revision: 2, pending: command, value: { ...payload, notes: 'Newer writing' } };
  const confirmed = { ...captured, revision: 3, value: { ...payload, priority: 'high' as const } };
  const next = confirmedTaskDraft(stored, command, confirmed)!;
  assert.equal(next.draft.revision, 3); assert.equal(next.draft.pending, undefined); assert.equal(next.draft.value.notes, 'Newer writing');
  assert.equal(next.draft.value.priority, 'high'); assert.equal(next.clean, false); assert.equal(stored.pending, command);
  assert.equal(confirmedTaskDraft({ ...stored, value: payload }, command, confirmed)!.clean, true);
});

test('different requests, task identity, epoch or revision cannot adopt a late response', () => {
  const captured = task('parent'), command = { requestId: 'original', epoch: 'epoch', kind: 'task', entityId: captured.id, expectedRevision: 2, payload: captured.value } as Command;
  const stored = { epoch: 'epoch', revision: 2, pending: command, value: captured.value }, confirmed = { ...captured, revision: 3 };
  for (const wrong of [{ ...stored, epoch: 'other' }, { ...stored, revision: 3 }, { ...stored, pending: { ...command, requestId: 'newer' } }]) assert.equal(confirmedTaskDraft(wrong, command, confirmed), undefined);
  assert.equal(confirmedTaskDraft(stored, command, { ...confirmed, id: 'task:other' }), undefined);
  assert.equal(confirmedTaskDraft(stored, command, captured), undefined);
});

test('legacy Add Task hints cannot trap creation on saved, trashed, foreign or incompatible drafts', () => {
  const f = fixture(), legacy = task('legacy', 0), key = taskDraftKey('device', legacy.id);
  const journal = { epoch: 'epoch', revision: 0, value: { ...legacy.value, notes: 'Kept writing' } };
  assert.equal(resumableNewTask(legacy, f.snapshot, f.storage), undefined);
  f.storage.write(key, journal); assert.equal(resumableNewTask(legacy, f.snapshot, f.storage)!.value.notes, 'Kept writing');
  f.snapshot.trashedTasks = [{ ...legacy, revision: 1 }]; assert.equal(resumableNewTask(legacy, f.snapshot, f.storage), undefined); f.snapshot.trashedTasks = [];
  for (const invalid of [{ ...journal, revision: 1 }, { ...journal, epoch: 'old' }, { ...journal, pending: { kind: 'task', entityId: 'task:other', epoch: 'epoch', expectedRevision: 0 } }]) {
    f.storage.write(key, invalid); assert.equal(resumableNewTask(legacy, f.snapshot, f.storage), undefined); assert.deepEqual(f.storage.read(key), invalid);
  }
  f.storage.write(key, { ...journal, pending: { kind: 'task', entityId: legacy.id, epoch: 'epoch', expectedRevision: 0, requestId: 'original' } });
  assert.equal(resumableNewTask(legacy, f.snapshot, f.storage)!.id, legacy.id);
});
