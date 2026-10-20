import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyWorkspace, restoreWorkspace, workspaceTabs, type WorkspaceView } from '../apps/client/src/workspace-tabs.js';

const file = (id: string, hash = 'a'.repeat(64)): WorkspaceView => ({ kind: 'file', file: { id, name: `${id}.md`, size: 12, sha256: hash } });
test('workspace keeps open views, reuses the same file, and replaces the new-tab launcher', () => {
  let state = workspaceTabs(emptyWorkspace(), { type: 'open', view: { kind: 'files' } });
  state = workspaceTabs(state, { type: 'open', view: file('one') });
  state = workspaceTabs(state, { type: 'open', view: file('two') });
  assert.equal(state.tabs.length, 3);
  const one = state.tabs[1].id;
  state = workspaceTabs(state, { type: 'open', view: file('one') });
  assert.equal(state.active, one); assert.equal(state.tabs.length, 3);
  state = workspaceTabs(state, { type: 'open', view: { kind: 'home' } });
  state = workspaceTabs(state, { type: 'open', view: { kind: 'changes' } });
  assert.deepEqual(state.tabs.map(tab => tab.view.kind), ['files', 'file', 'file', 'changes']);
  state = workspaceTabs(state, { type: 'open', view: file('one', 'b'.repeat(64)) });
  assert.equal(state.tabs.length, 5, 'different immutable file bytes keep their own preview');
});

test('closing selects a neighbor only for the active tab and keeps a usable last-tab launcher', () => {
  let state = workspaceTabs(emptyWorkspace(), { type: 'open', view: { kind: 'files' } });
  state = workspaceTabs(state, { type: 'open', view: { kind: 'changes' } });
  state = workspaceTabs(state, { type: 'open', view: { kind: 'live' } });
  state = workspaceTabs(state, { type: 'close', id: 'files' });
  assert.equal(state.active, 'live');
  state = workspaceTabs(state, { type: 'close', id: 'live' });
  assert.equal(state.active, 'changes');
  state = workspaceTabs(state, { type: 'close', id: 'changes' });
  assert.equal(state.active, 'home'); assert.equal(state.visible, true);
  assert.equal(workspaceTabs(state, { type: 'select', id: 'missing' }), state);
});

test('hiding preserves selection and recovery restores validated tabs without opening the panel', () => {
  let state = workspaceTabs(emptyWorkspace(), { type: 'open', view: file('retained') });
  state = workspaceTabs(state, { type: 'expand', expanded: true });
  const hidden = workspaceTabs(state, { type: 'visibility', visible: false });
  assert.deepEqual(workspaceTabs(hidden, { type: 'visibility', visible: true }), state);
  assert.deepEqual(restoreWorkspace(JSON.parse(JSON.stringify(state))), hidden);
  for (const invalid of [null, { ...state, active: 'missing' }, { ...state, tabs: [...state.tabs, state.tabs[0]] }, { ...state, tabs: [{ id: 'forged', view: file('retained') }] }, { ...state, tabs: [{ id: 'file', view: { kind: 'file', file: { id: '../../private' } } }] }]) {
    assert.deepEqual(restoreWorkspace(invalid), emptyWorkspace());
  }
});

test('optional plan tabs retain identity but reopen closed after recovery', () => {
  let state = workspaceTabs(emptyWorkspace(), { type: 'open', view: { kind: 'plan', planId: 'proposal-a' } });
  const first = state.active;
  state = workspaceTabs(state, { type: 'open', view: { kind: 'plan', planId: 'proposal-b' } });
  assert.equal(state.tabs.length, 2);
  state = workspaceTabs(state, { type: 'open', view: { kind: 'plan', planId: 'proposal-a' } });
  assert.equal(state.tabs.length, 2);
  assert.equal(state.active, first);
  const restored = restoreWorkspace(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.visible, false, 'restoring a chat must not force the plan panel open');
  assert.deepEqual(restored.tabs, state.tabs);
  assert.deepEqual(restoreWorkspace({ ...state, tabs: [{ id: first, view: { kind: 'plan', planId: '' } }] }), emptyWorkspace());
});


test('current sources, captured replies and history retain distinct identities through hide and reload', () => {
  let state = workspaceTabs(emptyWorkspace(), { type: 'open', view: { kind: 'sources' } });
  state = workspaceTabs(state, { type: 'open', view: { kind: 'sources', operationId: 'reply-one' } });
  const firstReply = state.active;
  state = workspaceTabs(state, { type: 'open', view: { kind: 'sources', operationId: 'reply-two' } });
  state = workspaceTabs(state, { type: 'open', view: { kind: 'history' } });
  state = workspaceTabs(state, { type: 'open', view: { kind: 'sources', operationId: 'reply-one' } });
  assert.equal(state.active, firstReply);
  assert.deepEqual(state.tabs.map(tab => tab.id), ['sources:next', 'sources:reply:reply-one', 'sources:reply:reply-two', 'history']);
  const hidden = workspaceTabs(state, { type: 'visibility', visible: false });
  const restored = restoreWorkspace(JSON.parse(JSON.stringify(hidden)));
  assert.deepEqual(restored, hidden);
  assert.deepEqual(workspaceTabs(restored, { type: 'visibility', visible: true }), state);
  const closed = workspaceTabs(restored, { type: 'close', id: firstReply });
  assert.equal(closed.tabs.some(tab => tab.id === firstReply), false);
  assert.equal(closed.tabs.some(tab => tab.id === 'sources:next'), true);
});

test('source recovery rejects a substituted identity, empty capture or copied context instead of changing its meaning', () => {
  const state = workspaceTabs(emptyWorkspace(), { type: 'open', view: { kind: 'sources', operationId: 'reply' } });
  for (const tab of [
    { id: 'sources:next', view: { kind: 'sources', operationId: 'reply' } },
    { id: 'sources:reply:', view: { kind: 'sources', operationId: '' } },
    { id: 'sources:next', view: { kind: 'sources', project: { revision: 4 } } },
    { id: 'sources:next', view: { kind: 'sources', operationId: 'x'.repeat(201) } },
  ]) assert.deepEqual(restoreWorkspace({ ...state, active: tab.id, tabs: [tab] }), emptyWorkspace());
});
