import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { defaultLayout, type Snapshot } from '../packages/domain/contracts';
import type { HomeAssistantHandoff, HomeLibraryCommand, HomeLibraryState, HomeResource, HomeSourceCapture } from '../packages/domain/home-library';
import { emptyIdeaScope, emptySourcePickerView, ideaScopeKey, type SourcePickerView } from '../apps/client/src/home-ideas-state';

// Retain the real component callbacks, capture journal and domain selectors.
// Only hook scheduling, browser storage and the network boundary are controlled.
const key = Symbol.for('nova.test.home-ideas-interactions');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
 resolve(specifier, context, next) {
  if (/\/apps\/client\/src\/(?:HomeIdeas|HomeSourcePicker|HomeLibrary|useIdeaPursuits)\./.test(context.parentURL ?? '')) {
   if (specifier === 'react') return { url: 'nova-ideas-test:react', shortCircuit: true };
   if (specifier === './api') return { url: 'nova-ideas-test:api', shortCircuit: true };
   if (specifier === './useWorkspace') return { url: 'nova-ideas-test:window', shortCircuit: true };
  }
  return next(specifier, context);
 },
 load(url, context, next) {
  const f = `const f=()=>globalThis[Symbol.for('nova.test.home-ideas-interactions')];`;
  if (url === 'nova-ideas-test:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};${f}export const useMemo=(fn,deps)=>f().memo(fn,deps);export const useState=v=>f().state(v);export const useRef=v=>f().ref(v);export const useId=()=>f().id();export const useEffect=(fn,deps)=>f().effect(fn,deps);` };
  if (url === 'nova-ideas-test:api') return { format: 'module', shortCircuit: true, source: `${f}export class ApiError extends Error{};export const readLocal=k=>f().read(k);export const saveLocal=(k,v)=>f().save(k,v);export const request=(p,d)=>f().request(p,d);` };
  if (url === 'nova-ideas-test:window') return { format: 'module', shortCircuit: true, source: `export const retainedWindowId='ideas-test-window';` };
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
  return next(url, context);
 },
});
const { HomeIdeas } = await import('../apps/client/src/HomeIdeas');
const { HomeSourcePicker } = await import('../apps/client/src/HomeSourcePicker');
const { mayLeaveHomeDraft } = await import('../apps/client/src/home-draft-navigation');
type Deferred = { path: string; input: any; resolve: (value: HomeSourceCapture) => void; reject: (error: Error) => void };
const instances = new Set<Hooks>();
class Hooks {
 slots: any[] = []; index = 0; effects: (() => void)[] = [];
 storage = new Map<string, string>(); failStorage = false; failReadbackOnce = false; readFailures = 0; storageWrites: string[] = []; requests: Deferred[] = [];
 memo(make:()=>any,deps:unknown[]){const i=this.index++,old=this.slots[i];if(!old||deps.some((value,k)=>!Object.is(value,old.deps[k])))this.slots[i]={value:make(),deps};return this.slots[i].value;}
 ideaReceipts=new Map<string,unknown>();ideaCommands:any[]=[];
 state(initial: any) { const i = this.index++;if (!(i in this.slots)) this.slots[i] = typeof initial === 'function' ? initial() : initial;return [this.slots[i], (value: any) => { this.slots[i] = typeof value === 'function' ? value(this.slots[i]) : value; }]; }
 ref(value: unknown) { return this.slots[this.index++] ??= { current: value }; }
 id() { return this.slots[this.index++] ??= 'ideas-source-search'; }
 effect(fn: () => (() => void) | void, deps: unknown[]) { const i = this.index++, old = this.slots[i];if (!old || deps.some((value, n) => !Object.is(value, old.deps[n]))) this.effects.push(() => { old?.cleanup?.();this.slots[i] = { deps, cleanup: fn() }; }); }
 read(name: string) { try { const raw = this.storage.get(name);return raw === undefined ? undefined : JSON.parse(raw); } catch { return undefined; } }
 get(name: string) { if (this.readFailures > 0) { this.readFailures--;throw Error('Synthetic readback failure'); }return this.storage.get(name) ?? null; }
 write(name: string, raw: string) { if (this.failStorage) throw Error('Synthetic storage full');this.storageWrites.push(name);this.storage.set(name, raw);if (this.failReadbackOnce) { this.failReadbackOnce = false;this.readFailures++; } }
 save(name: string, value: unknown) { try { this.write(name, JSON.stringify(value));return true; } catch { return false; } }
 request(path: string, input: any) {
  if(path==='home/ideas'&&input===undefined)return Promise.resolve({epoch,rows:[],next:null});
  if(path==='home/ideas'){
   assert.equal(input.type,'create');this.ideaCommands.push(input);
   const receipt={command:input,state:'saved',entryId:input.entryId,pursuit:{id:input.id,epoch:input.epoch,starterId:input.handoff.ideaId,title:input.handoff.title,revision:1,createdAt:'2026-10-20T05:00:00Z',updatedAt:'2026-10-20T05:00:00Z',initialEntryId:input.entryId,reviewed:false}};
   this.ideaReceipts.set(input.requestId,receipt);return Promise.resolve(receipt);
  }
  if(path==='home/ideas/receipt')return Promise.resolve(this.ideaReceipts.get(input.requestId)??{command:input,state:'unknown'});
  assert.equal(path, 'home/context', 'No provider or send route is allowed');return new Promise<HomeSourceCapture>((resolve, reject) => this.requests.push({ path, input, resolve, reject }));
 }
 render<T>(fn: () => T) { instances.add(this);(globalThis as any)[key] = this;this.index = 0;this.effects = [];const tree = fn();for (const effect of this.effects) effect();return tree; }
 dispose() { for (const slot of this.slots) slot?.cleanup?.();instances.delete(this); }
}
const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
 getItem: (name: string) => ((globalThis as any)[key] as Hooks).get(name),
 setItem: (name: string, value: string) => ((globalThis as any)[key] as Hooks).write(name, value),
} });
Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
test.afterEach(() => { for (const f of [...instances]) f.dispose(); });
test.after(() => {
 loader.deregister();delete (globalThis as any)[key];
 if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);else delete (globalThis as any).localStorage;
 if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);else delete (globalThis as any).window;
});
const nodes = (node: any): any[] => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
const text = (node: any): string => typeof node === 'string' || typeof node === 'number' ? String(node) : !node || typeof node !== 'object' ? '' : [node.props?.children].flat(Infinity).map(text).join('');
function button(tree: any, name: string) { const found = nodes(tree).find(n => n.type === 'button' && (n.props['aria-label'] === name || text(n) === name));assert.ok(found, name);return found; }
const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const epoch = '11111111-1111-4111-8111-111111111111', device = 'device:ideas';
const viewKey = `e3:home-ideas-view:${device}:${epoch}:ideas-test-window`;
const scopeKey = ideaScopeKey(device, epoch, 'draft-notes');
const source: HomeResource = { reference: { kind: 'note', id: 'library:original', revision: 7, sha256: 'a'.repeat(64) }, title: 'Original Saved Writing', subtitle: 'Original note', text: 'Exact saved source body', availability: 'current', updatedAt: '2026-10-20T05:00:00Z' };
function fixture(selected = true) {
 const hooks = new Hooks();
 const snapshot: Snapshot = { epoch, deviceId: device, cursor: 0, tasks: [], projects: [], drafts: [],
  layout: { id: 'layout', revision: 1, updatedAt: source.updatedAt, deviceId: device, value: structuredClone(defaultLayout) },
  capabilities: { assistant: false, voice: false, reason: 'Isolated fixture' } };
 const state: HomeLibraryState = { epoch, collections: [], items: [], resources: [source], ideaPreferences: { revision: 8, saved: [], hidden: [] }, organization: { revision: 0, collectionIds: [] } };
 const writes: HomeLibraryCommand[] = [], handoffs: HomeAssistantHandoff[] = [];
 const props: Parameters<typeof HomeIdeas>[0] = { snapshot, controller: { state, busy: false, error: '', journalError: '', loading: false, pending: undefined, lastSave: undefined,
  async load() {}, async run(command) { writes.push(command);return undefined; } }, onAssistantHandoff(value) { handoffs.push(value); } };
 if (selected) {
  hooks.storage.set(viewKey, JSON.stringify({ view: 'explore', category: 'All Categories', selected: 'draft-notes' }));
  hooks.storage.set(scopeKey, JSON.stringify({ ...emptyIdeaScope('draft-notes'), sources: [source.reference], instructions: 'Keep this exact direction' }));
 }
 const render = () => hooks.render(() => HomeIdeas(props));
 return { hooks, snapshot, state, props, writes, handoffs, render };
}
function directions(tree: any) { const found = nodes(tree).find(n => n.type === 'textarea');assert.ok(found);return found; }
function picker(tree: any) { const found = nodes(tree).find(n => n.type === HomeSourcePicker);assert.ok(found);return found; }
function capture(f: ReturnType<typeof fixture>, index = 0, changed = false): HomeSourceCapture {
 const request = f.hooks.requests[index];assert.ok(request);
 return { id: '22222222-2222-4222-8222-222222222222', epoch: request.input.epoch, createdAt: source.updatedAt, sources: request.input.references.map((reference: HomeResource['reference']) => ({ ...source, reference: changed ? { ...reference, revision: reference.revision + 1 } : reference })) };
}

test('failed retention keeps visible writing, blocks departure and retries the same scope only', () => {
 const f = fixture(), original = f.hooks.storage.get(scopeKey);
 let tree = f.render();f.hooks.failStorage = true;
 directions(tree).props.onChange({ target: { value: 'Unkept newer writing\n雪' } });tree = f.render();
 button(tree, 'Keep And Close').props.onClick();tree = f.render();
 assert.equal(directions(tree).props.value, 'Unkept newer writing\n雪');assert.equal(f.hooks.storage.get(scopeKey), original);
 assert.equal(mayLeaveHomeDraft(), false);assert.equal(f.hooks.requests.length, 0);assert.equal(f.handoffs.length, 0);
 f.hooks.failStorage = false;button(tree, 'Retry Keeping Writing').props.onClick();tree = f.render();
 assert.equal(f.hooks.read(scopeKey).instructions, 'Unkept newer writing\n雪');assert.equal(mayLeaveHomeDraft(), true);
 button(tree, 'Keep And Close').props.onClick();tree = f.render();assert.equal(nodes(tree).some(n => n.type === 'textarea'), false);
});

test('concurrent scope changes preserve both the other window record and newer open writing', () => {
 const f = fixture();let tree = f.render();
 const external = JSON.stringify({ ...emptyIdeaScope('draft-notes'), instructions: 'Other window owns this saved value' });
 f.hooks.storage.set(scopeKey, external);
 directions(tree).props.onChange({ target: { value: 'Keep my unsaved current writing' } });tree = f.render();
 button(tree, 'Open Assistant Draft').props.onClick();button(tree, 'Keep And Close').props.onClick();tree = f.render();
 assert.equal(f.hooks.storage.get(scopeKey), external);assert.equal(directions(tree).props.value, 'Keep my unsaved current writing');
 assert.match(text(tree), /another window/);assert.equal(f.hooks.requests.length, 0);assert.deepEqual(f.writes, []);assert.deepEqual(f.handoffs, []);
});

test('readback failure reconciles exact already-written scope on explicit retry without another write', () => {
 const f = fixture();let tree = f.render();f.hooks.failReadbackOnce = true;
 directions(tree).props.onChange({ target: { value: 'Written but not yet confirmed' } });tree = f.render();
 assert.equal(f.hooks.read(scopeKey).instructions, 'Written but not yet confirmed');
 assert.equal(directions(tree).props.value, 'Written but not yet confirmed');
 const writes = f.hooks.storageWrites.filter(key => key === scopeKey).length;
 button(tree, 'Retry Keeping Writing').props.onClick();tree = f.render();
 assert.equal(nodes(tree).some(n => n.type === 'button' && text(n) === 'Retry Keeping Writing'), false);
 assert.equal(f.hooks.storageWrites.filter(key => key === scopeKey).length, writes, 'Exact completed write is acknowledged, not repeated');
 assert.equal(mayLeaveHomeDraft(), true);assert.deepEqual(f.hooks.requests, []);assert.deepEqual(f.handoffs, []);
});

test('malformed retained scopes remain read-only without capture or fallback writes', () => {
 const f = fixture(), raw = '{"unfinished":"original bytes"';f.hooks.storage.set(scopeKey, raw);
 const tree = f.render();
 assert.match(text(tree), /original browser record is preserved/);assert.equal(nodes(tree).some(n => n.type === 'textarea'), false);
 assert.equal(button(tree, 'Open Assistant Draft').props.disabled, true);assert.equal(f.hooks.storage.get(scopeKey), raw);
 assert.deepEqual(f.hooks.storageWrites, []);assert.deepEqual(f.hooks.requests, []);assert.deepEqual(f.handoffs, []);
});

test('a late original capture after epoch change or unmount never hands off or clears its journal', async () => {
 for (const boundary of ['epoch', 'unmount']) {
  const f = fixture();button(f.render(), 'Open Assistant Draft').props.onClick();assert.equal(f.hooks.requests.length, 1);
  const journalKey = `e3:home-capture:${device}:${epoch}:idea:draft-notes`, kept = f.hooks.storage.get(journalKey);
  if (boundary === 'epoch') { f.props.snapshot = { ...f.snapshot, epoch: '22222222-2222-4222-8222-222222222222' };f.render(); } else f.hooks.dispose();
  f.hooks.requests[0].resolve(capture(f));await settle();
  assert.deepEqual(f.handoffs, []);assert.equal(f.hooks.storage.get(journalKey), kept);assert.equal(f.hooks.requests.length, 1);f.hooks.dispose();
 }
});

test('a preview uses the exact saved version and stale or mismatched responses cannot replace it', async () => {
 const f = fixture();picker(f.render()).props.inspect(source);let tree = f.render();
 assert.equal(f.hooks.requests.length, 1);assert.deepEqual(f.hooks.requests[0].input.references, [source.reference]);
 f.hooks.requests[0].resolve(capture(f, 0, true));await settle();tree = f.render();
 assert.match(text(tree), /did not match the exact selected source/);assert.deepEqual(f.handoffs, []);assert.deepEqual(f.writes, []);
 button(tree, 'Back To Idea').props.onClick();picker(f.render()).props.inspect(source);tree = f.render();
 button(tree, 'Back To Idea').props.onClick();f.hooks.requests[1].resolve(capture(f, 1));await settle();tree = f.render();
 assert.equal(nodes(tree).some(n => n.props?.title === source.title), false);assert.deepEqual(f.handoffs, []);
});

test('handoff validates source identity, retains direction and opens only the existing draft callback', async () => {
 const f = fixture();button(f.render(), 'Open Assistant Draft').props.onClick();
 f.hooks.requests[0].resolve(capture(f, 0, true));await settle();
 assert.equal(f.handoffs.length, 0);assert.match(text(f.render()), /did not match the reviewed source versions/);
 button(f.render(), 'Open Assistant Draft').props.onClick();
 assert.equal(f.hooks.requests[1].input.requestId, f.hooks.requests[0].input.requestId, 'The original capture request is reconciled');
 f.hooks.requests[1].resolve(capture(f, 1));await settle();
 assert.equal(f.handoffs.length, 1);const handed = f.handoffs[0];
 assert.equal(handed.authoredDirections,'Keep this exact direction');
 assert.equal(f.hooks.ideaCommands.length,1);assert.equal(handed.idea?.pursuitId,f.hooks.ideaCommands[0].id);assert.equal(handed.idea?.entryId,f.hooks.ideaCommands[0].entryId);
 assert.equal(handed.sourceCaptureId, '22222222-2222-4222-8222-222222222222');assert.deepEqual(handed.sourceRefs, [source.reference]);
 assert.equal(handed.ideaId, 'draft-notes');assert.match(handed.text, /Keep this exact direction/);assert.match(handed.text, /Exact saved source body/);
 assert.deepEqual(f.writes, []);assert.equal(f.hooks.requests.every(r => r.path === 'home/context'), true);
 assert.equal(f.hooks.read(scopeKey).instructions, 'Keep this exact direction');
});

test('handoff completion clears only its selection and preserves a newer chosen view', async () => {
 const f = fixture();let tree = f.render();button(tree, 'Open Assistant Draft').props.onClick();tree = f.render();
 const savedTab = nodes(tree).find(n => n.type === 'button' && n.props.role === 'tab' && text(n).startsWith('Saved'));assert.ok(savedTab);
 savedTab.props.onClick();tree = f.render();assert.equal(f.hooks.read(viewKey).view, 'saved');
 f.hooks.requests[0].resolve(capture(f));await settle();f.render();
 assert.equal(f.handoffs.length, 1);assert.equal(f.hooks.read(viewKey).view, 'saved');
 assert.equal(f.hooks.read(viewKey).selected, undefined);
});

test('Save uses the current preference revision and an unresolved original command blocks new saves', () => {
 const f = fixture(false);let tree = f.render();
 button(tree, 'Save Plan My Week').props.onClick();
 assert.equal(f.writes.length, 1);const saved = f.writes[0];assert.equal(saved.type, 'preferences-save');
 if (saved.type !== 'preferences-save') throw Error('Expected preference command');
 assert.equal(saved.expectedRevision, 8);assert.deepEqual(saved.value, { saved: ['plan-week'], hidden: [] });assert.equal(saved.epoch, epoch);
 f.props.controller.pending = saved;tree = f.render();assert.equal(button(tree, 'Save Plan My Week').props.disabled, true);
 button(tree, 'Check Original Library Save').props.onClick();assert.equal(f.writes[1], saved);
 assert.deepEqual(f.handoffs, []);assert.deepEqual(f.hooks.requests, []);
});

test('stale Save callbacks cannot bypass a newer pending command, revision or invalid journal', () => {
 for (const changed of ['pending', 'revision', 'journal']) {
  const f = fixture(false), stale = button(f.render(), 'Save Plan My Week');
  const original: HomeLibraryCommand = { type: 'preferences-save', requestId: crypto.randomUUID(), epoch, expectedRevision: 8, value: { saved: ['daily-focus'], hidden: [] } };
  f.props.controller = { ...f.props.controller,
   ...(changed === 'pending' ? { pending: original } : changed === 'journal' ? { journalError: 'Original Library request cannot be read.' } :
    { state: { ...f.state, ideaPreferences: { revision: 9, saved: ['daily-focus'], hidden: [] } } }) };
  const tree = f.render();stale.props.onClick();assert.deepEqual(f.writes, []);
  if (changed === 'journal') { assert.match(text(tree), /Original Library request cannot be read/);assert.equal(button(tree, 'Save Plan My Week').props.disabled, true); }
  f.hooks.dispose();
 }
});

test('original pending collection saves stay exact and use truthful Library recovery wording', () => {
 const f = fixture(false);
 const original: HomeLibraryCommand = { type: 'collection-save', requestId: crypto.randomUUID(), epoch, id: 'collection:original', expectedRevision: 3,
  value: { title: 'Keep original collection', subtitle: 'Original description', icon: 'folder', archived: false, pinned: false, references: [source.reference] } };
 f.props.controller.pending = original;const tree = f.render();assert.deepEqual(f.writes, []);
 button(tree, 'Check Original Library Save').props.onClick();assert.equal(f.writes[0], original);
 assert.equal(original.value.title, 'Keep original collection');assert.equal(button(tree, 'Save Plan My Week').props.disabled, true);
});

test('keyboard Ideas tabs move focus only after retaining navigation and refuse a failed view save', () => {
 const f = fixture(false), focused: string[] = [];let tree = f.render();
 for (const tab of nodes(tree).filter(n => n.type === 'button' && n.props.role === 'tab')) tab.props.ref({ focus() { focused.push(tab.props.id); } });
 let prevented = false;const tablist = nodes(tree).find(n => n.props?.role === 'tablist');assert.ok(tablist);
 tablist.props.onKeyDown({ key: 'ArrowRight', preventDefault() { prevented = true; } });tree = f.render();
 assert.equal(prevented, true);assert.equal(f.hooks.read(viewKey).view, 'saved');assert.deepEqual(focused, ['idea-tab-saved']);
 assert.equal(nodes(tree).find(n => n.props?.id === 'idea-tab-saved')!.props.tabIndex, 0);
 f.hooks.failStorage = true;
 nodes(tree).find(n => n.props?.role === 'tablist')!.props.onKeyDown({ key: 'End', preventDefault() {} });tree = f.render();
 assert.equal(f.hooks.read(viewKey).view, 'saved');assert.deepEqual(focused, ['idea-tab-saved']);
 assert.equal(nodes(tree).find(n => n.props?.id === 'idea-tab-saved')!.props['aria-selected'], true);
 assert.match(text(tree), /view could not be kept/);assert.deepEqual(f.hooks.requests, []);assert.deepEqual(f.writes, []);
});

test('a throwing browser storage getter shows a readable state without replacing unknown records', () => {
 const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
 Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('Browser denies storage'); } });
 try {
  const f = fixture(false), tree = f.render();
  assert.match(text(tree), /earlier Idea view could not be read/);
  assert.deepEqual(f.hooks.storageWrites, []);assert.deepEqual(f.hooks.requests, []);assert.deepEqual(f.writes, []);
 } finally { Object.defineProperty(globalThis, 'localStorage', prior); }
});

test('compact picker reaches filtered source141, keeps exact selections and previews without selecting', () => {
 const hooks = new Hooks(), resources: HomeResource[] = Array.from({ length: 141 }, (_, index) => ({ ...source,
  reference: { kind: 'note', id: `note:${index + 1}`, revision: index + 1 }, title: `Source ${index + 1}`, subtitle: 'Collection material' }));
 let view: SourcePickerView = { ...emptySourcePickerView }, selected: HomeResource['reference'][] = [];
 const selections: HomeResource['reference'][][] = [], previews: HomeResource[] = [];
 const collection = { id: 'collection:all', title: 'All 141 Sources', subtitle: '', icon: 'folder' as const, revision: 1, updatedAt: source.updatedAt, pinned: false, archived: false, references: resources.map(r => r.reference) };
 function render() {
  return hooks.render(() => {
   const catalog = HomeSourcePicker({ compact: true, resources, collections: [collection], selected, view,
    changeView(next) { view = next; }, select(refs) { selections.push(refs);selected = refs; }, inspect(resource) { previews.push(resource); } });
   const tool = nodes(catalog).find(n => typeof n.type === 'function' && n.type.name === 'SourceTools');assert.ok(tool);
   return { catalog, tools: tool.type(tool.props) };
  });
 }
 let result = render();nodes(result.tools).find(n => n.type === 'select')!.props.onChange({ target: { value: collection.id } });result = render();
 for (let n = 0; n < 3; n++) { nodes(result.catalog).find(n => n.type === 'button' && text(n).startsWith('Show More Sources'))!.props.onClick();result = render(); }
 assert.match(text(result.catalog), /Source 141/);button(result.catalog, 'Preview Source 141').props.onClick();
 assert.equal(previews[0], resources[140]);assert.deepEqual(selections, []);
 button(result.tools, 'Search Library Sources').props.onClick();result = render();
 nodes(result.tools).find(n => n.type === 'input' && n.props.type === 'search')!.props.onChange({ target: { value: 'Source 141' } });result = render();
 const checkbox = nodes(result.catalog).find(n => n.type === 'input' && n.props.type === 'checkbox');assert.ok(checkbox);
 checkbox.props.onChange({ target: { checked: true } });result = render();assert.equal(selected[0], resources[140].reference);
 button(result.tools, 'Close Source Search').props.onClick();result = render();assert.equal(view.query, 'Source 141');assert.equal(view.collection, collection.id);
 resources.splice(140, 1);result = render();assert.match(text(result.catalog), /Unavailable saved source/);assert.equal(selected[0].revision, 141);
 assert.equal(selections.length, 1);const remove = nodes(result.catalog).find(n => n.type === 'input' && n.props['aria-label'] === 'Remove unavailable source');assert.ok(remove);
 remove.props.onChange();assert.deepEqual(selected, []);assert.equal(previews.length, 1);
});
