import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assistantSpace, spaceDraftId, spaceInstructions } from '../packages/domain/assistant-space.js';
import { conversationSearchSchema, inSearchScope } from '../packages/domain/search.js';
import { Store } from '../apps/service/store.js';
import { emptyDraft } from '../packages/domain/contracts.js';
import type { Conversation } from '../packages/domain/assistant.js';

test('legacy history remains Chat; scoped search includes only the chosen history across Projects and archives', () => {
  const legacy = { projectId: 'project:shared', archived: false } as Conversation;
  assert.equal(assistantSpace(legacy), 'chat'); assert.equal(spaceInstructions(undefined), '');
  assert.equal(inSearchScope(legacy, { space: 'chat', scope: 'all' }), true);
  assert.equal(inSearchScope(legacy, { space: 'work', scope: 'all' }), false);
  assert.equal(inSearchScope({ ...legacy, space: 'work', archived: true }, { space: 'work', scope: 'archived', projectId: 'project:shared' }), true);
  assert.equal(inSearchScope({ ...legacy, space: 'work', deleted: true }, { space: 'work', scope: 'all' }), false);
  assert.throws(() => conversationSearchSchema.parse({ epoch: randomUUID(), query: 'same', scope: 'all', space: 'other' }));
});

test('both device drafts survive restart without overwriting each other or granting another device write access', () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-spaces-')); let store = new Store(directory);
  try {
    const device = store.session().deviceId;
    for (const space of ['chat', 'work'] as const) store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'draft', entityId: spaceDraftId(device, space), expectedRevision: 0, payload: { ...emptyDraft, space, text: `${space} unsent`, workMode: 'plan' } });
    store.close(); store = new Store(directory);
    assert.equal(store.readEntity('draft', spaceDraftId(device, 'chat'))!.value.text, 'chat unsent');
    assert.equal(store.readEntity('draft', spaceDraftId(device, 'work'))!.value.text, 'work unsent');
    assert.throws(() => store.mutate(randomUUID(), { requestId: randomUUID(), epoch: store.epoch, kind: 'draft', entityId: spaceDraftId(device, 'work'), expectedRevision: 1, payload: { ...emptyDraft, space: 'work' } }), /own device draft/);
    assert.throws(() => store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'draft', entityId: spaceDraftId(device, 'chat'), expectedRevision: 1, payload: { ...emptyDraft, space: 'work' } }), /own device draft/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Work Projects own a real folder; old forms preserve context and bound folders cannot silently change', () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-project-spaces-')); const store = new Store(directory);
  try {
    const device = store.session().deviceId, command = { requestId: randomUUID(), epoch: store.epoch, kind: 'project' as const, entityId: 'project:work', expectedRevision: 0, payload: { name: 'Work files', purpose: '', space: 'work', instructions: 'Verify outputs' } };
    store.mutate(device, command); const saved = store.readEntity('project', command.entityId)!;
    assert.ok(saved.value.workspace?.folder.startsWith(realpathSync(directory))); assert.equal(saved.value.workspace?.environment, 'local');
    store.mutate(device, { ...command, requestId: randomUUID(), expectedRevision: 1, payload: { name: 'Renamed', purpose: '' } });
    const renamed = store.readEntity('project', command.entityId)!;
    assert.equal(renamed.value.space, 'work'); assert.equal(renamed.value.instructions, 'Verify outputs'); assert.deepEqual(renamed.value.workspace, saved.value.workspace);
    store.internalWrite('assistant:conversation:fixture', { projectId: saved.id });
    assert.throws(() => store.mutate(device, { ...command, requestId: randomUUID(), expectedRevision: 2, payload: { ...renamed.value, workspace: { folder: directory, environment: 'local' } } }), /already linked/);
    assert.throws(() => store.mutate(device, { ...command, requestId: randomUUID(), expectedRevision: 2, payload: { ...renamed.value, space: 'chat' } }), /separate Project/);
    assert.throws(() => store.mutate(device, { ...command, requestId: randomUUID(), entityId: 'project:chat-folder', payload: { name: 'Chat', purpose: '', workspace: { folder: directory, environment: 'local' } } }), /Chat Projects use shared sources/);
    assert.throws(() => store.mutate(device, { ...command, requestId: randomUUID(), entityId: 'project:worktree', payload: { ...command.payload, workspace: { folder: directory, environment: 'worktree' } } }), /Git repository/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
