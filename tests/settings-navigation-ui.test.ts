import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { defaultLayout, type Snapshot } from '../packages/domain/contracts';

const key = Symbol.for('nova.test.settings-navigation');
const reactUrl = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
let activeStorage = { values: new Map<string, string>(), failWrite: false, failRemove: false };
const storage = {
  getItem: (name: string) => activeStorage.values.get(name) ?? null,
  setItem(name: string, value: string) { if (activeStorage.failWrite) throw Error('Full'); activeStorage.values.set(name, value); },
  removeItem(name: string) { if (activeStorage.failRemove) throw Error('Unavailable'); activeStorage.values.delete(name); },
};
const beforeStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && context.parentURL?.includes('/apps/client/src/')) return { url: 'nova-test:settings-navigation-react', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:settings-navigation-react') return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(reactUrl)};
      export const useState = value => globalThis[Symbol.for('nova.test.settings-navigation')].state(value);
      export const useRef = value => globalThis[Symbol.for('nova.test.settings-navigation')].ref(value);
      export const useEffect = (effect, deps) => globalThis[Symbol.for('nova.test.settings-navigation')].effect(effect, deps);
      export const useLayoutEffect = useEffect;
      export const useId = () => 'settings-fixture';
      export const useSyncExternalStore = (_subscribe, snapshot) => snapshot();
    ` };
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return next(url, context);
  },
});
const { SettingsPage, SettingsPanel } = await import('../apps/client/src/SettingsPage');
const { Connections } = await import('../apps/client/src/Connections');
const { GeneralSettings } = await import('../apps/client/src/GeneralSettings');
const { Dialog } = await import('../apps/client/src/ui');
const { mayLeaveSettingsDraft } = await import('../apps/client/src/settings-draft-navigation');
const { typographyStore, typographyStorageKey } = await import('../apps/client/src/typography');
const { retainedWindowId } = await import('../apps/client/src/useWorkspace');
hooks.deregister();
if (beforeStorage) Object.defineProperty(globalThis, 'localStorage', beforeStorage); else Reflect.deleteProperty(globalThis, 'localStorage');

const nodes = (tree: any): any[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree?.props ? [tree, ...nodes(tree.props.children)] : [];
const text = (tree: any): string => tree == null || typeof tree === 'boolean' ? '' : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : Array.isArray(tree) ? tree.map(text).join(' ') : text(tree.props?.children);
function snapshot(epoch = 'settings-fixture'): Snapshot {
  return { epoch, cursor: 0, deviceId: 'device', tasks: [], projects: [], drafts: [], capabilities: { assistant: false, voice: false, reason: 'Local fixture' }, layout: { id: 'layout', revision: 2, deviceId: 'device', updatedAt: '', value: { ...structuredClone(defaultLayout), theme: 'light', timezone: 'UTC' } } };
}
function host<P>(component: (props: P) => any, initial: P, respond: (path: string, init: RequestInit) => unknown | Promise<unknown> = () => ({})) {
  let props = initial, cursor = 0, dirty = true, closed = false, tree: any, timerId = 0;
  const cells: any[] = [], pending: (() => (() => void))[] = [], calls: { path: string; init: RequestInit }[] = [];
  const timers = new Map<number, () => void>();
  activeStorage = { values: new Map(), failWrite: false, failRemove: false };
  const stored = activeStorage;
  const document = Object.assign(new EventTarget(), { hidden: false, querySelector: () => null, documentElement: { dataset: {} } });
  const values: Record<PropertyKey, unknown> = {
    [key]: {
      state(value: any) { const i = cursor++; if (!cells[i]) cells[i] = { value: typeof value === 'function' ? value() : value }; return [cells[i].value, (next: any) => { const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true; } }]; },
      ref(value: any) { const i = cursor++; return cells[i] ??= { current: value }; },
      effect(run: () => void | (() => void), deps: unknown[]) { const i = cursor++, before = cells[i]; if (!before || deps.some((value, index) => !Object.is(value, before.deps[index]))) { cells[i] = { deps, cleanup: before?.cleanup }; pending.push(() => { cells[i].cleanup?.(); return () => { cells[i].cleanup = run(); }; }); } },
    }, document, window: new EventTarget(), localStorage: storage,
    setTimeout: (run: () => void) => { const id = ++timerId; timers.set(id, run); return id; }, clearTimeout: (id: number) => timers.delete(id),
    fetch: async (path: string, init: RequestInit) => { calls.push({ path, init }); const value = await respond(path, init); return new Response(JSON.stringify(value), { status: 200 }); },
  };
  const originals = Reflect.ownKeys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of Reflect.ownKeys(values)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  typographyStore.receiveStorageChange(typographyStorageKey);
  const flush = async () => { for (let pass = 0; pass < 24; pass++) { if (dirty) { dirty = false; cursor = 0; tree = component(props); const setup = pending.splice(0).map(cleanup => cleanup()); for (const run of setup) run(); } for (let tick = 0; tick < 10; tick++) await Promise.resolve(); } };
  return {
    calls, stored, get tree() { return tree; }, flush,
    async update(next: Partial<P>) { props = { ...props, ...next }; dirty = true; await flush(); },
    find(match: (node: any) => boolean) { const node = nodes(tree).find(match); assert.ok(node, 'Expected actual component control'); return node; },
    button(label: string) { return this.find(node => node.type === 'button' && text(node) === label); },
    close() { if (closed) return; closed = true; for (const cell of cells) cell?.cleanup?.(); for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } },
  };
}

test('Settings uses seven equal owner destinations and keeps restricted phone children out at any width', async () => {
  const selected: string[] = [], data = snapshot();
  const app = host(SettingsPage, { appIcon: 'red', selected: 'index', select: value => selected.push(value), snapshot: data, online: true, access: { surface: 'web', requiresPairing: false }, general: createElement('p', null, 'Retained General'), openAssistant() {} });
  try {
    await app.flush();
    const destinations = () => nodes(app.tree).filter(node => node.props.className === 'settings-destination');
    assert.equal(destinations().length, 7);
    destinations().find(node => text(node).trim().startsWith('Updates'))!.props.onClick(); assert.deepEqual(selected, ['updates']);
    assert.equal(nodes(app.tree).filter(node => node.type === SettingsPanel && node.props.eager).length, 1);
    assert.equal(nodes(app.tree).filter(node => node.props.section !== undefined).length, 1, 'One retained connection owner occupies a fixed position');
    await app.update({ selected: 'accounts' });
    const connectionKey = app.find(node => node.props.section === 'accounts').key;
    await app.update({ selected: 'assistant' }); assert.equal(app.find(node => node.props.section === 'assistant').key, connectionKey);
    await app.update({ selected: 'index' }); assert.equal(app.find(node => node.props.section === null).key, connectionKey);
    await app.update({ snapshot: { ...data, epoch: 'other' } }); assert.notEqual(app.find(node => node.props.section === null).key, connectionKey, 'Changed workspace retires the old secret owner');
    await app.update({ access: { surface: 'phone', requiresPairing: false }, selected: 'updates' });
    assert.equal(destinations().length, 2);
    assert.deepEqual(nodes(app.tree).filter(node => node.type === SettingsPanel).map(node => node.props.id), ['general', 'phone']);
    assert.equal(nodes(app.tree).filter(node => node.props.section !== undefined).length, 0);
    assert.equal(app.find(node => node.type === 'h1').props.children, 'Devices', 'Illegal section normalizes without mounting owner controls');
    assert.equal(nodes(app.tree).filter(node => node.type === SettingsPanel && node.props.id === 'phone').flatMap(node => nodes(node.props.children)).filter(node => node.props.identity === 'other:device').length, 1, 'Paired phone retains read-only About in Devices');
  } finally { app.close(); }
});

test('visited sections retain the exact child through hiding and eager Appearance exists before visiting', async () => {
  const child = createElement('input', { defaultValue: 'Secret in the original child' });
  const app = host(SettingsPanel, { id: 'accounts', active: false, children: child });
  try {
    await app.flush(); assert.equal(nodes(app.tree).some(node => node === child), false);
    await app.update({ active: true }); assert.ok(nodes(app.tree).includes(child));
    await app.update({ active: false }); assert.ok(nodes(app.tree).includes(child)); assert.equal(app.tree.props.inert, true);
    await app.update({ active: true }); assert.ok(nodes(app.tree).includes(child)); assert.equal(app.tree.props.inert, false);
  } finally { app.close(); }
  const general = host(SettingsPanel, { id: 'general', active: false, eager: true, children: child });
  try { await general.flush(); assert.ok(nodes(general.tree).includes(child)); } finally { general.close(); }
});

function generalFixture(saveShared: Parameters<typeof GeneralSettings>[0]['saveShared']) {
  const data = snapshot(), reveals: string[] = [], summaries: unknown[] = [];
  const props: Parameters<typeof GeneralSettings>[0] = { currentLayout: data.layout.value, appIcon: 'red', snapshot: data, online: true, saveShared, reveal: () => reveals.push('appearance'), onDraftState: value => summaries.push(value) };
  return { app: host(GeneralSettings, props), data, reveals, summaries };
}

test('hidden Appearance reveals its original leave dialog; Keep and failed Save do not resume the route', async () => {
  let saves = 0, resumes = 0;
  const { app, reveals } = generalFixture(async () => { saves++; return false; });
  try {
    await app.flush(); app.find(node => node.props['aria-label'] === 'Color Theme').props.onChange({ target: { value: 'dark' } }); await app.flush();
    assert.equal(mayLeaveSettingsDraft(() => resumes++), false); assert.deepEqual(reveals, ['appearance']);
    await app.flush(); assert.equal(app.find(node => node.type === Dialog).props.title, 'Unsaved Settings');
    app.button('Keep Editing').props.onClick(); await app.flush(); assert.equal(resumes, 0);
    assert.equal(mayLeaveSettingsDraft(() => resumes++), false); await app.flush();
    app.button('Save And Leave').props.onClick(); await app.flush();
    assert.equal(saves, 1); assert.equal(resumes, 0); assert.equal(app.find(node => node.props['aria-label'] === 'Color Theme').props.value, 'dark');
    assert.match(text(app.tree), /not confirmed/);
  } finally { app.close(); }
});

test('successful deferred Save resumes the exact route once after confirmation, including repeated clicks', async () => {
  let confirm!: (saved: boolean) => void, resumes = 0, saves = 0;
  const { app, data } = generalFixture(() => { saves++; return new Promise(resolve => { confirm = resolve; }); });
  try {
    await app.flush(); app.find(node => node.props['aria-label'] === 'Color Theme').props.onChange({ target: { value: 'dark' } }); await app.flush();
    assert.equal(mayLeaveSettingsDraft(() => resumes++), false); await app.flush();
    const save = app.button('Save And Leave').props.onClick; save(); save(); await app.flush(); assert.equal(resumes, 0); assert.equal(saves, 1);
    await app.update({ snapshot: { ...data, layout: { ...data.layout, revision: 3, value: { ...data.layout.value, theme: 'dark' } } } });
    confirm(true); await app.flush(); assert.equal(resumes, 1); assert.equal(mayLeaveSettingsDraft(), true);
  } finally { app.close(); }
});

test('failed browser retention keeps in-memory Appearance edits; failed Discard preserves the original return', async () => {
  let resumes = 0;
  const { app, summaries } = generalFixture(async () => assert.fail('Storage refusal must precede a shared save'));
  try {
    await app.flush(); app.stored.failWrite = true;
    app.find(node => node.props['aria-label'] === 'Color Theme').props.onChange({ target: { value: 'dark' } }); await app.flush();
    assert.equal((summaries.at(-1) as any).retentionFailed, true);
    assert.equal(mayLeaveSettingsDraft(() => resumes++), false); await app.flush(); app.button('Save And Leave').props.onClick(); await app.flush(); assert.equal(resumes, 0);
    app.stored.failRemove = true; app.button('Discard And Leave').props.onClick(); await app.flush(); assert.equal(resumes, 0);
    assert.equal(app.find(node => node.props['aria-label'] === 'Color Theme').props.value, 'dark');
    app.stored.failRemove = false; app.button('Discard And Leave').props.onClick(); await app.flush(); assert.equal(resumes, 1);
  } finally { app.close(); }
});

test('Navigation reset requires its own review and retains unrelated appearance writing', async () => {
  let resets = 0;
  const { app } = generalFixture(async () => true);
  try {
    await app.update({ resetNavigation: () => resets++ });
    app.find(node => node.props['aria-label'] === 'Color Theme').props.onChange({ target: { value: 'dark' } }); await app.flush();
    app.button('Reset Navigation').props.onClick(); await app.flush(); assert.equal(resets, 0);
    app.button('Keep Current Order').props.onClick(); await app.flush(); assert.equal(resets, 0);
    app.button('Reset Navigation').props.onClick(); await app.flush();
    const dialog = app.find(node => node.type === Dialog && node.props.title === 'Reset Navigation Order?');
    nodes(dialog).find(node => node.type === 'button' && text(node) === 'Reset Navigation')!.props.onClick(); await app.flush();
    assert.equal(resets, 1); assert.equal(app.find(node => node.props['aria-label'] === 'Color Theme').props.value, 'dark');
  } finally { app.close(); }
});

const runtime = { state: 'running', canSignIn: true };
const assistant = { connection: { state: 'ready', generation: 1, url: 'wss://fixture', modelAuthReady: false } };
const reading = (path: string) => path.endsWith('/runtime') ? runtime : path.endsWith('/state') ? assistant : path.endsWith('/account') ? { state: 'available', accounts: [], emails: [], profileCount: 0 } : path.endsWith('/sign-in') ? { state: 'idle' } : { state: 'unconfigured', message: 'Synthetic voice unavailable' };

test('one Connections owner retains a gateway secret and exact sign-in through Accounts, Setup and index', async () => {
  let confirm!: (value: unknown) => void;
  const app = host(Connections, { snapshot: snapshot(), online: true, openAssistant() {}, section: 'assistant', remoteHost: true }, (path, init) => init.method === 'POST' ? new Promise(resolve => { confirm = resolve; }) : reading(path));
  try {
    await app.flush(); app.find(node => node.type === 'input' && node.props.type === 'password').props.onChange({ target: { value: 'synthetic-secret' } }); await app.flush();
    await app.update({ section: 'accounts' }); app.button('Sign in to ChatGPT').props.onClick(); await app.flush();
    const action = app.calls.find(call => call.init.method === 'POST')!, original = JSON.parse(action.init.body as string);
    assert.equal(action.path, '/api/assistant/sign-in/start'); assert.equal(original.epoch, 'settings-fixture');
    assert.equal(JSON.parse(app.stored.values.get('e3:chatgpt-signin-request:settings-fixture')!).requestId, original.requestId);
    const reads = app.calls.length;
    await app.update({ section: null }); await app.update({ section: 'assistant' }); await app.update({ section: 'accounts' });
    assert.equal(app.calls.length, reads, 'Changing the view neither recreates readers nor resends the request');
    assert.equal(app.find(node => node.type === 'input' && node.props.type === 'password').props.value, 'synthetic-secret');
    assert.ok([...app.stored.values.values()].every(value => !value.includes('synthetic-secret')));
    confirm({ id: 'original-attempt', state: 'waiting', method: 'device-code', userCode: 'SYNTHETIC', verificationUrl: 'https://example.invalid', message: 'Complete original request' }); await app.flush();
    assert.equal(app.calls.filter(call => call.init.method === 'POST').length, 1); assert.equal(app.stored.values.has('e3:chatgpt-signin-request:settings-fixture'), false);
  } finally { app.close(); }
});

test('an exact pending account intent is resumed without replacing its method or original request ID', async () => {
  const app = host(Connections, { snapshot: snapshot(), online: true, openAssistant() {}, section: 'accounts', remoteHost: true }, (path, init) => init.method === 'POST' ? { id: 'old-attempt', state: 'waiting', message: 'Original resumed' } : reading(path));
  try {
    const intent = { requestId: 'original-request', epoch: 'settings-fixture', method: 'browser', intent: 'reconnect', profileId: 'original-profile' };
    app.stored.values.set('e3:chatgpt-signin-request:settings-fixture', JSON.stringify(intent));
    await app.flush(); app.button('Resume Sign-In').props.onClick(); await app.flush();
    assert.deepEqual(JSON.parse(app.calls.find(call => call.init.method === 'POST')!.init.body as string), intent);
  } finally { app.close(); }
});

test('retained General journal is discovered before Appearance is visited and old epoch cannot resume after replacement', async () => {
  let resumes = 0;
  const { app, data } = generalFixture(async () => true);
  try {
    const values = { theme: 'light', appIcon: data.layout.value.appIcon, timezone: 'UTC', interfaceFont: 'system', interfaceTextSize: 'standard', messageFont: 'system', messageTextSize: 'standard' };
    app.stored.values.set(`e3:general-settings:${data.epoch}:${data.deviceId}:${retainedWindowId}`, JSON.stringify({ version: 1, epoch: data.epoch, base: values, value: { ...values, theme: 'dark' } }));
    await app.flush(); assert.equal(app.find(node => node.props['aria-label'] === 'Color Theme').props.value, 'dark');
    assert.equal(mayLeaveSettingsDraft(() => resumes++), false); await app.flush();
    await app.update({ snapshot: snapshot('new-epoch') });
    assert.equal(nodes(app.tree).filter(node => node.type === Dialog).length, 0); assert.equal(resumes, 0);
  } finally { app.close(); }
});


test('the original native Dialog opens only after its retained Appearance ancestor is made active', async () => {
  const data = snapshot(), sequence: string[] = [];
  let section = 'accounts';
  const view = () => SettingsPanel({ id: 'general', active: section === 'general', eager: true, children: GeneralSettings({
    snapshot: data, currentLayout: data.layout.value, appIcon: 'red', online: true, async saveShared() { return false; },
    reveal() { section = 'general'; sequence.push('reveal'); },
  }) });
  const app = host(view, {});
  try {
    await app.flush(); app.find(node => node.props['aria-label'] === 'Color Theme').props.onChange({ target: { value: 'dark' } }); await app.flush();
    assert.equal(app.tree.props.inert, true); assert.equal(mayLeaveSettingsDraft(() => assert.fail('No confirmed departure')), false);
    await app.flush(); assert.equal(app.tree.props.inert, false); assert.equal(app.tree.props.hidden, false);
    const original = app.find(node => node.type === Dialog);
    // Run the actual Dialog component and its showModal effect in the next committed host.
    app.close();
    const native = { showModal() { sequence.push('showModal'); }, querySelector() { return null; } };
    const opening = host(() => { const tree = Dialog(original.props); tree.props.ref.current = native; return tree; }, {});
    try { await opening.flush(); assert.deepEqual(sequence, ['reveal', 'showModal']); } finally { opening.close(); }
  } finally { app.close(); }
});

test('retired Connections callbacks cannot adopt a late sign-in into the replacement secret owner', async () => {
  let confirm!: (value: unknown) => void;
  const old = host(Connections, { snapshot: snapshot(), online: true, openAssistant() {}, section: 'accounts', remoteHost: true }, (path, init) => init.method === 'POST' ? new Promise(resolve => { confirm = resolve; }) : reading(path));
  await old.flush(); old.button('Sign in to ChatGPT').props.onClick(); await old.flush(); old.close();
  const next = host(Connections, { snapshot: snapshot('new-workspace'), online: true, openAssistant() {}, section: 'assistant', remoteHost: true }, reading);
  try {
    await next.flush(); const before = next.calls.length;
    confirm({ id: 'old-attempt', state: 'waiting', userCode: 'OLD-CODE', message: 'Old response' }); await next.flush();
    assert.equal(next.calls.length, before); assert.doesNotMatch(text(next.tree), /OLD-CODE|Old response/);
    assert.equal(next.find(node => node.type === 'input' && node.props.type === 'password').props.value, '');
    assert.equal(next.calls.some(call => call.init.method === 'POST'), false);
  } finally { next.close(); }
});


test('Settings entry and section transitions focus the current context and restore section scroll', async () => {
  const focused: string[] = [], scroller = { scrollTop: 0 };
  const view = (props: Parameters<typeof SettingsPage>[0]) => {
    const tree = SettingsPage(props);
    tree.props.ref.current = scroller;
    for (const node of nodes(tree)) {
      if (node.type === 'h1') node.props.ref.current = { focus() { focused.push(text(node)); } };
      if (node.props.className === 'settings-destination') node.props.ref({ focus() { focused.push(`card:${text(node).trim().split(' ').slice(0, 1).join('')}`); } });
    }
    return tree;
  };
  const app = host(view, { appIcon: 'red', selected: 'index', select() {}, snapshot: snapshot(), online: true, general: null, openAssistant() {} });
  try {
    await app.flush(); assert.deepEqual(focused, ['Settings']);
    await app.update({ selected: 'accounts' }); assert.equal(focused.at(-1), 'Accounts');
    app.tree.props.onScroll({ currentTarget: { scrollTop: 271 } });
    await app.update({ selected: 'index' }); assert.equal(focused.at(-1), 'card:Accounts');
    await app.update({ selected: 'accounts' }); assert.equal(scroller.scrollTop, 271); assert.equal(focused.at(-1), 'Accounts');
  } finally { app.close(); }
});
