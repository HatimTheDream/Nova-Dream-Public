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
      export const useLayoutEffect = (f,d) => globalThis[Symbol.for('nova.test.feature-races')].effect(f,d);
      export const useCallback = (f,d) => globalThis[Symbol.for('nova.test.feature-races')].memo(f,d);
      export const useMemo = (f,d) => globalThis[Symbol.for('nova.test.feature-races')].memoValue(f,d);` };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  },
});
const { ChatGoalControl } = await import('../apps/client/src/ChatGoal');
const { QuestionCard } = await import('../apps/client/src/QuestionCard');
const { retainedWindowId } = await import('../apps/client/src/useWorkspace');
const { GeneratedOutput } = await import('../apps/client/src/GeneratedOutput');
const { PlanReviewCard, PlanReviewDecision, PlanReviewDocument } = await import('../apps/client/src/PlanReviewCard');
const { usePlanReview } = await import('../apps/client/src/plan-review-state');
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
      memoValue(read: () => unknown, deps: unknown[]) { const i = cursor++, prior = cells[i]; if (!prior || deps.some((v, n) => !Object.is(v, prior.deps[n]))) cells[i] = { deps, value: read() }; return cells[i].value; },
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
    await app.flush(); find(app.tree, node => node.type === 'button' && node.props['aria-label'] === 'Pause goal').props.onClick(); await app.flush();
    assert.equal(app.storage.size, 1);
    await app.update({ conversation: { ...conversation, id: 'chat-b', nativeId: 'native-b' } });
    result.resolve({ goal: { ...goal, status: 'paused' } }); await app.flush();
    assert.equal(app.storage.size, 0); assert.equal(find(app.tree, node => node.props?.className === 'chat-goal'), undefined);
  } finally { app.close(); }
});
test('the Goal row pauses and resumes the exact objective, then removes active controls and freezes confirmed completion', async () => {
  let result = { ...goal, createdAt: 0, updatedAt: 0 };
  const app = host(ChatGoalControl, { conversation, epoch: 'epoch', refresh: async () => {} }, (_path, init) => {
    if (init.method === 'POST') {
      const intent = JSON.parse(String(init.body));
      assert.equal(intent.goalId, goal.id); assert.equal(intent.conversationId, conversation.id); assert.equal(intent.nativeId, conversation.nativeId);
      result = { ...result, status: intent.action === 'pause' ? 'paused' : 'active', updatedAt: Date.now() };
    }
    return { goal: result };
  });
  const action = (name: string) => find(app.tree, node => node.type === 'button' && node.props['aria-label'] === name);
  try {
    await app.flush(); await app.advance(5000);
    assert.ok(action('Pause goal')); assert.equal(action('Resume goal'), undefined);
    action('Pause goal').props.onClick(); await app.flush();
    assert.equal(action('Pause goal'), undefined); assert.ok(action('Resume goal'));
    action('Resume goal').props.onClick(); await app.flush(); assert.ok(action('Pause goal'));
    result = { ...result, status: 'complete', updatedAt: 5000 }; await app.update({ activityKey: 'goal-completed' });
    assert.equal(action('Pause goal'), undefined); assert.equal(action('Resume goal'), undefined);
    assert.equal(find(app.tree, node => node.props?.['data-goal-status'])?.props['data-goal-status'], 'complete');
    assert.equal(find(app.tree, node => node.props?.className === 'goal-elapsed').props.children, '5s');
    const calls = app.calls.length; await app.advance(60000);
    assert.equal(app.calls.length, calls); assert.equal(app.activeTimers, 0);
    assert.equal(find(app.tree, node => node.props?.className === 'goal-elapsed').props.children, '5s');
  } finally { app.close(); }
});
test('an unconfirmed Goal change keeps visible recovery and retries its saved request instead of offering another action', async () => {
  let fail = true, result = goal;
  const app = host(ChatGoalControl, { conversation, epoch: 'epoch', refresh: async () => {} }, (_path, init) => {
    if (init.method === 'POST' && fail) throw Error('Connection lost after submitting the pause.');
    if (init.method === 'POST') result = { ...goal, status: 'paused' };
    return { goal: result };
  });
  try {
    await app.flush(); find(app.tree, node => node.props?.['aria-label'] === 'Pause goal').props.onClick(); await app.flush();
    assert.equal(find(app.tree, node => node.props?.['data-goal-status'])?.props['data-goal-status'], 'unconfirmed');
    assert.equal(find(app.tree, node => node.props?.['aria-label'] === 'Pause goal' || node.props?.['aria-label'] === 'Resume goal'), undefined);
    assert.ok(find(app.tree, node => node.props?.className === 'goal-recovery'));
    assert.equal(find(app.tree, node => node.props?.className === 'goal-elapsed').props['aria-label'], 'Goal elapsed time unavailable');
    const original = JSON.parse(String(app.calls.find(call => call.init.method === 'POST')!.init.body));
    fail = false; find(app.tree, node => node.type === 'button' && node.props.children === 'Retry goal change').props.onClick(); await app.flush();
    const posts = app.calls.filter(call => call.init.method === 'POST');
    assert.equal(posts.length, 2); assert.deepEqual(JSON.parse(String(posts[1].init.body)), original);
    assert.equal(app.storage.size, 0); assert.ok(find(app.tree, node => node.props?.['aria-label'] === 'Resume goal'));
  } finally { app.close(); }
});
test('a failed Goal status read does not present stale action controls or an invented elapsed time', async () => {
  let fail = false;
  const app = host(ChatGoalControl, { conversation, epoch: 'epoch', refresh: async () => {} }, () => { if (fail) throw Error('Goal status cannot be reached.'); return { goal }; });
  try {
    await app.flush();
    assert.equal(find(app.tree, node => node.props?.className === 'goal-elapsed').props['aria-label'], 'Goal elapsed time unavailable');
    fail = true; await app.update({ activityKey: 'unconfirmed-goal' });
    assert.equal(find(app.tree, node => node.props?.['data-goal-status'])?.props['data-goal-status'], 'unknown');
    assert.equal(find(app.tree, node => node.props?.['aria-label'] === 'Pause goal'), undefined);
    assert.ok(find(app.tree, node => node.props?.className === 'goal-recovery'));
    fail = false; find(app.tree, node => node.type === 'button' && node.props.children === 'Check status').props.onClick(); await app.flush();
    assert.ok(find(app.tree, node => node.props?.['aria-label'] === 'Pause goal'));
    assert.equal(app.calls.filter(call => call.init.method === 'POST').length, 0);
  } finally { app.close(); }
});
test('question header paging keeps each answer local and a rapid final Send submits the batch once', async () => {
  const receipt = deferred<any>();
  const item = { id: 'batch', revision: 4, availability: 'live', snapshot: { status: 'pending', expiresAtMs: 60000, questions: [
    { questionId: 'format', question: 'Which format?', options: [{ label: 'Brief' }, { label: 'Detailed' }] },
    { questionId: 'notes', question: 'What should stay?', options: [] },
  ] } };
  const props = { item, epoch: 'epoch', ready: true, refresh: async () => {}, compact: true };
  const wrapper = QuestionCard(props as any), app = host(wrapper.type as any, wrapper.props, () => receipt.promise);
  const writingKey = `e3:question:epoch:${retainedWindowId}:batch`;
  app.storage.set(writingKey, JSON.stringify({ choices: { format: ['Brief'] }, text: { notes: 'Keep the original title.' } }));
  const pageButton = (name: string) => find(app.tree, node => node.type === 'button' && node.props['aria-label'] === name);
  try {
    await app.flush(); pageButton('Next').props.onClick({ preventDefault() {} }); await app.flush();
    assert.equal(JSON.parse(app.storage.get(writingKey)!).activeQuestionId, 'notes'); assert.equal(app.calls.length, 0);
    pageButton('Previous').props.onClick({ preventDefault() {} }); await app.flush();
    assert.equal(JSON.parse(app.storage.get(writingKey)!).choices.format[0], 'Brief');
    pageButton('Next').props.onClick({ preventDefault() {} }); await app.flush();
    const form = find(app.tree, node => node.type === 'form');
    form.props.onSubmit({ preventDefault() {} }); form.props.onSubmit({ preventDefault() {} }); await app.flush();
    assert.equal(app.calls.length, 1);
    const sent = JSON.parse(String(app.calls[0].init.body));
    assert.equal(sent.id, 'batch'); assert.equal(sent.expectedRevision, 4); assert.equal(sent.epoch, 'epoch');
    assert.deepEqual(sent.answers, { format: ['Brief'], notes: ['Keep the original title.'] });
    receipt.resolve({}); await app.flush();
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


const reviewPlan = () => ({ id: 'plan-a', revision: 3, version: 1, state: 'ready', reviewDigest: 'a'.repeat(64), versions: [{ version: 1, digest: 'a'.repeat(64), proposal: { title: 'Review', summary: 'Retain this exact proposal.', steps: ['First'], assumptions: [], verification: ['Check'] } }] });
test('a lost plan amendment retries the original identity and text while retaining newer writing', async () => {
  const item = reviewPlan();
  let attempts = 0;
  const app = host(usePlanReview, { item, epoch: 'epoch', ready: true, refresh: async () => {} }, () => { if (++attempts === 1) throw Error('Response lost'); return { id: 'same-operation' }; });
  try {
    await app.flush(); app.tree.setText('Original change'); await app.flush();
    void app.tree.amend(); await app.flush();
    assert.equal(app.calls.length, 1); const original = JSON.parse(String(app.calls[0].init.body));
    app.tree.setText('Newer unsent writing'); await app.flush();
    void app.tree.amend(); void app.tree.approve(); await app.flush(); assert.equal(app.calls.length, 1);
    void app.tree.retry(); await app.flush();
    assert.equal(app.calls.length, 2); assert.deepEqual(JSON.parse(String(app.calls[1].init.body)), original);
    assert.equal(app.tree.text, 'Newer unsent writing');
    assert.equal(JSON.parse(app.storage.get('e3:plan-amendment:epoch:plan-a')!), 'Newer unsent writing');
  } finally { app.close(); }
});

test('Skip and return preserve plan changes without submitting or approving anything', async () => {
  const app = host(usePlanReview, { item: reviewPlan(), epoch: 'epoch', ready: true, refresh: async () => {} });
  try {
    await app.flush(); assert.equal(app.tree.decisionVisible, true);
    app.tree.setText('Keep the existing navigation.'); await app.flush();
    app.tree.skip(); await app.flush();
    assert.equal(app.tree.decisionVisible, false); assert.equal(app.tree.text, 'Keep the existing navigation.');
    assert.equal(app.calls.length, 0);
    app.tree.openDecision(); await app.flush();
    assert.equal(app.tree.decisionVisible, true); assert.equal(app.tree.text, 'Keep the existing navigation.');
    assert.equal(app.calls.length, 0);
  } finally { app.close(); }
});

test('a new saved plan version reopens its own decision and retains unsent amendment writing', async () => {
  const item = reviewPlan(), app = host(usePlanReview, { item, epoch: 'epoch', ready: true, refresh: async () => {} });
  try {
    await app.flush(); app.tree.setText('Unsent changes for later review.'); app.tree.skip(); await app.flush();
    assert.equal(app.tree.decisionVisible, false);
    await app.update({ item: { ...item, revision: 6, version: 2, reviewDigest: 'b'.repeat(64), versions: [...item.versions, { version: 2, digest: 'b'.repeat(64), proposal: { ...item.versions[0].proposal, summary: 'The current revised proposal.' } }] } });
    assert.equal(app.tree.decisionVisible, true); assert.equal(app.tree.text, 'Unsent changes for later review.');
    assert.equal(app.tree.version.version, 2); assert.equal(app.calls.length, 0);
  } finally { app.close(); }
});

test('two immediate approval actions admit one request before React can rerender', async () => {
  const receipt = deferred<any>(); let approved = 0;
  const app = host(usePlanReview, { item: reviewPlan(), epoch: 'epoch', ready: true, refresh: async () => {}, onApproved: () => { approved++; } }, () => receipt.promise);
  try {
    await app.flush(); const original = app.tree.approve;
    void original(); void original(); await app.flush();
    assert.equal(app.calls.length, 1); assert.equal(app.tree.busy, true);
    receipt.resolve({ id: 'implementation' }); await app.flush();
    assert.equal(approved, 1); assert.equal(app.calls.length, 1);
  } finally { app.close(); }
});

for (const change of ['plan', 'epoch', 'version'] as const) test(`a late plan approval cannot act on a different ${change}`, async () => {
  const item = reviewPlan(), receipt = deferred<any>(); let approved = 0;
  const app = host(usePlanReview, { item, epoch: 'epoch', ready: true, refresh: async () => {}, onApproved: () => { approved++; } }, () => receipt.promise);
  try {
    await app.flush(); void app.tree.approve(); await app.flush(); assert.equal(app.calls.length, 1);
    if (change === 'plan') await app.update({ item: { ...item, id: 'plan-b' } });
    else if (change === 'epoch') await app.update({ epoch: 'new-epoch' });
    else await app.update({ item: { ...item, version: 2, revision: 6, reviewDigest: 'b'.repeat(64), versions: [...item.versions, { ...item.versions[0], version: 2, digest: 'b'.repeat(64) }] } });
    app.tree.setText('The new review must keep this writing.'); await app.flush();
    receipt.resolve({ id: 'old-implementation' }); await app.flush();
    assert.equal(approved, 0); assert.equal(app.tree.text, 'The new review must keep this writing.');
    assert.equal(app.calls.length, 1);
  } finally { app.close(); }
});

test('a retained approval callback cannot authorize work after navigating to another review', async () => {
  const item = reviewPlan(), app = host(usePlanReview, { item, epoch: 'epoch', ready: true, refresh: async () => {} });
  try {
    await app.flush(); const approveOldReview = app.tree.approve;
    await app.update({ item: { ...item, id: 'plan-b' } });
    void approveOldReview(); await app.flush();
    assert.equal(app.calls.length, 0);
    assert.equal(app.tree.item.id, 'plan-b'); assert.equal(app.tree.canApprove, true);
  } finally { app.close(); }
});

test('a deferred decision and amendment writing survive reopening the same saved plan', async () => {
  const props = { item: reviewPlan(), epoch: 'epoch', ready: true, refresh: async () => {} };
  let app = host(usePlanReview, props);
  try {
    await app.flush(); app.tree.setText('Keep this change until I return.'); app.tree.skip(); await app.flush();
    const persisted = [...app.storage.entries()]; app.close(); app = host(usePlanReview, props);
    for (const [key, value] of persisted) app.storage.set(key, value);
    await app.flush();
    assert.equal(app.tree.decisionVisible, false); assert.equal(app.tree.text, 'Keep this change until I return.');
    app.tree.openDecision(); await app.flush();
    assert.equal(app.tree.decisionVisible, true); assert.equal(app.calls.length, 0);
  } finally { app.close(); }
});

test('an uncertain approval reopens with its exact original payload after a plan revision refresh', async () => {
  const item = reviewPlan(), props = { item, epoch: 'epoch', ready: true, refresh: async () => {} };
  let app = host(usePlanReview, props, () => { throw Error('Response lost'); });
  try {
    await app.flush(); void app.tree.approve(); await app.flush();
    const original = JSON.parse(String(app.calls[0].init.body)), persisted = [...app.storage.entries()];
    app.close(); app = host(usePlanReview, { ...props, item: { ...item, revision: item.revision + 1 } });
    for (const [key, value] of persisted) app.storage.set(key, value);
    await app.flush();
    assert.equal(app.tree.pendingAction, 'approve'); assert.equal(app.tree.canApprove, false); assert.equal(app.tree.canAmend, false);
    app.tree.setText('A later idea must not replace the pending approval.'); await app.flush();
    void app.tree.amend(); void app.tree.approve(); await app.flush(); assert.equal(app.calls.length, 0);
    void app.tree.retry(); await app.flush();
    assert.equal(app.calls.length, 1); assert.deepEqual(JSON.parse(String(app.calls[0].init.body)), original);
    assert.equal(app.tree.accepted, true); assert.equal(app.tree.decisionVisible, false);
    void app.tree.retry(); void app.tree.approve(); await app.flush(); assert.equal(app.calls.length, 1);
    assert.equal(app.tree.text, 'A later idea must not replace the pending approval.');
  } finally { app.close(); }
});

test('an uncertain decision that settles away from its plan is not stuck busy when revisited', async () => {
  const item = reviewPlan(), receipt = deferred<void>(); let attempts = 0;
  const app = host(usePlanReview, { item, epoch: 'epoch', ready: true, refresh: async () => {} }, async () => { if (++attempts === 1) { await receipt.promise; throw Error('Response lost'); } return { id: 'same-operation' }; });
  try {
    await app.flush(); void app.tree.approve(); await app.flush(); assert.equal(app.tree.busy, true);
    await app.update({ item: { ...item, id: 'plan-b' } }); assert.equal(app.tree.busy, false);
    receipt.resolve(); await app.flush();
    await app.update({ item });
    assert.equal(app.tree.busy, false); assert.equal(app.tree.pendingAction, 'approve');
    void app.tree.retry(); await app.flush();
    assert.equal(app.calls.length, 2);
    assert.deepEqual(JSON.parse(String(app.calls[1].init.body)), JSON.parse(String(app.calls[0].init.body)));
  } finally { app.close(); }
});

test('expanding an inline plan and opening its optional pane do not approve or amend it', async () => {
  const item = reviewPlan(); let panels = 0, decisions = 0;
  const review = { item, proposal: item.versions[0].proposal, decisionVisible: true, canReview: true, approve: () => { decisions++; }, amend: () => { decisions++; } };
  const app = host(PlanReviewCard, { review, onOpenPanel: () => { panels++; } });
  try {
    await app.flush();
    let expand = find(app.tree, node => node.type === 'button' && 'aria-expanded' in node.props);
    assert.equal(expand.props['aria-expanded'], false); expand.props.onClick(); await app.flush();
    expand = find(app.tree, node => node.type === 'button' && 'aria-expanded' in node.props);
    assert.equal(expand.props['aria-expanded'], true);
    assert.equal(find(app.tree, node => node.type === PlanReviewDocument)?.props.item, item);
    find(app.tree, node => node.props?.['aria-label'] === 'Open plan in side panel').props.onClick(); await app.flush();
    assert.equal(panels, 1); assert.equal(decisions, 0); assert.equal(app.calls.length, 0);
    expand.props.onClick(); await app.flush();
    assert.equal(find(app.tree, node => node.type === PlanReviewDocument), undefined);
    await app.update({ onOpenPanel: undefined });
    assert.equal(find(app.tree, node => node.props?.['aria-label'] === 'Open plan in side panel'), undefined);
  } finally { app.close(); }
});

test('the full plan reads earlier versions without changing the current approval target', async () => {
  const first = reviewPlan(), second = { ...first.versions[0], version: 2, digest: 'b'.repeat(64), proposal: { ...first.versions[0].proposal, summary: 'The current proposal.' } };
  const item = { ...first, epoch: 'epoch', version: 2, reviewDigest: second.digest, versions: [...first.versions, second] };
  const wrapper = PlanReviewDocument({ item } as any), app = host(wrapper.type as any, wrapper.props);
  try {
    await app.flush();
    assert.equal(find(app.tree, node => node.type === 'select').props.value, 2);
    assert.equal(find(app.tree, node => node.props?.proposal)?.props.proposal, second.proposal);
    find(app.tree, node => node.type === 'select').props.onChange({ target: { value: '1' } }); await app.flush();
    assert.equal(find(app.tree, node => node.props?.proposal)?.props.proposal, first.versions[0].proposal);
    assert.equal(item.version, 2); assert.equal(item.reviewDigest, second.digest);
    assert.equal(find(app.tree, node => node.type === 'button' || node.type === 'form' || node.type === 'textarea'), undefined);
    assert.equal(app.calls.length, 0);
  } finally { app.close(); }
});

test('plan-change Enter submits only an amendment while Shift and composition keep writing', async () => {
  let amended = 0, approved = 0, prevented = 0;
  const review = { item: reviewPlan(), decisionVisible: true, text: 'Use a smaller review.', canApprove: true, canAmend: true, ready: true, approve: () => { approved++; }, amend: () => { amended++; } };
  const app = host(PlanReviewDecision, { review });
  try {
    await app.flush(); const textarea = find(app.tree, node => node.type === 'textarea');
    const event = { key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: () => { prevented++; } };
    textarea.props.onKeyDown({ ...event, shiftKey: true });
    textarea.props.onKeyDown({ ...event, nativeEvent: { isComposing: true } });
    assert.equal(amended, 0); assert.equal(approved, 0); assert.equal(prevented, 0);
    textarea.props.onKeyDown(event); assert.equal(amended, 1); assert.equal(prevented, 1); assert.equal(approved, 0);
    await app.update({ review: { ...review, text: '  ' } });
    find(app.tree, node => node.type === 'form').props.onSubmit(event);
    assert.equal(amended, 1); assert.equal(approved, 0); assert.equal(app.calls.length, 0);
  } finally { app.close(); }
});
