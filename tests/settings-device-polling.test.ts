import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const key = Symbol.for('nova.test.settings-device-polling');
const reactUrl = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && context.parentURL?.includes('/apps/client/src/')) return { url: 'nova-test:settings-react', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:settings-react') return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(reactUrl)};
      export const useState = value => globalThis[Symbol.for('nova.test.settings-device-polling')].state(value);
      export const useRef = value => globalThis[Symbol.for('nova.test.settings-device-polling')].ref(value);
      export const useEffect = (effect, deps) => globalThis[Symbol.for('nova.test.settings-device-polling')].effect(effect, deps);
      export const useSyncExternalStore = (_subscribe, snapshot) => snapshot();
    ` };
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return next(url, context);
  },
});
// Install's event subscription is harmless in this isolated module host.
Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
const { InstallSettings } = await import('../apps/client/src/InstallSettings');
const { UsageSettings } = await import('../apps/client/src/UsageSettings');
const { StorageSettings } = await import('../apps/client/src/StorageSettings');
const { ProviderAccounts } = await import('../apps/client/src/ProviderAccounts');
Reflect.deleteProperty(globalThis, 'window'); hooks.deregister();

function host(component: (props: any) => any, initial: any, respond: (path: string, init: RequestInit) => unknown | Promise<unknown>, saved: Record<string, string> = {}) {
  let props = initial, cursor = 0, dirty = true, now = 0, timerId = 0, tree: any;
  const cells: any[] = [], pending: (() => (() => void))[] = [], calls: { path: string; init: RequestInit }[] = [];
  const timers = new Map<number, { at: number; run: () => void }>(), stored = new Map(Object.entries(saved));
  const document = Object.assign(new EventTarget(), { hidden: false, querySelector: () => null }), window = new EventTarget();
  const values: Record<PropertyKey, unknown> = {
    [key]: {
      state(value: any) { const i = cursor++; if (!cells[i]) cells[i] = { value: typeof value === 'function' ? value() : value }; return [cells[i].value, (next: any) => { const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true; } }]; },
      ref(value: any) { const i = cursor++; return cells[i] ??= { current: value }; },
      effect(run: () => void | (() => void), deps: unknown[]) { const i = cursor++, before = cells[i]; if (!before || deps.some((value, index) => !Object.is(value, before.deps[index]))) { cells[i] = { deps, cleanup: before?.cleanup }; pending.push(() => { cells[i].cleanup?.(); return () => { cells[i].cleanup = run(); }; }); } },
    }, document, window, navigator: { userAgent: 'fixture', maxTouchPoints: 0 }, matchMedia: () => ({ matches: false }),
    localStorage: { getItem: (name: string) => stored.get(name) ?? null, setItem: (name: string, value: string) => stored.set(name, value) },
    setTimeout: (run: () => void, delay: number) => { const id = ++timerId; timers.set(id, { at: now + delay, run }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (path: string, init: RequestInit) => { calls.push({ path, init }); const value = await respond(path, init); return new Response(JSON.stringify(value), { status: 200 }); },
  };
  const originals = Reflect.ownKeys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of Reflect.ownKeys(values)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  const originalNow = Date.now; Date.now = () => now;
  // React cleans up every changed effect before installing the new effects.
  const flush = async () => { for (let pass = 0; pass < 20; pass++) { if (dirty) { dirty = false; cursor = 0; tree = component(props); const setup = pending.splice(0).map(cleanup => cleanup()); for (const run of setup) run(); } for (let tick = 0; tick < 10; tick++) await Promise.resolve(); } };
  return {
    calls, stored, get tree() { return tree; }, flush,
    async update(next: any) { props = { ...props, ...next }; dirty = true; await flush(); },
    async advance(ms: number) { const until = now + ms; for (;;) { const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; timers.delete(next[0]); now = next[1].at; next[1].run(); await flush(); } now = until; await flush(); },
    async visible(value: boolean) { document.hidden = !value; document.dispatchEvent(new Event('visibilitychange')); await flush(); },
    async focus() { window.dispatchEvent(new Event('focus')); await flush(); },
    close() { for (const cell of cells) cell?.cleanup?.(); Date.now = originalNow; for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } },
  };
}
function element(tree: any, match: (node: any) => boolean): any {
  if (!tree || typeof tree !== 'object') return;
  if (Array.isArray(tree)) return tree.map(child => element(child, match)).find(Boolean);
  return match(tree) ? tree : element(tree.props?.children, match);
}
const text = (tree: any): string => tree == null || typeof tree === 'boolean' ? '' : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : Array.isArray(tree) ? tree.map(text).join(' ') : text(tree.props?.children);
const usage = { state: 'ready', providers: [], activity: { status: 'ready', tokens: 0, input: 0, output: 0, daily: [] } };

test('device and usage reads stop on inactive categories and hidden documents, and refresh on return', async () => {
  for (const [component, props, respond, initialReads] of [
    [InstallSettings, { epoch: 'workspace', appIcon: 'red', active: false }, () => ({ devices: [], downloads: [] }), 1],
    [UsageSettings, { identity: 'workspace', active: false, online: true }, (path: string) => path.endsWith('/usage') ? usage : { state: 'available', accounts: [], emails: [], profileCount: 0 }, 2],
  ] as const) {
    const app = host(component as (props: any) => any, props, respond);
    try {
      await app.flush(); await app.focus(); await app.advance(120000); assert.equal(app.calls.length, 0);
      await app.update({ active: true }); assert.equal(app.calls.length, initialReads);
      await app.visible(false); const hidden = app.calls.length; await app.advance(120000); assert.equal(app.calls.length, hidden);
      await app.visible(true); assert.equal(app.calls.length, hidden + initialReads);
      await app.update({ active: false }); const inactive = app.calls.length; await app.focus(); await app.advance(120000); assert.equal(app.calls.length, inactive);
      await app.update({ active: true }); assert.equal(app.calls.length, inactive + initialReads);
      assert.ok(app.calls.every(call => call.init.method === 'GET'));
    } finally { app.close(); }
  }
});

test('leaving Devices cancels its read but preserves an explicit revoke and its original result', async () => {
  let complete: ((value: unknown) => void) | undefined;
  const computer = { id: 'fixture', name: 'Fixture computer', connected: true, enabledUntil: null, scope: 'desktop', apps: [] };
  const app = host(InstallSettings, { epoch: 'workspace', appIcon: 'red', active: true }, (path, init) => init.method === 'POST' ? new Promise(resolve => { complete = resolve; }) : { devices: [computer], downloads: [] });
  try {
    await app.flush(); element(app.tree, node => node.type === 'button' && text(node) === 'Revoke link').props.onClick(); await app.flush();
    element(app.tree, node => node.type === 'button' && node.props.className === 'primary' && text(node) === 'Revoke link').props.onClick(); await app.flush();
    const action = app.calls.find(call => call.init.method === 'POST')!;
    await app.update({ active: false }); await app.visible(false); assert.equal(action.init.signal?.aborted, false);
    complete!({}); await app.flush();
    assert.equal(app.calls.filter(call => call.init.method === 'POST').length, 1);
    assert.equal(app.calls.at(-1)!.path, '/api/companions/state', 'An explicit action still obtains its confirmation while automatic reads are paused');
    const confirmed = app.calls.length; await app.advance(120000); assert.equal(app.calls.length, confirmed);
  } finally { app.close(); }
});

test('unknown security remains unknown through failed loading instead of implying a local unprotected key', async () => {
  let fail!: (error: Error) => void;
  const app = host(StorageSettings, { epoch: 'workspace', deviceId: 'device' }, () => new Promise((_resolve, reject) => { fail = reject; }));
  try {
    await app.flush(); assert.match(text(app.tree), /Checking security/); assert.doesNotMatch(text(app.tree), /Local key file|Protected and verified/);
    fail(new Error('Offline fixture')); await app.flush();
    assert.match(text(app.tree), /Status unavailable/); assert.doesNotMatch(text(app.tree), /Local key file|Protected and verified/);
    assert.equal(element(app.tree, node => node.type === 'button' && text(node) === 'Protect key'), undefined);
  } finally { app.close(); }
});

test('pending protection is visible without a status read and cannot leak across workspace identity changes', async () => {
  let reads = 0, finish!: (value: unknown) => void;
  const journal = 'e3:protect-key:device', pending = JSON.stringify({ requestId: 'original', epoch: 'original' });
  const app = host(StorageSettings, { epoch: 'original', deviceId: 'device' }, () => ++reads === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.reject(new Error('Offline fixture')), { [journal]: pending });
  try {
    await app.flush(); assert.match(text(app.tree), /Protection is unconfirmed/);
    await app.update({ epoch: 'next' }); assert.equal(app.calls[0].init.signal?.aborted, true);
    assert.match(text(app.tree), /Status unavailable/); assert.doesNotMatch(text(app.tree), /Protection is unconfirmed/);
    finish({ protection: 'server', verified: true, protectedCopy: true, provider: 'server-secret' }); await app.flush();
    assert.doesNotMatch(text(app.tree), /Protected and verified/);
    assert.equal(app.stored.get(journal), pending, 'A previous workspace receipt remains saved without being applied to this workspace');
    assert.ok(app.calls.every(call => call.init.method === 'GET'));
  } finally { app.close(); }
});

test('Retry status recovers a failed security read without replaying or clearing a pending protection action', async () => {
  let reads = 0;
  const journal = 'e3:protect-key:device', pending = JSON.stringify({ requestId: 'original', epoch: 'workspace' });
  const app = host(StorageSettings, { epoch: 'workspace', deviceId: 'device' }, () => ++reads === 1 ? Promise.reject(new Error('Offline fixture')) : { protection: 'server', verified: true, protectedCopy: true, provider: 'server-secret' }, { [journal]: pending });
  try {
    await app.flush(); assert.match(text(app.tree), /Status unavailable/); assert.match(text(app.tree), /Protection is unconfirmed/);
    element(app.tree, node => node.type === 'button' && text(node) === 'Retry status').props.onClick(); await app.flush();
    assert.equal(app.calls.length, 2); assert.ok(app.calls.every(call => call.path === '/api/storage/state' && call.init.method === 'GET'));
    assert.match(text(app.tree), /Protected and verified/); assert.doesNotMatch(text(app.tree), /Status unavailable/);
    assert.equal(app.stored.get(journal), pending); assert.match(text(app.tree), /Protection is unconfirmed/);
    assert.ok(element(app.tree, node => node.type === 'button' && text(node) === 'Retry protection'));
  } finally { app.close(); }
});

test('Accounts stays idle when inactive and never adopts a late previous-workspace response', async () => {
  let reads = 0, finish!: (value: unknown) => void;
  const current = { clients: [], accounts: [], attempts: [], probes: [] };
  const app = host(ProviderAccounts, { snapshot: { epoch: 'old', deviceId: 'device' }, online: true, active: false }, () => ++reads === 1 ? new Promise(resolve => { finish = resolve; }) : current);
  try {
    await app.flush(); await app.focus(); await app.advance(120000); assert.equal(app.calls.length, 0);
    await app.update({ active: true }); assert.equal(app.calls.length, 1);
    await app.update({ snapshot: { epoch: 'new', deviceId: 'device' } });
    assert.equal(app.calls[0].init.signal?.aborted, true); assert.equal(app.calls.length, 2);
    const card = () => element(app.tree, node => node.type?.name === 'ProviderCard');
    assert.deepEqual(card().props.state, current); assert.equal(card().props.snapshot.epoch, 'new');
    finish({ ...current, accounts: [{ label: 'Obsolete account' }] }); await app.flush();
    assert.deepEqual(card().props.state, current);
    await app.update({ active: false }); const idle = app.calls.length; await app.focus(); await app.advance(120000);
    assert.equal(app.calls.length, idle); assert.ok(app.calls.every(call => call.init.method === 'GET'));
  } finally { app.close(); }
});
