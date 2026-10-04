import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Conversation, ConversationChanges, AssistantOperation } from '../packages/domain/assistant';
import type { AssistantController } from '../apps/client/src/useAssistant';
import type { Snapshot } from '../packages/domain/contracts';
import { editConversation } from '../apps/client/src/conversation-edit';
import { conversationVisibilityBlocked, conversationWritePending } from '../apps/client/src/conversation-visibility';
import { ConversationRestoreStatus } from '../apps/client/src/ConversationRestoreStatus';

const symbol = Symbol.for('nova.test.conversation-visibility');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && /\/(ConversationSettings|ConversationRow|ConversationReader|ConversationQuickActions)\.tsx$/.test(context.parentURL ?? '')) return { url: 'nova-test:conversation-visibility', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {};' };
    if (url === 'nova-test:conversation-visibility') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      export const useState = initial => globalThis[Symbol.for('nova.test.conversation-visibility')].state(initial);
      export const useRef = initial => globalThis[Symbol.for('nova.test.conversation-visibility')].ref(initial);
      export const useEffect = () => {};
      export const useLayoutEffect = () => {};` };
    return next(url, context);
  },
});
const { ConversationSettings } = await import('../apps/client/src/ConversationSettings');
const { ConversationRow } = await import('../apps/client/src/ConversationRow');
const { ConversationReader } = await import('../apps/client/src/ConversationReader');
const { ConversationQuickActions } = await import('../apps/client/src/ConversationQuickActions');
hooks.deregister();

const epoch = '11111111-1111-4111-8111-111111111111';
const conversation = (changes: Partial<Conversation> = {}): Conversation => ({ id: '22222222-2222-4222-8222-222222222222', revision: 4, title: 'Kept chat', projectId: null, archived: false, nativeId: 'native', nativeKey: 'native-key', connectionGeneration: 'generation', state: 'ready', model: null, thinking: null, createdAt: '', updatedAt: '', ...changes });
const pending = { requestId: '33333333-3333-4333-8333-333333333333', model: 'new-model' };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function storageHost() {
  const values = new Map<string, string>(), requests: Record<string, any>[] = [];
  const descriptors = ['localStorage', 'fetch'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  let respond: (input: Record<string, any>) => Promise<Response> = async () => Response.json(conversation());
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (_url: string, options: RequestInit) => { const input = JSON.parse(String(options.body)); requests.push(input); return respond(input); } });
  return { values, requests, respond: (next: typeof respond) => { respond = next; }, close: () => { for (const [name, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } };
}

test('Delete sends its own exact request, clears it after local success, and keeps the original settings request', async () => {
  const h = storageHost(), current = conversation({ pendingSettings: pending });
  const settingsKey = `e3:conversation-edit:${current.id}`, key = `e3:conversation-visibility:${epoch}:${current.id}`;
  const original = JSON.stringify({ ...pending, epoch, conversationId: current.id, expectedRevision: 3 });
  h.values.set(settingsKey, original);
  h.respond(async () => Response.json({ ...current, revision: 5, visibilityRevision: 1, deleted: true, archived: true }));
  try {
    const result = await editConversation(epoch, current, { deleted: true });
    assert.equal(h.requests.length, 1);
    const { requestId, ...input } = h.requests[0];
    assert.notEqual(requestId, pending.requestId);
    assert.deepEqual(input, { epoch, conversationId: current.id, expectedRevision: 4, deleted: true });
    assert.deepEqual(result.pendingSettings, pending);
    assert.equal(h.values.get(settingsKey), original);
    assert.equal(h.values.has(key), false);
  } finally { h.close(); }
});

test('a lost visibility response retains its request identity across unrelated native revision changes', async () => {
  const h = storageHost(), current = conversation({ pendingSettings: pending });
  h.respond(async () => { throw Error('Disconnected after send'); });
  try {
    await assert.rejects(editConversation(epoch, current, { archived: true }), /Disconnected/);
    const first = h.requests[0];
    h.respond(async () => Response.json({ ...current, archived: true, visibilityRevision: 1 }));
    await editConversation(epoch, { ...current, revision: 7 }, { archived: true });
    assert.deepEqual(h.requests[1], first);
    assert.equal(h.values.size, 0);
  } finally { h.close(); }
});

test('a confirmed visibility revision permits Restore without replaying the lost Delete', async () => {
  const h = storageHost(), current = conversation({ pendingSettings: pending });
  h.respond(async () => { throw Error('Response lost'); });
  try {
    await assert.rejects(editConversation(epoch, current, { deleted: true }));
    h.respond(async () => Response.json({ ...current, revision: 6, visibilityRevision: 2, archived: false, deleted: false }));
    await editConversation(epoch, { ...current, revision: 5, visibilityRevision: 1, deleted: true, archived: true }, { deleted: false });
    assert.notEqual(h.requests[0].requestId, h.requests[1].requestId);
    assert.equal(h.requests[1].deleted, false);
    assert.equal(h.requests[1].expectedRevision, 5);
  } finally { h.close(); }
});

test('an unresolved opposite move is not silently replayed or replaced, and another epoch cannot inherit it', async () => {
  const h = storageHost(), current = conversation();
  h.respond(async () => { throw Error('Response lost'); });
  try {
    await assert.rejects(editConversation(epoch, current, { deleted: true }));
    const kept = [...h.values];
    await assert.rejects(editConversation(epoch, current, { deleted: false }), /previous chat move is not confirmed/);
    assert.equal(h.requests.length, 1); assert.deepEqual([...h.values], kept);
    h.respond(async () => Response.json(current));
    await editConversation('44444444-4444-4444-8444-444444444444', current, { deleted: false });
    assert.notEqual(h.requests[0].requestId, h.requests[1].requestId);
    assert.deepEqual([...h.values], kept);
  } finally { h.close(); }
});

test('definite local rejection releases only that move, while native settings retain their original retry', async () => {
  for (const code of ['conversation_changed', 'run_unsettled']) {
    const h = storageHost(), current = conversation({ pendingSettings: pending }), key = `e3:conversation-edit:${conversation().id}`;
    const kept = { requestId: pending.requestId, epoch, conversationId: current.id, expectedRevision: 3, model: 'new-model' };
    h.values.set(key, JSON.stringify(kept));
    h.respond(async () => Response.json({ code, message: 'Not admitted' }, { status: 409 }));
    try {
      await assert.rejects(editConversation(epoch, current, { deleted: true }), /Not admitted/);
      assert.deepEqual([...h.values], [[key, JSON.stringify(kept)]]);
      h.respond(async () => Response.json(current));
      await editConversation(epoch, current, { title: 'A different setting' });
      assert.deepEqual(h.requests[1], kept);
      assert.equal(h.values.has(key), true);
    } finally { h.close(); }
  }
});

const nodes = (node: any, disabled = false): any[] => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(child => nodes(child, disabled)) : [{ node, disabled: disabled || !!node.props?.disabled }, ...nodes(node.props?.children, disabled || node.type === 'fieldset' && node.props.disabled)];
const text = (node: any): string => node == null || typeof node === 'boolean' ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children);
function componentHost(surface: 'settings' | 'row' | 'reader' | 'quick', current: Conversation, operations: AssistantOperation[] = []) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, symbol);
  let cursor = 0, tree: any, closed = 0;
  const cells: any[] = [], edits: ConversationChanges[] = [];
  Object.defineProperty(globalThis, symbol, { configurable: true, value: {
    state(initial: any) { const i = cursor++; const cell = cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cell.value, (next: any) => { cell.value = typeof next === 'function' ? next(cell.value) : next; }]; },
    ref(initial: any) { return cells[cursor++] ??= { current: initial }; },
  } });
  const controller = { operations, removals: [], conversations: [current], connection: { state: 'disconnected' }, plans: [], outputs: [],
    edit: async (_conversation: Conversation, changes: ConversationChanges) => { edits.push(changes); return current; }, checkStatus: async () => true } as unknown as AssistantController;
  const snapshot = { epoch, projects: [] } as unknown as Snapshot;
  function render() {
    cursor = 0;
    if (surface === 'settings') tree = ConversationSettings({ conversation: current, controller, snapshot, close: () => { closed++; } });
    else if (surface === 'quick') tree = ConversationQuickActions({ conversation: current, blocked: true, visibilityBlocked: hiding => conversationVisibilityBlocked(current, operations, [], false, hiding), edit: changes => controller.edit(current, changes), close: () => { closed++; }, projects: [] });
    else if (surface === 'row') tree = ConversationRow({ conversation: current, controller, snapshot, selected: false, hasDraft: true, updatedAt: '2026-10-04T10:00:00Z', open() {}, refreshWorkspace: async () => {} }).props.children(() => { closed++; });
    else tree = ConversationReader({ target: { epoch, conversationId: current.id, nativeId: current.nativeId! }, snapshot, controller, close() {}, change() {}, sidebarControls: null, navigationCovered: false, refreshWorkspace: async () => {} });
  }
  function button(label: string) { const found = nodes(tree).find(({ node }) => node.type === 'button' && text(node) === label); assert.ok(found, `Missing ${label}`); return found; }
  render();
  return { edits, controller, get tree() { return tree; }, get closed() { return closed; }, button,
    async click(label: string) { const found = button(label); assert.equal(found.disabled, false, `${label} is disabled`); found.node.props.onClick(); render(); await tick(); render(); },
    input(type: string, value: string) { const found = nodes(tree).find(({ node }) => node.type === type); assert.ok(found); found.node.props.onChange({ target: { value } }); render(); },
    async submit() { nodes(tree).find(({ node }) => node.type === 'form')!.node.props.onSubmit({ preventDefault() {} }); await tick(); render(); },
    close() { if (descriptor) Object.defineProperty(globalThis, symbol, descriptor); else Reflect.deleteProperty(globalThis, symbol); },
  };
}

for (const surface of ['settings', 'row'] as const) {
  test(`${surface}: pending settings and unknown run allow exact Delete/Archive actions while settings stay locked`, async () => {
    const current = conversation({ pendingSettings: pending, state: 'unknown' });
    for (const [label, changes] of [[surface === 'row' ? 'Delete' : 'Move to Deleted', { deleted: true }], ['Archive', { archived: true }]] as const) {
      const h = componentHost(surface, current, [{ conversationId: current.id, state: 'unknown' } as AssistantOperation]);
      try {
        assert.equal(h.button(surface === 'row' ? 'Rename' : 'Save changes').disabled, true);
        assert.equal(h.button('Pin').disabled, true);
        await h.click(label);
        assert.deepEqual(h.edits, [changes]); assert.equal(h.closed, 1);
      } finally { h.close(); }
    }
  });

  test(`${surface}: known active work blocks hiding but allows exact Restore chat`, async () => {
    const operation = { conversationId: conversation().id, state: 'running' } as AssistantOperation;
    const active = componentHost(surface, conversation(), [operation]);
    try { assert.equal(active.button(surface === 'row' ? 'Delete' : 'Move to Deleted').disabled, true); assert.equal(active.button('Archive').disabled, true); } finally { active.close(); }
    const restored = componentHost(surface, conversation({ archived: true, deleted: true, pendingSettings: pending }), [operation]);
    try {
      await restored.click('Restore chat'); assert.deepEqual(restored.edits, [{ deleted: false }]);
      if (surface === 'row') assert.equal(restored.button('Remove permanently').disabled, true);
    } finally { restored.close(); }
  });
}

test('standalone settings actions do not submit dirty name/project fields, while form Save submits them', async () => {
  for (const [label, changes] of [['Move to Deleted', { deleted: true }], ['Archive', { archived: true }], ['Pin', { pinned: true }], ['Mark unread', { unread: true }]] as const) {
    const h = componentHost('settings', conversation());
    try { h.input('input', 'Unsaved name'); h.input('select', 'different-project'); await h.click(label); assert.deepEqual(h.edits, [changes]); } finally { h.close(); }
  }
  const h = componentHost('settings', conversation());
  try { h.input('input', 'Saved name'); h.input('select', 'project'); await h.submit(); assert.deepEqual(h.edits, [{ title: 'Saved name', projectId: 'project' }]); } finally { h.close(); }
});

test('read-only history offers Restore alongside Check original change without submitting pending settings', async () => {
  const h = componentHost('reader', conversation({ archived: true, deleted: true, pendingSettings: pending }));
  try { assert.equal(h.button('Check original change').disabled, false); await h.click('Restore chat'); assert.deepEqual(h.edits, [{ deleted: false }]); } finally { h.close(); }
});

test('header quick actions distinguish local moves from blocked native settings and restore a deleted chat', async () => {
  const current = conversation({ pendingSettings: pending, state: 'unknown' });
  for (const [label, changes] of [['Delete chat', { deleted: true }], ['Archive', { archived: true }]] as const) {
    const h = componentHost('quick', current, [{ conversationId: current.id, state: 'unknown' } as AssistantOperation]);
    try { assert.equal(h.button('Pin').disabled, true); await h.click(label); assert.deepEqual(h.edits, [changes]); } finally { h.close(); }
  }
  const operation = { conversationId: current.id, state: 'running' } as AssistantOperation;
  const active = componentHost('quick', current, [operation]);
  try { assert.equal(active.button('Delete chat').disabled, true); assert.equal(active.button('Archive').disabled, true); } finally { active.close(); }
  const restored = componentHost('quick', { ...current, archived: true, deleted: true }, [operation]);
  try { await restored.click('Restore chat'); assert.deepEqual(restored.edits, [{ deleted: false }]); } finally { restored.close(); }
});

test('a pending native restore locks native settings while local visibility remains usable', async () => {
  const current = conversation({ nativeRestorePending: true });
  assert.equal(conversationWritePending(current), true);
  assert.equal(conversationWritePending({ ...current, nativeRestorePending: undefined }), false);
  for (const surface of ['settings', 'row'] as const) {
    const h = componentHost(surface, current);
    try {
      assert.equal(h.button('Pin').disabled, true);
      if (surface === 'settings') assert.equal(h.button('Save changes').disabled, true);
      await h.click(surface === 'row' ? 'Delete' : 'Move to Deleted');
      assert.deepEqual(h.edits, [{ deleted: true }]);
    } finally { h.close(); }
  }
});

test('pending restore explains reconnect and only calls the existing status check when connected', () => {
  let checked = 0;
  const props = { conversation: conversation({ nativeRestorePending: true }), connected: false, busy: false, checkStatus: () => { checked++; } };
  const offline = ConversationRestoreStatus(props);
  assert.match(text(offline), /Reconnect the Assistant/);
  assert.equal(nodes(offline).find(({ node }) => node.type === 'button').disabled, true);
  const online = ConversationRestoreStatus({ ...props, connected: true });
  const action = nodes(online).find(({ node }) => node.type === 'button');
  assert.equal(action.disabled, false); action.node.props.onClick(); assert.equal(checked, 1);
  assert.equal(ConversationRestoreStatus({ ...props, conversation: conversation() }), null);
});
