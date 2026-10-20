import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { ProfileStudio, studioCurationKey } from '../apps/service/profile-studio.js';
import { phoneRouteAllowed } from '../apps/service/phone-policy.js';
import { studioCommandSchema, studioFocus, studioNextWork, studioStateSchema } from '../packages/domain/profile-studio.js';
import type { QuestDraft } from '../packages/domain/profile-progression.js';
import type { Entity, Task } from '../packages/domain/contracts.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nova-profile-studio-')); let store = new Store(root);
  const input = (questIds: string[], expectedRevision = 0) => ({ requestId: randomUUID(), epoch: store.epoch, expectedRevision, questIds });
  const quest = (title = 'Keep my quest', taskId: string | null = null) => store.saveQuest('one', { requestId: randomUUID(), epoch: store.epoch, expectedRevision: 0, action: 'save',
    quest: { id: randomUUID(), title, description: 'Original writing', projectId: null, due: '', steps: [{ id: randomUUID(), taskId, title: 'Original next Task' }] } satisfies QuestDraft });
  const capture = () => { const { id: _id, createdAt: _at, ...snapshot } = store.captureBackup('fixture', { status: 'not-configured', notes: [] }); return snapshot; };
  return { get store() { return store; }, get studio() { return new ProfileStudio(store); }, input, quest, capture,
    restart() { store.close(); store = new Store(root); }, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('Studio reads absent metadata without creating state or choosing quests implicitly', () => {
  const f = fixture(); try { f.quest(); const before = f.capture(); assert.deepEqual(f.studio.state(), { epoch: f.store.epoch, curation: { format: 1, revision: 0, questIds: [] }, availableQuestIds: [], unavailable: [] }); assert.deepEqual(f.capture(), before); } finally { f.close(); }
});
test('two-device curation uses exact revision and original receipt; restart cannot duplicate a selection', () => {
  const f = fixture(); try {
    const q = f.quest(), cmd = f.input([q.id]), before = f.capture(), result = f.studio.save('one', cmd);
    assert.deepEqual(f.studio.save('one', cmd), result); assert.equal(result.curation.revision, 1);
    assert.throws(() => f.studio.save('two', cmd), /different work/);
    assert.throws(() => f.studio.save('one', { ...cmd, questIds: [] }), /different work/);
    assert.throws(() => f.studio.save('two', f.input([])), /another window/);
    const after = f.capture();
    for (const key of ['entities', 'history', 'files', 'references', 'epoch', 'cursor'] as const) assert.deepEqual(after[key], before[key]);
    assert.deepEqual(after.services.filter(row => row.id !== studioCurationKey), before.services);
    assert.equal(after.receipts.length, before.receipts.length + 1);
    f.restart(); assert.deepEqual(f.studio.save('one', cmd), result); assert.deepEqual(f.capture(), after);
    const next = f.studio.save('two', f.input([], 1)); assert.equal(next.curation.revision, 2); assert.deepEqual(next.curation.questIds, []);
  } finally { f.close(); }
});
test('malformed, unknown-format or zero-revision saved metadata is preserved and refuses every save', () => {
  for (const raw of [{ format: 2, revision: 1, questIds: [] }, { format: 1, revision: 0, questIds: [] }, { format: 1, revision: 1, questIds: [], unknown: 'Keep me' }, null]) {
    const f = fixture(); try {
      f.store.internalWrite(studioCurationKey, raw); const before = f.capture();
      assert.throws(() => f.studio.state(), /kept unchanged/); assert.throws(() => f.studio.save('one', f.input([])), /kept unchanged/); assert.deepEqual(f.capture(), before);
    } finally { f.close(); }
  }
});
test('strict two-slot unique selection and epoch validation refuse before any write', () => {
  const f = fixture(); try {
    const a = f.quest(), b = f.quest('Second'), c = f.quest('Third'), before = f.capture();
    for (const value of [f.input([a.id, b.id, c.id]), f.input([a.id, a.id]), { ...f.input([]), epoch: randomUUID() }, { ...f.input([]), autoComplete: true }]) assert.throws(() => f.studio.save('one', value));
    assert.deepEqual(f.capture(), before); assert(studioCommandSchema.safeParse(f.input([a.id, b.id])).success);
  } finally { f.close(); }
});
test('archived and missing references remain readable without silently freeing or replacing saved slots', () => {
  const f = fixture(); try {
    const a = f.quest(), missing = randomUUID(); f.studio.save('one', f.input([a.id]));
    f.store.saveQuest('one', { requestId: randomUUID(), epoch: f.store.epoch, expectedRevision: 1, action: 'archive', id: a.id, archived: true });
    f.store.internalWrite(studioCurationKey, { format: 1, revision: 2, questIds: [a.id, missing] });
    const before = f.capture(), state = f.studio.state();
    assert.deepEqual(state.availableQuestIds, []); assert.deepEqual(state.unavailable, [{ id: a.id, reason: 'archived' }, { id: missing, reason: 'missing' }]);
    assert.deepEqual(state.curation.questIds, [a.id, missing]); assert.throws(() => f.studio.save('one', f.input([a.id], 2)), /unavailable or archived/);
    assert.throws(() => f.studio.save('one', f.input([missing], 2)), /unavailable or archived/); assert.deepEqual(f.capture(), before);
    assert.deepEqual(f.studio.save('one', f.input([], 2)).curation.questIds, []);
  } finally { f.close(); }
});
test('quest metadata identity failures are visible and cannot be overwritten through curation', () => {
  const f = fixture(); try {
    const id = randomUUID(); f.store.internalWrite('profile:quest:' + id, { id: randomUUID(), revision: 1, archived: false, writing: 'Preserve' });
    f.store.internalWrite(studioCurationKey, { format: 1, revision: 1, questIds: [id] }); const before = f.capture();
    assert.throws(() => f.studio.state(), /cannot be verified/); assert.throws(() => f.studio.save('one', f.input([id], 1)), /cannot be verified/); assert.deepEqual(f.capture(), before);
  } finally { f.close(); }
});
test('maintenance and held recovery reject direct service writes; activated local recovery permits metadata only', () => {
  const f = fixture(); try {
    const cmd = f.input([]); f.store.setUpdateMaintenanceHeld(true); let before = f.capture(); assert.throws(() => f.studio.save('one', cmd)); assert.deepEqual(f.capture(), before);
    f.store.setUpdateMaintenanceHeld(false); f.store.internalWrite('recovery:state', { held: true, effectsPaused: true }); before = f.capture();
    assert.throws(() => f.studio.save('one', cmd), /recovered workspace/); assert.deepEqual(f.capture(), before);
    f.store.internalWrite('recovery:state', { held: false, effectsPaused: true }); assert.equal(f.studio.save('one', cmd).curation.revision, 1); assert(f.store.recoveryEffectsPaused);
  } finally { f.close(); }
});
test('curating two quests sharing one Task neither changes it nor creates a second XP ledger', () => {
  const f = fixture(); try {
    const a = f.quest(), b = f.quest('Shared work', a.steps[0].taskId), task = f.store.readEntity('task', a.steps[0].taskId)!;
    f.store.mutate('one', { requestId: randomUUID(), epoch: f.store.epoch, kind: 'task', entityId: task.id, expectedRevision: task.revision, payload: { ...task.value, status: 'done' } });
    const before = f.store.profileProgress(), original = f.store.readEntity('task', task.id);
    f.studio.save('one', f.input([a.id, b.id])); assert.deepEqual(f.store.profileProgress(), before); assert.equal(before.earnedXp, 10); assert.deepEqual(f.store.readEntity('task', task.id), original);
    assert.equal(before.personalQuests.filter(q => q.complete).length, 2);
  } finally { f.close(); }
});
test('Studio next work follows original status and prerequisites without guessing completion', () => {
  const f = fixture(); try {
    const saved = f.quest(), quest = f.store.profileProgress().personalQuests[0], original = f.store.readEntity('task', saved.steps[0].taskId)! as Entity<Task>;
    const withTask = (patch: Partial<Task>) => [{ ...original, value: { ...original.value, ...patch } }];
    assert.equal(studioNextWork(quest, [original]).kind, 'task');
    for (const status of ['blocked', 'waiting', 'skipped'] as const) assert.deepEqual(studioNextWork(quest, withTask({ status })), { kind: 'review' });
    assert.deepEqual(studioNextWork(quest, []), { kind: 'review' }); assert.deepEqual(studioNextWork(quest, withTask({ trashed: true, status: 'done' })), { kind: 'review' });
    assert.deepEqual(studioNextWork(quest, withTask({ dependencies: ['missing'] })), { kind: 'review' }); assert.deepEqual(studioNextWork(quest, withTask({ status: 'done' })), { kind: 'revisit' });
  } finally { f.close(); }
});
test('focus remains within explicit available selection, including a completed focused quest', () => {
  const f = fixture(); try {
    const a = f.quest(), b = f.quest('Second'); f.studio.save('one', f.input([b.id, a.id]));
    const quests = f.store.profileProgress().personalQuests, state = f.studio.state();
    assert.equal(studioFocus(quests, state, 'missing').focused?.id, b.id);
    assert.equal(studioFocus(quests.map(q => ({ ...q, complete: true })), state, a.id).focused?.id, a.id);
    assert.equal(studioFocus(quests.map(q => ({ ...q, archived: q.id === a.id })), state, a.id).focused?.id, b.id);
    assert.equal(studioFocus(quests, { ...state, availableQuestIds: [] }, a.id).focused, null);
  } finally { f.close(); }
});
test('state projection is complete and disjoint; phone admits only the exact two Studio routes', () => {
  const id = randomUUID(), state = { epoch: randomUUID(), curation: { format: 1, revision: 1, questIds: [id] }, availableQuestIds: [id], unavailable: [] };
  assert(studioStateSchema.safeParse(state).success); assert(!studioStateSchema.safeParse({ ...state, availableQuestIds: [] }).success);
  assert(!studioStateSchema.safeParse({ ...state, unavailable: [{ id, reason: 'missing' }] }).success);
  assert(phoneRouteAllowed('/api/profile/studio', 'GET')); assert(phoneRouteAllowed('/api/profile/studio', 'POST'));
  for (const path of ['/api/profile/studio/', '/api/profile/studio/delete', '/api/profile/studio/other']) assert(!phoneRouteAllowed(path, 'POST'));
  assert(!phoneRouteAllowed('/api/profile/studio', 'DELETE'));
});
