import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const key = Symbol.for('nova.test.feature-races');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
  resolve(specifier, context, next) { return specifier === 'react' && context.parentURL?.includes('/apps/client/src/') ? { url: 'nova-test:feature-races', shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
    if (url === 'nova-test:feature-races') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      export const useState = v => globalThis[Symbol.for('nova.test.feature-races')].state(v);
      export const useRef = v => globalThis[Symbol.for('nova.test.feature-races')].ref(v);
      export const useId = () => globalThis[Symbol.for('nova.test.feature-races')].ref('test-panel').current;
      export const useEffect = (f,d) => globalThis[Symbol.for('nova.test.feature-races')].effect(f,d);
      export const useCallback = (f,d) => globalThis[Symbol.for('nova.test.feature-races')].memo(f,d);` };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  },
});
const { ChatGoalControl } = await import('../apps/client/src/ChatGoal');
const { GeneratedOutput } = await import('../apps/client/src/GeneratedOutput');
const { PlanReviewCard } = await import('../apps/client/src/PlanReviewCard');
const { StepsPill } = await import('../apps/client/src/ToolActivity');
loader.deregister();

function host(component: (props: any) => any, initial: any, respond: (path: string, init: RequestInit) => unknown | Promise<unknown> = () => ({})) {
  let props = initial, cursor = 0, dirty = true, now = 0, timerId = 0, tree: any;
  const cells: any[] = [], effects: (() => void)[] = [], calls: { path: string; init: RequestInit }[] = [], storage = new Map<string, string>();
  const timers = new Map<number, { at: number; run: () => void; interval?: number }>();
  const document = Object.assign(new EventTarget(), { hidden: false, querySelector: () => null, createElement: () => ({ click: () => { downloads++; } }) });
  const window = new EventTarget(); let downloads = 0;
  const setTimer = (run: () => void, delay: number, interval?: number) => { const id = ++timerId; timers.set(id, { at: now + delay, run, interval }); return id; };
  const values: Record<PropertyKey, unknown> = {
    [key]: {
      state(value: any) { const i = cursor++; if (!cells[i]) cells[i] = { value: typeof value === 'function' ? value() : value }; return [cells[i].value, (next: any) => { const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true; } }]; },
      ref(value: any) { return cells[cursor++] ??= { current: value }; },
      effect(run: () => void | (() => void), deps: unknown[]) { const i = cursor++, prior = cells[i]; if (!prior || deps.some((v, n) => !Object.is(v, prior.deps[n]))) { cells[i] = { deps, cleanup: prior?.cleanup }; effects.push(() => { cells[i].cleanup?.(); cells[i].cleanup = run(); }); } },
      memo(value: any, deps: unknown[]) { const i = cursor++, prior = cells[i]; if (!prior || deps.some((v, n) => !Object.is(v, prior.deps[n]))) cells[i] = { deps, value }; return cells[i].value; },
    }, document, window,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } },
    setTimeout: (run: () => void, delay: number) => setTimer(run, delay), clearTimeout: (id: number) => timers.delete(id),
    setInterval: (run: () => void, delay: number) => setTimer(run, delay, delay), clearInterval: (id: number) => timers.delete(id),
    fetch: async (path: string, init: RequestInit) => { calls.push({ path, init }); const value = await respond(path, init); return new Response(JSON.stringify(value), { status: 200 }); },
  };
  const originals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const originalNow = Date.now; Date.now = () => now;
  const flush = async () => { for (let pass = 0; pass < 25; pass++) { if (dirty) { dirty = false; cursor = 0; tree = component(props); while (effects.length) effects.shift()!(); } for (let tick = 0; tick < 10; tick++) await Promise.resolve(); } };
  const unmount = () => { for (const cell of cells) { cell?.cleanup?.(); if (cell) cell.cleanup = undefined; } };
  return {
    calls, storage, flush, get tree() { return tree; }, get downloads() { return downloads; }, get activeTimers() { return timers.size; },
    async update(next: any) { props = { ...props, ...next }; dirty = true; await flush(); },
    async advance(ms: number) { const until = now + ms; for (;;) { const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; const [id, timer] = next; timers.delete(id); now = timer.at; if (timer.interval) timers.set(id, { ...timer, at: now + timer.interval }); timer.run(); await flush(); } now = until; await flush(); },
    unmount, close() { unmount(); Date.now = originalNow; for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); },
  };
}
function find(tree: any, match: (node: any) => boolean): any { if (!tree || typeof tree !== 'object') return; if (Array.isArray(tree)) return tree.map(child => find(child, match)).find(Boolean); return match(tree) ? tree : find(tree.props?.children, match); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const conversation = { id: 'chat-a', nativeId: 'native-a', archived: false };
const goal = { id: 'goal-a', status: 'active', objective: 'Finish the fixture' };

test('an expanded step dock and its timer disappear when the run completes without another plan update', async () => {
  const operation = { id: 'same-operation', state: 'running', createdAt: '2026-09-21T00:00:00Z', updatedAt: '2026-09-21T00:00:05Z' };
  const plan = [{ id: 'first', label: 'Inspect', status: 'complete' }, { id: 'second', label: 'Finish', status: 'active' }];
  const app = host(StepsPill, { operation, plan });
  try {
    await app.flush(); find(app.tree, node => node.type === 'button').props.onClick(); await app.flush();
    assert.ok(find(app.tree, node => node.props?.role === 'region'));
    assert.equal(app.activeTimers, 1);
    await app.update({ operation: { ...operation, state: 'completed' } });
    assert.equal(app.tree, null); assert.equal(app.activeTimers, 0);
    await app.advance(60000); assert.equal(app.tree, null);
    assert.equal(plan[1].status, 'active');
  } finally { app.close(); }
});

test('Goal stops recurring reads when empty and resumes active retries after an activity-triggered failure', async () => {
  let result: any = null, fail = false;
  const app = host(ChatGoalControl, { conversation, epoch: 'epoch', refresh: async () => {} }, () => { if (fail) throw Error('Temporary interruption'); return { goal: result }; });
  try {
    await app.flush(); await app.advance(90000); assert.equal(app.calls.length, 1);
    result = goal; await app.update({ activityKey: 'goal-started' }); assert.equal(app.calls.length, 2);
    fail = true; await app.update({ activityKey: 'goal-running' }); const afterFailure = app.calls.length;
    await app.advance(15000); assert.equal(app.calls.length, afterFailure + 1, 'An already active goal keeps its retry cadence after a failed restart read');
    fail = false; result = { ...goal, status: 'paused' }; await app.advance(30000); const afterPause = app.calls.length;
    await app.advance(90000); assert.equal(app.calls.length, afterPause);
  } finally { app.close(); }
});
test('late Goal mutation receipts clear only their original recovery intent and never populate another chat', async () => {
  const result = deferred<any>();
  const app = host(ChatGoalControl, { conversation, epoch: 'epoch', refresh: async () => {} }, (path, init) => init.method === 'POST' ? result.promise : { goal: path.endsWith('chat-a') ? goal : null });
  try {
    await app.flush(); find(app.tree, node => node.type === 'button' && node.props.children === 'Pause goal').props.onClick(); await app.flush();
    assert.equal(app.storage.size, 1);
    await app.update({ conversation: { ...conversation, id: 'chat-b', nativeId: 'native-b' } });
    result.resolve({ goal: { ...goal, status: 'paused' } }); await app.flush();
    assert.equal(app.storage.size, 0); assert.equal(find(app.tree, node => node.props?.className === 'chat-goal'), undefined);
  } finally { app.close(); }
});
for (const action of ['View image', 'Download', 'Refine']) test(`a late image save cannot ${action.toLowerCase()} after leaving its message`, async () => {
  const saving = deferred<any>(); let opened = 0, refined = 0, saves = 0;
  const file = { id: 'image-file', name: 'Image.png', sha256: 'hash' };
  const app = host(GeneratedOutput, { conversation, epoch: 'epoch', message: { id: 'message-a', textHash: 'hash', attachments: [] }, attachment: { artifactId: 'artifact-a', name: 'Image.png', type: 'image' }, controller: { outputs: [], saveArtifact: () => { saves++; return saving.promise; } }, blocked: false, open: () => { opened++; }, refine: async () => { refined++; }, contentActions: {} });
  try {
    await app.flush(); const button = find(app.tree, node => node.type === 'button' && (node.props.children === action || Array.isArray(node.props.children) && node.props.children.includes(action)));
    button.props.onClick(); button.props.onClick(); await app.flush(); assert.equal(saves, 1);
    await app.update({ message: { id: 'message-b', textHash: 'new-hash', attachments: [] } });
    saving.resolve({ id: 'saved', file }); await app.flush();
    assert.equal(opened, 0); assert.equal(refined, 0); assert.equal(app.downloads, 0);
  } finally { app.close(); }
});
test('image actions still open the exact saved original when the current message remains selected', async () => {
  const saving = deferred<any>(); let opened: any;
  const file = { id: 'image-file', name: 'Image.png', sha256: 'hash' };
  const app = host(GeneratedOutput, { conversation, epoch: 'epoch', message: { id: 'message-a', textHash: 'hash', attachments: [] }, attachment: { artifactId: 'artifact-a', name: 'Image.png', type: 'image' }, controller: { outputs: [], saveArtifact: () => saving.promise }, blocked: false, open: (value: unknown) => { opened = value; }, refine: async () => {}, contentActions: {} });
  try { await app.flush(); find(app.tree, node => node.type === 'button' && node.props.children === 'View image').props.onClick(); saving.resolve({ id: 'saved', file }); await app.flush(); assert.deepEqual(opened, file); }
  finally { app.close(); }
});

for (const restriction of ['blocked', 'archived']) test(`a pending image save cannot refine after the current chat becomes ${restriction}`, async () => {
  const saving = deferred<any>(); let refined = 0;
  const app = host(GeneratedOutput, { conversation, epoch: 'epoch', message: { id: 'message-a', textHash: 'hash', attachments: [] }, attachment: { artifactId: 'artifact-a', name: 'Image.png', type: 'image' }, controller: { outputs: [], saveArtifact: () => saving.promise }, blocked: false, refine: async () => { refined++; }, contentActions: {} });
  try {
    await app.flush(); find(app.tree, node => node.type === 'button' && node.props.children === 'Refine').props.onClick(); await app.flush();
    await app.update(restriction === 'blocked' ? { blocked: true } : { conversation: { ...conversation, archived: true } });
    saving.resolve({ id: 'saved', file: { id: 'image-file', name: 'Image.png', sha256: 'hash' } }); await app.flush();
    assert.equal(refined, 0);
  } finally { app.close(); }
});


test('a lost plan amendment retries the original identity and text while retaining newer writing', async () => {
  const item = { id: 'plan-a', revision: 3, version: 1, state: 'ready', reviewDigest: 'hash', versions: [{ version: 1, proposal: { title: 'Review', summary: 'Retain this exact proposal.', steps: ['First'], assumptions: [], verification: ['Check'] } }] };
  let attempts = 0;
  const app = host(PlanReviewCard, { item, epoch: 'epoch', ready: true, refresh: async () => {} }, () => { if (++attempts === 1) throw Error('Response lost'); return { id: 'same-operation' }; });
  try {
    await app.flush(); find(app.tree, node => node.type === 'button' && node.props.children === 'Request changes').props.onClick(); await app.flush();
    find(app.tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Original change' } }); await app.flush();
    find(app.tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await app.flush();
    assert.equal(app.calls.length, 1); const original = JSON.parse(String(app.calls[0].init.body));
    find(app.tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Newer unsent writing' } }); await app.flush();
    find(app.tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await app.flush(); assert.equal(app.calls.length, 1);
    find(app.tree, node => node.type === 'button' && node.props.children === 'Retry original decision').props.onClick(); await app.flush();
    assert.equal(app.calls.length, 2); assert.deepEqual(JSON.parse(String(app.calls[1].init.body)), original);
    assert.equal(find(app.tree, node => node.type === 'textarea').props.value, 'Newer unsent writing');
    assert.equal(JSON.parse(app.storage.get('e3:plan-amendment:epoch:plan-a')!), 'Newer unsent writing');
  } finally { app.close(); }
});
