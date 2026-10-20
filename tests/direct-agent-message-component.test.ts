import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { defaultLayout, emptyDraft, type Snapshot } from '../packages/domain/contracts';
import { blankRecord } from '../packages/domain/workspace-records';
import { randomUUID } from 'node:crypto';

// Exercise the actual retained composer and its original-message callbacks.
// Provider, voice and attachment effects are inert; only captured HTTP is allowed.
const symbol = Symbol.for('nova.test.direct-agent-message');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const mocks: Record<string, string> = {
  './useAttachments': `export const useAttachments=()=>({staging:false,pending:[],errors:{},notice:'',add(){throw Error('Unexpected upload');},remove(){},retry(){}});`,
  './useWorkspace': `export const retainedWindowId='search-window'; export const useWorkspace=()=>({});
    export const useRetained=(kind,id,fallback,entity,snapshot)=>globalThis[Symbol.for('nova.test.direct-journal')];`,
  './AppIcon': `export const useAppIcon=()=> 'red'; export const NovaAppMark=()=>null;`,
};
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/apps/client/src/')) {
      if (specifier === 'react') return { url: 'nova-direct-message:react', shortCircuit: true };
      if (mocks[specifier]) return { url: `nova-direct-message:${specifier}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-direct-message:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      const h=()=>globalThis[Symbol.for('nova.test.direct-agent-message')];
      export const useState=v=>h().state(v),useRef=v=>h().ref(v),useId=()=>h().id();
      export const useEffect=(f,d)=>h().effect(f,d),useLayoutEffect=useEffect;
      export const useMemo=(f,d)=>h().memo(f,d),useCallback=(f,d)=>h().memo(()=>f,d);
      export const useSyncExternalStore=(_subscribe,read)=>read();` };
    if (url.startsWith('nova-direct-message:./')) return { format: 'module', shortCircuit: true, source: mocks[url.slice('nova-direct-message:'.length)] };
    if (url.endsWith('.png')) return { format: 'module', shortCircuit: true, source: 'export default "fixture-art";' };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  },
});
const { Assistant } = await import('../apps/client/src/Assistant');
loader.deregister();
const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join(' ') : node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const scope = { epoch: '00000000-0000-4000-8000-000000000001', deviceId: 'device', windowId: 'search-window' };
function snapshot(): Snapshot {
  const row = <T>(id: string, value: T) => ({ id, value, revision: 2, deviceId: 'device', updatedAt: '2026-10-19T00:00:00.000Z' });
  return { ...scope, cursor: 0, tasks: [], projects: [], drafts: [row('draft:saved', { ...emptyDraft, title: 'Saved Article', text: 'Exact host writing' })],
    layout: row('layout', { ...structuredClone(defaultLayout), theme: 'light', timezone: 'UTC' }),
    capabilities: { assistant: false, voice: false, reason: 'Synthetic component fixture' },
    records: { contact: [row('contact:first', { ...blankRecord('contact', 'UTC'), name: 'First Person' }), row('contact:second', { ...blankRecord('contact', 'UTC'), name: 'Second Person' })], content: [], agent: [], assignment: [], profile: [] } } as Snapshot;
}
function fixture(respond: (path: string, init: RequestInit) => unknown | Promise<unknown> = () => ({ epoch: scope.epoch, items: [], collections: [], resources: [], ideaPreferences: { revision: 0, saved: [], hidden: [] } })) {
  const storage = new Map<string, string>(), calls: { path: string; init: RequestInit }[] = [], owners: { close(): void }[] = [];
  let fail: (key: string) => boolean = () => false, failRead: (key: string) => boolean = () => false;
  const values: Record<PropertyKey, unknown> = {
    window: Object.assign(new EventTarget(), { innerWidth: 1280 }),
    document: Object.assign(new EventTarget(), { hidden: false, documentElement: { dataset: {} }, querySelector: () => null, activeElement: null, getElementById: () => null }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    HTMLElement: class HTMLElement {},
    localStorage: { getItem: (key: string) => { if (failRead(key)) throw Error('Synthetic read refusal'); return storage.get(key) ?? null; }, setItem: (key: string, value: string) => { if (fail(key)) throw Error('Synthetic storage refusal'); storage.set(key, value); }, removeItem: (key: string) => storage.delete(key) },
    requestAnimationFrame: (run: () => void) => { run(); return 1; },
    fetch: async (path: string, init: RequestInit) => { calls.push({ path, init }); return new Response(JSON.stringify(await respond(path, init))); },
  };
  const originals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  function mount(component: (props: any) => any, initial: any) {
    let props = initial, cursor = 0, dirty = true, tree: any, closed = false;
    const cells: any[] = [], effects: (() => void)[] = [];
    const hooks = {
      state(value: any) { const i = cursor++; if (!cells[i]) cells[i] = { value: typeof value === 'function' ? value() : value }; return [cells[i].value, (next: any) => { const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true; } }]; },
      ref(value: any) { return cells[cursor++] ??= { current: value }; },
      id() { return (cells[cursor++] ??= { value: crypto.randomUUID() }).value; },
      effect(run: () => void | (() => void), deps?: unknown[]) { const i = cursor++, before = cells[i]; if (!before || !deps || deps.some((value, index) => !Object.is(value, before.deps?.[index]))) { cells[i] = { deps, cleanup: before?.cleanup }; effects.push(() => { cells[i].cleanup?.(); cells[i].cleanup = run(); }); } },
      memo(read: () => unknown, deps: unknown[]) { const i = cursor++, before = cells[i]; if (!before || deps.some((value, index) => !Object.is(value, before.deps[index]))) cells[i] = { deps, value: read() }; return cells[i].value; },
    };
    const owner = {
      get tree() { return tree; },
      async flush() { for (let pass = 0; pass < 24; pass++) { if (dirty && !closed) { dirty = false; cursor = 0; (globalThis as any)[symbol] = hooks; tree = component(props); while (effects.length) effects.shift()!(); } for (let tick = 0; tick < 10; tick++) await Promise.resolve(); } },
      async update(next: any) { props = { ...props, ...next }; dirty = true; await owner.flush(); },
      find(predicate: (node: any) => boolean) { const found = nodes(tree).find(predicate); assert.ok(found, 'Expected rendered control'); return found; },
      button(label: string) { return owner.find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node).trim() === label)); },
      close() { closed = true; for (const cell of cells) cell?.cleanup?.(); },
    };
    owners.push(owner); return owner;
  }
  return { storage, calls, mount, refuse: (check: typeof fail) => { fail = check; }, refuseRead: (check: typeof failRead) => { failRead = check; }, close() { owners.reverse().forEach(owner => owner.close()); for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); Reflect.deleteProperty(globalThis, symbol); } };
}
const directDesign = { ...blankRecord('agent', 'UTC'), name: 'Same Name', position: 'Researcher', archived: false };
const recipient = { agentId: 'agent:one', agentRevision: 3 };
function directSnapshot() { const value = snapshot(); value.records!.agent = [{ id: recipient.agentId, revision: 3, deviceId: scope.deviceId, updatedAt: '', value: directDesign as any }]; return value; }
function directConversation(requestId = randomUUID()) { return { id: randomUUID(), revision: 1, title: 'Original direct chat', space: 'chat', projectId: null, permissionMode: 'read-only', archived: false, nativeId: null, nativeKey: 'original-key', connectionGeneration: '', state: 'ready', model: null, thinking: null, createdAt: '', updatedAt: '', directAgent: { format: 1, recipient, design: directDesign, createdBy: { requestId, epoch: scope.epoch, deviceId: scope.deviceId } } }; }
function directController(conversations: any[] = []) { return { space: 'chat', conversations, operations: [], outputs: [], directConnections: [], statusRead: 'ready', selectedId: null, select() { return false; }, refresh: async () => {}, checkStatus: async () => true } as any; }
const postCalls = (f: ReturnType<typeof fixture>) => f.calls.filter(c => c.init.body);


async function composer(f: ReturnType<typeof fixture>, options: { retained?: boolean; newer?: boolean; flush?: () => Promise<any> } = {}) {
  const data = directSnapshot(), conversation = { ...directConversation(), nativeId: randomUUID() };
  const draftId = `draft:${scope.deviceId}:${conversation.id}`, key = `e3:submit:${draftId}`;
  const captured = { ...structuredClone(emptyDraft), conversationId: conversation.id, text: 'Original captured message' };
  const pending = { request: { requestId: randomUUID(), epoch: scope.epoch, conversationId: conversation.id, conversationRevision: conversation.revision, draftId, draftRevision: 2, projectRevision: 0 }, captured };
  const operation = { id: randomUUID(), requestId: pending.request.requestId, epoch: scope.epoch, deviceId: scope.deviceId, conversationId: conversation.id, conversationRevision: conversation.revision, state: 'failed', input: captured.text, createdAt: '', updatedAt: '', context: { draftId, draftRevision: 2, attachments: [], directAgent: { conversationId: conversation.id, requestId: pending.request.requestId, recipient } } };
  let value = options.newer ? { ...captured, text: 'Newer local writing' } : structuredClone(captured);
  let allowChange = true, changes = 0;
  const journal = { get value() { return value; }, epoch: scope.epoch, revision: 2, dirty: false, saving: false, submitBlocked: false,
    change(update: any) { if (!allowChange) return false; changes++; value = update(value); return true; }, retainForNavigation: () => true,
    flush: async () => {}, flushForSubmit: options.flush ?? (async () => ({ epoch: scope.epoch, revision: 2, value })) };
  const controller = { ...directController([conversation]), conversation, selectedId: conversation.id, connection: { state: 'ready', generation: 'fixture', methods: [], grantedScopes: ['operator.write'] }, models: [], queue: [], pins: [], removals: [], plans: [], loadHistory: async () => {} };
  const symbol = Symbol.for('nova.test.direct-journal'), original = Object.getOwnPropertyDescriptor(globalThis, symbol);
  Object.defineProperty(globalThis, symbol, { configurable: true, value: journal });
  data.drafts.push({ id: draftId, revision: 2, deviceId: scope.deviceId, updatedAt: '', value: captured });
  if (options.retained !== false) f.storage.set(key, JSON.stringify(pending));
  const props = { snapshot: data, controller, legacyJournal: journal, appIcon: 'red', voice: { subscribe: () => () => {}, getSnapshot: () => ({ phase: 'idle', turns: [] }) }, contentActions: {}, refreshWorkspace: async () => {}, openSettings() {}, newProject() {}, editProject() {} };
  const outer = f.mount(Assistant, props); await outer.flush();
  const retained = f.mount(outer.tree.type, outer.tree.props); await retained.flush();
  const editor = f.mount(retained.tree.type, retained.tree.props); await editor.flush();
  return { editor, controller, journal, pending, operation, key, draftId, captured, value: () => value, changes: () => changes,
    refuseChange() { allowChange = false; }, close() { if (original) Object.defineProperty(globalThis, symbol, original); else Reflect.deleteProperty(globalThis, symbol); } };
}

for (const newer of [false, true]) test(`actual direct message Check joins the original operation using GET only and ${newer ? 'preserves newer writing' : 'clears only its exact captured text'}`, async () => {
  let state: unknown; const f = fixture(() => state); let c: Awaited<ReturnType<typeof composer>> | undefined;
  try {
    c = await composer(f, { newer }); state = { operations: [c.operation] };
    assert.deepEqual(postCalls(f), []); c.editor.button('Check Original Message').props.onClick(); await c.editor.flush();
    assert.equal(f.storage.has(c.key), false); assert.equal(c.value().text, newer ? 'Newer local writing' : '');
    assert.equal(f.storage.get(`${c.key}:confirmed:${c.pending.request.requestId}`), JSON.stringify(c.pending));
    assert.equal(f.calls.length, 1); assert.match(f.calls[0].path, /assistant\/state$/); assert.deepEqual(postCalls(f), []);
  } finally { f.close(); c?.close(); }
});

for (const kind of ['wrong original', 'marker refusal', 'draft refusal', 'changed request', 'unmounted'] as const) test(`actual direct message Check preserves its original on ${kind}`, async () => {
  let finish!: (value: unknown) => void; const f = fixture(() => new Promise(resolve => { finish = resolve; })); let c: Awaited<ReturnType<typeof composer>> | undefined;
  try {
    c = await composer(f); const original = f.storage.get(c.key)!;
    if (kind === 'marker refusal') f.refuse(key => key.includes(':confirmed:'));
    if (kind === 'draft refusal') c.refuseChange();
    c.editor.button('Check Original Message').props.onClick(); await c.editor.flush();
    const changed = JSON.stringify({ ...c.pending, request: { ...c.pending.request, requestId: randomUUID() } });
    if (kind === 'changed request') f.storage.set(c.key, changed);
    if (kind === 'unmounted') c.editor.close();
    finish({ operations: [{ ...c.operation, ...(kind === 'wrong original' ? { requestId: randomUUID() } : {}) }] }); await c.editor.flush();
    assert.equal(f.storage.get(c.key), kind === 'changed request' ? changed : original); assert.equal(c.value().text, c.captured.text); assert.deepEqual(postCalls(f), []);
  } finally { f.close(); c?.close(); }
});

test('actual direct Send refuses malformed or unreadable original request without POST or draft flush', async () => {
  for (const kind of ['malformed', 'read refusal']) {
    let flushes = 0; const f = fixture(); let c: Awaited<ReturnType<typeof composer>> | undefined;
    try {
      c = await composer(f, { retained: false, flush: async () => { flushes++; throw Error('Must not flush'); } });
      f.storage.set(c.key, '{original incomplete'); if (kind === 'read refusal') f.refuseRead(key => key === c!.key);
      await c.editor.update({}); const send = c.editor.button('Send message'); assert.equal(send.props.disabled, true);
      send.props.onClick(); await c.editor.flush(); assert.equal(flushes, 0); assert.deepEqual(postCalls(f), []); assert.equal(f.storage.get(c.key), '{original incomplete');
    } finally { f.close(); c?.close(); }
  }
});

test('actual direct Send does not replace a request arriving while its draft is being kept', async () => {
  let finish!: (value: unknown) => void; const f = fixture(); let c: Awaited<ReturnType<typeof composer>> | undefined;
  try {
    c = await composer(f, { retained: false, flush: () => new Promise(resolve => { finish = resolve; }) });
    assert.equal(c.editor.button('Send message').props.disabled, false); c.editor.button('Send message').props.onClick(); await c.editor.flush();
    const raw = JSON.stringify(c.pending); f.storage.set(c.key, raw); finish({ epoch: scope.epoch, revision: 2, value: c.captured }); await c.editor.flush();
    assert.equal(f.storage.get(c.key), raw); assert.equal(c.value().text, c.captured.text); assert.deepEqual(postCalls(f), []);
  } finally { f.close(); c?.close(); }
});
