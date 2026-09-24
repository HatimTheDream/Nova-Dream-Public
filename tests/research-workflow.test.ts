import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const key = Symbol.for('nova.test.research-workflow');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
  resolve(specifier, context, next) { return specifier === 'react' && /\/(ResearchWorkflow\.tsx|research-review-state\.ts)$/.test(context.parentURL ?? '') ? { url: 'nova-test:research-workflow', shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
    if (url === 'nova-test:research-workflow') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      export const useState = value => globalThis[Symbol.for('nova.test.research-workflow')].state(value);
      export const useRef = value => globalThis[Symbol.for('nova.test.research-workflow')].ref(value);
      export const useEffect = (run,deps) => globalThis[Symbol.for('nova.test.research-workflow')].effect(run,deps);` };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  },
});
const { ResearchWorkflow } = await import('../apps/client/src/ResearchWorkflow');
loader.deregister();

function host(initial: any, respond: (path: string, body: any) => unknown | Promise<unknown> = () => ({ id: 'operation' })) {
  let props = initial, cursor = 0, dirty = true, tree: any, now = Date.parse('2026-09-23T12:00:00Z'), timerId = 0;
  const cells: any[] = [], effects: (() => void)[] = [], calls: { path: string; body: any }[] = [], storage = new Map<string, string>(), timers = new Map<number, { at: number; run: () => void; interval: number }>();
  const values: Record<PropertyKey, unknown> = {
    [key]: {
      state(value: any) { const index = cursor++; if (!cells[index]) cells[index] = { value: typeof value === 'function' ? value() : value }; return [cells[index].value, (next: any) => { const value = typeof next === 'function' ? next(cells[index].value) : next; if (!Object.is(cells[index].value, value)) { cells[index].value = value; dirty = true; } }]; },
      ref(value: any) { return cells[cursor++] ??= { current: value }; },
      effect(run: () => void | (() => void), deps: unknown[]) { const index = cursor++, old = cells[index]; if (!old || deps.some((value, offset) => !Object.is(value, old.deps[offset]))) { cells[index] = { deps, cleanup: old?.cleanup }; effects.push(() => { cells[index].cleanup?.(); cells[index].cleanup = run(); }); } },
    },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    setInterval: (run: () => void, interval: number) => { const id = ++timerId; timers.set(id, { at: now + interval, run, interval }); return id; },
    clearInterval: (id: number) => timers.delete(id),
    fetch: async (path: string, init: RequestInit) => { const body = JSON.parse(String(init.body)); calls.push({ path, body }); const result = await respond(path, body); return new Response(JSON.stringify(result)); },
  };
  const originals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const originalNow = Date.now; Date.now = () => now;
  const flush = async () => { for (let pass = 0; pass < 25; pass++) { if (dirty) { dirty = false; cursor = 0; tree = ResearchWorkflow(props); while (effects.length) effects.shift()!(); } for (let tick = 0; tick < 10; tick++) await Promise.resolve(); } };
  return { calls, storage, flush, get tree() { return tree; }, get timers() { return timers.size; },
    async update(next: any) { props = { ...props, ...next }; dirty = true; await flush(); },
    async advance(ms: number) { const until = now + ms; for (;;) { const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; const [id, timer] = next; now = timer.at; timers.set(id, { ...timer, at: now + timer.interval }); timer.run(); await flush(); } now = until; await flush(); },
    close() { for (const cell of cells) cell?.cleanup?.(); Date.now = originalNow; for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); },
  };
}
const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
const text = (node: any): string => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : '';
const button = (tree: any, label: string) => nodes(tree).find(node => node.type === 'button' && text(node) === label);
const labelledButton = (tree: any, label: string) => nodes(tree).find(node => node.type === 'button' && node.props['aria-label'] === label);
const byClass = (tree: any, name: string) => nodes(tree).filter(node => node.props?.className?.split(' ').includes(name));
const progress = (tree: any) => nodes(tree).find(node => node.props.role === 'progressbar');
const statusText = (tree: any) => nodes(tree).filter(node => node.props.role === 'status').map(text).join(' ');
const rows = (tree: any) => nodes(tree).filter(node => node.type === 'li');
const assertProgress = (tree: any) => {
  const bar = progress(tree); assert.ok(bar, 'Research activity needs an accessible progress indicator');
  assert.equal(bar.props['aria-valuemin'], undefined); assert.equal(bar.props['aria-valuemax'], undefined); assert.equal(bar.props['aria-valuenow'], undefined);
  assert.equal(typeof bar.props['aria-valuetext'], 'string'); assert.ok(bar.props['aria-valuetext'].length > 0);
  assert.notEqual(bar.props['aria-hidden'], true);
  assert.doesNotMatch(text(tree) + bar.props['aria-valuetext'], /\d+ of \d+ research steps complete|\d+%/i, 'A changing checklist is not an overall-work denominator');
  assert.equal(byClass(bar, 'research-progress-fill').length, 0, 'Checklist completion must not invent an overall completed segment');
  return bar;
};
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
const item = (extra: any = {}) => ({ id: 'research-a', epoch: 'epoch', kind: 'research', conversationId: 'chat-a', revision: 3, version: 1, state: 'ready', reviewDigest: 'a'.repeat(64), autoStartAt: '2026-09-23T12:00:45Z', versions: [{ version: 1, operationId: 'plan-operation', digest: 'a'.repeat(64), proposal: { title: 'How seasons work', summary: 'Compare primary sources.', steps: ['Proposed search', 'Proposed comparison'], assumptions: [], verification: ['Cite sources'] } }], ...extra });
const operation = (extra: any = {}) => ({ id: 'research-operation', epoch: 'epoch', conversationId: 'chat-a', nativeId: 'native-session', nativeKey: 'agent:main:e3:research-fixture', connectionGeneration: 'generation', nativeRunId: 'native-run', state: 'running', context: { workMode: 'research', researchWorkflow: 'chat-research-v1', approvedPlan: { id: 'research-a', version: 1, digest: 'a'.repeat(64), proposal: item().versions[0].proposal } }, createdAt: '2026-09-23T11:59:00Z', updatedAt: '2026-09-23T11:59:30Z', plan: [{ id: 'source', label: 'Proposed search', detail: '', status: 'complete' }, { id: 'verify', label: 'Proposed comparison', detail: 'Comparing measurements from primary sources', status: 'active' }, { id: 'report', label: 'New runtime-only milestone', detail: '', status: 'waiting' }], planSequence: 1, tools: [{ id: 'search', name: 'web_search', title: 'Search', state: 'running', input: 'Earth seasons axial tilt', sequence: 2 }], ...extra });
const active = (extra: any = {}) => item({ state: 'implementing', autoStartAt: undefined, approval: { requestId: 'approved', operationId: 'research-operation', version: 1, digest: 'a'.repeat(64) }, ...extra });
const question = (extra: any = {}) => ({ id: 'a'.repeat(64), epoch: 'epoch', revision: 1, conversationId: 'chat-a', nativeId: 'native-session', nativeKey: 'agent:main:e3:research-fixture', connectionGeneration: 'generation', availability: 'live', fingerprint: 'fingerprint', snapshot: { id: 'question-a', sessionKey: 'agent:main:e3:research-fixture', runId: 'native-run', status: 'pending', questions: [{ questionId: 'scope', header: 'Scope', question: 'Which region should I compare?', options: [] }], createdAtMs: 1790164700000, expiresAtMs: 1790165900000 }, ...extra });
const props = (research = item(), extra: any = {}) => ({ item: research, operations: [], epoch: 'epoch', ready: true, connected: true, connectionGeneration: 'generation', questions: [], refresh: async () => {}, ...extra });

test('the inline ready card counts down to the server deadline without dispatching research itself', async () => {
  const app = host(props());
  try {
    await app.flush(); assert.equal(app.tree.type, 'section'); assert.equal(app.tree.props['aria-label'], 'Research');
    assert.equal(nodes(app.tree).some(node => node.props.role === 'dialog' || node.props['aria-modal']), false);
    assert.equal(byClass(app.tree, 'research-countdown')[0].props['aria-label'], 'Starts automatically in 45 seconds');
    assert.equal(button(app.tree, 'Edit').props.disabled, false); assert.equal(button(app.tree, 'Cancel').props.disabled, false);
    assert.deepEqual(nodes(app.tree).filter(node => node.type === 'li').map(node => node.props['data-state']), ['waiting', 'waiting']);
    await app.advance(14000); assert.equal(text(byClass(app.tree, 'research-countdown')[0]), '31');
    await app.advance(31000); assert.ok(button(app.tree, 'Starting…')); assert.equal(app.calls.length, 0);
  } finally { app.close(); }
});

test('Edit waits for server Hold, then displays an inline form and submits the returned revision', async () => {
  const gate = deferred<any>(), original = item();
  const app = host(props(original), path => path.endsWith('/hold') ? gate.promise : { id: 'amendment-operation' });
  try {
    await app.flush(); button(app.tree, 'Edit').props.onClick(); await app.flush();
    assert.equal(app.calls[0].path, '/api/assistant/plan/hold'); assert.equal(nodes(app.tree).some(node => node.type === 'textarea'), false);
    gate.resolve({ ...original, revision: 4, autoStartAt: undefined, autoStartHeld: 'editing' }); await app.flush();
    const form = nodes(app.tree).find(node => node.type === 'form'), textarea = nodes(form).find(node => node.type === 'textarea');
    assert.ok(form); assert.ok(textarea); assert.equal(app.tree.type, 'section'); assert.equal(app.timers, 0);
    assert.equal(byClass(app.tree, 'research-countdown').length, 0); assert.equal(nodes(app.tree).some(node => node.props.role === 'dialog'), false);
    textarea.props.onChange({ target: { value: 'Prefer NASA and NOAA.' } }); await app.flush();
    assert.equal(button(app.tree, 'Save changes').props.disabled, false);
    nodes(app.tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await app.flush();
    assert.equal(app.calls[1].path, '/api/assistant/plan/amend'); assert.equal(app.calls[1].body.expectedRevision, 4); assert.equal(app.calls[1].body.text, 'Prefer NASA and NOAA.');
  } finally { app.close(); }
});

test('an unconfirmed Hold keeps editing closed and shows recovery for the original decision', async () => {
  const app = host(props(), () => { throw Error('Connection interrupted'); });
  try {
    await app.flush(); button(app.tree, 'Edit').props.onClick(); await app.flush();
    assert.equal(nodes(app.tree).some(node => node.type === 'textarea'), false);
    assert.ok(button(app.tree, 'Check status')); assert.ok(button(app.tree, 'Retry original decision'));
    assert.equal(button(app.tree, 'Edit').props.disabled, true); assert.equal(button(app.tree, 'Cancel').props.disabled, true);
    assert.ok(nodes(app.tree).find(node => node.props.role === 'alert'));
  } finally { app.close(); }
});

test('Start research submits the reviewed proposal exactly once through its decision endpoint', async () => {
  const app = host(props());
  try {
    await app.flush(); const start = byClass(app.tree, 'research-start')[0];
    start.props.onClick(); start.props.onClick(); await app.flush();
    assert.equal(app.calls.length, 1); assert.equal(app.calls[0].path, '/api/assistant/plan/approve');
    assert.equal(app.calls[0].body.id, 'research-a'); assert.equal(app.calls[0].body.expectedRevision, 3); assert.equal(app.calls[0].body.version, 1); assert.equal(app.calls[0].body.digest, 'a'.repeat(64));
    assert.equal(byClass(app.tree, 'research-start')[0].props.disabled, true);
  } finally { app.close(); }
});

test('Cancel waits for server acknowledgement and retains the numbered proposal as cancelled', async () => {
  const gate = deferred<any>(), original = item(), app = host(props(original), () => gate.promise);
  try {
    await app.flush(); button(app.tree, 'Cancel').props.onClick(); await app.flush();
    assert.equal(app.calls[0].path, '/api/assistant/plan/cancel'); assert.doesNotMatch(text(app.tree), /Research cancelled/);
    gate.resolve({ ...original, revision: 4, state: 'cancelled', autoStartAt: undefined }); await app.flush();
    assert.match(text(app.tree), /Research cancelled/); assert.equal(nodes(app.tree).filter(node => node.type === 'li').length, 2);
    assert.equal(byClass(app.tree, 'research-countdown').length, 0); assert.equal(app.timers, 0); assert.equal(byClass(app.tree, 'research-progress--running').length, 0);
  } finally { app.close(); }
});

test('active research keeps approved proposal rows and shows a specific observed subtask for the exact operation', async () => {
  const stopped: string[] = [], updated: string[] = [];
  const app = host(props(active(), { operations: [operation()], stop: (id: string) => stopped.push(id), update: (id: string) => updated.push(id) }));
  try {
    await app.flush();
    const steps = nodes(app.tree).filter(node => node.type === 'li');
    assert.deepEqual(steps.map(node => node.props['data-state']), ['complete', 'active']);
    assert.match(text(steps[0]), /Proposed search/); assert.match(text(steps[1]), /Proposed comparison/);
    assert.doesNotMatch(text(app.tree), /New runtime-only milestone/);
    assert.match(statusText(app.tree), /Earth seasons axial tilt/); assertProgress(app.tree);
    assert.doesNotMatch(text(app.tree), /Researching for|1m 0s|1 of 3 research steps complete/);
    assert.equal(byClass(app.tree, 'research-current-tool').length, 0); assert.equal(app.timers, 0);
    const stopControl = labelledButton(app.tree, 'Stop research'); assert.ok(stopControl);
    assert.equal(text(stopControl), '', 'Stop is icon-only with an accessible action name');
    const row = byClass(app.tree, 'research-progress-row')[0], region = byClass(app.tree, 'research-progress-region')[0];
    assert.ok(row); assert.equal(nodes(row).includes(stopControl), true); assert.equal(nodes(row).includes(progress(app.tree)), true);
    assert.ok(nodes(row).indexOf(progress(app.tree)) < nodes(row).indexOf(stopControl), 'Stop follows the bar in its row');
    const status = nodes(region).find(node => node.props.role === 'status'); assert.match(text(status), /Earth seasons axial tilt/);
    assert.ok(nodes(region).indexOf(status) < nodes(region).indexOf(row), 'The research status sits above the progress row');
    button(app.tree, 'Update').props.onClick(); stopControl.props.onClick();
    assert.deepEqual(updated, ['research-operation']); assert.deepEqual(stopped, ['research-operation']); assert.equal(app.calls.length, 0);
    assert.equal(nodes(app.tree).some(node => node.props.role === 'dialog' || node.props['aria-modal']), false);
  } finally { app.close(); }
});

test('a pending Stop keeps honest stopping status and removes animated progress and live tools', async () => {
  const app = host(props(active(), { operations: [operation({ cancelRequested: true })], stop() {}, update() {} }));
  try {
    await app.flush(); assert.equal(byClass(app.tree, 'research-progress--running').length, 0); assertProgress(app.tree);
    assert.equal(nodes(app.tree).some(node => node.props['data-state'] === 'active'), false);
    assert.equal(byClass(app.tree, 'research-current-tool').length, 0); assert.equal(button(app.tree, 'Update'), undefined);
    const stopControl = labelledButton(app.tree, 'Stopping research'); assert.ok(stopControl);
    assert.equal(stopControl.props.disabled, true); assert.equal(text(stopControl), ''); assert.match(text(app.tree), /Stopping/); assert.equal(app.timers, 0);
  } finally { app.close(); }
});

test('Stop and Update wait for a captured native run identity', async () => {
  const app = host(props(active(), { operations: [operation({ state: 'prepared', nativeRunId: null })], stop() {}, update() {} }));
  try {
    await app.flush(); assert.equal(labelledButton(app.tree, 'Stop research').props.disabled, true); assert.equal(button(app.tree, 'Update').props.disabled, true);
    assert.equal(app.calls.length, 0);
  } finally { app.close(); }
});

test('unknown research freezes progress and offers a read-only status check', async () => {
  let refreshed = 0;
  const app = host(props(active({ state: 'unknown' }), { operations: [operation({ state: 'unknown' })], refresh: async () => { refreshed++; }, stop() {}, update() {} }));
  try {
    await app.flush(); assert.equal(app.timers, 0); assert.equal(byClass(app.tree, 'research-progress--running').length, 0); assertProgress(app.tree);
    assert.equal(nodes(app.tree).some(node => node.props['data-state'] === 'active'), false);
    assert.match(text(app.tree), /Checking|unconfirmed/); assert.equal(labelledButton(app.tree, 'Stop research'), undefined); assert.equal(button(app.tree, 'Update'), undefined);
    button(app.tree, 'Check status').props.onClick(); await app.flush(); assert.equal(refreshed, 1); assert.equal(app.calls.length, 0);
  } finally { app.close(); }
});

test('an operation becoming unknown before the plan refresh also freezes and exposes recovery', async () => {
  const app = host(props(active(), { operations: [operation()], stop() {}, update() {} }));
  try {
    await app.flush(); assert.equal(app.timers, 0);
    await app.update({ operations: [operation({ state: 'unknown' })] });
    assert.equal(app.timers, 0); assert.equal(byClass(app.tree, 'research-progress--running').length, 0);
    assert.match(text(app.tree), /Checking|unconfirmed/); assert.ok(button(app.tree, 'Check status')); assertProgress(app.tree);
    await app.advance(120000); assertProgress(app.tree);
  } finally { app.close(); }
});

for (const mismatch of ['conversation', 'workflow'] as const) test(`an operation from another ${mismatch} cannot supply active steps or controls`, async () => {
  const other = operation(mismatch === 'conversation' ? { conversationId: 'chat-b' } : { context: { workMode: 'research' } });
  const app = host(props(active(), { operations: [other], stop() {}, update() {} }));
  try {
    await app.flush(); assert.equal(byClass(app.tree, 'research-progress--running').length, 0); assert.equal(app.timers, 0);
    assert.equal(labelledButton(app.tree, 'Stop research'), undefined); assert.equal(button(app.tree, 'Update'), undefined);
    assert.doesNotMatch(text(app.tree), /Found primary sources|Compare the evidence/);
  } finally { app.close(); }
});

test('the completed workflow card disappears and clears its countdown interval', async () => {
  const original = item(), app = host(props(original));
  try {
    await app.flush(); assert.equal(app.timers, 1);
    await app.update({ item: { ...original, state: 'completed', autoStartAt: undefined } });
    assert.equal(app.tree, null); assert.equal(app.timers, 0);
    await app.advance(120000); assert.equal(app.tree, null); assert.equal(app.calls.length, 0);
  } finally { app.close(); }
});

test('the confirmed approved operation finishing removes the workflow before a lagging plan refresh', async () => {
  const app = host(props(active(), { operations: [operation()] }));
  try {
    await app.flush(); assert.ok(app.tree); assert.equal(app.timers, 0);
    await app.update({ operations: [operation({ state: 'completed', settledAt: '2026-09-23T12:00:00Z' })] });
    assert.equal(app.tree, null); assert.equal(app.timers, 0);
  } finally { app.close(); }
});

test('starting research clears the ready countdown timer and does not add an inner elapsed timer', async () => {
  const app = host(props(item(), { stop() {} }));
  try {
    await app.flush(); assert.equal(app.timers, 1);
    await app.update({ item: active(), operations: [operation()] });
    assert.equal(app.timers, 0); assert.equal(byClass(app.tree, 'research-countdown').length, 0);
    await app.advance(300000); assert.equal(app.timers, 0); assertProgress(app.tree);
    assert.match(statusText(app.tree), /Earth seasons axial tilt/); assert.doesNotMatch(text(app.tree), /Researching for|\d+m \d+s/);
    assert.equal(app.calls.length, 0);
  } finally { app.close(); }
});

test('completed preparation does not hide the unapproved research proposal', async () => {
  const app = host(props(item(), { operations: [operation({ id: 'plan-operation', state: 'completed' })] }));
  try {
    await app.flush(); assert.ok(app.tree); assert.equal(button(app.tree, 'Edit').props.disabled, false);
    assert.equal(byClass(app.tree, 'research-countdown').length, 1); assert.equal(byClass(app.tree, 'research-progress--running').length, 0);
  } finally { app.close(); }
});

test('a restarted hold has no invented countdown and still offers explicit review and start', async () => {
  const app = host(props(item({ autoStartAt: undefined, autoStartHeld: 'restarted' })));
  try {
    await app.flush(); assert.equal(byClass(app.tree, 'research-countdown').length, 0); assert.equal(app.timers, 0);
    assert.equal(button(app.tree, 'Start research').props.disabled, false); assert.equal(button(app.tree, 'Edit').props.disabled, false);
    assert.match(text(app.tree), /Ready when you are/);
  } finally { app.close(); }
});

test('read-only research presents an existing amendment as read-only and disables submission', async () => {
  const app = host(props(item({ autoStartAt: undefined, autoStartHeld: 'editing' }), { readOnly: true }));
  try {
    await app.flush(); const textarea = nodes(app.tree).find(node => node.type === 'textarea'); assert.ok(textarea);
    assert.ok(textarea.props.readOnly || textarea.props.disabled); assert.equal(button(app.tree, 'Save changes').props.disabled, true);
    assert.equal(app.calls.length, 0);
  } finally { app.close(); }
});

test('runtime checklist changes never replace approved rows or invent an overall research percentage', async () => {
  const observed = operation(), app = host(props(active(), { operations: [observed] }));
  try {
    await app.flush(); assertProgress(app.tree); const originalLabels = rows(app.tree).map(node => text(node.props.children[1]).replace(/ · .*/, ''));
    await app.advance(30000); assertProgress(app.tree);
    const revised = { ...observed, plan: observed.plan.map((step: any) => step.id === 'verify' ? { ...step, status: 'complete' } : step) };
    await app.update({ operations: [revised] }); assertProgress(app.tree);
    assert.deepEqual(rows(app.tree).map(node => node.props['data-state']), ['complete', 'complete']);
    assert.doesNotMatch(text(app.tree), /\d+ of \d+ research steps complete/i);
    assert.doesNotMatch(text(app.tree), /\d+% (?:of (?:the )?)?(?:work|research|effort|time)/i);
    const extended = { ...revised, plan: [...revised.plan, { id: 'check', label: 'Check a newly discovered source', status: 'waiting' }] };
    await app.update({ operations: [extended] }); assertProgress(app.tree);
    assert.deepEqual(rows(app.tree).map(node => text(node.props.children[1]).replace(/ · .*/, '')), originalLabels);
    assert.doesNotMatch(text(app.tree), /Check a newly discovered source/);
    await app.update({ operations: [operation({ plan: [{ id: 'replacement', label: 'A different runtime checklist', detail: '', status: 'complete' }] })] });
    assert.deepEqual(rows(app.tree).map(node => text(node.props.children[1]).replace(/ · .*/, '')), originalLabels);
    assert.deepEqual(rows(app.tree).map(node => node.props['data-state']), ['waiting', 'waiting']);
    assertProgress(app.tree);
  } finally { app.close(); }
});

for (const plan of [undefined, []]) test(`research with ${plan ? 'an empty' : 'no'} observed step list stays indeterminate despite proposal steps`, async () => {
  const app = host(props(active(), { operations: [operation({ plan })] }));
  try {
    await app.flush(); const bar = progress(app.tree); assert.ok(bar);
    assert.equal(bar.props['aria-valuenow'], undefined); assert.equal(bar.props['aria-valuemax'], undefined);
    assert.equal(byClass(app.tree, 'research-progress--running').length, 1);
    assert.deepEqual(nodes(app.tree).filter(node => node.type === 'li').map(node => node.props['data-state']), ['waiting', 'waiting']);
    assert.doesNotMatch(text(app.tree), /\d+ of \d+ research steps complete/i);
    await app.advance(60000); assert.equal(progress(app.tree).props['aria-valuenow'], undefined);
  } finally { app.close(); }
});

for (const state of ['unknown', 'cancelled', 'failed'] as const) test(`${state} research preserves its proposal and observed completion without animating or inventing a fraction`, async () => {
  const observed = operation({ state }), app = host(props(active({ state }), { operations: [observed] }));
  try {
    await app.flush(); assertProgress(app.tree); assert.equal(app.timers, 0);
    assert.equal(byClass(app.tree, 'research-progress--running').length, 0); assert.equal(nodes(app.tree).some(node => node.props['data-state'] === 'active'), false);
    assert.equal(rows(app.tree)[0].props['data-state'], 'complete');
    await app.advance(300000); assertProgress(app.tree); assert.equal(app.calls.length, 0);
  } finally { app.close(); }
});

test('an unapproved proposal never borrows completed steps from its planning operation', async () => {
  const app = host(props(item(), { operations: [operation({ id: 'plan-operation', state: 'completed' })] }));
  try {
    await app.flush(); assert.equal(progress(app.tree), undefined);
    assert.deepEqual(nodes(app.tree).filter(node => node.type === 'li').map(node => node.props['data-state']), ['waiting', 'waiting']);
    assert.doesNotMatch(text(app.tree), /\d+ of \d+ research steps complete/i);
  } finally { app.close(); }
});

test('unknown research without observed steps has no invented percentage or moving indicator', async () => {
  const app = host(props(active({ state: 'unknown' }), { operations: [operation({ state: 'unknown', plan: undefined })] }));
  try {
    await app.flush(); const bar = progress(app.tree); assert.ok(bar);
    assert.equal(bar.props['aria-valuenow'], undefined); assert.equal(bar.props['aria-valuemax'], undefined);
    assert.equal(byClass(app.tree, 'research-progress--running').length, 0); assert.equal(byClass(app.tree, 'research-progress-fill').length, 0);
    assert.match(bar.props['aria-valuetext'], /unconfirmed/i); assert.equal(app.timers, 0);
  } finally { app.close(); }
});

test('observed activity opens in a native inline disclosure for only its bound operation', async () => {
  const observed = operation(), unrelated = operation({ id: 'other-operation', tools: [{ id: 'other-tool', name: 'web_search', input: 'Private unrelated query', state: 'running', sequence: 99 }] });
  const app = host(props(active(), { operations: [unrelated, observed] }));
  try {
    await app.flush(); const disclosure = nodes(app.tree).find(node => node.type === 'details'); assert.ok(disclosure);
    assert.ok(nodes(disclosure).find(node => node.type === 'summary'));
    const activity = nodes(disclosure).find(node => node.type?.name === 'ToolActivity'); assert.ok(activity);
    assert.equal(activity.props.operation.id, observed.id); assert.equal(activity.props.paused, false);
    assert.doesNotMatch(text(app.tree), /Private unrelated query/);
    assert.equal(nodes(app.tree).some(node => node.props.role === 'dialog' || node.props['aria-modal']), false);
    await app.update({ connected: false });
    const paused = nodes(app.tree).find(node => node.type?.name === 'ToolActivity'); assert.ok(paused); assert.equal(paused.props.paused, true);
    assert.equal(byClass(app.tree, 'research-progress--running').length, 0);
  } finally { app.close(); }
});

for (const name of ['update_plan', 'functions.update_plan', 'mcp__progress_card']) test(`${name}-only activity does not create an empty research activity disclosure`, async () => {
  const app = host(props(active(), { operations: [operation({ tools: [{ id: 'plan-tool', name, state: 'completed', sequence: 3 }] })] }));
  try {
    await app.flush(); assert.equal(nodes(app.tree).some(node => node.type === 'details'), false);
    assert.ok(statusText(app.tree)); assertProgress(app.tree);
  } finally { app.close(); }
});

test('a question bound to the current research run pauses live activity until the answer settles', async () => {
  const app = host(props(active(), { operations: [operation()], questions: [question()], stop() {}, update() {} }));
  try {
    await app.flush(); assert.match(statusText(app.tree), /answer|question/i); assert.doesNotMatch(statusText(app.tree), /Earth seasons axial tilt/);
    assert.equal(byClass(app.tree, 'research-progress--running').length, 0); assert.equal(rows(app.tree).some(row => row.props['data-state'] === 'active'), false);
    assert.equal(button(app.tree, 'Update'), undefined); assertProgress(app.tree);
    await app.update({ questions: [question({ action: { requestId: 'answering', kind: 'answer', state: 'unknown' } })] });
    assert.match(statusText(app.tree), /Checking.*answer/i); assert.equal(byClass(app.tree, 'research-progress--running').length, 0);
    await app.update({ questions: [question({ action: { requestId: 'answering', kind: 'answer', state: 'confirmed' } })] });
    assert.match(statusText(app.tree), /Earth seasons axial tilt/); assert.equal(byClass(app.tree, 'research-progress--running').length, 1);
  } finally { app.close(); }
});

test('another run or connection question cannot pause the current research activity', async () => {
  const source = question();
  const app = host(props(active(), { operations: [operation()], questions: [question({ snapshot: { ...source.snapshot, runId: 'different-run' } }), question({ connectionGeneration: 'different-generation' }), question({ nativeId: 'different-native' })] }));
  try {
    await app.flush(); assert.match(statusText(app.tree), /Earth seasons axial tilt/); assert.equal(byClass(app.tree, 'research-progress--running').length, 1);
    assertProgress(app.tree);
  } finally { app.close(); }
});

test('connection loss pauses observed activity while button readiness alone does not invent a disconnect', async () => {
  const app = host(props(active(), { operations: [operation()], ready: false, connected: true }));
  try {
    await app.flush(); assert.match(statusText(app.tree), /Earth seasons axial tilt/); assert.equal(byClass(app.tree, 'research-progress--running').length, 1);
    await app.update({ ready: true, connected: false });
    assert.match(statusText(app.tree), /connect|paused|unconfirmed/i); assert.doesNotMatch(statusText(app.tree), /Earth seasons axial tilt/);
    assert.equal(byClass(app.tree, 'research-progress--running').length, 0); assert.equal(app.timers, 0);
    await app.update({ connected: true });
    assert.match(statusText(app.tree), /Earth seasons axial tilt/); assert.equal(byClass(app.tree, 'research-progress--running').length, 1);
  } finally { app.close(); }
});

test('a newly connected runtime generation cannot animate the original research run as current', async () => {
  const app = host(props(active(), { operations: [operation()] }));
  try {
    await app.flush(); assert.match(statusText(app.tree), /Earth seasons axial tilt/); assert.equal(byClass(app.tree, 'research-progress--running').length, 1);
    await app.update({ connectionGeneration: 'new-generation', connected: true });
    assert.match(statusText(app.tree), /paused|unconfirmed/i); assert.doesNotMatch(statusText(app.tree), /Earth seasons axial tilt/);
    assert.equal(byClass(app.tree, 'research-progress--running').length, 0); assert.equal(rows(app.tree)[0].props['data-state'], 'complete');
    const retained = nodes(app.tree).find(node => node.type?.name === 'ToolActivity'); assert.ok(retained);
    assert.equal(retained.props.operation.connectionGeneration, 'generation'); assert.equal(retained.props.paused, true);
    assertProgress(app.tree);
  } finally { app.close(); }
});

test('requested cancellation takes precedence over a question and lost connection', async () => {
  const app = host(props(active(), { operations: [operation({ cancelRequested: true })], connected: false, questions: [question()], stop() {} }));
  try {
    await app.flush(); assert.match(statusText(app.tree), /Stopping/i); assert.doesNotMatch(statusText(app.tree), /answer|Earth seasons axial tilt/i);
    assert.equal(labelledButton(app.tree, 'Stopping research').props.disabled, true); assert.equal(byClass(app.tree, 'research-progress--running').length, 0);
  } finally { app.close(); }
});

for (const terminal of ['failed', 'cancelled', 'completed'] as const) test(`confirmed ${terminal} takes precedence over pending cancellation, questions and disconnection`, async () => {
  const app = host(props(active(), { operations: [operation({ state: terminal, cancelRequested: true })], connected: false, questions: [question()], stop() {}, update() {} }));
  try {
    await app.flush();
    if (terminal === 'completed') { assert.equal(app.tree, null); return; }
    assert.match(statusText(app.tree), terminal === 'failed' ? /failed|interrupted|attention/i : /cancelled|stopped/i);
    assert.doesNotMatch(statusText(app.tree), /Stopping|answer|Earth seasons axial tilt/i);
    assert.equal(byClass(app.tree, 'research-progress--running').length, 0); assert.equal(labelledButton(app.tree, 'Stop research'), undefined);
  } finally { app.close(); }
});

for (const mismatch of ['id', 'epoch', 'captured-plan', 'captured-version', 'captured-digest', 'work-space'] as const) test(`${mismatch} activity cannot supply research status, disclosure or controls`, async () => {
  const source = operation(), approvedPlan = source.context.approvedPlan;
  const other = mismatch === 'id' ? { ...source, id: 'other-operation' } : mismatch === 'epoch' ? { ...source, epoch: 'other-epoch' } : { ...source, context: { ...source.context, ...(mismatch === 'work-space' ? { space: 'work' } : { approvedPlan: { ...approvedPlan, ...(mismatch === 'captured-plan' ? { id: 'other-plan' } : mismatch === 'captured-version' ? { version: 2 } : { digest: 'b'.repeat(64) }) } }) } };
  const app = host(props(active(), { operations: [other], stop() {}, update() {} }));
  try {
    await app.flush(); assert.doesNotMatch(text(app.tree), /Earth seasons axial tilt|Comparing measurements/);
    assert.equal(nodes(app.tree).some(node => node.type === 'details' || node.type?.name === 'ToolActivity'), false);
    assert.equal(labelledButton(app.tree, 'Stop research'), undefined); assert.equal(button(app.tree, 'Update'), undefined);
    assert.equal(byClass(app.tree, 'research-progress--running').length, 0); assert.deepEqual(rows(app.tree).map(row => row.props['data-state']), ['waiting', 'waiting']);
  } finally { app.close(); }
});

test('long proposal text stays readable text while the live subtask remains bounded', async () => {
  const longLabel = 'Review the full research scope including accessibility and source quality. '.repeat(30) + '<script>not executable</script>';
  const proposal = { ...item().versions[0].proposal, steps: [longLabel, 'Compare primary sources'] };
  const record = active({ versions: [{ ...item().versions[0], proposal }] });
  const source = operation(), observed = { ...source, context: { ...source.context, approvedPlan: { ...source.context.approvedPlan, proposal } }, plan: [{ id: 'long', label: longLabel, detail: 'Comparing primary source measurements '.repeat(80), status: 'active' }], tools: [] };
  const app = host(props(record, { operations: [observed] }));
  try {
    await app.flush(); assert.ok(text(rows(app.tree)[0]).includes(longLabel));
    assert.equal(nodes(app.tree).some(node => node.type === 'script' || node.props.dangerouslySetInnerHTML), false);
    assert.match(statusText(app.tree), /Comparing primary source measurements/); assert.ok(statusText(app.tree).length < 1000, 'The narrow activity summary must remain bounded');
    assertProgress(app.tree);
  } finally { app.close(); }
});
