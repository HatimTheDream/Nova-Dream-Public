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

// Exercise the actual App callbacks and Settings guard. Provider, voice and
// background command owners are inert; navigation must never invoke them.
const symbol = Symbol.for('nova.test.global-search');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const mocks: Record<string, string> = {
  './useWorkspace': `export const retainedWindowId='search-window'; export const useWorkspace=()=>({});
    export const useRetained=(kind,id,fallback,entity,snapshot)=>({value:entity?.value??fallback,revision:entity?.revision??0,epoch:snapshot.epoch,dirty:false,change:()=>true,flush:async()=>entity});`,
  './useAssistant': `export const useAssistant=()=>({space:'chat',operations:[],conversations:[],statusRead:'ready',select(){throw Error('Unexpected conversation selection');}});`,
  './useReminders': `export const useReminders=()=>({});`,
  './useTaskActions': `export const useTaskActions=()=>({state:{queue:[],undo:[]},busy:false});`,
  './useReorder': `export const useReorder=order=>({order,bind:()=>({}),suppressClick:{current:false},containerRef:{current:null}});`,
  './voice-controller': `export class VoiceController {dispose(){}}`,
  './AppIcon': `export const useAppIcon=()=> 'red'; export const NovaAppMark=()=>null;`,
};
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/apps/client/src/')) {
      if (specifier === 'react') return { url: 'nova-search:react', shortCircuit: true };
      if (mocks[specifier]) return { url: `nova-search:${specifier}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-search:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      const h=()=>globalThis[Symbol.for('nova.test.global-search')];
      export const useState=v=>h().state(v),useRef=v=>h().ref(v),useId=()=>h().id();
      export const useEffect=(f,d)=>h().effect(f,d),useLayoutEffect=useEffect;
      export const useMemo=(f,d)=>h().memo(f,d),useCallback=(f,d)=>h().memo(()=>f,d);
      export const useSyncExternalStore=(_subscribe,read)=>read();` };
    if (url.startsWith('nova-search:./')) return { format: 'module', shortCircuit: true, source: mocks[url.slice('nova-search:'.length)] };
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
  let searchWidth = 1280;
  const mediaListeners = new Set<() => void>();
  let fail: (key: string) => boolean = () => false, failRead: (key: string) => boolean = () => false;
  const values: Record<PropertyKey, unknown> = {
    HTMLElement: class {},
    window: Object.assign(new EventTarget(), { innerWidth: 1280 }),
    document: Object.assign(new EventTarget(), { hidden: false, documentElement: { dataset: {} }, querySelector: () => null, activeElement: null }),
    matchMedia: (query: string) => query === '(max-width: 1150px)' ? {
      get matches() { return searchWidth <= 1150; },
      addEventListener(_event: string, listener: () => void) { mediaListeners.add(listener); },
      removeEventListener(_event: string, listener: () => void) { mediaListeners.delete(listener); },
    } : { matches: false, addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: (key: string) => { if (failRead(key)) throw Error('Synthetic read refusal'); return storage.get(key) ?? null; }, setItem: (key: string, value: string) => { if (fail(key)) throw Error('Synthetic storage refusal'); storage.set(key, value); }, removeItem: (key: string) => storage.delete(key) },
    requestAnimationFrame: (run: () => void) => { run(); return 1; },
    fetch: async (path: string, init: RequestInit) => { calls.push({ path, init }); return new Response(JSON.stringify(await respond(path, init))); },
  };
  const originals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  function mount(component: (props: any) => any, initial: any, bindRefs?: (tree: any) => void) {
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
      async flush() { for (let pass = 0; pass < 24; pass++) { if (dirty && !closed) { dirty = false; cursor = 0; (globalThis as any)[symbol] = hooks; tree = component(props); bindRefs?.(tree); while (effects.length) effects.shift()!(); } for (let tick = 0; tick < 10; tick++) await Promise.resolve(); } },
      async update(next: any) { props = { ...props, ...next }; dirty = true; await owner.flush(); },
      find(predicate: (node: any) => boolean) { const found = nodes(tree).find(predicate); assert.ok(found, 'Expected rendered control'); return found; },
      button(label: string) { return owner.find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node).trim() === label)); },
      close() { closed = true; for (const cell of cells) cell?.cleanup?.(); },
    };
    owners.push(owner); return owner;
  }
  return { storage, calls, mount, resize(width: number) { searchWidth = width; for (const listener of mediaListeners) listener(); }, refuse: (check: typeof fail) => { fail = check; }, refuseRead: (check: typeof failRead) => { failRead = check; }, close() { owners.reverse().forEach(owner => owner.close()); for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); Reflect.deleteProperty(globalThis, symbol); } };
}
const appProps = (data = snapshot()) => ({ snapshot: data, online: true, refresh: async () => {}, reconnect: async () => {}, dismissFrontendUpdate() {} });
// Commit actual component refs to small focus/scroll hosts. These exercise the
// component effects and retained controller, not browser layout or CSS geometry.
function searchHosts() {
  const hosts = new Map<string, any>();
  let oldRefs: any[] = [];
  const host = (key: string) => {
    if (!hosts.has(key)) {
      const value = { key, scrollTop: 0, focusOptions: undefined as unknown,
        focus(options?: unknown) { value.focusOptions = options; (document as any).activeElement = value; },
        scrollTo({ top }: { top: number }) { value.scrollTop = top; } };
      hosts.set(key, value);
    }
    return hosts.get(key);
  };
  const bind = (tree: any) => {
    for (const ref of oldRefs) if (typeof ref === 'function') ref(null); else ref.current = null;
    oldRefs = [];
    for (const node of nodes(tree)) {
      const ref = node.props.ref;
      if (!ref) continue;
      const key = node.props.className === 'global-search-result' ? `row:${node.key}`
        : node.props.className?.includes('global-search-back') ? 'back'
          : node.props['aria-label'] === 'Search saved work' ? 'input'
            : node.props['aria-label'] === 'Search results' ? 'list' : `control:${text(node)}`;
      oldRefs.push(ref);
      if (typeof ref === 'function') ref(host(key)); else ref.current = host(key);
    }
  };
  return { host, bind };
}
const currentRoute = (app: ReturnType<ReturnType<typeof fixture>['mount']>) => app.find(node => node.props['data-route']).props['data-route'];
const searchElement = (app: ReturnType<ReturnType<typeof fixture>['mount']>) => app.find(node => node.type === SearchWorkspace);
async function select(app: ReturnType<ReturnType<typeof fixture>['mount']>, target: SearchTarget) {
  searchElement(app).props.search.update({ selected: target, detail: true }); await app.flush();
}
// App now defers GeneralSettings. Keep its real App callbacks when mounting the
// actual module, without assuming the lazy element equals the eager export.
const generalElement = (node: any) => nodes(node.props.general).find(child =>
  typeof child.props.saveShared === 'function' && typeof child.props.onDraftState === 'function' && child.props.currentLayout);
async function settingsSearch(f: ReturnType<typeof fixture>) {
  const app = f.mount(Workspace, appProps()); await app.flush(); app.button('Settings').props.onClick(); await app.flush();
  const settings = app.find(generalElement);
  const general = f.mount(GeneralSettings, generalElement(settings).props); await general.flush();
  general.find(node => node.props['aria-label'] === 'Color Theme').props.onChange({ target: { value: 'dark' } }); await general.flush(); await app.flush();
  app.button('Search saved work').props.onClick(); await app.flush();
  return { app, general };
}

test('actual Settings departure remains visible, then retries the exact complete Contact action', async () => {
  const f = fixture();
  try {
    const { app, general } = await settingsSearch(f), target: SearchTarget = { kind: 'contact', id: 'contact:first', revision: 2 };
    await select(app, target); searchElement(app).props.open(target); await app.flush(); await general.flush();
    assert.equal(currentRoute(app), 'settings'); assert.equal(nodes(app.tree).some(node => node.type === SearchWorkspace), false);
    const settings = app.find(generalElement);
    assert.equal(nodes(app.tree).find(node => node.props.className === 'global-search-origin' && nodes(node).includes(settings))?.props.hidden, false);
    assert.equal(general.find(node => node.type === Dialog).props.title, 'Unsaved Settings');
    assert.equal(f.storage.has(recordIndexKey(scope.deviceId, 'contact', scope.windowId)), false);
    general.button('Discard And Leave').props.onClick(); await general.flush(); await app.flush();
    assert.equal(currentRoute(app), 'contacts');
    assert.equal(JSON.parse(f.storage.get(recordIndexKey(scope.deviceId, 'contact', scope.windowId))!).selected, target.id);
    assert.ok(f.calls.every(call => call.init.method === 'GET'), 'No command, submit or provider operation');
  } finally { f.close(); }
});
test('an old Settings callback cannot open a superseded Search selection', async () => {
  const f = fixture();
  try {
    const { app, general } = await settingsSearch(f), first: SearchTarget = { kind: 'contact', id: 'contact:first', revision: 2 };
    await select(app, first); const search = searchElement(app).props.search;
    searchElement(app).props.open(first); await app.flush(); await general.flush();
    search.update({ selected: { ...first, id: 'contact:second' } });
    general.button('Discard And Leave').props.onClick(); await general.flush(); await app.flush();
    assert.equal(currentRoute(app), 'settings'); assert.equal(f.storage.has(recordIndexKey(scope.deviceId, 'contact', scope.windowId)), false);
  } finally { f.close(); }
});
test('deferred Settings query navigation does not substitute later Search writing', async () => {
  const f = fixture();
  try {
    const { app, general } = await settingsSearch(f), search = searchElement(app).props.search;
    search.update({ query: 'captured words' }); await app.flush();
    await searchElement(app).props.queryIn('assistant'); await app.flush(); await general.flush();
    search.update({ query: 'later words' });
    general.button('Discard And Leave').props.onClick(); await general.flush(); await app.flush();
    assert.equal(currentRoute(app), 'settings');
    assert.equal([...f.storage.keys()].some(key => key.startsWith('e3:search-query:')), false);
    assert.ok(f.calls.every(call => call.init.method === 'GET'));
  } finally { f.close(); }
});
test('target storage refusal keeps Search and its origin; mounted writer refusal never changes the target', async () => {
  const f = fixture(); let release: (() => void) | undefined;
  try {
    const app = f.mount(Workspace, appProps()); await app.flush(); app.button('Search saved work').props.onClick(); await app.flush();
    const target: SearchTarget = { kind: 'contact', id: 'contact:first', revision: 2 }; await select(app, target);
    const index = recordIndexKey(scope.deviceId, 'contact', scope.windowId); f.refuse(key => key === index);
    searchElement(app).props.open(target); await app.flush(); assert.equal(currentRoute(app), 'search'); assert.equal(f.storage.has(index), false);
    f.refuse(() => false); release = registerRecordDraftNavigation(() => false);
    searchElement(app).props.open(target); await app.flush(); assert.equal(currentRoute(app), 'home'); assert.equal(f.storage.has(index), false);
    assert.ok(f.calls.every(call => call.init.method === 'GET'));
  } finally { release?.(); f.close(); }
});
test('a restored Search does not mount an origin editor, and saved-draft opening is read only until explicit entry', async () => {
  const f = fixture();
  try {
    const nav = new SearchNavigation(scope, { read: key => f.storage.has(key) ? JSON.parse(f.storage.get(key)!) : undefined, write: (key, value) => { f.storage.set(key, JSON.stringify(value)); return true; } });
    nav.begin({ route: 'assistant', label: 'Assistant' });
    const app = f.mount(Workspace, appProps()); await app.flush();
    assert.equal(currentRoute(app), 'search'); assert.equal(nodes(app.tree).some(node => node.props.legacyJournal), false);
    const target: SearchTarget = { kind: 'draft', id: 'draft:saved', revision: 2 }; await select(app, target); searchElement(app).props.open(target); await app.flush();
    assert.equal(currentRoute(app), 'assistant'); assert.equal(nodes(app.tree).some(node => node.props.legacyJournal), false);
    assert.equal(app.find(node => node.type === SavedDraftArticle).props.draft.value.text, 'Exact host writing');
    assert.ok(f.calls.every(call => call.init.method === 'GET'));
    app.button('Open Assistant Workspace').props.onClick(); await app.flush();
    assert.equal(nodes(app.tree).filter(node => node.props.legacyJournal).length, 1);
  } finally { f.close(); }
});
test('literal malformed and read-failed target storage is preserved before any selection or route change', async () => {
  const f = fixture();
  try {
    const app = f.mount(Workspace, appProps()); await app.flush(); app.button('Search saved work').props.onClick(); await app.flush();
    const target: SearchTarget = { kind: 'contact', id: 'contact:first', revision: 2 }, key = recordIndexKey(scope.deviceId, 'contact', scope.windowId);
    await select(app, target); f.storage.set(key, '{malformed original draft ids');
    searchElement(app).props.open(target); await app.flush(); assert.equal(currentRoute(app), 'search'); assert.equal(f.storage.get(key), '{malformed original draft ids');
    f.storage.set(key, JSON.stringify({ selected: 'contact:prior', drafts: ['contact:unsaved'] })); const original = f.storage.get(key);
    f.refuseRead(value => value === key); searchElement(app).props.open(target); await app.flush();
    assert.equal(currentRoute(app), 'search'); assert.equal(f.storage.get(key), original);
    assert.ok(f.calls.every(call => call.init.method === 'GET'));
  } finally { f.close(); }
});
test('failed Search close never publishes a prepared restoration to the still-mounted original', async () => {
  const f = fixture();
  try {
    const index = recordIndexKey(scope.deviceId, 'contact', scope.windowId);
    f.storage.set(index, JSON.stringify({ selected: 'contact:first', drafts: ['contact:unsaved'], editing: true }));
    const app = f.mount(Workspace, appProps()); await app.flush(); app.button('Contacts').props.onClick(); await app.flush();
    app.button('Search saved work').props.onClick(); await app.flush();
    const target: SearchTarget = { kind: 'contact', id: 'contact:second', revision: 2 }; await select(app, target);
    searchElement(app).props.open(target); await app.flush(); app.button('Back To Search').props.onClick(); await app.flush();
    const destination = app.find(node => node.props.target?.id === 'contact:second').props.target;
    f.refuse(key => key === searchKey(scope));
    searchElement(app).props.close(); await app.flush();
    assert.equal(currentRoute(app), 'search'); assert.equal(searchElement(app).props.search.view.open, true);
    assert.equal(app.find(node => node.props.target?.id === 'contact:second').props.target, destination);
    assert.equal(JSON.parse(f.storage.get(index)!).selected, 'contact:first', 'Prepared view metadata is retained without activating an editor');
    assert.ok(f.calls.every(call => call.init.method === 'GET'));
  } finally { f.close(); }
});
test('parsed malformed Library views preserve their original bytes with no navigation write or destination mount', async () => {
  const state = { epoch: scope.epoch, collections: [], items: [{ kind: 'note', id: 'note:saved', revision: 1, title: 'Saved Note', body: 'Exact text', archived: false, updatedAt: '2026-10-19T00:00:00.000Z' }], resources: [], ideaPreferences: { revision: 0, saved: [], hidden: [] } };
  for (const view of [
    { ...defaultLibraryView(), query: 42 },
    { ...defaultLibraryView(), selection: { collectionId: 'collection:kept', references: 'original invalid selection' } },
    { ...defaultLibraryView(), selection: { collectionId: 'collection:kept', references: [{ kind: 'note', id: 'note:original', revision: 'one' }] } },
  ]) {
    const f = fixture(() => state);
    try {
      const app = f.mount(Workspace, appProps()); await app.flush(); app.button('Search saved work').props.onClick(); await app.flush();
      const target: SearchTarget = { kind: 'note', id: 'note:saved', revision: 1 }; await select(app, target);
      const key = libraryViewKey(scope), raw = JSON.stringify(view); f.storage.set(key, raw);
      const before = new Map(f.storage);
      searchElement(app).props.open(target); await app.flush();
      assert.equal(currentRoute(app), 'search'); assert.deepEqual(f.storage, before);
      assert.equal(nodes(app.tree).some(node => node.props.libraryTarget), false);
      assert.ok(f.calls.every(call => call.init.method === 'GET'));
    } finally { f.close(); }
  }
});
test('unreadable or malformed target journals never mount a destination or replace its original writing', async () => {
  const cases = ['{original unreadable writing', JSON.stringify({ dirty: false }), JSON.stringify({ value: {}, revision: 2, epoch: scope.epoch, dirty: true })];
  for (const raw of [...cases, 'read refusal']) {
    const f = fixture();
    try {
      const app = f.mount(Workspace, appProps()); await app.flush(); app.button('Search saved work').props.onClick(); await app.flush();
      const target: SearchTarget = { kind: 'contact', id: 'contact:first', revision: 2 }; await select(app, target);
      const key = `e3:journal:${scope.deviceId}:${target.id}:${scope.windowId}`;
      f.storage.set(key, raw); if (raw === 'read refusal') f.refuseRead(value => value === key);
      const before = new Map(f.storage);
      searchElement(app).props.open(target); await app.flush();
      assert.equal(currentRoute(app), 'search'); assert.deepEqual(f.storage, before);
      assert.equal(nodes(app.tree).some(node => node.type === Contacts), false);
      assert.ok(f.calls.every(call => call.init.method === 'GET'));
    } finally { f.close(); }
  }
});
test('unreadable original Library or Search navigation is not replaced by opening Search', async () => {
  for (const key of [`e3:home-library-view:${scope.deviceId}:${scope.epoch}`, searchKey(scope)]) {
    const f = fixture();
    try {
      f.storage.set(key, '{original unavailable');
      const app = f.mount(Workspace, appProps()); await app.flush(); app.button('Search saved work').props.onClick(); await app.flush();
      assert.equal(currentRoute(app), 'home'); assert.equal(f.storage.get(key), '{original unavailable');
      assert.match(text(app.tree), /could not be read/); assert.deepEqual(f.calls, []);
    } finally { f.close(); }
  }
});
test('Library failure is partial and retry reads only Library; an unmounted response cannot replace a later owner', async () => {
  let release!: (value: unknown) => void, calls = 0;
  const f = fixture(() => { calls++; return calls === 1 ? new Promise(resolve => { release = resolve; }) : { epoch: scope.epoch, items: [], collections: [], resources: [], ideaPreferences: { revision: 0, saved: [], hidden: [] } }; });
  try {
    const owner = f.mount(({ data }) => useGlobalSearch(data), { data: snapshot() }); await owner.flush();
    owner.tree.begin({ route: 'home', label: 'Home' }); await owner.flush();
    assert.equal(owner.tree.rows.length, 3); owner.close();
    const current = f.mount(({ data }) => useGlobalSearch(data), { data: snapshot() }); await current.flush();
    release({ epoch: 'wrong-workspace', items: [], collections: [] }); await current.flush();
    assert.equal(current.tree.libraryStatus, 'ready'); assert.equal(current.tree.library.epoch, scope.epoch);
    assert.ok(f.calls.every(call => call.path === '/api/home/library' && call.init.method === 'GET'));
  } finally { f.close(); }
});
test('a failed Library read preserves complete saved results and a separate retry can recover', async () => {
  let fail = true;
  const f = fixture(() => { if (fail) throw Error('Synthetic Library unavailable'); return { epoch: scope.epoch, items: [], collections: [], resources: [], ideaPreferences: { revision: 0, saved: [], hidden: [] } }; });
  try {
    const owner = f.mount(({ data }) => useGlobalSearch(data), { data: snapshot() }); await owner.flush();
    owner.tree.begin({ route: 'home', label: 'Home' }); await owner.flush();
    assert.equal(owner.tree.libraryStatus, 'error'); assert.equal(owner.tree.rows.length, 3);
    fail = false; owner.tree.retryLibrary(); await owner.flush();
    assert.equal(owner.tree.libraryStatus, 'ready'); assert.equal(owner.tree.rows.length, 3);
    assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.path === '/api/home/library' && call.init.method === 'GET'));
  } finally { f.close(); }
});
test('actual Search batches beyond the hundredth result and retains selection, scroll and filters on return', async () => {
  const f = fixture(), data = snapshot();
  data.tasks = Array.from({ length: 132 }, (_, i) => ({ id: `task:${i}`, revision: 1, deviceId: scope.deviceId, updatedAt: '', value: { title: `Launch ${i}`, notes: 'Full result', status: 'open', planned: '', due: '', timezone: 'UTC' } }));
  try {
    const owner = f.mount(({ data }) => useGlobalSearch(data), { data }); await owner.flush(); owner.tree.begin({ route: 'tasks', label: 'Tasks' }); await owner.flush();
    const ui = f.mount(SearchWorkspace, { search: owner.tree, snapshot: data, open() {}, close() {}, queryIn() {} }); await ui.flush();
    ui.find(node => node.props['aria-label'] === 'Search saved work').props.onChange({ target: { value: 'Launch' } }); await owner.flush(); await ui.update({ search: owner.tree });
    for (let i = 0; i < 6; i++) { ui.find(node => node.props.className === 'global-search-more').props.onClick(); await owner.flush(); await ui.update({ search: owner.tree }); }
    const rows = nodes(ui.tree).filter(node => node.props.className === 'global-search-result'); assert.equal(rows.length, 132);
    const row = rows.find(node => text(node).includes('Launch 100'))!; assert.ok(row); row.props.onClick();
    ui.find(node => node.props['aria-label'] === 'Search results').props.onScroll({ currentTarget: { scrollTop: 871 } }); await owner.flush();
    assert.equal(owner.tree.view.selected.id, 'task:100'); assert.equal(owner.tree.view.scroll, 871); assert.equal(owner.tree.view.batch, 140);
    const preserved = JSON.parse(f.storage.get(searchKey(scope))!);
    owner.close(); const reopened = f.mount(({ data }) => useGlobalSearch(data), { data }); await reopened.flush();
    assert.deepEqual(reopened.tree.view, preserved); assert.equal(reopened.tree.view.query, 'Launch');
  } finally { f.close(); }
});

for (const width of [960, 390]) test(`Search preview and Back/Escape retain the exact result and writing at ${width}px`, async () => {
  const f = fixture(), data = snapshot(), dom = searchHosts();
  try {
    f.resize(width);
    f.storage.set('unrelated-writing', 'Exact unfinished writing 雪');
    const owner = f.mount(({ data }) => useGlobalSearch(data), { data }); await owner.flush();
    owner.tree.begin({ route: 'content', label: 'Content' }); await owner.flush();
    owner.tree.update({ query: 'Person', filters: { type: 'contact', project: 'all', status: 'active', sort: 'recent' }, batch: 40, scroll: 437 }); await owner.flush();
    const ui = f.mount(SearchWorkspace, { search: owner.tree, snapshot: data, open() {}, close() {}, queryIn() {} }, dom.bind); await ui.flush();
    assert.equal(document.activeElement, dom.host('input'));
    const result = ui.find(node => node.props.className === 'global-search-result' && text(node).includes('Second Person'));
    const resultHost = dom.host(`row:${result.key}`);
    resultHost.focus(); result.props.onClick(); await owner.flush(); await ui.update({ search: owner.tree });
    assert.equal(document.activeElement, dom.host('back'));
    const kept = structuredClone(owner.tree.view);
    dom.host('list').scrollTop = 0;
    ui.find(node => node.props['aria-label'] === 'Search results').props.onScroll({ currentTarget: dom.host('list') }); await owner.flush();
    assert.equal(owner.tree.view.scroll, 437, 'Hiding results must not erase their scroll position');
    ui.button('Back To Results').props.onClick(); await owner.flush(); await ui.update({ search: owner.tree });
    assert.equal(document.activeElement, resultHost);
    assert.deepEqual(resultHost.focusOptions, { preventScroll: true });
    assert.equal(dom.host('list').scrollTop, 437);
    assert.deepEqual(owner.tree.view, { ...kept, detail: false });
    ui.find(node => node.key === result.key).props.onClick(); await owner.flush(); await ui.update({ search: owner.tree });
    let prevented = false;
    ui.tree.props.onKeyDown({ key: 'Escape', defaultPrevented: false, nativeEvent: { isComposing: false }, preventDefault() { prevented = true; } });
    await owner.flush(); await ui.update({ search: owner.tree });
    assert.equal(prevented, true); assert.equal(document.activeElement, resultHost);
    assert.deepEqual(owner.tree.view, { ...kept, detail: false });
    assert.equal(f.storage.get('unrelated-writing'), 'Exact unfinished writing 雪');
    assert.ok(f.calls.every(call => call.init.method === 'GET'));
  } finally { f.close(); }
});

test('Search keeps desktop result focus and moves it when the preview becomes focused at the width boundary', async () => {
  const f = fixture(), data = snapshot(), dom = searchHosts();
  try {
    f.resize(1920);
    const owner = f.mount(({ data }) => useGlobalSearch(data), { data }); await owner.flush(); owner.tree.begin({ route: 'home', label: 'Home' }); await owner.flush();
    const ui = f.mount(SearchWorkspace, { search: owner.tree, snapshot: data, open() {}, close() {}, queryIn() {} }, dom.bind); await ui.flush();
    const result = ui.find(node => node.props.className === 'global-search-result'), resultHost = dom.host(`row:${result.key}`);
    resultHost.focus(); result.props.onClick(); await owner.flush(); await ui.update({ search: owner.tree });
    assert.equal(document.activeElement, resultHost, 'Split preview does not steal focus from the results');
    f.resize(960); await ui.flush(); assert.equal(document.activeElement, dom.host('back'));
    f.resize(1920); await ui.flush(); assert.equal(document.activeElement, resultHost, 'The hidden narrow Back control cannot keep focus');
  } finally { f.close(); }
});

test('Search retains focus on refusal and falls back to the query when the original result disappears', async () => {
  const f = fixture(), data = snapshot(), dom = searchHosts();
  try {
    f.resize(390);
    const owner = f.mount(({ data }) => useGlobalSearch(data), { data }); await owner.flush(); owner.tree.begin({ route: 'home', label: 'Home' }); await owner.flush();
    const ui = f.mount(SearchWorkspace, { search: owner.tree, snapshot: data, open() {}, close() {}, queryIn() {} }, dom.bind); await ui.flush();
    const result = ui.find(node => node.props.className === 'global-search-result'), resultHost = dom.host(`row:${result.key}`);
    resultHost.focus(); f.refuse(key => key === searchKey(scope)); result.props.onClick(); await owner.flush(); await ui.update({ search: owner.tree });
    assert.equal(owner.tree.view.detail, false); assert.equal(document.activeElement, resultHost);
    f.refuse(() => false); ui.find(node => node.key === result.key).props.onClick(); await owner.flush(); await ui.update({ search: owner.tree });
    const selectedKey = owner.tree.view.selected.kind + ':' + owner.tree.view.selected.id;
    await ui.update({ search: { ...owner.tree, rows: owner.tree.rows.filter((row: any) => row.target.kind + ':' + row.target.id !== selectedKey) } });
    ui.button('Back To Results').props.onClick(); await owner.flush();
    await ui.update({ search: { ...owner.tree, rows: owner.tree.rows.filter((row: any) => row.target.kind + ':' + row.target.id !== selectedKey) } });
    assert.equal(document.activeElement, dom.host('input'));
    assert.equal(owner.tree.view.selected.kind + ':' + owner.tree.view.selected.id, selectedKey, 'Missing originals keep their exact saved reference');
  } finally { f.close(); }
});

test('a restored narrow Search preview starts on Back and returns to its retained selected result', async () => {
  const f = fixture(), data = snapshot(), dom = searchHosts();
  try {
    f.resize(960);
    const owner = f.mount(({ data }) => useGlobalSearch(data), { data }); await owner.flush(); owner.tree.begin({ route: 'home', label: 'Home' }); await owner.flush();
    owner.tree.update({ selected: { kind: 'contact', id: 'contact:second', revision: 2 }, detail: true, scroll: 82 }); await owner.flush();
    const ui = f.mount(SearchWorkspace, { search: owner.tree, snapshot: data, open() {}, close() {}, queryIn() {} }, dom.bind); await ui.flush();
    assert.equal(document.activeElement, dom.host('back'));
    ui.button('Back To Results').props.onClick(); await owner.flush(); await ui.update({ search: owner.tree });
    assert.equal(document.activeElement, dom.host('row:contact:contact:second')); assert.equal(dom.host('list').scrollTop, 82);
  } finally { f.close(); }
});
test('Conversation query handoff preserves current account/space and requires explicit message search', async () => {
  const f = fixture(), controller = { space: 'work', conversations: [], connection: { generation: 'current-account' }, select: () => assert.fail('Must not select a conversation') };
  try {
    const seed = { ...scope, token: 'search-token', nonce: 'first', query: 'retained words' };
    const panel = f.mount(ConversationSearch, { snapshot: snapshot(), controller, open: () => assert.fail('Must not navigate'), seed }); await panel.flush();
    assert.equal(panel.find(node => node.type === 'input').props.value, 'retained words'); assert.deepEqual(f.calls, []);
    panel.find(node => node.type === 'input').props.onChange({ target: { value: 'edited query' } }); await panel.flush();
    await panel.update({ seed: { ...seed } }); assert.equal(panel.find(node => node.type === 'input').props.value, 'edited query');
    await panel.update({ seed: { ...seed, nonce: 'next', epoch: 'other' } }); assert.equal(panel.find(node => node.type === 'input').props.value, 'edited query');
    assert.equal(controller.space, 'work'); assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});
test('an explicit Contact section change releases only the temporary Search view override', async () => {
  const f = fixture(), data = snapshot(), nonce = 'contact-target';
  try {
    const index = recordIndexKey(scope.deviceId, 'contact', scope.windowId);
    f.storage.set(index, JSON.stringify({ selected: 'contact:first', drafts: ['contact:unsaved'], seenTarget: nonce }));
    f.storage.set(index + ':view', JSON.stringify({ section: 'organizations', query: 'kept query' }));
    const app = f.mount(Contacts, { snapshot: data, refresh: async () => {}, editTask() {}, openEmail: async () => {}, openCalendar() {}, openSettings() {}, target: { kind: 'contact', id: 'contact:first', nonce, admitted: { ...scope, revision: 2 } } }); await app.flush();
    const menu = app.find(node => String(node.props.label).startsWith('Browse Contacts:'));
    assert.equal(menu.props.label, 'Browse Contacts: People');
    const choices = menu.props.children(() => {}), organization = nodes(choices).find(node => node.type === 'button' && text(node).trim() === 'Organizations')!;
    organization.props.onClick(); await app.flush();
    assert.equal(app.find(node => String(node.props.label).startsWith('Browse Contacts:')).props.label, 'Browse Contacts: Organizations');
    assert.deepEqual(JSON.parse(f.storage.get(index)!).drafts, ['contact:unsaved']); assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});
test('an explicit Agents view change is storage-first and releases the temporary Assignment target', async () => {
  const f = fixture(), data = snapshot(), nonce = 'assignment-target';
  data.records!.assignment = [{ id: 'assignment:one', revision: 2, updatedAt: '', deviceId: scope.deviceId, value: blankRecord('assignment', 'UTC') as any }];
  try {
    f.storage.set(recordIndexKey(scope.deviceId, 'assignment', scope.windowId), JSON.stringify({ selected: 'assignment:one', drafts: ['assignment:unsaved'], seenTarget: nonce }));
    const viewKey = `e3:agent-view:${scope.deviceId}:${scope.windowId}`; f.storage.set(viewKey, JSON.stringify({ view: 'skills' }));
    const app = f.mount(RecordsPage, { page: 'agents', snapshot: data, refresh: async () => {}, editTask() {}, outputs: [], openContent() {}, openSource() {}, target: { kind: 'assignment', id: 'assignment:one', nonce, admitted: { ...scope, revision: 2 } } }); await app.flush();
    assert.equal(app.find(node => node.type === AgentsWorkspaceNavigation).props.view, 'assignment');
    f.refuse(key => key === viewKey); app.find(node => node.type === AgentsWorkspaceNavigation).props.choose('team'); await app.flush();
    assert.equal(app.find(node => node.type === AgentsWorkspaceNavigation).props.view, 'assignment');
    f.refuse(() => false); app.find(node => node.type === AgentsWorkspaceNavigation).props.choose('team'); await app.flush();
    assert.equal(app.find(node => node.props.presentation).props.presentation, 'team');
    assert.equal(JSON.parse(f.storage.get(viewKey)!).view, 'agent'); assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});
test('the borrowed Home writing guard refuses Search without hiding the current writer or reading Library', async () => {
  const f = fixture(); let release: (() => void) | undefined;
  try {
    const app = f.mount(Workspace, appProps()); await app.flush(); release = registerHomeDraftNavigation(() => false);
    app.button('Search saved work').props.onClick(); await app.flush();
    assert.equal(currentRoute(app), 'home'); assert.equal(f.storage.has(searchKey(scope)), false); assert.deepEqual(f.calls, []);
    release(); release = undefined; app.button('Search saved work').props.onClick(); await app.flush(); assert.equal(currentRoute(app), 'search');
  } finally { release?.(); f.close(); }
});
test('Inbox admission preserves literal unreadable browser metadata, including a thrown storage read', () => {
  const f = fixture(), key = `e3:original-inbox:${scope.deviceId}:inbox-window:view`;
  try {
    const request = { ...scope, nonce: 'one', token: 'current-search', query: 'search', inboxWindowId: 'inbox-window' };
    const io = { read: readNavigationLocal, write: (key: string, value: unknown) => { localStorage.setItem(key, JSON.stringify(value)); return true; } };
    f.storage.set(key, '{malformed account view'); assert.match(admitInboxSearch(scope, request, io)!, /preserved/); assert.equal(f.storage.get(key), '{malformed account view');
    f.refuseRead(value => value === key); assert.match(admitInboxSearch(scope, request, io)!, /preserved/); assert.equal(f.storage.get(key), '{malformed account view');
  } finally { f.close(); }
});
test('the actual Library target previews exact saved text without capture, command or replacing kept item writing', async () => {
  const f = fixture(), data = snapshot(), item = { id: 'note:original', revision: 3, kind: 'note' as const, title: 'Exact saved note', body: 'Saved version three', archived: false, updatedAt: '2026-10-19T00:00:00Z' };
  const state = { epoch: scope.epoch, collections: [], items: [item], resources: [], ideaPreferences: { revision: 0, saved: [], hidden: [] }, organization: { revision: 0, collectionIds: [] } };
  const target = { ...scope, nonce: 'library-open', target: { kind: 'note' as const, id: item.id, revision: 3 } };
  try {
    const key = `e3:home-library-writer:${scope.deviceId}:${scope.epoch}:${scope.windowId}:item`;
    const original = JSON.stringify({ id: 'note:unfinished', revision: 0, value: { kind: 'note', title: 'Unfinished', body: 'Keep this writing separately', archived: false } });
    f.storage.set(key, original);
    assert.equal(admitLibraryTarget(scope, state, target, { read: readNavigationLocal, write: (key, value) => { f.storage.set(key, JSON.stringify(value)); return true; } }), undefined);
    const app = f.mount(HomeLibrary, { snapshot: data, controller: { state, busy: false, loading: false, run: () => assert.fail('No Library command'), load: () => assert.fail('No repeated read') }, libraryTarget: target, openWidgets() {} }); await app.flush();
    const detail = app.find(node => node.type === Dialog && node.props.title === item.title);
    assert.match(text(detail), /Saved version three/); assert.equal(f.storage.get(key), original); assert.deepEqual(f.calls, []);
    assert.equal(JSON.parse(f.storage.get(libraryViewKey(scope))!).searchNonce, target.nonce);
  } finally { f.close(); }
});


test('actual failed Team room writing refuses module and global Search departure, then succeeds after exact retention', async () => {
  const hubState = { observedAt: 1, runtimeReady: false, runtimeReason: 'Disconnected fixture', agents: [], roster: [], layout: { version: 1, revision: 1, rooms: [], placements: {}, previousPlacements: {} }, total: 0, nextCursor: null, activeAgentId: null };
  const f = fixture(path => path.includes('agents/hub') ? hubState : path.includes('agents/meetings') ? { current: null, history: [] } : { epoch: scope.epoch, items: [], collections: [], resources: [], ideaPreferences: { revision: 0, saved: [], hidden: [] } });
  try {
    const app = f.mount(Workspace, appProps()); await app.flush(); app.button('Agents').props.onClick(); await app.flush(); assert.equal(currentRoute(app), 'agents');
    const hub = f.mount(AgentHub, { snapshot: snapshot(), presentation: 'hub', setPresentation() {}, manage() {}, unfinished: [], openAgent() {}, assignWork() {}, openPlan() {}, openRoutine() {}, openContent() {}, editTask() {} }); await hub.flush();
    hub.button('Add Room').props.onClick(); await hub.flush();
    const key = `e3:hub:${scope.epoch}:${scope.deviceId}:${scope.windowId}:room-form`; f.refuse(value => value === key);
    hub.find(node => node.type === 'input' && node.props.value === 'Private office').props.onChange({ target: { value: 'Keep original room writing 雪' } }); await hub.flush();
    app.button('Search saved work').props.onClick(); await app.flush(); assert.equal(currentRoute(app), 'agents'); assert.equal(f.storage.has(searchKey(scope)), false);
    app.button('Home').props.onClick(); await app.flush(); assert.equal(currentRoute(app), 'agents');
    assert.ok(hub.find(node => node.type === 'input' && node.props.value === 'Keep original room writing 雪'));
    f.refuse(() => false); hub.button('Retry Keeping Writing').props.onClick(); await hub.flush();
    app.button('Home').props.onClick(); await app.flush(); assert.equal(currentRoute(app), 'home');
    app.button('Agents').props.onClick(); await app.flush(); app.button('Search saved work').props.onClick(); await app.flush(); assert.equal(currentRoute(app), 'search');
    assert.equal(JSON.parse(f.storage.get(key)!).name, 'Keep original room writing 雪'); assert.ok(f.calls.every(call => call.init.method === 'GET'));
  } finally { f.close(); }
});

test('Agents local views retain owners first, remember Headquarters and keep exact profile attempt identity', async () => {
  const f = fixture(), data = snapshot(); let release: (() => void) | undefined;
  try {
    const viewKey = `e3:agent-view:${scope.deviceId}:${scope.windowId}`; f.storage.set(viewKey, JSON.stringify({ view: 'hub' }));
    const page = f.mount(RecordsPage, { page: 'agents', snapshot: data, refresh: async () => {}, editTask() {}, outputs: [], openContent() {}, openSource() {} }); await page.flush();
    const choose = (value: string) => page.find(node => node.type === AgentsWorkspaceNavigation).props.choose(value);
    release = registerAgentDraftNavigation(`${scope.epoch}:${scope.deviceId}:${scope.windowId}`, () => false);
    assert.equal(choose('work'), false); await page.flush(); assert.equal(page.find(node => node.props.presentation).props.presentation, 'hub');
    release(); release = undefined; assert.equal(choose('work'), true); await page.flush(); assert.equal(choose('team'), true); await page.flush();
    let hub = page.find(node => node.props.presentation); assert.equal(hub.props.presentation, 'hub'); assert.equal(hub.key, `${scope.epoch}:${scope.deviceId}:${scope.windowId}`);
    hub.props.openAgent('agent:design'); await page.flush(); assert.equal(page.find(node => node.props.presentation).props.presentation, 'hub');
    page.find(node => node.type === Dialog).props.close(); await page.flush(); assert.equal(page.find(node => node.props.presentation).props.presentation, 'hub');
    hub = page.find(node => node.props.presentation);
    hub.props.openPlan('assignment:old', 'attempt:exact-old'); await page.flush();
    const index = JSON.parse(f.storage.get(recordIndexKey(scope.deviceId, 'assignment', scope.windowId))!);
    assert.equal(index.selected, 'assignment:old'); assert.deepEqual(index.attempt, { id: 'attempt:exact-old', epoch: scope.epoch });
    assert.equal(page.find(node => node.type === AgentsWorkspaceNavigation).props.view, 'assignment'); assert.deepEqual(f.calls, []);
    const stale = hub.props.openPlan; await page.update({ snapshot: { ...data, epoch: 'another-epoch' } }); const before = new Map(f.storage); stale('assignment:different', 'wrong'); await page.flush(); assert.deepEqual(f.storage, before);
  } finally { release?.(); f.close(); }
});

test('partial Assign navigation retries the same durable draft and refuses a changed destination', async () => {
  const f = fixture(), data = snapshot();
  data.records!.agent = [{ id: 'agent:one', revision: 3, updatedAt: '', deviceId: scope.deviceId, value: { ...blankRecord('agent', 'UTC'), name: 'One' } as any }];
  try {
    const page = f.mount(RecordsPage, { page: 'agents', snapshot: data, refresh: async () => {}, editTask() {}, outputs: [], openContent() {}, openSource() {} }); await page.flush();
    const viewKey = `e3:agent-view:${scope.deviceId}:${scope.windowId}`, indexKey = recordIndexKey(scope.deviceId, 'assignment', scope.windowId);
    f.refuse(key => key === viewKey); page.find(node => node.props.presentation).props.assignWork('agent:one'); await page.flush();
    const originalIndex = f.storage.get(indexKey)!; const selected = JSON.parse(originalIndex).selected;
    const journalKey = `e3:journal:${scope.deviceId}:${selected}:${scope.windowId}`, originalJournal = f.storage.get(journalKey)!;
    assert.equal(JSON.parse(originalJournal).value.agentRevision, 3); assert.equal(mayLeaveAgentDrafts(`${scope.epoch}:${scope.deviceId}:${scope.windowId}`), false);
    page.find(node => node.props.presentation).props.assignWork('agent:one'); await page.flush(); assert.equal([...f.storage.keys()].filter(key => key.startsWith('e3:journal:')).length, 1);
    f.refuse(() => false); f.storage.set(indexKey, JSON.stringify({ selected: 'assignment:other', drafts: [selected, 'assignment:other'] }));
    page.button('Retry Opening Kept Writing').props.onClick(); await page.flush(); assert.equal(page.find(node => node.props.presentation).props.presentation, 'team'); assert.equal(f.storage.get(journalKey), originalJournal);
    f.storage.set(indexKey, originalIndex); page.button('Retry Opening Kept Writing').props.onClick(); await page.flush();
    assert.equal(page.find(node => node.type === AgentsWorkspaceNavigation).props.view, 'assignment'); assert.equal(JSON.parse(f.storage.get(indexKey)!).selected, selected);
    assert.equal(f.storage.get(journalKey), originalJournal); assert.equal(mayLeaveAgentDrafts(`${scope.epoch}:${scope.deviceId}:${scope.windowId}`), true); assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});


test('Work query retention refuses local departure on storage failure and preserves malformed old preferences', async () => {
  for (const original of [undefined, '{original malformed preferences']) {
    const f = fixture();
    try {
      const viewKey = `e3:agent-view:${scope.deviceId}:${scope.windowId}`, key = recordIndexKey(scope.deviceId, 'assignment', scope.windowId) + ':view';
      f.storage.set(viewKey, JSON.stringify({ view: 'assignment', teamPresentation: 'hub' })); if (original) f.storage.set(key, original);
      const page = f.mount(RecordsPage, { page: 'agents', snapshot: snapshot(), refresh: async () => {}, editTask() {}, outputs: [], openContent() {}, openSource() {} }); await page.flush();
      const collection = page.find(node => typeof node.type === 'function' && node.props.kind === 'assignment');
      const work = f.mount(collection.type, collection.props); await work.flush();
      f.refuse(value => value === key); work.find(node => node.type === AgentWorkControls).props.changeQuery('Kept exact brief query 雪'); await work.flush();
      assert.equal(page.find(node => node.type === AgentsWorkspaceNavigation).props.choose('team'), false); await page.flush();
      assert.equal(page.find(node => node.type === AgentsWorkspaceNavigation).props.view, 'assignment'); assert.equal(work.find(node => node.type === AgentWorkControls).props.query, 'Kept exact brief query 雪');
      f.refuse(() => false); const changed = page.find(node => node.type === AgentsWorkspaceNavigation).props.choose('team'); await page.flush();
      if (original) { assert.equal(changed, false); assert.equal(f.storage.get(key), original); }
      else { assert.equal(changed, true); assert.equal(JSON.parse(f.storage.get(key)!).query, 'Kept exact brief query 雪'); assert.equal(page.find(node => node.props.presentation).props.presentation, 'hub'); }
      assert.deepEqual(f.calls, []);
    } finally { f.close(); }
  }
});


test('Agents linked-work callbacks retain the original owner before changing any offscreen destination', async () => {
  const f = fixture(), calls: unknown[][] = []; let release: (() => void) | undefined;
  try {
    const page = f.mount(RecordsPage, { page: 'agents', snapshot: snapshot(), refresh: async () => {}, editTask: (value: unknown) => calls.push(['task', value]), outputs: [], openContent: (id: string) => calls.push(['content', id]), openSource() {}, openWork: (id: string) => calls.push(['work', id]), openAssistantSettings: () => calls.push(['settings']) }); await page.flush();
    const hub = page.find(node => node.props.presentation), task = { id: 'task:original', revision: 4 };
    release = registerAgentDraftNavigation(`${scope.epoch}:${scope.deviceId}:${scope.windowId}`, () => false);
    hub.props.openWork('conversation:original'); hub.props.openContent('content:original'); hub.props.editTask(task); hub.props.openSettings(); await page.flush(); assert.deepEqual(calls, []);
    release(); release = undefined;
    hub.props.openWork('conversation:original'); hub.props.openContent('content:original'); hub.props.editTask(task); hub.props.openSettings();
    assert.deepEqual(calls, [['work', 'conversation:original'], ['content', 'content:original'], ['task', task], ['settings']]); assert.deepEqual(f.calls, []);
  } finally { release?.(); f.close(); }
});


test('an unreadable original Agents view admits no index or draft write', async () => {
  for (const readFailure of [false, true]) {
    const f = fixture();
    try {
      const key = `e3:agent-view:${scope.deviceId}:${scope.windowId}`; f.storage.set(key, readFailure ? JSON.stringify({ view: 'hub' }) : '{original view'); if (readFailure) f.refuseRead(value => value === key);
      const page = f.mount(RecordsPage, { page: 'agents', snapshot: snapshot(), refresh: async () => {}, editTask() {}, outputs: [], openContent() {}, openSource() {} }); await page.flush();
      const before = new Map(f.storage); page.find(node => node.props.presentation).props.openAgent(); await page.flush();
      assert.deepEqual(f.storage, before); assert.equal(nodes(page.tree).some(node => node.type === Dialog), false); assert.deepEqual(f.calls, []);
    } finally { f.close(); }
  }
});
