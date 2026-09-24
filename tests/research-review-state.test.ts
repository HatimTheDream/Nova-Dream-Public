import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const key = Symbol.for('nova.test.research-review');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
  resolve(specifier, context, next) { return specifier === 'react' && context.parentURL?.endsWith('/research-review-state.ts') ? { url: 'nova-test:research-review', shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
    return url === 'nova-test:research-review' ? { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      export const useState = value => globalThis[Symbol.for('nova.test.research-review')].state(value);
      export const useRef = value => globalThis[Symbol.for('nova.test.research-review')].ref(value);
      export const useEffect = (run,deps) => globalThis[Symbol.for('nova.test.research-review')].effect(run,deps);` } : next(url, context);
  },
});
const { useResearchReview } = await import('../apps/client/src/research-review-state');
loader.deregister();

function host(initial: any, respond: (path: string, body: any) => unknown | Promise<unknown> = () => ({ id: 'operation' })) {
  let props = initial, cursor = 0, dirty = true, tree: any, full = false;
  const cells: any[] = [], effects: (() => void)[] = [], calls: { path: string; body: any }[] = [], storage = new Map<string, string>();
  const values: Record<PropertyKey, unknown> = {
    [key]: {
      state(value: any) { const index = cursor++; if (!cells[index]) cells[index] = { value: typeof value === 'function' ? value() : value }; return [cells[index].value, (next: any) => { cells[index].value = typeof next === 'function' ? next(cells[index].value) : next; dirty = true; }]; },
      ref(value: any) { return cells[cursor++] ??= { current: value }; },
      effect(run: () => void | (() => void), deps: unknown[]) { const index = cursor++, old = cells[index]; if (!old || deps.some((value, offset) => !Object.is(value, old.deps[offset]))) { cells[index] = { deps, cleanup: old?.cleanup }; effects.push(() => { cells[index].cleanup?.(); cells[index].cleanup = run(); }); } },
    },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { if (full) throw Error('Storage is full'); storage.set(key, value); } },
    fetch: async (path: string, init: RequestInit) => { const body = JSON.parse(String(init.body)); calls.push({ path, body }); const value = await respond(path, body); return value instanceof Response ? value : new Response(JSON.stringify(value)); },
  };
  const originals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const flush = async () => { for (let pass = 0; pass < 25; pass++) { if (dirty) { dirty = false; cursor = 0; tree = useResearchReview(props); while (effects.length) effects.shift()!(); } for (let tick = 0; tick < 10; tick++) await Promise.resolve(); } };
  const unmount = () => { for (const cell of cells) { cell?.cleanup?.(); if (cell) cell.cleanup = undefined; } };
  return { calls, storage, flush, get tree() { return tree; },
    async update(next: any) { props = { ...props, ...next }; dirty = true; await flush(); },
    fillStorage() { full = true; },
    unmount, close() { unmount(); for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); },
  };
}
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
const research = (extra: any = {}) => ({ id: 'research-a', epoch: 'epoch', kind: 'research', revision: 3, version: 1, state: 'ready', reviewDigest: 'a'.repeat(64), autoStartAt: '2026-09-23T12:00:45Z', versions: [{ version: 1, digest: 'a'.repeat(64), proposal: { title: 'Research', summary: 'Compare verified sources.', steps: ['Review sources'], assumptions: [], verification: ['Citations'] } }], ...extra });
const options = (item = research(), extra: any = {}) => ({ item, epoch: 'epoch', ready: true, refresh: async () => {}, ...extra });
const held = (item = research()) => ({ ...item, revision: item.revision + 1, autoStartAt: undefined, autoStartHeld: 'editing' });

test('editing waits for a durable hold and uses its returned revision even when refresh fails', async () => {
  const gate = deferred<any>(); const item = research();
  const app = host(options(item, { refresh: async () => { throw Error('Refresh unavailable'); } }), path => path.endsWith('/hold') ? gate.promise : { id: 'amendment' });
  try {
    await app.flush(); assert.equal(app.tree.editing, false);
    app.tree.setText('Not yet editable'); assert.equal(app.storage.size, 0);
    void app.tree.hold(); await app.flush();
    assert.equal(app.tree.busy, true); assert.equal(app.tree.editing, false); assert.equal(app.tree.pendingAction, 'hold');
    gate.resolve(held(item)); await app.flush();
    assert.equal(app.tree.editing, true); assert.equal(app.tree.canAmend, true); assert.equal(app.tree.item.revision, 4);
    app.tree.setText('Use primary sources.'); await app.flush();
    void app.tree.amend(); await app.flush();
    assert.equal(app.calls.length, 2); assert.equal(app.calls[1].body.expectedRevision, 4); assert.equal(app.calls[1].body.text, 'Use primary sources.');
    assert.equal(app.tree.text, ''); assert.equal(app.tree.editing, false);
  } finally { app.close(); }
});

for (const action of ['hold', 'cancel'] as const) test(`uncertain ${action} survives reopening and retries the exact decision after a revision refresh`, async () => {
  const item = research(); let app = host(options(item), () => { throw Error('Response lost'); });
  try {
    await app.flush(); void app.tree[action](); await app.flush();
    const original = app.calls[0].body, saved = [...app.storage];
    assert.equal(app.tree.editing, false); assert.equal(app.tree.item.state, 'ready');
    app.close(); app = host(options({ ...item, revision: 5 }), () => action === 'hold' ? held({ ...item, revision: 5 }) : { ...item, revision: 6, state: 'cancelled', autoStartAt: undefined });
    for (const [key, value] of saved) app.storage.set(key, value);
    await app.flush(); assert.equal(app.tree.pendingAction, action); assert.equal(app.tree.canApprove, false); assert.equal(app.tree.canCancel, false);
    void app.tree.approve(); void app.tree.cancel(); await app.flush(); assert.equal(app.calls.length, 0);
    void app.tree.retry(); await app.flush(); assert.equal(app.calls.length, 1); assert.deepEqual(app.calls[0].body, original);
    assert.equal(app.tree.pendingAction, undefined);
    assert.equal(app.tree.editing, action === 'hold'); assert.equal(app.tree.item.state, action === 'cancel' ? 'cancelled' : 'ready');
  } finally { app.close(); }
});

test('hold, cancel and start share a synchronous guard before React rerenders', async () => {
  const gate = deferred<any>(), app = host(options(), () => gate.promise);
  try {
    await app.flush(); const current = app.tree;
    void current.hold(); void current.cancel(); void current.approve(); void current.hold(); await app.flush();
    assert.equal(app.calls.length, 1); assert.equal(app.tree.busy, true);
    gate.resolve(held()); await app.flush(); assert.equal(app.tree.editing, true);
  } finally { app.close(); }
});

test('a lost amendment replays original writing and retains newer unsent changes', async () => {
  let attempts = 0; const item = held();
  const app = host(options(item), () => { if (++attempts === 1) throw Error('Response lost'); return { id: 'same-operation' }; });
  try {
    await app.flush(); app.tree.setText('Original changes'); await app.flush(); void app.tree.amend(); await app.flush();
    const original = app.calls[0].body;
    app.tree.setText('New unsent writing'); await app.flush();
    void app.tree.amend(); void app.tree.approve(); await app.flush(); assert.equal(app.calls.length, 1);
    void app.tree.retry(); await app.flush(); assert.deepEqual(app.calls[1].body, original);
    assert.equal(app.tree.text, 'New unsent writing'); assert.equal(app.tree.accepted, true);
  } finally { app.close(); }
});

for (const change of ['item', 'epoch', 'version'] as const) test(`a late hold and old callbacks cannot edit a different ${change}`, async () => {
  const gate = deferred<any>(), item = research(), app = host(options(item), () => gate.promise);
  try {
    await app.flush(); const previous = app.tree; void previous.hold(); await app.flush();
    const next = change === 'item' ? research({ id: 'research-b' }) : change === 'epoch' ? research({ epoch: 'other-epoch' }) : research({ version: 2, revision: 5, versions: [{ ...item.versions[0], version: 2 }] });
    await app.update({ item: next, ...(change === 'epoch' ? { epoch: 'other-epoch' } : {}) });
    gate.resolve(held(item)); await app.flush();
    assert.equal(app.tree.editing, false); assert.equal(app.tree.busy, false);
    previous.setText('Wrong view'); void previous.approve(); void previous.cancel(); await app.flush();
    assert.equal(app.tree.text, ''); assert.equal(app.calls.length, 1);
  } finally { app.close(); }
});

test('a late approval cannot consume the new view or call its approval callback', async () => {
  const gate = deferred<any>(); let approved = 0;
  const app = host(options(research(), { onApproved: () => { approved++; } }), () => gate.promise);
  try {
    await app.flush(); void app.tree.approve(); await app.flush();
    await app.update({ item: held(research({ id: 'research-b' })) }); app.tree.setText('Keep this later writing'); await app.flush();
    gate.resolve({ id: 'operation' }); await app.flush();
    assert.equal(approved, 0); assert.equal(app.tree.text, 'Keep this later writing'); assert.equal(app.tree.accepted, false);
  } finally { app.close(); }
});

test('confirmed cancellation preserves proposal and writing and never pretends to be active', async () => {
  const item = held(), app = host(options(item), () => ({ ...item, revision: 5, state: 'cancelled', autoStartHeld: undefined, autoStartAt: undefined }));
  try {
    await app.flush(); app.tree.setText('A retained possible revision'); await app.flush(); void app.tree.cancel(); await app.flush();
    assert.equal(app.tree.item.state, 'cancelled'); assert.deepEqual(app.tree.proposal, item.versions[0].proposal);
    assert.equal(app.tree.text, 'A retained possible revision'); assert.equal(app.tree.editing, false); assert.equal(app.tree.canApprove, false); assert.equal(app.tree.canCancel, false); assert.equal(app.tree.canHold, true);
  } finally { app.close(); }
});

for (const restriction of ['readOnly', 'offline', 'ordinary-plan', 'wrong-epoch', 'approved', 'drafting']) test(`${restriction} cannot hold, cancel or start research`, async () => {
  const item = research(restriction === 'ordinary-plan' ? { kind: undefined } : restriction === 'wrong-epoch' ? { epoch: 'old-epoch' } : restriction === 'approved' ? { approval: { requestId: 'approved' } } : restriction === 'drafting' ? { state: 'drafting' } : {});
  const app = host(options(item, { ready: restriction !== 'offline', readOnly: restriction === 'readOnly' }));
  try {
    await app.flush(); void app.tree.hold(); void app.tree.cancel(); void app.tree.approve(); await app.flush();
    assert.equal(app.calls.length, 0); assert.equal(app.tree.canApprove, false); assert.equal(app.tree.canCancel, false);
  } finally { app.close(); }
});

test('storage failure blocks Hold before the server timer can be changed', async () => {
  const app = host(options());
  try {
    await app.flush(); app.fillStorage(); void app.tree.hold(); await app.flush();
    assert.equal(app.calls.length, 0); assert.equal(app.tree.editing, false); assert.match(app.tree.error, /saved safely/);
  } finally { app.close(); }
});

test('a definite stale decision clears recovery but an unknown decision remains pending', async () => {
  const app = host(options(), () => new Response(JSON.stringify({ code: 'plan_changed', message: 'Research changed' }), { status: 409 }));
  try {
    await app.flush(); void app.tree.hold(); await app.flush();
    assert.equal(app.tree.pendingAction, undefined); assert.equal(app.tree.editing, false); assert.equal(app.tree.canApprove, true);
    assert.match(app.tree.error, /Research changed/);
  } finally { app.close(); }
});

test('Check refreshes without repeating an uncertain cancellation', async () => {
  let refreshes = 0; const app = host(options(research(), { refresh: async () => { refreshes++; } }), () => { throw Error('Response lost'); });
  try {
    await app.flush(); void app.tree.cancel(); await app.flush();
    void app.tree.check(); await app.flush();
    assert.equal(app.calls.length, 1); assert.equal(refreshes, 2); assert.equal(app.tree.pendingAction, 'cancel');
  } finally { app.close(); }
});

test('a retained successful approval callback cannot submit again before React rerenders', async () => {
  let approved = 0; const app = host(options(research(), { onApproved: () => { approved++; } }));
  try {
    await app.flush(); const original = app.tree.approve;
    await original(); await original(); await app.flush();
    assert.equal(app.calls.length, 1); assert.equal(approved, 1); assert.equal(app.tree.accepted, true);
  } finally { app.close(); }
});

test('a rejected amendment retains the acknowledged hold and unsent writing while the parent is stale', async () => {
  const app = host(options(), path => path.endsWith('/hold') ? held() : new Response(JSON.stringify({ code: 'plan_sources', message: 'Review sources' }), { status: 409 }));
  try {
    await app.flush(); void app.tree.hold(); await app.flush();
    app.tree.setText('Keep these changes'); await app.flush(); void app.tree.amend(); await app.flush();
    assert.equal(app.tree.item.revision, 4); assert.equal(app.tree.editing, true); assert.equal(app.tree.text, 'Keep these changes'); assert.equal(app.tree.pendingAction, undefined);
  } finally { app.close(); }
});

test('a newer server revision overrides an old acknowledged hold after automatic start elsewhere', async () => {
  const item = research(), app = host(options(item), () => held(item));
  try {
    await app.flush(); void app.tree.hold(); await app.flush(); assert.equal(app.tree.editing, true);
    await app.update({ item: { ...item, revision: 6, state: 'implementing', approval: { requestId: 'approved' }, autoStartAt: undefined } });
    assert.equal(app.tree.editing, false); assert.equal(app.tree.canAmend, false); assert.equal(app.tree.canCancel, false); assert.equal(app.tree.item.revision, 6);
  } finally { app.close(); }
});

for (const action of ['hold', 'cancel'] as const) test(`replayed ${action} reconciles a newer version started by another device without reopening editing`, async () => {
  const item = research(); let attempts = 0;
  const current = { ...item, version: 2, revision: 7, state: 'implementing', autoStartAt: undefined, approval: { requestId: 'other-approval' }, versions: [...item.versions, { ...item.versions[0], version: 2 }] };
  const app = host(options(item), () => { if (++attempts === 1) throw Error('Response lost'); return current; });
  try {
    await app.flush(); void app.tree[action](); await app.flush();
    const original = app.calls[0].body; void app.tree.retry(); await app.flush();
    assert.deepEqual(app.calls[1].body, original); assert.equal(app.tree.pendingAction, undefined);
    assert.equal(app.tree.item.version, 2); assert.equal(app.tree.item.state, 'implementing'); assert.equal(app.tree.editing, false); assert.equal(app.tree.canAmend, false); assert.equal(app.tree.canApprove, false);
    await app.update({ item: current }); assert.equal(app.tree.pendingAction, undefined); assert.equal(app.tree.item.version, 2);
  } finally { app.close(); }
});
