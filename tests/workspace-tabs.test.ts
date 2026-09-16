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
