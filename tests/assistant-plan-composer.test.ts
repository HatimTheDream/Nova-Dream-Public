import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { emptyDraft, type Draft } from '../packages/domain/contracts';
import { workModes, type WorkMode } from '../packages/domain/work-mode';

const key = Symbol.for('nova.test.plan-composer');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
// Exercise the real Editor's event handlers, receipts and mode reconciliation
// effect without timers, subscriptions, uploads or provider effects.
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('nova-test:')) return { url: specifier, shortCircuit: true };
    if (specifier === 'react' && context.parentURL?.endsWith('/useComposerMode.ts')) return { url: 'nova-test:composer-mode-react', shortCircuit: true };
    return specifier === 'react' && context.parentURL?.includes('/apps/client/src/') ? { url: 'nova-test:plan-composer', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:composer-mode-react') return { format: 'module', shortCircuit: true, source: `export * from 'nova-test:plan-composer';
      export const useEffect = (run, deps) => {
        const state = globalThis[Symbol.for('nova.test.plan-composer')], index = state.index++;
        const prior = state.values[index];
        if (!prior || deps.some((value, offset) => !Object.is(value, prior.deps[offset]))) {
          state.values[index] = { deps }; state.effects.push(run);
        }
      };` };
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

const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children), ...nodes(node.props.footer)] : [];
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function fixture(t: any, kind: 'existing' | 'queue' | 'new', refinement = false, plan?: any, mode: WorkMode = 'plan') {
  const state = { index: 0, values: [] as any[], effects: [] as (() => void)[] }, storage = new Map<string, string>();
  const time = '2026-09-23T12:00:00Z';
  const file = { id: 'original', name: 'Original.png', mime: 'image/png', size: 10, sha256: 'a'.repeat(64) };
  const refineSource = { outputId: 'output', version: 1, sha256: file.sha256 };
  const conversation = { id: 'conversation', nativeId: 'native', nativeKey: 'key', connectionGeneration: 'generation', revision: 1, title: 'Planning', state: 'ready', projectId: null, archived: false, model: null, thinking: null, createdAt: time, updatedAt: time, ...(refinement ? { refineSource } : {}) };
  let draft: Draft = { ...emptyDraft, text: 'Help with a desk tidy', workMode: mode, ...(kind === 'new' ? {} : { conversationId: conversation.id }), ...(refinement ? { refineSource, attachments: [file] } : {}) };
  const captured = structuredClone(draft);
  let storageFull = false;
  const journal = { get value() { return draft; }, revision: 1, dirty: false, saving: false, retainForNavigation: () => true, change(update: Draft | ((value: Draft) => Draft)) { draft = typeof update === 'function' ? update(draft) : update; return !storageFull; }, flush: async () => {} };
  let admission: 'pending' | 'accepted' | 'rejected' | 'unknown' = 'pending';
  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  const calls: { path: string; body: any }[] = [], submitted: Draft[] = [];
  const savedDrafts = new Map<string, Draft>(), capturedRequests = new Map<string, Draft>();
  const values: Record<PropertyKey, unknown> = {
    [key]: state,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { if (storageFull) throw Error('Browser storage is full'); storage.set(key, value); }, removeItem: (key: string) => storage.delete(key) },
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame: (run: () => void) => { run(); return 0; },
    fetch: async (path: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); calls.push({ path, body });
      if (path === '/api/commands') { savedDrafts.set(body.entityId, structuredClone(body.payload)); return new Response(JSON.stringify({ id: body.entityId, revision: 2, value: body.payload })); }
      if (['/api/assistant/plan/amend', '/api/assistant/plan/approve'].includes(path)) {
        await gate;
        if (admission === 'unknown') throw Error('Connection interrupted');
        return new Response(JSON.stringify({ id: 'plan-operation', state: 'prepared' }));
      }
      if (!['/api/assistant/submit', '/api/assistant/queue', '/api/assistant/steer'].includes(path)) throw Error(`Unexpected request ${path}`);
      // A replay resolves the immutable original operation, not today's draft.
      if (!capturedRequests.has(body.requestId)) capturedRequests.set(body.requestId, structuredClone(body.draftId === currentDraftId ? draft : savedDrafts.get(body.draftId) ?? draft));
      submitted.push(structuredClone(capturedRequests.get(body.requestId)!));
      await gate;
      if (admission === 'unknown') throw Error('Connection interrupted');
      if (admission === 'rejected') return new Response(JSON.stringify({ code: 'draft_changed', message: 'Draft changed' }), { status: 409 });
      return new Response(JSON.stringify({ id: 'operation', state: 'prepared' }));
    },
  };
  const originals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  const controller = { space: 'chat', selectedId: kind === 'new' ? undefined : conversation.id, conversation: kind === 'new' ? undefined : conversation, conversations: kind === 'new' ? [] : [conversation], statusRead: 'ready', connection: { state: 'ready', generation: 'generation', methods: ['sessions.goal.update', 'sessions.describe'], grantedScopes: ['operator.write'] }, operations: kind === 'queue' ? [{ id: 'active', conversationId: conversation.id, nativeId: 'native', nativeRunId: 'run', state: 'running', context: { project: null, attachments: [], draftId: 'draft:device:conversation', draftRevision: 1, digest: 'context', workMode: mode }, createdAt: time, updatedAt: time }] : [], models: [], outputs: [], queue: [], pins: [], removals: [], plans: plan ? [plan] : [], select() { return true; }, create: async () => conversation, refresh: async () => {}, loadHistory: async () => {} };
  if (plan) Object.assign(controller, { history: { nativeId: 'native', messages: [], hasMore: false, hasNewer: false } });
  const props = { appIcon: 'red', snapshot: { epoch: 'epoch', deviceId: 'device', projects: [], drafts: [], records: {} }, legacyJournal: journal, controller, voice: { subscribe: () => () => {}, getSnapshot: () => ({ phase: 'idle', turns: [] }) }, contentActions: {}, refreshWorkspace: async () => {}, openSettings() {}, newProject() {}, editProject() {} } as any;
  // Obtain the Editor through its public parent, then provide the retained journal
  // directly so edits arriving while a request is in flight can be exercised.
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: { index: 0, values: [] } });
  const outer = Assistant({ ...props, controller: { ...controller, selectedId: undefined, conversation: undefined } });
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: state });
  let currentDraftId = kind === 'new' ? 'draft:device' : 'draft:device:conversation';
  const render = () => {
    let tree: any;
    for (let pass = 0; pass < 10; pass++) {
      state.index = 0; tree = (outer.type as any)({ ...outer.props, controller, journal, draftId: currentDraftId });
      if (!state.effects.length) return tree;
      while (state.effects.length) state.effects.shift()!();
    }
    assert.fail('Composer mode reconciliation did not settle');
  };
  const modeOptions = () => {
    const menu = nodes(render()).find(node => node.type?.name === 'ComposerMenu' && node.props.label === 'Add to message');
    assert.ok(menu); return nodes(menu.props.children(() => {})).filter(node => node.props?.role === 'menuitemradio');
  };
  return {
    get draft() { return draft; }, captured, storage, calls, submitted, savedDrafts, render,
    modeOptions,
    hasChip() { return nodes(render()).some(node => node.props?.className === 'work-mode-chip'); },
    selectMode(mode: WorkMode) { const option = modeOptions().find(node => node.key === mode); assert.ok(option); assert.equal(option.props.disabled, false); option.props.onClick(); },
    remount() { state.values = []; state.index = 0; return render(); },
    openCreated() { currentDraftId = 'draft:device:conversation'; const saved = savedDrafts.get(currentDraftId); assert.ok(saved); draft = structuredClone(saved); journal.revision = 2; Object.assign(controller, { selectedId: conversation.id, conversation, conversations: [conversation] }); state.values = []; state.index = 0; return render(); },
    beginReply() { controller.operations = [{ id: 'active', conversationId: conversation.id, nativeId: 'native', nativeRunId: 'run', state: 'running', context: { project: null, attachments: [], draftId: currentDraftId, draftRevision: 1, digest: 'context', workMode: mode }, createdAt: time, updatedAt: time }]; },
    async send(steer = false) { const button = nodes(render()).find(node => node.type === 'button' && (steer ? node.props.children === 'Steer current reply' : node.props['aria-label'] === (controller.operations.length ? 'Queue message' : 'Send message'))); assert.ok(button); assert.equal(button.props.disabled, false); button.props.onClick(); await settle(); },
    async finish(outcome: typeof admission) { admission = outcome; release(); await settle(); },
    retry() { admission = 'pending'; gate = new Promise<void>(resolve => { release = resolve; }); },
    edit(update: Partial<Draft>) { journal.change(value => ({ ...value, ...update })); },
    fillStorage() { storageFull = true; },
    failHistory() { Object.assign(controller, { history: undefined, historyError: 'Transcript is temporarily unavailable.' }); },
  };
}

function savedPlan() {
  return { id: 'plan', conversationId: 'conversation', epoch: 'epoch', revision: 3, version: 1, state: 'ready', reviewDigest: 'a'.repeat(64), createdAt: '2026-09-23T12:00:00Z', versions: [{ version: 1, digest: 'a'.repeat(64), proposal: { title: 'Plan the update', summary: 'Keep a readable review.', steps: ['Review before implementation'], assumptions: [], verification: ['Approval is explicit'] } }] };
}

test('the Editor keeps its ordinary draft and attachments across Skip, return and amendment writing', async t => {
  const f = fixture(t, 'existing', true, savedPlan());
  f.edit({ text: 'An ordinary message I have not sent.', workMode: 'chat' });
  const kept = structuredClone(f.draft);
  let tree = f.render();
  nodes(tree).find(node => node.props?.['aria-label'] === 'Conversation history').props.ref({}); tree = f.render();
  const decision = nodes(tree).find(node => node.type?.name === 'PlanReviewDecision'); assert.ok(decision);
  assert.ok(nodes(tree).some(node => node.props?.className?.includes('plan-decision-composer')));
  assert.equal(nodes(tree).find(node => node.type === 'textarea' && node.props.id === 'assistant-draft')?.props.value, kept.text);
  decision.props.review.setText('Keep mobile actions compact.'); tree = f.render();
  nodes(tree).find(node => node.type?.name === 'PlanReviewDecision').props.review.skip(); tree = f.render();
  assert.equal(nodes(tree).some(node => node.type?.name === 'PlanReviewDecision'), false);
  assert.equal(nodes(tree).some(node => node.props?.className?.includes('plan-decision-composer')), false);
  assert.deepEqual(f.draft, kept); assert.equal(f.calls.length, 0);
  const card = nodes(tree).find(node => node.type?.name === 'PlanReviewCard'); assert.ok(card);
  card.props.review.openDecision(); tree = f.render();
  const returned = nodes(tree).find(node => node.type?.name === 'PlanReviewDecision'); assert.ok(returned);
  assert.equal(returned.props.review.text, 'Keep mobile actions compact.');
  assert.deepEqual(f.draft, kept); assert.equal(f.calls.length, 0);
});

test('the Editor submits amendments through the saved plan while keeping normal composer writing untouched', async t => {
  const plan = savedPlan(), f = fixture(t, 'existing', true, plan);
  f.edit({ text: 'Keep this normal draft.', workMode: 'chat' }); const kept = structuredClone(f.draft);
  nodes(f.render()).find(node => node.type?.name === 'PlanReviewDecision').props.review.setText('Change only the plan layout.');
  const decision = nodes(f.render()).find(node => node.type?.name === 'PlanReviewDecision');
  void decision.props.review.amend(); await settle();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/api/assistant/plan/amend');
  assert.equal(f.calls[0].body.id, plan.id); assert.equal(f.calls[0].body.version, 1);
  assert.equal(f.calls[0].body.digest, plan.reviewDigest); assert.equal(f.calls[0].body.text, 'Change only the plan layout.');
  assert.equal(f.submitted.length, 0, 'amendments must not be sent as an ordinary conversation draft');
  await f.finish('accepted'); assert.deepEqual(f.draft, kept);
});

test('the saved proposal remains reviewable before transcript mounting and when history fails', t => {
  const plan = savedPlan(), f = fixture(t, 'existing', false, plan);
  let tree = f.render();
  let cards = nodes(tree).filter(node => node.type?.name === 'PlanReviewCard'); assert.equal(cards.length, 1);
  assert.equal(cards[0].props.review.proposal, plan.versions[0].proposal);
  nodes(tree).find(node => node.props?.['aria-label'] === 'Conversation history').props.ref({});
  f.failHistory(); tree = f.render();
  cards = nodes(tree).filter(node => node.type?.name === 'PlanReviewCard'); assert.equal(cards.length, 1);
  const decision = nodes(tree).find(node => node.type?.name === 'PlanReviewDecision'); assert.ok(decision);
  assert.equal(cards[0].props.review, decision.props.review);
  assert.equal(cards[0].props.review.proposal, plan.versions[0].proposal);
  assert.equal(f.calls.length, 0);
});

const featureModes = workModes.filter(mode => mode.id !== 'chat').map(mode => mode.id);
function assertConsumed(f: ReturnType<typeof fixture>) {
  assert.equal(f.hasChip(), false, 'the sent feature must not remain as a composer chip');
  assert.equal(f.modeOptions().some(option => option.props['aria-checked']), false, 'the + menu must not imply a consumed feature applies to the next message');
}

for (const mode of featureModes) {
  for (const kind of ['existing', 'queue', 'new'] as const) {
    test(`${kind} ${mode} consumes its chip on Send before admission and keeps the captured feature`, async t => {
      const f = fixture(t, kind, false, undefined, mode);
      assert.equal(f.hasChip(), true);
      await f.send(); assertConsumed(f);
      assert.equal(f.draft.workMode, mode, 'pending admission must not mutate the host draft revision');
      assert.equal(f.submitted.length, 1); assert.equal(f.submitted[0].workMode, mode);
      await f.finish('accepted'); assertConsumed(f);
      assert.equal(f.draft.workMode, 'chat'); assert.equal(f.draft.text, '');
      assert.equal(f.captured.workMode, mode); assert.equal(f.submitted[0].workMode, mode);
      if (kind === 'new') assert.equal(f.savedDrafts.get('draft:device:conversation')?.workMode, 'chat', 'the newly created conversation also has a normal next draft');
    });

    test(`${kind} ${mode} rejection preserves writing without restoring the consumed chip`, async t => {
      const f = fixture(t, kind, false, undefined, mode);
      await f.send(); assertConsumed(f); await f.finish('rejected'); assertConsumed(f);
      assert.equal(f.draft.text, f.captured.text); assert.deepEqual(f.draft.attachments, f.captured.attachments);
      assert.equal(f.draft.workMode, 'chat');
      f.remount(); assertConsumed(f);
    });

    test(`${kind} ${mode} unknown outcome keeps the chip consumed across remount and retries the original request`, async t => {
      const f = fixture(t, kind, false, undefined, mode);
      await f.send(); await f.finish('unknown'); assertConsumed(f);
      assert.equal(f.draft.text, f.captured.text);
      const submits = () => f.calls.filter(call => ['/api/assistant/submit', '/api/assistant/queue'].includes(call.path));
      const first = structuredClone(submits()[0].body);
      f.remount(); assertConsumed(f);
      f.retry(); await f.send(); assertConsumed(f); await f.finish('accepted');
      assert.deepEqual(submits()[1].body, first, 'a retry must reconcile the exact original operation');
      assert.equal(f.draft.workMode, 'chat'); assert.equal(f.draft.text, ''); assertConsumed(f);
      assert.equal(f.submitted[0].workMode, mode); assert.equal(f.submitted[1].workMode, mode);
    });

    test(`${kind} ${mode} consumes the old feature while preserving new writing during submission`, async t => {
      const f = fixture(t, kind, false, undefined, mode);
      await f.send(); f.edit({ text: 'An independent next message.' }); await f.finish('accepted');
      assert.equal(f.draft.text, 'An independent next message.'); assert.equal(f.draft.workMode, 'chat'); assertConsumed(f);
      assert.equal(f.submitted[0].text, f.captured.text); assert.equal(f.submitted[0].workMode, mode);
    });

    for (const selected of [mode, mode === 'research' ? 'image' : 'research'] as WorkMode[]) {
      test(`${kind} ${mode} leaves an explicitly selected ${selected} feature intact after its late receipt`, async t => {
        const f = fixture(t, kind, false, undefined, mode);
        await f.send(); f.selectMode(selected);
        assert.equal(f.hasChip(), true);
        await f.finish('accepted');
        assert.equal(f.draft.workMode, selected); assert.equal(f.draft.text, f.captured.text, 'explicitly choosing the next feature creates a new draft intent even when the text matches');
        assert.ok(nodes(f.render()).some(node => node.props?.['aria-label'] === `Turn off ${selected} mode`));
        assert.equal(f.submitted[0].workMode, mode);
      });
    }
  }

  for (const kind of ['existing', 'queue'] as const) {
    test(`${kind} ${mode} refinement consumes the feature but keeps the original output attached`, async t => {
      const f = fixture(t, kind, true, undefined, mode);
      await f.send(); assertConsumed(f); await f.finish('accepted'); assertConsumed(f);
      assert.equal(f.draft.workMode, 'chat'); assert.equal(f.draft.text, '');
      assert.deepEqual(f.draft.attachments, f.captured.attachments); assert.deepEqual(f.draft.refineSource, f.captured.refineSource);
    });
  }

  if (mode !== 'goal') {
    test(`${mode} direction consumes its chip immediately and preserves its feature on an uncertain retry`, async t => {
      const f = fixture(t, 'queue', false, undefined, mode);
      await f.send(true); assertConsumed(f); await f.finish('unknown'); assertConsumed(f);
      const original = structuredClone(f.calls[0].body);
      f.remount(); assertConsumed(f); f.retry(); await f.send(true); await f.finish('accepted');
      assert.equal(f.calls[0].path, '/api/assistant/steer'); assert.deepEqual(f.calls[1].body, original);
      assert.equal(f.draft.workMode, 'chat'); assert.equal(f.submitted[1].workMode, mode); assertConsumed(f);
    });
  }

  test(`a rejected new ${mode} request does not silently apply its consumed feature from the copied conversation`, async t => {
    const f = fixture(t, 'new', false, undefined, mode);
    await f.send(); await f.finish('rejected'); f.openCreated(); assertConsumed(f);
    f.retry(); await f.send();
    assert.equal(f.submitted[1].workMode ?? 'chat', 'chat', 'a fresh send from the copied conversation must use the visible next-message mode');
    await f.finish('accepted'); assertConsumed(f);
  });

  test(`an unknown new ${mode} request reconciles its original feature from the copied conversation without restoring the chip`, async t => {
    const f = fixture(t, 'new', false, undefined, mode);
    await f.send(); await f.finish('unknown');
    const first = structuredClone(f.calls.find(call => call.path === '/api/assistant/submit')!.body);
    f.openCreated(); assertConsumed(f); f.retry(); await f.send(); assertConsumed(f);
    assert.deepEqual(f.calls.filter(call => call.path === '/api/assistant/submit')[1].body, first);
    assert.equal(f.submitted[1].workMode, mode);
    await f.finish('accepted'); assertConsumed(f);
  });

  test(`an old ${mode} receipt does not clear an explicit feature choice made after reopening the editor`, async t => {
    const f = fixture(t, 'existing', false, undefined, mode);
    await f.send(); f.remount(); f.selectMode(mode);
    await f.finish('accepted');
    assert.equal(f.draft.workMode, mode); assert.equal(f.hasChip(), true);
    assert.equal(f.draft.text, f.captured.text);
  });

  test(`queuing after an unknown ${mode} send reconciles it before capturing a fresh Chat follow-up`, async t => {
    const f = fixture(t, 'existing', false, undefined, mode);
    await f.send(); await f.finish('unknown'); assertConsumed(f);
    const first = structuredClone(f.calls[0].body);
    f.beginReply(); f.edit({ text: 'A separate follow-up for the running reply.' });
    f.retry(); await f.send();
    assert.equal(f.calls[1].path, '/api/assistant/submit'); assert.deepEqual(f.calls[1].body, first);
    assert.equal(f.submitted[1].workMode, mode, 'uncertain delivery is reconciled without changing the original request');
    await f.finish('accepted'); assertConsumed(f);
    assert.equal(f.draft.text, 'A separate follow-up for the running reply.');
    f.retry(); await f.send();
    assert.equal(f.calls[2].path, '/api/assistant/queue');
    assert.equal(f.submitted[2].workMode ?? 'chat', 'chat', 'the consumed feature cannot carry into a new queue capture');
    await f.finish('accepted'); assertConsumed(f);
  });

  test(`approving an earlier plan preserves a newly selected ${mode} feature`, async t => {
    const f = fixture(t, 'existing', false, savedPlan());
    f.edit({ text: '' });
    void nodes(f.render()).find(node => node.type?.name === 'PlanReviewDecision').props.review.approve();
    await settle(); f.selectMode(mode); await f.finish('accepted');
    assert.equal(f.calls[0].path, '/api/assistant/plan/approve');
    assert.equal(f.draft.workMode, mode); assert.equal(f.hasChip(), true); assert.equal(f.draft.text, '');
  });

  test(`a normal message after an accepted ${mode} send is captured as Chat`, async t => {
    const f = fixture(t, 'existing', false, undefined, mode);
    await f.send(); await f.finish('accepted'); assertConsumed(f);
    f.edit({ text: 'A new ordinary message.' }); f.retry(); await f.send();
    assert.notEqual(f.calls[1].body.requestId, f.calls[0].body.requestId);
    assert.equal(f.submitted[1].workMode ?? 'chat', 'chat'); assert.equal(f.submitted[1].text, 'A new ordinary message.');
    await f.finish('accepted'); assertConsumed(f); assert.equal(f.draft.text, '');
  });
}

test('a storage-full Send consumes the feature locally while preserving writing and avoiding an unsafe submission', async t => {
  const f = fixture(t, 'existing', false, undefined, 'research');
  f.fillStorage(); await f.send(); assertConsumed(f);
  assert.equal(f.draft.text, f.captured.text); assert.deepEqual(f.draft.attachments, f.captured.attachments);
  assert.equal(f.calls.length, 0); assert.equal(f.submitted.length, 0);
  assert.ok(nodes(f.render()).some(node => typeof node.props?.children === 'string' && node.props.children.includes('Free browser storage before sending')));
});
