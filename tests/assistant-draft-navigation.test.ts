import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { emptyDraft, type Snapshot } from '../packages/domain/contracts';
import { registerRecordDraftNavigation } from '../apps/client/src/record-draft-navigation';
import { mayLeaveAssistantDraft, registerAssistantDraftNavigation } from '../apps/client/src/assistant-draft-navigation';

const fixtureKey = Symbol.for('nova.test.draft-navigation-hooks');
const reactUrl = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
// Exercise the real journal and selection callbacks without starting pollers.
// Ref/state slots persist across renders, including edits made before a render.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && context.parentURL?.includes('/apps/client/src/')) return { url: 'nova-test:draft-navigation-react', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:draft-navigation-react') return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(reactUrl)};
      export const useEffect = () => {};
      export const useLayoutEffect = effect => { globalThis[Symbol.for('nova.test.draft-navigation-hooks')].effects.push(effect); };
      export const useCallback = value => value;
      export const useMemo = read => read();
      export const useSyncExternalStore = (subscribe, read) => read();
      export const useState = initial => {
        const fixture = globalThis[Symbol.for('nova.test.draft-navigation-hooks')], index = fixture.index++;
        if (!(index in fixture.values)) fixture.values[index] = typeof initial === 'function' ? initial() : initial;
        return [fixture.values[index], value => { fixture.values[index] = typeof value === 'function' ? value(fixture.values[index]) : value; }];
      };
      export const useRef = value => useState(() => ({ current: value }))[0];
    ` };
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return next(url, context);
  },
});
const { useRetained, retainedWindowId } = await import('../apps/client/src/useWorkspace');
const { useAssistant } = await import('../apps/client/src/useAssistant');
const { Assistant } = await import('../apps/client/src/Assistant');
hooks.deregister();

function fixture(t: any) {
  let full = false;
  const storage = new Map<string, string>();
  const snapshot = { epoch: 'epoch', deviceId: 'device', projects: [], drafts: [] } as unknown as Snapshot;
  const original = [fixtureKey, 'localStorage', 'matchMedia', 'requestAnimationFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { if (full) throw Error('Storage full'); storage.set(key, value); }, removeItem: (key: string) => storage.delete(key) } });
  Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: () => ({ matches: true }) });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: () => void) => { callback(); return 1; } });
  t.after(() => { for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  function renderer<T>(run: () => T) {
    const state = { index: 0, values: [] as unknown[], effects: [] as (() => (() => void) | void)[] };
    return Object.assign(() => { state.index = 0; Object.defineProperty(globalThis, fixtureKey, { configurable: true, value: state }); return run(); }, { commitLayoutEffects: () => { const cleanups = state.effects.splice(0).map(effect => effect()); return () => { for (const cleanup of cleanups) cleanup?.(); }; } });
  }
  const id = 'draft:device:original';
  const renderJournal = renderer(() => useRetained('draft', id, emptyDraft, undefined, snapshot, async () => {}));
  const renderAssistant = renderer(() => useAssistant(snapshot));
  storage.set('e3:conversation:device', JSON.stringify('original'));
  return { storage, snapshot, renderJournal, renderAssistant, full: (value: boolean) => { full = value; }, journalKey: `e3:journal:device:${id}:${retainedWindowId}`, renderer, id };
}

test('a fresh failed draft write blocks conversation, new-draft and space switches before rerender', async t => {
  const f = fixture(t), journal = f.renderJournal(), controller = f.renderAssistant();
  const unregister = registerAssistantDraftNavigation(journal.retainForNavigation); t.after(unregister);
  const attachment = { id: 'file', name: 'Kept.txt', size: 5, sha256: 'a'.repeat(64), mime: 'text/plain' };
  journal.change(value => ({ ...value, text: 'Previously retained text' }));
  f.full(true);
  journal.change(value => ({ ...value, text: 'The latest unsent writing', attachments: [attachment] }));
  assert.equal(journal.storageError, false, 'the callback must check the journal ref rather than a stale render flag');
  assert.equal(controller.select('other'), false);
  assert.equal(controller.select(null), false);
  assert.equal(controller.switchSpace('work'), false);
  assert.equal(mayLeaveAssistantDraft(), false, 'module departure shares the same fresh retention check');
  await assert.rejects(controller.remove({ id: 'original' } as Parameters<typeof controller.remove>[0]), /Keep the current draft/);
  assert.equal(f.storage.has('e3:conversation-remove:epoch:original'), false, 'removal cannot be captured or sent before retaining the current editor');
  assert.equal(f.renderAssistant().selectedId, 'original');
  assert.equal(f.storage.get('e3:conversation:device'), JSON.stringify('original'));
  assert.equal(f.storage.has('e3:assistant-space:epoch:device'), false);
  assert.equal(f.renderJournal().value.text, 'The latest unsent writing');
  assert.deepEqual(f.renderJournal().value.attachments, [attachment]);

  f.full(false);
  assert.equal(controller.select('other'), true, 'freeing storage makes the original navigation usable again');
  const remount = f.renderer(() => useRetained('draft', f.id, emptyDraft, undefined, f.snapshot, async () => {}));
  assert.equal(remount().value.text, 'The latest unsent writing');
  assert.deepEqual(remount().value.attachments, [attachment]);
  assert.equal(JSON.parse(f.storage.get(f.journalKey)!).dirty, true, 'retention does not falsely acknowledge a host save');
});

test('host acknowledgement releases navigation when local storage fills during the save', async t => {
  const f = fixture(t), journal = f.renderJournal();
  let resolve!: (response: Response) => void, command: any;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { command = JSON.parse(String(init.body)); return new Promise<Response>(done => { resolve = done; }); });
  journal.change(value => ({ ...value, text: 'Saved by the host' }));
  const saving = journal.flush();
  assert.ok(command);
  f.full(true);
  resolve(new Response(JSON.stringify({ id: f.id, revision: 1, value: command.payload })));
  await saving;
  assert.equal(f.renderJournal().storageError, true);
  assert.equal(f.renderJournal().dirty, false);
  assert.equal(journal.retainForNavigation(), true, 'already acknowledged writing does not trap the owner');
});

test('an old editor cleanup cannot unregister its replacement draft guard', () => {
  const old = registerAssistantDraftNavigation(() => true);
  const current = registerAssistantDraftNavigation(() => false);
  old();
  assert.equal(mayLeaveAssistantDraft(), false);
  current();
  assert.equal(mayLeaveAssistantDraft(), true);
});

test('the actual Editor registers draft protection for row and New Chat controls and releases it on unmount', t => {
  const f = fixture(t), controller = f.renderAssistant();
  const time = '2026-09-20T12:00:00Z';
  const conversation = { id: 'original', nativeId: 'native', nativeKey: 'key', connectionGeneration: 'generation', revision: 1, title: 'Original', state: 'ready', projectId: null, archived: false, model: null, thinking: null, createdAt: time, updatedAt: time };
  const props = { appIcon: 'red', snapshot: { ...f.snapshot, records: {}, drafts: [{ id: f.id, deviceId: 'device', revision: 1, value: { ...emptyDraft, conversationId: 'original', text: 'Original draft' }, updatedAt: time }] },
    controller: { ...controller, conversation, conversations: [conversation, { ...conversation, id: 'other', title: 'Other chat' }], connection: { state: 'ready', generation: 'generation', methods: [], grantedScopes: ['operator.write'] }, statusRead: 'ready' },
    voice: { subscribe: () => () => {}, getSnapshot: () => ({ phase: 'idle', turns: [] }) }, contentActions: {}, refreshWorkspace: async () => {}, openSettings() {}, newProject() {}, editProject() {},
  } as unknown as Parameters<typeof Assistant>[0];
  const outer = f.renderer(() => Assistant(props))();
  const branch = f.renderer(() => (outer.type as any)(outer.props))();
  const renderEditor = f.renderer(() => (branch.type as any)(branch.props));
  const tree = renderEditor();
  const unmount = renderEditor.commitLayoutEffects(); t.after(unmount);
  const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
  const controls = nodes(tree);
  f.full(true);
  controls.find(node => node.type === 'textarea').props.onChange({ target: { value: 'Writing that must survive navigation' } });
  controls.find(node => node.type?.name === 'ConversationRow' && node.props.conversation.id === 'other').props.open();
  assert.equal(f.renderAssistant().selectedId, 'original');
  controls.find(node => node.type?.name === 'AssistantOrganizationRailFrame').props.onNewDraft();
  assert.equal(f.renderAssistant().selectedId, 'original');
  assert.equal(mayLeaveAssistantDraft(), false, 'the mounted Editor also protects module departure');
  f.full(false);
  controls.find(node => node.type?.name === 'ConversationRow' && node.props.conversation.id === 'other').props.open();
  assert.equal(f.renderAssistant().selectedId, 'other');
  assert.equal(JSON.parse(f.storage.get(f.journalKey)!).value.text, 'Writing that must survive navigation');
  unmount();
  f.full(true);
  assert.equal(mayLeaveAssistantDraft(), true, 'unmount removes the old editor callback');
});


test('actual Editor source preview, History and Back keep the original conversation draft and mounted tab contents', t => {
  const f = fixture(t), controller = f.renderAssistant(), time = '2026-10-19T12:00:00Z';
  const attachment = { id: 'original-file', name: 'Keep The Original Name.txt', size: 12, sha256: 'a'.repeat(64), mime: 'text/plain' };
  const conversation = { id: 'original', nativeId: 'native', nativeKey: 'key', connectionGeneration: 'generation', revision: 1, title: 'Original', state: 'ready', projectId: null, archived: false, model: null, thinking: null, createdAt: time, updatedAt: time };
  const operation = { id: 'original-reply', conversationId: 'original', state: 'completed', createdAt: time, updatedAt: time, input: 'Original sent input', text: 'Saved result', context: { attachments: [attachment], project: null } };
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('Inspection must not dispatch'); });
  const props = { appIcon: 'red', snapshot: { ...f.snapshot, records: {}, drafts: [{ id: f.id, deviceId: 'device', revision: 1, value: { ...emptyDraft, conversationId: 'original', text: 'Original draft', attachments: [attachment] }, updatedAt: time }] },
    controller: { ...controller, conversation, conversations: [conversation], operations: [operation], connection: { state: 'ready', generation: 'generation', methods: [], grantedScopes: ['operator.write'] }, statusRead: 'ready' },
    voice: { subscribe: () => () => {}, getSnapshot: () => ({ phase: 'idle', turns: [] }) }, contentActions: {}, refreshWorkspace: async () => {}, openSettings() {}, newProject() {}, editProject() {},
  } as unknown as Parameters<typeof Assistant>[0];
  const outer = f.renderer(() => Assistant(props))();
  const renderBranch = f.renderer(() => (outer.type as any)(outer.props)); let branch = renderBranch();
  const renderEditor = f.renderer(() => (branch.type as any)(branch.props));
  const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
  const render = () => { branch = renderBranch(); return nodes(renderEditor()); };
  let controls = render();
  controls.find(node => node.type === 'textarea').props.onChange({ target: { value: 'Newer unsent writing' } });
  controls = render();
  controls.find(node => node.type?.name === 'ConversationHeaderTools').props.sources();
  controls = render();
  let panel = controls.find(node => node.type?.name === 'AssistantSidePanel');
  assert.equal(panel.props.visible, true); assert.equal(panel.props.active, 'sources:next');
  controls.find(node => node.type?.name === 'ConversationSources').props.openFile(attachment);
  controls = render(); panel = controls.find(node => node.type?.name === 'AssistantSidePanel');
  assert.equal(panel.props.active, `file:${attachment.id}:${attachment.sha256}`);
  assert.ok(controls.some(node => node.type?.name === 'ConversationSources'), 'source contents stay mounted behind the exact file preview');
  panel.props.select('sources:next'); controls = render();
  controls.find(node => node.type?.name === 'ConversationHeaderTools').props.runs();
  controls = render(); panel = controls.find(node => node.type?.name === 'AssistantSidePanel');
  assert.equal(panel.props.active, 'history');
  const keptTabs = panel.props.tabs;
  panel.props.close(); controls = render(); panel = controls.find(node => node.type?.name === 'AssistantSidePanel');
  assert.equal(panel.props.visible, false); assert.equal(panel.props.tabs, keptTabs);
  assert.ok(controls.some(node => node.type?.name === 'AssistantRunHistory'), 'Back hides rather than unmounts History');
  assert.equal(controls.find(node => node.type === 'textarea').props.value, 'Newer unsent writing');
  assert.deepEqual(branch.props.journal.value.attachments, [attachment]);
  assert.equal(f.renderAssistant().selectedId, 'original');
  assert.equal(JSON.parse(f.storage.get(f.journalKey)!).value.text, 'Newer unsent writing');
  assert.equal(calls, 0); assert.equal(operation.input, 'Original sent input');
});


test('actual Projects panel refuses archived, pin, saved-version and conversation navigation while its writer cannot retain',t=>{
  const f=fixture(t),controller=f.renderAssistant(),time='2026-10-20T12:00:00Z';
  const conversation={id:'original',nativeId:'native',nativeKey:'key',connectionGeneration:'generation',revision:1,title:'Original',state:'ready',projectId:null,archived:false,model:null,thinking:null,createdAt:time,updatedAt:time};
  const archived={...conversation,id:'archived',nativeId:'native:archive',title:'Earlier Chat',archived:true};
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('Navigation must not dispatch');});
  const props={appIcon:'red',snapshot:{...f.snapshot,records:{},drafts:[{id:f.id,deviceId:'device',revision:1,value:{...emptyDraft,conversationId:'original',text:'Original writing'},updatedAt:time}]},
    controller:{...controller,conversation,conversations:[conversation,archived],connection:{state:'ready',generation:'generation',methods:[],grantedScopes:['operator.write']},statusRead:'ready'},
    voice:{subscribe:()=>()=>{},getSnapshot:()=>({phase:'idle',turns:[]})},contentActions:{},refreshWorkspace:async()=>{},openSettings(){},newProject(){},editProject(){},
  } as unknown as Parameters<typeof Assistant>[0];
  const outer=f.renderer(()=>Assistant(props))(),renderBranch=f.renderer(()=>(outer.type as any)(outer.props));let branch=renderBranch();
  const renderEditor=f.renderer(()=>(branch.type as any)(branch.props));const nodes=(node:any):any[]=>Array.isArray(node)?node.flatMap(nodes):node?.props?[node,...nodes(node.props.children)]:[];
  const render=()=>{branch=renderBranch();return nodes(renderEditor());};let controls=render();
  controls.find(n=>n.type==='button'&&n.props.children==='Manage').props.onClick();controls=render();assert.ok(controls.some(n=>n.type?.name==='ProjectManager'));
  let allowed=false;const unregister=registerRecordDraftNavigation(()=>allowed);t.after(unregister);
  const tools=controls.find(n=>n.type?.name==='ConversationHeaderTools');tools.props.openVersion(archived);controls=render();assert.ok(controls.some(n=>n.type?.name==='ProjectManager'));assert.equal(controls.some(n=>n.type?.name==='ConversationReader'),false);
  tools.props.openPin({conversationId:archived.id,nativeId:archived.nativeId,messageId:'message',messageHash:'a'.repeat(64),role:'assistant'});controls=render();assert.ok(controls.some(n=>n.type?.name==='ProjectManager'));
  controls.find(n=>n.type?.name==='AssistantSidePanel').props.close();controls=render();assert.equal(controls.find(n=>n.type?.name==='AssistantSidePanel').props.visible,true);
  assert.equal(controller.select('other'),false);assert.equal(f.renderAssistant().selectedId,'original');assert.equal(calls,0);assert.equal(f.storage.has('e3:reading:device'),false);
  allowed=true;controls.find(n=>n.type?.name==='ConversationHeaderTools').props.openVersion(archived);controls=render();assert.ok(controls.some(n=>n.type?.name==='ConversationReader'));assert.equal(controls.some(n=>n.type?.name==='ProjectManager'),false);assert.equal(branch.props.journal.value.text,'Original writing');assert.equal(f.renderAssistant().selectedId,'original');assert.equal(calls,0);
});
