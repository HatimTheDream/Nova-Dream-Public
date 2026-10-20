import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { PermanentConversationCleanupBatch } from '../packages/domain/conversation-cleanup';
const hookKey = Symbol.for('nova.test.permanent-cleanup');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
  resolve(specifier, context, next) { return specifier === 'react' && context.parentURL?.includes('/apps/client/src/') ? { url: 'nova-test:permanent-cleanup', shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
    if (url === 'nova-test:permanent-cleanup') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      const h=()=>globalThis[Symbol.for('nova.test.permanent-cleanup')];
      export const useState=v=>h().state(v),useRef=v=>h().ref(v),useEffect=(f,d)=>h().effect(f,d),useLayoutEffect=useEffect;
      export const useMemo=(f,d)=>h().memo(f,d),useCallback=(f,d)=>h().memo(()=>f,d),useSyncExternalStore=(s,g)=>h().external(s,g);` };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  },
});
const { ConversationCleanupPanel } = await import('../apps/client/src/ConversationCleanupPanel');
const { PermanentConversationCleanupPanel } = await import('../apps/client/src/PermanentConversationCleanupPanel');
const { retainedWindowId } = await import('../apps/client/src/useWorkspace');
const { registerAssistantDraftNavigation } = await import('../apps/client/src/assistant-draft-navigation');
loader.deregister();
const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const button = (tree: any, label: string) => nodes(tree).find(n => n.type === 'button' && text(n) === label);
const ack = (tree: any) => nodes(tree).find(n => n.type === 'label' && n.props.className === 'permanent-cleanup-ack')?.props.children[0];
function host(component: (props: any) => any, initialProps: any, respond: (path: string, body: any) => unknown | Promise<unknown>) {
  let props = initialProps, cursor = 0, dirty = true, tree: any, writable = true, readable = true;
  let cells: any[] = [], effects: (() => void)[] = [];
  const storage = new Map<string, string>(), calls: { path: string; body: any }[] = [], writes: string[] = [];
  const values: Record<PropertyKey, unknown> = {
    [hookKey]: {
      state(initial: any) { const i = cursor++; if (!cells[i]) cells[i] = { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, (next: any) => { const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true; } }]; },
      ref(value: any) { return cells[cursor++] ??= { current: value }; },
      effect(run: () => void | (() => void), deps: unknown[]) { const i = cursor++, prior = cells[i]; if (!prior || deps.some((v, n) => !Object.is(v, prior.deps[n]))) { cells[i] = { deps, cleanup: prior?.cleanup }; effects.push(() => { cells[i].cleanup?.(); cells[i].cleanup = run(); }); } },
      memo(read: () => unknown, deps: unknown[]) { const i = cursor++, prior = cells[i]; if (!prior || deps.some((v, n) => !Object.is(v, prior.deps[n]))) cells[i] = { deps, value: read() }; return cells[i].value; },
      external(subscribe: (listener: () => void) => () => void, get: () => unknown) { const i = cursor++; if (!cells[i]) cells[i] = { cleanup: subscribe(() => { dirty = true; }) }; return get(); },
    },
    window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
    document: { hidden: false, addEventListener() {}, removeEventListener() {}, querySelector() { return null; } },
    localStorage: {
      getItem(key: string) { if (!readable) throw Error('Storage read refused'); return storage.get(key) ?? null; },
      setItem(key: string, value: string) { if (!writable) throw Error('Storage write refused'); writes.push(key); storage.set(key, value); },
    },
    fetch: async (path: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path, body });
      const response = await respond(path, body); return response instanceof Response ? response : new Response(JSON.stringify(response));
    },
  };
  const originals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const flush = async () => {
    for (let pass = 0; pass < 30; pass++) {
      if (dirty) { dirty = false; cursor = 0; tree = component(props); while (effects.length) effects.shift()!(); }
      for (let n = 0; n < 10; n++) await Promise.resolve();
    }
  };
  return {
    flush, calls, storage, writes, get tree() { return tree; }, writable(value: boolean) { writable = value; }, readable(value: boolean) { readable = value; },
    async update(next: any) { props = { ...props, ...next }; dirty = true; await flush(); },
    async remount() { for (const cell of cells) cell?.cleanup?.(); cells = []; effects = []; dirty = true; await flush(); },
    close() { for (const cell of cells) cell?.cleanup?.(); for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); },
  };
}
function fixture() {
  const epoch = randomUUID(), deviceId = randomUUID(), id = randomUUID();
  const target = { id, revision: 1, title: 'Synthetic Trash', deleted: true as const, archived: false, space: 'chat' as const, projectId: null };
  const props = { epoch, deviceId, currentScope: { space: 'all' as const, folder: 'deleted' as const, query: '' }, conversations: [target] as any, active: true, refresh: async () => { refreshes++; } };
  let batch: PermanentConversationCleanupBatch, lose = false, refreshes = 0;
  const respond = async (path: string, input: any) => {
    if (!input && path.includes('offset=')) return { items: [], total: 0, nextOffset: null };
    if (path.endsWith('/prepare')) batch = {
      format: 2, id: input.requestId, epoch, revision: 1, digest: 'b'.repeat(64), action: 'remove', scope: input.scope, mode: input.targets ? 'selected' : 'matching',
      createdAt: '2026-01-01', updatedAt: '2026-01-01', state: 'review', targets: [target], outcomes: [{ id, state: 'pending' }], chunks: [],
      counts: { pending: 1, applied: 0, blocked: 0, unconfirmed: 0 }, remainder: { observedAt: '2026-01-01', verified: true, capturedRemaining: [id], matchingCount: 1, newMatchingCount: 0 }, running: false,
    };
    if (path.endsWith('/decide')) {
      if (input.decision === 'cancel') batch = { ...batch, revision: 2, state: 'cancelled' };
      else batch = { ...batch, revision: 3, state: 'complete', counts: { pending: 0, applied: 1, blocked: 0, unconfirmed: 0 },
        outcomes: [{ id, state: 'applied', removalId: randomUUID(), chunkId: input.requestId }],
        chunks: [{ id: input.requestId, decision: 'start', startedAt: '2026-01-01', settledAt: '2026-01-01', state: 'closed', itemIds: [id] }],
        remainder: { ...batch.remainder, capturedRemaining: [], matchingCount: 0 } };
      if (lose) throw Error('Original reply lost');
    }
    return batch;
  };
  return { props, respond, epoch, deviceId, id, refreshes: () => refreshes, lost: (value: boolean) => { lose = value; }, batch: () => batch,
    key: `e3:conversation-permanent-cleanup:${epoch}:${deviceId}:${retainedWindowId}`,
    modeKey: `e3:conversation-cleanup-mode:${epoch}:${deviceId}:${retainedWindowId}` };
}
async function review(app: ReturnType<typeof host>) {
  await app.flush(); button(app.tree, 'Review All 1 Matching').props.onClick(); await app.flush();
}
test('actual mode selection keeps both owners mounted and persists before changing their activity', async () => {
  const f = fixture(), Modes = ConversationCleanupPanel(f.props).type as any;
  const app = host(Modes, f.props, f.respond);
  try {
    await app.flush(); const ownerNodes = () => nodes(app.tree).filter(n => typeof n.type === 'function');
    const original = ownerNodes(); assert.equal(original.length, 2); assert.deepEqual(original.map(n => n.props.active), [true, false]);
    app.writable(false); button(app.tree, 'Permanent Trash Removal').props.onClick(); await app.flush();
    assert.deepEqual(ownerNodes().map(n => n.props.active), [true, false]); assert.equal(app.storage.has(f.modeKey), false);
    app.writable(true); button(app.tree, 'Permanent Trash Removal').props.onClick(); await app.flush();
    assert.deepEqual(ownerNodes().map(n => n.props.active), [false, true]); assert.equal(JSON.parse(app.storage.get(f.modeKey)!).mode, 'permanent');
    assert.deepEqual(ownerNodes().map(n => n.type), original.map(n => n.type)); assert.deepEqual(app.calls, []);
  } finally { app.close(); }
});
for (const malformed of ['{', 'null', '{"format":1,"mode":"permanent"}']) test(`actual malformed mode ${malformed} leaves both owners inactive without replacing original bytes`, async () => {
  const f = fixture(), app = host(ConversationCleanupPanel(f.props).type as any, f.props, f.respond); app.storage.set(f.modeKey, malformed);
  try {
    await app.flush(); assert.deepEqual(nodes(app.tree).filter(n => typeof n.type === 'function').map(n => n.props.active), [false, false]);
    button(app.tree, 'Permanent Trash Removal').props.onClick(); await app.flush();
    assert.equal(app.storage.get(f.modeKey), malformed); assert.deepEqual(app.writes, []); assert.deepEqual(app.calls, []);
  } finally { app.close(); }
});
test('actual permanent review requires acknowledgement and lost response only observes its original result', async () => {
  const f = fixture(), app = host(PermanentConversationCleanupPanel, f.props, f.respond);
  try {
    await review(app); const remove = button(app.tree, 'Permanently Remove (Up To 1)');
    assert.equal(remove.props.disabled, true); remove.props.onClick(); await app.flush();
    assert.equal(app.calls.filter(c => c.body?.decision).length, 0);
    ack(app.tree).props.onChange({ target: { checked: true } }); await app.flush(); f.lost(true);
    button(app.tree, 'Permanently Remove (Up To 1)').props.onClick(); await app.flush();
    const original = JSON.parse(app.storage.get(f.key)!).pending; assert.equal(original.command.decision, 'start');
    f.lost(false); await app.remount(); assert.equal(app.calls.filter(c => c.body?.decision).length, 1);
    assert.match(text(app.tree), /1 removed/); assert.equal(JSON.parse(app.storage.get(f.key)!).pending, undefined);
    assert.deepEqual(JSON.parse(app.storage.get(f.key)!).lastRequest, original);
  } finally { app.close(); }
});
test('hide and reactivation preserve exact writing/request state and invalidate acknowledgement', async () => {
  const f = fixture(), app = host(PermanentConversationCleanupPanel, f.props, f.respond);
  try {
    await review(app); ack(app.tree).props.onChange({ target: { checked: true } }); await app.flush();
    const raw = app.storage.get(f.key), calls = app.calls.length;
    await app.update({ active: false }); assert.equal(app.calls.length, calls);
    button(app.tree, 'Observe Original Status').props.onClick(); await app.flush(); assert.equal(app.calls.length, calls); assert.equal(app.storage.get(f.key), raw);
    await app.update({ active: true }); assert.equal(app.calls.filter(c => c.body?.decision).length, 0);
    assert.equal(ack(app.tree).props.checked, false); assert.equal(button(app.tree, 'Permanently Remove (Up To 1)').props.disabled, true);
  } finally { app.close(); }
});
test('a late reply after hide is retained without refreshing or admitting another request', async () => {
  const f = fixture(); let resolve!: (value: unknown) => void;
  const app = host(PermanentConversationCleanupPanel, f.props, async (path, input) => {
    const value = await f.respond(path, input); if (input?.decision === 'start') return new Promise(yes => { resolve = () => yes(value); }); return value;
  });
  try {
    await review(app); ack(app.tree).props.onChange({ target: { checked: true } }); await app.flush();
    button(app.tree, 'Permanently Remove (Up To 1)').props.onClick(); await app.flush(); await app.update({ active: false });
    const calls = app.calls.length; resolve(undefined); await app.flush();
    assert.equal(app.calls.length, calls); assert.equal(f.refreshes(), 0); assert.equal(JSON.parse(app.storage.get(f.key)!).pending, undefined);
  } finally { app.close(); }
});
test('current Assistant writing refusal and command-storage refusal both prevent actual removal POST', async () => {
  const f = fixture(), app = host(PermanentConversationCleanupPanel, f.props, f.respond), unregister = registerAssistantDraftNavigation(() => false);
  try {
    await review(app); ack(app.tree).props.onChange({ target: { checked: true } }); await app.flush();
    button(app.tree, 'Permanently Remove (Up To 1)').props.onClick(); await app.flush(); assert.equal(app.calls.filter(c => c.body?.decision).length, 0);
    unregister(); ack(app.tree).props.onChange({ target: { checked: true } }); await app.flush(); app.writable(false);
    button(app.tree, 'Permanently Remove (Up To 1)').props.onClick(); await app.flush();
    assert.equal(app.calls.filter(c => c.body?.decision).length, 0); assert.equal(JSON.parse(app.storage.get(f.key)!).pending, undefined);
  } finally { unregister(); app.close(); }
});
test('the inactive reversible owner never starts its original check continuation', async () => {
  const f = fixture(), modeApp = host(ConversationCleanupPanel(f.props).type as any, f.props, f.respond);
  let Organization: any;
  try { await modeApp.flush(); Organization = nodes(modeApp.tree).find(n => typeof n.type === 'function').type; } finally { modeApp.close(); }
  const app = host(Organization, { ...f.props, active: false }, () => { throw Error('Inactive request'); });
  try { await app.flush(); assert.deepEqual(app.calls, []); await app.update({ active: true }); assert.equal(app.calls.length, 1); await app.update({ active: false }); const calls = app.calls.length;
    button(app.tree, 'Refresh').props.onClick(); await app.flush(); assert.equal(app.calls.length, calls);
    await app.update({ active: true }); const beforeRemount = app.calls.length; await app.remount(); assert.equal(app.calls.length, beforeRemount + 1, 'remounted retained owner can read again without an obsolete activity ref');
  } finally { app.close(); }
});
