import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { defaultLayout, emptyDraft, type Snapshot } from '../packages/domain/contracts';
import { blankRecord } from '../packages/domain/workspace-records';
import { SearchNavigation, searchKey, type SearchTarget } from '../apps/client/src/search-workspace';
import { recordIndexKey } from '../apps/client/src/record-target-navigation';
import { admitLibraryTarget, defaultLibraryView, libraryViewKey } from '../apps/client/src/home-library-navigation';
import { admitInboxSearch } from '../apps/client/src/search-query-navigation';
import { readNavigationLocal } from '../apps/client/src/navigation-storage';
import { randomUUID } from 'node:crypto';
import { directChatCommandKey, keepDirectChatSelection, registerDirectChatOwner, mayLeaveDirectChat } from '../apps/client/src/direct-agent-chat';

// Exercise the actual App callbacks and Settings guard. Provider, voice and
// background command owners are inert; navigation must never invoke them.
const symbol = Symbol.for('nova.test.direct-agent-ui');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const mocks: Record<string, string> = {
  './useWorkspace': `export const retainedWindowId='search-window'; export const useWorkspace=()=>({});
    export const useRetained=(kind,id,fallback,entity,snapshot)=>({value:entity?.value??fallback,revision:entity?.revision??0,epoch:snapshot.epoch,dirty:false,change:()=>true,flush:async()=>entity});`,
  './useAssistant': `export const useAssistant=()=>globalThis[Symbol.for('nova.test.direct-controller')];`,
  './useReminders': `export const useReminders=()=>({});`,
  './useTaskActions': `export const useTaskActions=()=>({state:{queue:[],undo:[]},busy:false});`,
  './useReorder': `export const useReorder=order=>({order,bind:()=>({}),suppressClick:{current:false},containerRef:{current:null}});`,
  './voice-controller': `export class VoiceController {dispose(){}}`,
  './AppIcon': `export const useAppIcon=()=> 'red'; export const NovaAppMark=()=>null;`,
};
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/apps/client/src/')) {
      if (specifier === 'react') return { url: 'nova-direct:react', shortCircuit: true };
      if (mocks[specifier]) return { url: `nova-direct:${specifier}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-direct:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      const h=()=>globalThis[Symbol.for('nova.test.direct-agent-ui')];
      export const useState=v=>h().state(v),useRef=v=>h().ref(v),useId=()=>h().id();
      export const useEffect=(f,d)=>h().effect(f,d),useLayoutEffect=useEffect;
      export const useMemo=(f,d)=>h().memo(f,d),useCallback=(f,d)=>h().memo(()=>f,d);
      export const useSyncExternalStore=(_subscribe,read)=>read();` };
    if (url.startsWith('nova-direct:./')) return { format: 'module', shortCircuit: true, source: mocks[url.slice('nova-direct:'.length)] };
    if (url.endsWith('.png')) return { format: 'module', shortCircuit: true, source: 'export default "fixture-art";' };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  },
});
const { Workspace } = await import('../apps/client/src/App');
const { SearchWorkspace, useGlobalSearch } = await import('../apps/client/src/SearchWorkspace');
const { GeneralSettings } = await import('../apps/client/src/GeneralSettings');
const { Dialog } = await import('../apps/client/src/ui');
const { SavedDraftArticle } = await import('../apps/client/src/SavedDraftArticle');
const { registerRecordDraftNavigation } = await import('../apps/client/src/record-draft-navigation');
const { ConversationSearch } = await import('../apps/client/src/ConversationSearch');
const { default: Contacts } = await import('../apps/client/src/Contacts');
const { default: RecordsPage } = await import('../apps/client/src/RecordsPage');
const { HomeLibrary } = await import('../apps/client/src/HomeLibrary');
const { AgentsWorkspaceNavigation, AgentWorkControls } = await import('../apps/client/src/AgentsWorkspaceControls');
const { default: AgentHub } = await import('../apps/client/src/AgentHub');
const { registerAgentDraftNavigation, mayLeaveAgentDrafts } = await import('../apps/client/src/agent-workspace-navigation');
const { registerHomeDraftNavigation } = await import('../apps/client/src/home-draft-navigation');
const { DirectAgentChooser, DirectAgentStatus, DirectAgentAccount } = await import('../apps/client/src/DirectAgentChat');
const { useAssistant: actualUseAssistant } = await import('../apps/client/src/useAssistant');
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
const appProps = (data = snapshot()) => ({ snapshot: data, online: true, refresh: async () => {}, reconnect: async () => {}, dismissFrontendUpdate() {} });
const currentRoute = (app: ReturnType<ReturnType<typeof fixture>['mount']>) => app.find(node => node.props['data-route']).props['data-route'];
const searchElement = (app: ReturnType<ReturnType<typeof fixture>['mount']>) => app.find(node => node.type === SearchWorkspace);

const directDesign = { ...blankRecord('agent', 'UTC'), name: 'Same Name', position: 'Researcher', archived: false };
const recipient = { agentId: 'agent:one', agentRevision: 3 };
function directSnapshot() { const value = snapshot(); value.records!.agent = [{ id: recipient.agentId, revision: 3, deviceId: scope.deviceId, updatedAt: '', value: directDesign as any }]; return value; }
function directConversation(requestId = randomUUID()) { return { id: randomUUID(), revision: 1, title: 'Original direct chat', space: 'chat', projectId: null, permissionMode: 'read-only', archived: false, nativeId: null, nativeKey: 'original-key', connectionGeneration: '', state: 'ready', model: null, thinking: null, createdAt: '', updatedAt: '', directAgent: { format: 1, recipient, design: directDesign, createdBy: { requestId, epoch: scope.epoch, deviceId: scope.deviceId } } }; }
function directController(conversations: any[] = []) { return { space: 'chat', conversations, operations: [], outputs: [], directConnections: [], statusRead: 'ready', selectedId: null, select() { return false; }, refresh: async () => {}, checkStatus: async () => true } as any; }
function installController(value: any) { const key=Symbol.for('nova.test.direct-controller'), old=Object.getOwnPropertyDescriptor(globalThis,key); Object.defineProperty(globalThis,key,{configurable:true,value}); return () => {if(old)Object.defineProperty(globalThis,key,old);else Reflect.deleteProperty(globalThis,key);}; }
const chooserTarget = () => ({ format: 1 as const, scope, recipient, token: randomUUID(), origin: 'agents' as const, previousSelection: { space: 'chat' as const, id: null } });
const postCalls = (f: ReturnType<typeof fixture>) => f.calls.filter(c => c.init.body);

test('actual chooser mounts without an effect and failed original retention blocks Create', async () => {
  const f = fixture(), target = chooserTarget(), controller = directController();
  try {
    const view = f.mount(DirectAgentChooser, { target, snapshot: directSnapshot(), controller, current: () => true, open() { throw Error('Unexpected selection'); }, close() {} });
    await view.flush(); assert.deepEqual(f.calls, []);
    f.refuse(key => key === directChatCommandKey(scope, 'create:agent:one'));
    view.button('Create Chat & Connect').props.onClick(); await view.flush();
    assert.deepEqual(f.calls, []); assert.match(text(view.tree), /storage|full|refusal/i);
  } finally { f.close(); }
});

test('actual lost creation reply reopens and checks only the exact original result', async () => {
  let created: any, original: any;
  const f = fixture((path, init) => {
    if (init.body) { original = JSON.parse(String(init.body)); created = directConversation(original.requestId); throw Error('Lost reply'); }
    assert.equal(path, '/api/assistant/state'); return { conversations: [created], operations: [] };
  }), target = chooserTarget(), controller = directController();
  const props = { target, snapshot: directSnapshot(), controller, current: () => true, open() { return true; }, close() {} };
  try {
    let view = f.mount(DirectAgentChooser, props); await view.flush(); view.button('Create Chat & Connect').props.onClick(); await view.flush();
    const key = directChatCommandKey(scope, 'create:agent:one'), kept = JSON.parse(f.storage.get(key)!);
    assert.equal(kept.command.body.requestId, original.requestId); assert.equal(postCalls(f).length, 1);
    view.close(); view = f.mount(DirectAgentChooser, props); await view.flush(); assert.equal(postCalls(f).length, 1);
    view.button('Check Original Status').props.onClick(); await view.flush();
    assert.equal(JSON.parse(f.storage.get(key)!).confirmation.conversationId, created.id); assert.equal(postCalls(f).length, 1);
    assert.match(text(view.tree), /original chat was saved/);
  } finally { f.close(); }
});

test('actual known creation reply survives refresh failure and storage refusal without a second POST', async () => {
  const f = fixture((_path, init) => { const input = JSON.parse(String(init.body)); f.refuse(key => key.includes('direct-chat-command')); return directConversation(input.requestId); });
  let closes = 0;
  try {
    const controller = directController(); controller.refresh = async () => { throw Error('Refresh unavailable'); };
    const view = f.mount(DirectAgentChooser, { target: chooserTarget(), snapshot: directSnapshot(), controller, current: () => true, open() { return true; }, close() { closes++; } });
    await view.flush(); view.button('Create Chat & Connect').props.onClick(); await view.flush();
    assert.equal(mayLeaveDirectChat(), false); assert.equal(postCalls(f).length, 1);
    view.button('Back').props.onClick(); assert.equal(closes, 0);
    f.refuse(() => false); view.button('Back').props.onClick(); await view.flush();
    assert.equal(closes, 1); assert.equal(postCalls(f).length, 1);
    assert.ok(JSON.parse(f.storage.get(directChatCommandKey(scope, 'create:agent:one'))!).confirmation);
  } finally { f.close(); }
});

test('actual late creation result is kept but never navigates after its owner unmounts', async () => {
  let finish!: (value: unknown) => void, original: any, opened = 0;
  const f = fixture((_path, init) => { original = JSON.parse(String(init.body)); return new Promise(resolve => { finish = resolve; }); });
  try {
    const view = f.mount(DirectAgentChooser, { target: chooserTarget(), snapshot: directSnapshot(), controller: directController(), current: () => true, open() { opened++; return true; }, close() {} });
    await view.flush(); view.button('Create Chat & Connect').props.onClick(); await view.flush();
    view.close(); finish(directConversation(original.requestId)); await view.flush();
    assert.equal(opened, 0); assert.equal(postCalls(f).length, 1);
    assert.ok(JSON.parse(f.storage.get(directChatCommandKey(scope, 'create:agent:one'))!).confirmation);
  } finally { f.close(); }
});

test('actual status has no automatic work and Continue requires current exact proven-unsent authority', async () => {
  const row = directConversation(), controller = directController([row]); controller.selectedId = row.id;
  let checks = 0; controller.checkStatus = async () => { checks++; return true; };
  const f = fixture((_path, init) => { const input = JSON.parse(String(init.body)); assert.equal(input.action, 'continue-unsent'); return row; });
  try {
    const view = f.mount(DirectAgentStatus, { conversation: row, snapshot: directSnapshot(), controller, scope }); await view.flush();
    assert.deepEqual(f.calls, []); assert.equal(nodes(view.tree).some(node => text(node) === 'Continue Original Connection'), false);
    view.button('Check Original Status').props.onClick(); await view.flush(); assert.equal(checks, 1); assert.deepEqual(f.calls, []);
    const status = { conversationId: row.id, conversationRevision: row.revision, setupRevision: 1, originalRequestId: randomUUID(), setupSha256: 'a'.repeat(64), state: 'failed', canContinueUnsent: true };
    await view.update({ controller: { ...controller, directConnections: [status] } });
    view.button('Continue Original Connection').props.onClick(); await view.flush();
    assert.equal(postCalls(f).length, 1); const sent = JSON.parse(String(postCalls(f)[0].init.body));
    assert.equal(sent.originalRequestId, status.originalRequestId); assert.equal(sent.expectedSetupSha256, status.setupSha256);
    await view.update({ controller: { ...controller, directConnections: [{ ...status, conversationRevision: 999 }] } });
    assert.equal(nodes(view.tree).some(node => node.type === 'button' && text(node) === 'Continue Original Connection'), false);
  } finally { f.close(); }
});

test('actual account presentation separates future preference from a failed attempt and genuine reply', () => {
  const row = directConversation(), requestId = randomUUID(), operationId = randomUUID();
  const history = { conversationId: row.id, hasNewer: false, messages: [{ role: 'assistant', operationId, author: { conversationId: row.id, requestId } }] } as any;
  const operation = { id: operationId, requestId, conversationId: row.id, state: 'running', context: { directAgent: { operationId } }, accountSelection: { label: 'Saved Account' } } as any;
  const props = { conversation: { ...row, preferredAccountId: 'preference' } as any, history, operations: [operation] };
  assert.match(text(DirectAgentAccount(props)), /Next turn:\s+Saved account preference/);
  assert.match(text(DirectAgentAccount(props)), /Last confirmed reply:\s+Unavailable/);
  assert.match(text(DirectAgentAccount({ ...props, operations: [{ ...operation, state: 'completed' }] })), /Last confirmed reply:\s+Saved Account/);
});

test('actual App guarded entry and return preserve exact token and refuse destination storage failure', async () => {
  const data = directSnapshot(), row = directConversation(), controller = directController([row]), restore = installController(controller), f = fixture();
  controller.selectDirect = (id: string, view: any) => {
    if (!keepDirectChatSelection(localStorage, scope.epoch, scope.deviceId, id, 'chat', view)) return false;
    controller.selectedId = id; return true;
  };
  try {
    const app = f.mount(Workspace, appProps(data)); await app.flush(); app.button('Agents').props.onClick(); await app.flush();
    const page = () => app.find(node => node.props.page === 'agents' && node.props.openAgentChat);
    const viewKey = `e3:direct-chat-view:${scope.epoch}:${scope.deviceId}:${scope.windowId}`;
    f.refuse(key => key === viewKey); assert.equal(page().props.openAgentChat(recipient.agentId, recipient.agentRevision), false); await app.flush();
    assert.equal(currentRoute(app), 'agents'); assert.equal(nodes(app.tree).some(n => n.type === DirectAgentChooser), false);
    f.refuse(() => false); assert.equal(page().props.openAgentChat(recipient.agentId, recipient.agentRevision), true); await app.flush();
    const chooser = app.find(n => n.type === DirectAgentChooser), staleClose = chooser.props.close;
    f.refuse(key => key === viewKey); assert.equal(chooser.props.open(row), false); await app.flush();
    assert.equal(controller.selectedId, null); assert.equal(app.find(n => n.type === DirectAgentChooser).props.target.conversationId, undefined);
    f.refuse(() => false); assert.equal(app.find(n => n.type === DirectAgentChooser).props.open(row), true); await app.flush();
    const assistant = app.find(n => n.props.directBack); f.refuse(key => key === viewKey);
    assert.equal(assistant.props.directBack(), false); await app.flush(); assert.equal(currentRoute(app), 'assistant');
    f.refuse(() => false); assert.equal(assistant.props.directBack(), true); await app.flush(); assert.equal(currentRoute(app), 'agents');
    page().props.openAgentChat(recipient.agentId, recipient.agentRevision); await app.flush();
    const latest = f.storage.get(viewKey); staleClose(); await app.flush();
    assert.equal(f.storage.get(viewKey), latest); assert.equal(currentRoute(app), 'assistant'); assert.deepEqual(postCalls(f), []);
  } finally { f.close(); restore(); }
});

test('actual Team callback respects retained writer and exact saved revision without sending', async () => {
  const f = fixture(), calls: unknown[][] = []; let release: (() => void) | undefined;
  try {
    const page = f.mount(RecordsPage, { page: 'agents', snapshot: directSnapshot(), refresh: async () => {}, editTask() {}, outputs: [], openContent() {}, openSource() {}, openAgentChat: (...args: unknown[]) => calls.push(args) });
    await page.flush(); const hub = () => page.find(node => node.props.presentation);
    release = registerAgentDraftNavigation(`${scope.epoch}:${scope.deviceId}:${scope.windowId}`, () => false);
    hub().props.openChat(recipient.agentId, recipient.agentRevision); assert.deepEqual(calls, []);
    release(); release = undefined; hub().props.openChat(recipient.agentId, recipient.agentRevision);
    assert.deepEqual(calls, [[recipient.agentId, recipient.agentRevision]]); assert.deepEqual(postCalls(f), []);
  } finally { release?.(); f.close(); }
});

test('an old Team callback cannot bypass the current Settings writing owner', async () => {
  const restore = installController(directController()), f = fixture();
  try {
    const app = f.mount(Workspace, appProps(directSnapshot())); await app.flush();
    app.button('Agents').props.onClick(); await app.flush();
    const oldOpen = app.find(node => node.props.page === 'agents' && node.props.openAgentChat).props.openAgentChat;
    app.button('Settings').props.onClick(); await app.flush();
    const settings = app.find(node => nodes(node.props.general).some(child => child.type === GeneralSettings));
    const general = f.mount(GeneralSettings, nodes(settings.props.general).find(node => node.type === GeneralSettings).props); await general.flush();
    general.find(node => node.props['aria-label'] === 'Color Theme').props.onChange({ target: { value: 'dark' } }); await general.flush(); await app.flush();
    const before = new Map(f.storage); assert.equal(oldOpen(recipient.agentId, recipient.agentRevision), false); await app.flush();
    assert.equal(currentRoute(app), 'settings'); assert.deepEqual(f.storage, before);
    assert.equal(nodes(app.tree).some(node => node.type === DirectAgentChooser), false); assert.deepEqual(postCalls(f), []);
  } finally { f.close(); restore(); }
});

test('actual status cleanup stays usable when Check or Continue refresh advances the same chat revision', async () => {
  for (const action of ['check', 'continue']) {
    const row = directConversation(), next = { ...row, revision: 2 }, controller = directController([row]); controller.selectedId = row.id;
    controller.directConnections = [{ conversationId: row.id, conversationRevision: 1, setupRevision: 1, originalRequestId: randomUUID(), setupSha256: 'b'.repeat(64), state: 'failed', canContinueUnsent: true }];
    let finish!: (value: any) => void;
    controller.checkStatus = () => new Promise(resolve => { finish = resolve; });
    const f = fixture(() => next);
    try {
      const view = f.mount(DirectAgentStatus, { conversation: row, snapshot: directSnapshot(), controller, scope }); await view.flush();
      let refreshed: Promise<void> | undefined;
      controller.refresh = () => { refreshed = view.update({ conversation: next }); return refreshed; };
      if (action === 'check') {
        view.button('Check Original Status').props.onClick(); await view.flush();
        await view.update({ conversation: next }); finish(true);
      } else view.button('Continue Original Connection').props.onClick();
      await view.flush();
      if (refreshed) await refreshed; await view.flush();
      assert.equal(view.button('Check Original Status').props.disabled, false);
      assert.equal(postCalls(f).length, action === 'check' ? 0 : 1);
    } finally { f.close(); }
  }
});

test('Assistant-origin Back restores the exact previous conversation and refuses failed retention', async () => {
  const data = directSnapshot(), direct = directConversation(), ordinary = { ...directConversation(), directAgent: undefined, title: 'Original ordinary chat' };
  const controller = directController([ordinary, direct]); controller.selectedId = ordinary.id;
  const restore = installController(controller), f = fixture();
  controller.selectRetained = (id: string | null, space: 'chat' | 'work', view: any) => {
    if (!keepDirectChatSelection(localStorage, scope.epoch, scope.deviceId, id, space, view)) return false;
    controller.selectedId = id; controller.space = space; return true;
  };
  controller.selectDirect = (id: string, view: any) => controller.selectRetained(id, 'chat', view);
  try {
    f.storage.set(`e3:conversation:${scope.deviceId}`, JSON.stringify(ordinary.id)); f.storage.set(`e3:assistant-space:${scope.epoch}:${scope.deviceId}`, '"chat"');
    const app = f.mount(Workspace, appProps(data)); await app.flush(); app.button('Assistant').props.onClick(); await app.flush();
    const assistant = () => app.find(node => node.props.controller === controller && node.props.openAgentChat);
    assistant().props.openAgentChat(recipient.agentId, recipient.agentRevision); await app.flush();
    app.find(node => node.type === DirectAgentChooser).props.open(direct); await app.flush();
    assert.equal(controller.selectedId, direct.id);
    const viewKey = `e3:direct-chat-view:${scope.epoch}:${scope.deviceId}:${scope.windowId}`;
    f.refuse(key => key === viewKey); assert.equal(assistant().props.directBack(), false); await app.flush();
    assert.equal(controller.selectedId, direct.id); assert.equal(JSON.parse(f.storage.get(`e3:conversation:${scope.deviceId}`)!), direct.id);
    f.refuse(() => false); assert.equal(assistant().props.directBack(), true); await app.flush();
    assert.equal(controller.selectedId, ordinary.id); assert.equal(currentRoute(app), 'assistant');
    assert.equal(JSON.parse(f.storage.get(`e3:conversation:${scope.deviceId}`)!), ordinary.id); assert.deepEqual(postCalls(f), []);
  } finally { f.close(); restore(); }
});

test('actual controller reload selects the original chat after a refused rollback', async () => {
  const original = directConversation(), next = directConversation();
  const data = directSnapshot(), f = fixture(path => path.endsWith('assistant/state')
    ? { ...directController([original, next]), connection: { state: 'unconfigured', methods: [], grantedScopes: [] } } : []);
  try {
    const selected = `e3:conversation:${scope.deviceId}`, spaceKey = `e3:assistant-space:${scope.epoch}:${scope.deviceId}`;
    f.storage.set(selected, JSON.stringify(original.id)); f.storage.set(spaceKey, '"chat"');
    let wroteNext = false;
    const ordinarySet = localStorage.setItem;
    localStorage.setItem = (key, value) => {
      if (key === selected && value === JSON.stringify(next.id)) wroteNext = true;
      if (wroteNext && (key === spaceKey || key === selected && value === JSON.stringify(original.id))) throw Error('Rollback storage refusal');
      ordinarySet(key, value);
    };
    assert.equal(keepDirectChatSelection(localStorage, scope.epoch, scope.deviceId, next.id), false);
    assert.equal(f.storage.get(selected), JSON.stringify(next.id));
    const hook = f.mount(() => actualUseAssistant(data, false), {}); await hook.flush();
    assert.equal(hook.tree.selectedId, original.id); assert.match(hook.tree.error, /previous chat selection is kept/);
    assert.equal(hook.tree.select(next.id), false); assert.equal(hook.tree.selectedId, original.id); assert.deepEqual(postCalls(f), []);
  } finally { f.close(); }
});
