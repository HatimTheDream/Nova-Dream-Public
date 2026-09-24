import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const harnessKey = Symbol.for('nova.test.secondary-polling');
const reactUrl = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
// Run the actual component effects with a deterministic hook/clock host. No
// browser, runtime, account or mutation endpoint is contacted by these checks.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && context.parentURL?.includes('/apps/client/src/')) return { url: 'nova-test:secondary-react', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:secondary-react') return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(reactUrl)};
      export const useState = value => globalThis[Symbol.for('nova.test.secondary-polling')].state(value);
      export const useRef = value => globalThis[Symbol.for('nova.test.secondary-polling')].ref(value);
      export const useEffect = (effect, deps) => globalThis[Symbol.for('nova.test.secondary-polling')].effect(effect, deps);
    ` };
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return next(url, context);
  },
});
const { Connections } = await import('../apps/client/src/Connections');
const { AssistantActivityPanel } = await import('../apps/client/src/AssistantActivityPanel');
const { ModuleActionTray } = await import('../apps/client/src/ModuleActionTray');
hooks.deregister();

function host(component: (props: any) => any, initial: any, respond: (path: string, init: RequestInit) => unknown | Promise<unknown>) {
  let props = initial, cursor = 0, dirty = true, now = 0, timerId = 0, tree: any;
  const cells: any[] = [], pending: (() => void)[] = [], calls: { path: string; init: RequestInit }[] = [];
  const timers = new Map<number, { at: number; run: () => void }>();
  const document = Object.assign(new EventTarget(), { hidden: false, querySelector: () => null });
  const window = new EventTarget();
  const values: Record<PropertyKey, unknown> = {
    [harnessKey]: {
      state(value: any) { const i = cursor++; if (!cells[i]) cells[i] = { value: typeof value === 'function' ? value() : value }; return [cells[i].value, (next: any) => { const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true; } }]; },
      ref(value: any) { const i = cursor++; return cells[i] ??= { current: value }; },
      effect(run: () => void | (() => void), deps: unknown[]) { const i = cursor++, before = cells[i]; if (!before || deps.some((value, index) => !Object.is(value, before.deps[index]))) { cells[i] = { deps, cleanup: before?.cleanup }; pending.push(() => { cells[i].cleanup?.(); cells[i].cleanup = run(); }); } },
    }, document, window,
    localStorage: { getItem: () => null },
    setTimeout: (run: () => void, delay: number) => { const id = ++timerId; timers.set(id, { at: now + delay, run }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (path: string, init: RequestInit) => { calls.push({ path, init }); const value = await respond(path, init); return new Response(JSON.stringify(value), { status: 200 }); },
  };
  const originals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const originalNow = Date.now; Date.now = () => now;
  const flush = async () => {
    for (let pass = 0; pass < 20; pass++) {
      if (dirty) { dirty = false; cursor = 0; tree = component(props); while (pending.length) pending.shift()!(); }
      for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    }
  };
  return {
    calls, get tree() { return tree; }, get timers() { return timers.size; }, flush,
    async update(next: any) { props = { ...props, ...next }; dirty = true; await flush(); },
    async advance(ms: number) { const until = now + ms; for (;;) { const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; timers.delete(next[0]); now = next[1].at; next[1].run(); await flush(); } now = until; await flush(); },
    async visible(value: boolean) { document.hidden = !value; document.dispatchEvent(new Event('visibilitychange')); await flush(); },
    async focus() { window.dispatchEvent(new Event('focus')); await flush(); },
    close() { for (const cell of cells) cell?.cleanup?.(); Date.now = originalNow; for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } },
  };
}
function element(tree: any, match: (node: any) => boolean): any {
  if (!tree || typeof tree !== 'object') return;
  if (Array.isArray(tree)) return tree.map(child => element(child, match)).find(Boolean);
  if (match(tree)) return tree;
  return element(tree.props?.children, match);
}
const connectionProps = { snapshot: { epoch: 'epoch', deviceId: 'device' }, online: true, openAssistant() {} };
function connectionStatus(path: string) {
  if (path.endsWith('/state')) return { connection: { state: 'ready', modelAuthReady: true, generation: 'host', url: 'fixture' } };
  if (path.endsWith('/runtime')) return { state: 'running', phase: 'ready', canSignIn: true };
  if (path.endsWith('/sign-in')) return { state: 'idle' };
  if (path.endsWith('/account')) return { state: 'available', accounts: [], emails: [], profileCount: 0 };
  return { state: 'available' };
}

test('stable Connections makes seven recurring reads per minute, sleeps hidden, and refreshes once on demand', async () => {
  const app = host(Connections, connectionProps, connectionStatus);
  try {
    await app.flush(); assert.equal(app.calls.length, 5, 'Opening reads each of the five sources once');
    await app.advance(60000); assert.equal(app.calls.length, 12);
    assert.equal(app.calls.filter(call => call.path.endsWith('/voice/catalog')).length, 1);
    await app.visible(false); const hidden = app.calls.length;
    await app.advance(300000); assert.equal(app.calls.length, hidden);
    await app.visible(true); assert.equal(app.calls.length, hidden + 5);
    const check = element(app.tree, node => node.props?.['aria-label'] === 'Refresh Assistant connection and accounts');
    check.props.onClick(); await app.flush();
    assert.equal(app.calls.length, hidden + 12, 'Explicit account and models refresh plus one fresh set of five statuses');
    assert.ok(app.calls.every(call => call.init.method === 'GET'), 'Automatic status checks never start or reconnect a runtime');
  } finally { app.close(); }
});

test('runtime startup and waiting sign-in stay responsive without polling the voice catalog repeatedly', async () => {
  let starting = true, waiting = true;
  const app = host(Connections, connectionProps, path => path.endsWith('/runtime') ? { state: starting ? 'starting' : 'running' } : path.endsWith('/sign-in') ? { state: waiting ? 'waiting' : 'completed', id: 'sign-in' } : connectionStatus(path));
  try {
    await app.flush(); await app.advance(6000);
    assert.equal(app.calls.filter(call => call.path.endsWith('/runtime')).length, 5, 'The active-state boundary rearms the earlier idle schedule');
    assert.equal(app.calls.filter(call => call.path.endsWith('/sign-in')).length, 5);
    assert.equal(app.calls.filter(call => call.path.endsWith('/voice/catalog')).length, 1);
    starting = false; waiting = false; await app.advance(2000);
    assert.equal(app.calls.filter(call => call.path.endsWith('/voice/catalog')).length, 2, 'Completed sign-in refreshes voice readiness immediately');
    const settled = app.calls.length; await app.advance(10000); assert.equal(app.calls.length, settled);
  } finally { app.close(); }
});

test('starting a previously idle runtime rearms its status timer without repeating the Start request', async () => {
  let starting = false;
  const app = host(Connections, connectionProps, path => {
    if (path.endsWith('/runtime/start')) { starting = true; return {}; }
    if (path.endsWith('/runtime')) return { state: starting ? 'starting' : 'stopped', canSignIn: true };
    if (path.endsWith('/state')) return { connection: { state: starting ? 'connecting' : 'disconnected', modelAuthReady: false, generation: 'host', url: 'fixture' } };
    return connectionStatus(path);
  });
  try {
    await app.flush(); await app.advance(10000);
    element(app.tree, node => node.type === 'button' && node.props.className === 'primary').props.onClick(); await app.flush();
    const runtimeReads = app.calls.filter(call => call.path.endsWith('/runtime')).length;
    await app.advance(2000);
    assert.equal(app.calls.filter(call => call.path.endsWith('/runtime')).length, runtimeReads + 1, 'Startup does not wait for the old 30 s deadline');
    assert.equal(app.calls.filter(call => call.path.endsWith('/runtime/start')).length, 1);
  } finally { app.close(); }
});

const operation = { id: 'operation', state: 'running', tools: [], nativeRunId: 'run' };
const frame = { id: 'frame', operationId: 'operation', capturedAt: '2026-09-22T12:00:00Z', width: 800, height: 600 };
test('tool view discovers delayed images, stops when closed or finished, and reads fresh on reopening', async () => {
  let image: unknown = null, announcements = 0;
  const app = host(AssistantActivityPanel, { operation, open: false, show() { announcements++; }, available() {}, close() {}, stop: async () => {} }, () => image);
  try {
    await app.flush(); await app.advance(6000); assert.equal(app.calls.length, 5);
    await app.advance(60000); assert.equal(app.calls.length, 5, 'Closed discovery expires instead of polling indefinitely');
    await app.update({ operation: { ...operation, tools: [{ id: 'tool', state: 'completed' }] } });
    image = frame; await app.advance(1500); assert.equal(announcements, 1);
    await app.update({ open: true }); const live = app.calls.length;
    await app.advance(3000); assert.equal(app.calls.length, live + 3);
    await app.visible(false); const hidden = app.calls.length; await app.advance(60000); assert.equal(app.calls.length, hidden);
    await app.visible(true); assert.equal(app.calls.length, hidden + 1);
    await app.update({ open: false }); const closed = app.calls.length;
    await app.advance(60000); assert.equal(app.calls.length, closed);
    await app.update({ open: true, operation: { ...operation, state: 'completed' } }); const finished = app.calls.length;
    await app.advance(60000); assert.equal(app.calls.length, finished);
    assert.equal(announcements, 1, 'Reopening or refreshing does not force a second automatic panel opening');
    assert.ok(app.calls.every(call => call.init.method === 'GET'));
  } finally { app.close(); }
});

test('a late image hint wakes closed running and completed views after discovery expires without leaving a timer', async () => {
  for (const state of ['running', 'completed']) {
    let image: unknown = null, announcements = 0, available = false;
    const current = { ...operation, state };
    const app = host(AssistantActivityPanel, { operation: current, open: false, show() { announcements++; }, available(value: boolean) { available = value; }, close() {}, stop: async () => {} }, () => image);
    try {
      await app.flush(); await app.advance(6000); assert.equal(app.calls.length, 5);
      image = frame; await app.advance(60000);
      assert.equal(app.calls.length, 5, 'An expired discovery window does not keep polling');
      await app.update({ operation: { ...current, observationId: frame.id } });
      assert.equal(app.calls.length, 6, 'Late image arrival is discovered through the existing state response');
      assert.equal(available, true); assert.equal(announcements, 1); assert.equal(app.timers, 0);
      await app.advance(60000); assert.equal(app.calls.length, 6);
      await app.visible(false);
      image = { ...frame, id: 'newer-frame' };
      await app.update({ operation: { ...current, observationId: 'newer-frame' } });
      await app.advance(60000); assert.equal(app.calls.length, 6, 'Even an image hint respects hidden-tab suspension');
      await app.visible(true); assert.equal(app.calls.length, 7);
      assert.equal(announcements, 1, 'A later image does not reopen a view the user already closed');
      assert.equal(app.timers, 0);
    } finally { app.close(); }
  }
});

test('module-action discovery slows while empty and keeps pending checks and explicit refresh immediate', async () => {
  let items: any[] = [], workspaceReads = 0;
  const app = host(ModuleActionTray, { conversationId: 'conversation', epoch: 'epoch', refreshWorkspace: async () => { workspaceReads++; } }, () => items);
  try {
    await app.flush(); await app.advance(60000); assert.equal(app.calls.length, 3);
    assert.equal(workspaceReads, 0);
    items = [{ id: 'action', state: 'pending', revision: 1 }];
    await app.focus(); const pending = app.calls.length; await app.advance(9000); assert.equal(app.calls.length, pending + 3);
    await app.visible(false); const hidden = app.calls.length; await app.advance(60000); assert.equal(app.calls.length, hidden);
    items = [{ id: 'action', state: 'applied', revision: 2 }];
    const card = element(app.tree, node => node.type?.name === 'ActionCard');
    const refreshed = card.props.refresh(); await app.flush(); await refreshed;
    assert.equal(app.calls.length, hidden + 1, 'An explicit decision refresh does not wait for visibility or the idle timer');
    assert.equal(workspaceReads, 1, 'Confirmed applied revision refreshes workspace once');
    await app.visible(true); await app.advance(30000); assert.equal(workspaceReads, 1);
    assert.ok(app.calls.every(call => call.path === '/api/assistant/module-actions' && call.init.method === 'POST'), 'Discovery does not call the decision endpoint');
  } finally { app.close(); }
});

test('an active assignment discovers new module reviews every three seconds without clearing retained items', async () => {
  let items: any[] = [];
  const app = host(ModuleActionTray, { assignmentId: 'assignment', epoch: 'epoch', working: false, refreshWorkspace: async () => {} }, () => items);
  try {
    await app.flush(); await app.advance(10000); assert.equal(app.calls.length, 1);
    await app.update({ working: true }); assert.equal(app.calls.length, 2, 'Starting work refreshes before the old idle timer');
    items = [{ id: 'review', state: 'pending', revision: 1 }];
    await app.advance(3000); assert.equal(app.calls.length, 3);
    assert.equal(element(app.tree, node => node.type?.name === 'ActionCard').props.a.id, 'review');
    await app.update({ working: false });
    assert.equal(element(app.tree, node => node.type?.name === 'ActionCard').props.a.id, 'review');
    const pending = app.calls.length; await app.advance(3000); assert.equal(app.calls.length, pending + 1);
    assert.ok(app.calls.every(call => JSON.parse(call.init.body as string).assignmentId === 'assignment'));
  } finally { app.close(); }
});

test('post-decision module refresh waits for fresh data after an in-flight read and rejects a previous conversation result', async () => {
  let reads = 0, resolve: ((value: unknown) => void) | undefined, workspaceReads = 0;
  const pending = [{ id: 'review', state: 'pending', revision: 1 }];
  const app = host(ModuleActionTray, { conversationId: 'conversation', epoch: 'epoch', refreshWorkspace: async () => { workspaceReads++; } }, () => {
    reads++;
    return reads === 2 || reads === 4 ? new Promise(accept => { resolve = accept; }) : reads === 3 ? [{ ...pending[0], state: 'applied', revision: 2 }] : pending;
  });
  try {
    await app.flush(); await app.advance(3000);
    const refreshed = element(app.tree, node => node.type?.name === 'ActionCard').props.refresh();
    resolve!(pending); await app.flush(); await refreshed;
    assert.equal(app.calls.length, 3, 'The old in-flight read cannot acknowledge the mutation refresh');
    assert.equal(workspaceReads, 1);
    assert.equal(element(app.tree, node => node.type?.name === 'ActionCard').props.a.state, 'applied');
    await app.advance(30000); const staleSignal = app.calls.at(-1)!.init.signal;
    await app.update({ conversationId: 'next-conversation' });
    assert.equal(staleSignal?.aborted, true);
    resolve!([{ id: 'wrong-conversation', state: 'applied', revision: 1 }]); await app.flush();
    assert.equal(element(app.tree, node => node.type?.name === 'ActionCard').props.a.id, 'review');
    assert.equal(workspaceReads, 1, 'A late prior-conversation result cannot refresh the current workspace');
  } finally { app.close(); }
});

test('panel failures back off and unmount aborts an owned read without accepting its late result', async () => {
  let failure = true, resolve: ((value: unknown) => void) | undefined, signal: AbortSignal | undefined, available = 0;
  const app = host(AssistantActivityPanel, { operation, open: true, show() {}, available(value: boolean) { if (value) available++; }, close() {}, stop: async () => {} }, async (_path, init) => {
    if (failure) throw new Error('Offline fixture');
    signal = init.signal as AbortSignal; return new Promise(accept => { resolve = accept; });
  });
  await app.flush(); await app.advance(4000); assert.equal(app.calls.length, 1);
  await app.advance(1000); assert.equal(app.calls.length, 2);
  await app.advance(9000); assert.equal(app.calls.length, 2);
  failure = false; await app.advance(1000); assert.equal(app.calls.length, 3);
  app.close(); assert.equal(signal?.aborted, true);
  resolve!(frame); for (let tick = 0; tick < 20; tick++) await Promise.resolve();
  assert.equal(available, 0);
});
