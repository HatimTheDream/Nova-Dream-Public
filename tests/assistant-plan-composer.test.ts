import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { emptyDraft, type Draft } from '../packages/domain/contracts';

const key = Symbol.for('nova.test.plan-composer');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
// Exercise the real Editor's event handlers and request receipts without timers,
// subscriptions, uploads or provider effects.
const loader = registerHooks({
  resolve(specifier, context, next) { return specifier === 'react' && context.parentURL?.includes('/apps/client/src/') ? { url: 'nova-test:plan-composer', shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
    if (url === 'nova-test:plan-composer') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      export const useEffect = () => {};
      export const useLayoutEffect = () => {};
      export const useCallback = value => value;
      export const useMemo = read => read();
      export const useSyncExternalStore = (subscribe, read) => read();
      export const useState = initial => {
        const state = globalThis[Symbol.for('nova.test.plan-composer')], index = state.index++;
        if (!(index in state.values)) state.values[index] = typeof initial === 'function' ? initial() : initial;
        return [state.values[index], value => { state.values[index] = typeof value === 'function' ? value(state.values[index]) : value; }];
      };
      export const useRef = value => useState(() => ({ current: value }))[0];` };
    if (url.endsWith('/useAttachments.ts')) return { format: 'module', shortCircuit: true, source: `export const useAttachments = () => ({ staging: false, pending: [], errors: {}, notice: '', add() {}, retry() {}, remove() {} });` };
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return next(url, context);
  },
});
const { Assistant } = await import('../apps/client/src/Assistant');
loader.deregister();

const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function fixture(t: any, kind: 'existing' | 'queue' | 'new', refinement = false) {
  const state = { index: 0, values: [] as any[] }, storage = new Map<string, string>();
  const time = '2026-09-23T12:00:00Z';
  const file = { id: 'original', name: 'Original.png', mime: 'image/png', size: 10, sha256: 'a'.repeat(64) };
  const refineSource = { outputId: 'output', version: 1, sha256: file.sha256 };
  const conversation = { id: 'conversation', nativeId: 'native', nativeKey: 'key', connectionGeneration: 'generation', revision: 1, title: 'Planning', state: 'ready', projectId: null, archived: false, model: null, thinking: null, createdAt: time, updatedAt: time, ...(refinement ? { refineSource } : {}) };
  let draft: Draft = { ...emptyDraft, text: 'Plan a desk tidy', workMode: 'plan', ...(kind === 'new' ? {} : { conversationId: conversation.id }), ...(refinement ? { refineSource, attachments: [file] } : {}) };
  const captured = structuredClone(draft);
  const journal = { get value() { return draft; }, revision: 1, dirty: false, saving: false, retainForNavigation: () => true, change(update: Draft | ((value: Draft) => Draft)) { draft = typeof update === 'function' ? update(draft) : update; }, flush: async () => {} };
  let admission: 'pending' | 'accepted' | 'rejected' | 'unknown' = 'pending';
  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  const calls: { path: string; body: any }[] = [], submitted: Draft[] = [];
  const savedDrafts = new Map<string, Draft>();
  const values: Record<PropertyKey, unknown> = {
    [key]: state,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    matchMedia: () => ({ matches: true }),
    fetch: async (path: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); calls.push({ path, body });
      if (path === '/api/commands') { savedDrafts.set(body.entityId, structuredClone(body.payload)); return new Response(JSON.stringify({ id: body.entityId, revision: 2, value: body.payload })); }
      if (!['/api/assistant/submit', '/api/assistant/queue', '/api/assistant/steer'].includes(path)) throw Error(`Unexpected request ${path}`);
      submitted.push(structuredClone(savedDrafts.get(body.draftId) ?? draft));
      await gate;
      if (admission === 'unknown') throw Error('Connection interrupted');
      if (admission === 'rejected') return new Response(JSON.stringify({ code: 'draft_changed', message: 'Draft changed' }), { status: 409 });
      return new Response(JSON.stringify({ id: 'operation', state: 'prepared' }));
    },
  };
  const originals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  const controller = { space: 'chat', selectedId: kind === 'new' ? undefined : conversation.id, conversation: kind === 'new' ? undefined : conversation, conversations: kind === 'new' ? [] : [conversation], statusRead: 'ready', connection: { state: 'ready', generation: 'generation', methods: [], grantedScopes: ['operator.write'] }, operations: kind === 'queue' ? [{ id: 'active', conversationId: conversation.id, nativeId: 'native', nativeRunId: 'run', state: 'running', context: { project: null, attachments: [], draftId: 'draft:device:conversation', draftRevision: 1, digest: 'context' }, createdAt: time, updatedAt: time }] : [], models: [], outputs: [], queue: [], pins: [], removals: [], select() { return true; }, create: async () => conversation, refresh: async () => {} };
  const props = { appIcon: 'red', snapshot: { epoch: 'epoch', deviceId: 'device', projects: [], drafts: [], records: {} }, legacyJournal: journal, controller, voice: { subscribe: () => () => {}, getSnapshot: () => ({ phase: 'idle', turns: [] }) }, contentActions: {}, refreshWorkspace: async () => {}, openSettings() {}, newProject() {}, editProject() {} } as any;
  // Obtain the Editor through its public parent, then provide the retained journal
  // directly so edits arriving while a request is in flight can be exercised.
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: { index: 0, values: [] } });
  const outer = Assistant({ ...props, controller: { ...controller, selectedId: undefined, conversation: undefined } });
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: state });
  const render = () => { state.index = 0; return (outer.type as any)({ ...outer.props, controller, journal, draftId: kind === 'new' ? 'draft:device' : 'draft:device:conversation' }); };
  return {
    get draft() { return draft; }, captured, storage, calls, submitted, savedDrafts, render,
    async send(steer = false) { const button = nodes(render()).find(node => node.type === 'button' && (steer ? node.props.children === 'Steer current reply' : node.props['aria-label'] === (kind === 'queue' ? 'Queue message' : 'Send message'))); assert.ok(button); button.props.onClick(); await settle(); },
    async finish(outcome: typeof admission) { admission = outcome; release(); await settle(); },
    retry() { admission = 'pending'; gate = new Promise<void>(resolve => { release = resolve; }); },
    edit(update: Partial<Draft>) { journal.change(value => ({ ...value, ...update })); },
  };
}

for (const kind of ['existing', 'queue', 'new'] as const) {
  test(`accepted ${kind} Plan submission consumes the composer mode while captured work stays Plan`, async t => {
    const f = fixture(t, kind);
    assert.ok(nodes(f.render()).some(node => node.props?.['aria-label'] === 'Turn off plan mode'));
    await f.send();
    assert.equal(f.draft.workMode, 'plan', 'pending admission retains the unsent Plan choice');
    assert.equal(f.submitted.length, 1); assert.equal(f.submitted[0].workMode, 'plan');
    await f.finish('accepted');
    assert.equal(f.draft.workMode, 'chat'); assert.equal(f.draft.text, '');
    assert.equal(nodes(f.render()).some(node => node.props?.['aria-label'] === 'Turn off plan mode'), false);
    assert.equal(f.captured.workMode, 'plan'); assert.equal(f.submitted[0].workMode, 'plan');
    if (kind === 'new') assert.equal(f.savedDrafts.get('draft:device:conversation')?.workMode, 'chat', 'the newly created conversation also has a normal next draft');
  });
}

test('accepted Plan direction also clears the consumed chip', async t => {
  const f = fixture(t, 'queue'); await f.send(true); await f.finish('accepted');
  assert.equal(f.calls[0].path, '/api/assistant/steer'); assert.equal(f.draft.workMode, 'chat');
  assert.equal(f.submitted[0].workMode, 'plan');
});

for (const kind of ['existing', 'queue'] as const) {
  test(`${kind} refinement consumes Plan but preserves its original source`, async t => {
    const f = fixture(t, kind, true); await f.send(); await f.finish('accepted');
    assert.equal(f.draft.workMode, 'chat'); assert.equal(f.draft.text, '');
    assert.deepEqual(f.draft.attachments, f.captured.attachments); assert.deepEqual(f.draft.refineSource, f.captured.refineSource);
  });

  test(`${kind} Plan keeps its draft and original request identity after an uncertain response`, async t => {
    const f = fixture(t, kind); await f.send(); await f.finish('unknown');
    assert.deepEqual(f.draft, f.captured);
    const first = f.calls[0].body.requestId;
    f.retry(); await f.send(); await f.finish('accepted');
    assert.equal(f.calls[1].body.requestId, first);
    assert.equal(f.draft.workMode, 'chat'); assert.equal(f.submitted[1].workMode, 'plan');
  });

  test(`${kind} Plan rejection or an intervening new draft does not consume the current mode`, async t => {
    const f = fixture(t, kind); await f.send(); await f.finish('rejected');
    assert.deepEqual(f.draft, f.captured);
    f.retry(); await f.send(); f.edit({ text: 'Plan a separate assignment' }); await f.finish('accepted');
    assert.equal(f.draft.workMode, 'plan'); assert.equal(f.draft.text, 'Plan a separate assignment');
    assert.equal(f.submitted[1].text, f.captured.text, 'the accepted payload is not changed by later writing');
  });
}
