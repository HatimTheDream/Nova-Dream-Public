import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { RetainedLocalDrafts } from '../apps/client/src/retained-local-drafts';
import { saveRetainedQueueEdit, type QueueEditRequest } from '../apps/client/src/queue-edit-request';

const hookKey = Symbol.for('nova.test.assistant-cleanup');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const names = ['MessageQueue.tsx', 'AgentRoutines.tsx', 'AssignmentRuns.tsx', 'AssistantActivityPanel.tsx', 'ConversationRow.tsx'];
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && names.some(name => context.parentURL?.endsWith('/' + name))) return { url: 'nova-test:cleanup-hooks', shortCircuit: true };
    if (specifier === './AssignmentApprovalTray' && context.parentURL?.endsWith('/AssignmentRuns.tsx')) return { url: 'nova-test:cleanup-approvals', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    if (url === 'nova-test:cleanup-approvals') return { format: 'module', shortCircuit: true, source: 'export const useAssignmentApprovals=()=>({}); export const AssignmentApprovalTray=()=>null;' };
    if (url === 'nova-test:cleanup-hooks') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      export const useState = value => globalThis[Symbol.for('nova.test.assistant-cleanup')].state(value);
      export const useRef = value => globalThis[Symbol.for('nova.test.assistant-cleanup')].ref(value);
      export const useEffect = (run,deps) => globalThis[Symbol.for('nova.test.assistant-cleanup')].effect(run,deps);` };
    return next(url, context);
  },
});
const { QueueEditor } = await import('../apps/client/src/MessageQueue');
const { AgentRoutines } = await import('../apps/client/src/AgentRoutines');
const { AssignmentRuns } = await import('../apps/client/src/AssignmentRuns');
const { AssistantActivityPanel } = await import('../apps/client/src/AssistantActivityPanel');
const { ConversationRow } = await import('../apps/client/src/ConversationRow');
loader.deregister();

function host(Component: (props: any) => any, initial: any, respond: (path: string, body: any) => unknown | Promise<unknown>, storage = new Map<string, string>()) {
  let props = initial, cursor = 0, dirty = true, tree: any;
  const cells: any[] = [], effects: (() => void)[] = [], calls: { path: string; body: any }[] = [];
  const values: Record<PropertyKey, unknown> = {
    [hookKey]: {
      state(value: any) { const index = cursor++; if (!cells[index]) cells[index] = { value: typeof value === 'function' ? value() : value }; return [cells[index].value, (next: any) => { cells[index].value = typeof next === 'function' ? next(cells[index].value) : next; dirty = true; }]; },
      ref(value: any) { return cells[cursor++] ??= { current: value }; },
      effect(run: () => void | (() => void), deps: unknown[]) { const index = cursor++, old = cells[index]; if (!old || deps.some((value, offset) => !Object.is(value, old.deps[offset]))) { cells[index] = { deps, cleanup: old?.cleanup }; effects.push(() => { cells[index].cleanup?.(); cells[index].cleanup = run(); }); } },
    },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    document: Object.assign(new EventTarget(), { hidden: false }), window: new EventTarget(),
    fetch: async (path: string, init: RequestInit) => { const body = init.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path, body }); const value = await respond(path, body); return value instanceof Response ? value : new Response(JSON.stringify(value)); },
  };
  const originals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const flush = async () => { for (let pass = 0; pass < 30; pass++) { if (dirty) { dirty = false; cursor = 0; tree = Component(props); while (effects.length) effects.shift()!(); } for (let tick = 0; tick < 10; tick++) await Promise.resolve(); } };
  return { storage, calls, flush, get tree() { return tree; },
    async update(next: any) { props = { ...props, ...next }; dirty = true; await flush(); },
    close() { for (const cell of cells) cell?.cleanup?.(); for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); },
  };
}
const nodes = (tree: any): any[] => tree == null || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
const text = (tree: any): string => tree == null || typeof tree === 'boolean' ? '' : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : Array.isArray(tree) ? tree.map(text).join(' ') : text(tree.props?.children);
const find = (tree: any, type: string, label?: string) => { const node = nodes(tree).find(node => node.type === type && (!label || text(node) === label)); assert.ok(node, `${type} ${label ?? ''} was rendered`); return node; };
const submit = (tree: any) => find(tree, 'form').props.onSubmit({ preventDefault() {} });

test('unconfirmed queue edits lock writing and reconcile the original receipt without discarding a newer retained draft', async () => {
  const item = { id: 'queue', revision: 1, input: 'Original' }, storage = new Map<string, string>();
  let lost = true, closed = 0;
  const sent: any[] = [];
  const respond = async (_path: string, input: any) => { sent.push(input); if (lost) { lost = false; throw Error('Response lost'); } return {}; };
  let h = host(QueueEditor, { item, epoch: 'epoch', refresh: async () => {}, close: () => closed++ }, respond, storage);
  try {
    await h.flush(); find(h.tree, 'textarea').props.onChange({ target: { value: 'Edit A' } }); await h.flush(); submit(h.tree); await h.flush();
    assert.equal(find(h.tree, 'textarea').props.disabled, true); find(h.tree, 'button', 'Reconcile save');
    assert.equal(sent.length, 1);
    // Older clients could leave newer writing beside an unconfirmed request.
    h.close(); storage.set('e3:queue-writing:epoch:queue', JSON.stringify('Edit B'));
    h = host(QueueEditor, { item, epoch: 'epoch', refresh: async () => {}, close: () => closed++ }, respond, storage);
    await h.flush(); submit(h.tree); await h.flush();
    assert.deepEqual(sent, [sent[0], sent[0]]); assert.equal(sent[0].input, 'Edit A');
    assert.equal(closed, 0); assert.equal(find(h.tree, 'textarea').props.value, 'Edit B');
    assert.equal(JSON.parse(storage.get('e3:queue-writing:epoch:queue')!), 'Edit B');
    await h.update({ item: { ...item, revision: 2, input: 'Edit A' } }); submit(h.tree); await h.flush();
    assert.equal(sent[2].input, 'Edit B'); assert.notEqual(sent[2].requestId, sent[0].requestId); assert.equal(sent[2].expectedRevision, 2); assert.equal(closed, 1);
  } finally { h.close(); }
});

test('queue edits do not dispatch without a retained request or lose a confirmed receipt when cleanup fails', async () => {
  let kept: QueueEditRequest | undefined, writable = false, clearable = false, calls = 0;
  const command = { requestId: 'request', epoch: 'epoch', queueId: 'queue', expectedRevision: 1, input: 'Writing' };
  const ports = { read: () => kept, keep(input: QueueEditRequest | undefined) { if (input ? !writable : !clearable) return false; kept = input; return true; }, send: async () => { calls++; } };
  await saveRetainedQueueEdit(ports, command); assert.equal(calls, 0);
  writable = true; const confirmed = await saveRetainedQueueEdit(ports, command);
  assert.deepEqual(confirmed.pending, command); assert.equal(calls, 1);
  clearable = true; const retried = await saveRetainedQueueEdit(ports, { ...command, requestId: 'different', input: 'New writing' });
  assert.deepEqual(retried.confirmed, command); assert.equal(kept, undefined);
});

test('failed routine persistence preserves the newest draft across view remounts and clears the unload guard only after recovery', () => {
  const saved = new Map([['routine', { name: 'Saved version' }]]), warnings: boolean[] = [];
  let writable = false;
  const drafts = new RetainedLocalDrafts({ read: key => saved.get(key), write: (key, value) => { if (!writable) return false; saved.set(key, value); return true; } }, flag => warnings.push(flag));
  assert.equal(drafts.write('routine', { name: 'New writing' }), false);
  assert.equal(drafts.read('routine')?.name, 'New writing'); assert.equal(drafts.unsaved('routine'), true);
  assert.equal(saved.get('routine')?.name, 'Saved version');
  writable = true; assert.equal(drafts.write('routine', drafts.read('routine')!), true);
  assert.equal(drafts.unsaved('routine'), false); assert.equal(saved.get('routine')?.name, 'New writing'); assert.deepEqual(warnings, [true, false]);
});

test('assignment polling recovers its read error without clearing an unconfirmed action error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let first = true;
  const state = { attempts: [], canStart: true, nextCursor: null };
  const h = host(AssignmentRuns, { entity: { id: 'assignment', revision: 1, value: { state: 'planned', archived: false } }, snapshot: { deviceId: 'device', epoch: 'epoch', projects: [] }, dirty: false, refresh: async () => {} }, async path => {
    if (path.endsWith('/start')) throw Error('Start response lost');
    if (first) { first = false; throw Error('Temporary read failure'); }
    return state;
  });
  try {
    await h.flush(); assert.match(text(h.tree), /Temporary read failure/); assert.doesNotMatch(text(h.tree), /No attempts yet/);
    t.mock.timers.tick(3000); await h.flush(); assert.doesNotMatch(text(h.tree), /Temporary read failure/); assert.match(text(h.tree), /No attempts yet/);
    find(h.tree, 'button', 'Run saved version 1').props.onClick(); await h.flush(); assert.match(text(h.tree), /Start response lost/);
    t.mock.timers.tick(3000); await h.flush(); assert.match(text(h.tree), /Start response lost/);
  } finally { h.close(); }
});

test('routine history stays loading until a successful empty result, instead of claiming no runs', async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const h = host(AgentRoutines, { snapshot: { deviceId: 'device', epoch: 'epoch' }, openPlan: () => {} }, () => pending);
  try {
    await h.flush(); assert.match(text(h.tree), /Loading routine history/); assert.equal(nodes(h.tree).some(node => node.props?.title === 'No scheduled runs yet.'), false);
    release({ routines: [], history: [], nextCursor: null }); await h.flush();
    assert.equal(nodes(h.tree).some(node => node.props?.title === 'No scheduled runs yet.'), true);
  } finally { h.close(); }
});

test('a new tool observation exposes availability without opening a tab or taking focus', async () => {
  let opened = 0; const availability: boolean[] = [];
  const h = host(AssistantActivityPanel, { operation: { id: 'operation', state: 'running' }, open: false, show: () => opened++, close: () => {}, stop: async () => {}, available: (value: boolean) => availability.push(value) }, () => ({ id: 'observation', operationId: 'operation', width: 100, height: 100 }));
  try { await h.flush(); assert.equal(opened, 0); assert.ok(availability.includes(true)); assert.equal(h.tree, null); }
  finally { h.close(); }
});

test('chat rows expose their own ongoing work, preserve drafts and do not infer completion or dispatch effects', async () => {
  let opened = 0;
  const operation = { id: 'run', conversationId: 'chat', state: 'prepared', connectionGeneration: 'current' };
  const controller = { operations: [operation], connection: { state: 'ready', generation: 'current' }, statusRead: 'ready' };
  const h = host(ConversationRow, { conversation: { id: 'chat', title: 'Background chat', state: 'ready', nativeId: 'native' }, controller, selected: false, hasDraft: true, updatedAt: new Date().toISOString(), open: () => opened++, snapshot: {}, refreshWorkspace: async () => {} }, () => { throw Error('Rows must not request status independently'); });
  try {
    await h.flush(); assert.match(text(h.tree.props.secondary), /Starting.*Draft/);
    for (const state of ['dispatching', 'accepted', 'running']) {
      await h.update({ controller: { ...controller, operations: [{ ...operation, state }] } });
      assert.match(text(h.tree.props.secondary), state === 'running' ? /Working.*Draft/ : /Starting.*Draft/);
    }
    h.tree.props.open(); assert.equal(opened, 1);
    for (const change of [{ statusRead: 'error' }, { statusRead: 'loading' }, { connection: { state: 'disconnected', generation: 'current' } }, { connection: { state: 'ready', generation: 'replacement' } }, { operations: [{ ...operation, state: 'unknown' }] }]) {
      await h.update({ controller: { ...controller, ...change } });
      assert.match(text(h.tree.props.secondary), /Status unconfirmed.*Draft/);
    }
    await h.update({ controller: { ...controller, operations: [{ ...operation, state: 'running', cancelRequested: true }] } });
    assert.match(text(h.tree.props.secondary), /Stop requested.*Draft/);
    for (const state of ['completed', 'failed', 'cancelled']) {
      await h.update({ controller: { ...controller, operations: [{ ...operation, state }, { ...operation, conversationId: 'another-chat', state: 'running' }] } });
      assert.doesNotMatch(text(h.tree.props.secondary), /Working|Starting|unconfirmed|Stop requested/);
      assert.match(text(h.tree.props.secondary), /Draft/);
    }
    assert.equal(h.calls.length, 0);
  } finally { h.close(); }
});

test('chat row attention uses current pending input only and returns to work after resolution', async () => {
  const operation = { id: 'run', conversationId: 'chat', state: 'running', connectionGeneration: 'current' };
  const item = { conversationId: 'chat', connectionGeneration: 'current', snapshot: { status: 'pending' }, availability: 'live' };
  const controller = { operations: [operation], connection: { state: 'ready', generation: 'current' }, statusRead: 'ready' };
  const h = host(ConversationRow, { conversation: { id: 'chat', title: 'Background chat', state: 'ready' }, controller, selected: false, hasDraft: false, updatedAt: new Date().toISOString(), open() {}, snapshot: {}, refreshWorkspace: async () => {} }, () => null);
  try {
    for (const field of ['approvals', 'questions']) {
      await h.update({ controller: { ...controller, [field]: { state: 'ready', items: [item] } } });
      assert.equal(text(h.tree.props.secondary).trim(), 'Needs input');
      for (const change of [{ conversationId: 'another-chat' }, { connectionGeneration: 'old' }, { snapshot: { status: 'cancelled' } }, ...(field === 'questions' ? [{ dismissed: true }, { availability: 'missing' }] : [])]) {
        await h.update({ controller: { ...controller, [field]: { state: 'ready', items: [{ ...item, ...change }] } } });
        assert.equal(text(h.tree.props.secondary).trim(), 'Working');
      }
    }
    assert.equal(h.calls.length, 0);
  } finally { h.close(); }
});
