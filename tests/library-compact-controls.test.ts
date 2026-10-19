import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultLayout, type Snapshot } from '../packages/domain/contracts';
import type { HomeLibraryCommand, HomeLibraryState } from '../packages/domain/home-library';
import { Dialog } from '../apps/client/src/ui';

const key = Symbol.for('nova.test.library-compact'), react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
 resolve(specifier, context, next) {
  if (/\/apps\/client\/src\/HomeLibrary\./.test(context.parentURL ?? '')) {
   if (specifier === 'react') return { url: 'nova-library-compact:react', shortCircuit: true };
   if (specifier === './api') return { url: 'nova-library-compact:api', shortCircuit: true };
   if (specifier === './useWorkspace') return { url: 'nova-library-compact:window', shortCircuit: true };
   if (specifier === './useReorder') return { url: 'nova-library-compact:reorder', shortCircuit: true };
  }
  return next(specifier, context);
 },
 load(url, context, next) {
  const fixture = `const f=()=>globalThis[Symbol.for('nova.test.library-compact')];`;
  if (url === 'nova-library-compact:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};${fixture}export const useState=v=>f().state(v);export const useRef=v=>f().ref(v);export const useId=()=>f().id();export const useEffect=(fn,deps)=>f().effect(fn,deps);` };
  if (url === 'nova-library-compact:api') return { format: 'module', shortCircuit: true, source: `${fixture}export class ApiError extends Error{};export const readLocal=k=>f().read(k);export const saveLocal=(k,v)=>f().save(k,v);export const request=()=>{throw Error('Unexpected request');};` };
  if (url === 'nova-library-compact:window') return { format: 'module', shortCircuit: true, source: `export const retainedWindowId='fixture-tab';` };
  if (url === 'nova-library-compact:reorder') return { format: 'module', shortCircuit: true, source: `export const useReorder=ids=>({order:ids,suppressClick:{current:false},containerRef:{current:null},bind:()=>({}),move(){},announcement:'',saving:false});` };
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
  return next(url, context);
 },
});
const { HomeLibrary } = await import('../apps/client/src/HomeLibrary');
class Hooks {
 slots: any[] = []; index = 0; pending: (() => void)[] = []; storage = new Map<string, string>(); failStorage = false;
 state(value: any) { const i = this.index++; if (!(i in this.slots)) this.slots[i] = typeof value === 'function' ? value() : value; return [this.slots[i], (next: any) => { this.slots[i] = typeof next === 'function' ? next(this.slots[i]) : next; }]; }
 ref(value: unknown) { return this.slots[this.index++] ??= { current: value }; }
 id() { return this.slots[this.index++] ??= 'library-search-fixture'; }
 effect(fn: () => void, deps: unknown[]) { const i = this.index++, prior = this.slots[i] as unknown[] | undefined; if (!prior || deps.some((item, n) => !Object.is(item, prior[n]))) { this.slots[i] = deps; this.pending.push(fn); } }
 read(name: string) { const raw = this.storage.get(name); return raw === undefined ? undefined : JSON.parse(raw); }
 save(name: string, value: unknown) { if (this.failStorage) return false; this.storage.set(name, JSON.stringify(value)); return true; }
 render(props: Parameters<typeof HomeLibrary>[0]) { this.index = 0; this.pending = []; (globalThis as any)[key] = this; const tree = HomeLibrary(props); for (const run of this.pending) run(); return tree; }
}
const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (name: string) => ((globalThis as any)[key] as Hooks).storage.get(name) ?? null } });
function elements(node: any): any[] { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(elements)]; }
const text = (node: any): string => typeof node === 'string' || typeof node === 'number' ? String(node) : !node || typeof node !== 'object' ? '' : [node.props?.children].flat(Infinity).map(text).join('');
const button = (tree: any, name: string) => elements(tree).find(node => node.type === 'button' && (node.props['aria-label'] === name || text(node) === name));
const menu = (tree: any, label: string) => elements(tree).find(node => (node.props?.label === label || node.props?.label?.startsWith(label + ': ')) && typeof node.props.children === 'function')!.props.children(() => {});
const viewKey = 'e3:home-library-view:fixture:epoch-one';
const writerKey = 'e3:home-library-writer:fixture:epoch-one:fixture-tab:item';
function fixture() {
 const hooks = new Hooks(), at = '2026-10-19T12:00:00Z';
 const reference = { kind: 'note' as const, id: 'library:note', revision: 3 };
 const library: HomeLibraryState = { epoch: 'epoch-one', collections: [{ id: 'collection:one', revision: 4, updatedAt: at, title: 'Launch Notes', subtitle: 'Keep This Case', icon: 'folder', pinned: true, archived: false, references: [reference] }], items: [{ ...reference, kind: 'note', title: 'Keep My Writing', body: 'Original note body', archived: false, updatedAt: at }], resources: [{ reference, title: 'Keep My Writing', subtitle: 'Note', text: 'Original note body', availability: 'current', updatedAt: at }], ideaPreferences: { revision: 0, saved: [], hidden: [] }, organization: { revision: 1, collectionIds: ['collection:one'] } };
 const snapshot: Snapshot = { epoch: 'epoch-one', deviceId: 'fixture', cursor: 0, tasks: [], drafts: [], projects: [], layout: { id: 'layout', revision: 1, updatedAt: at, deviceId: 'fixture', value: structuredClone(defaultLayout) }, capabilities: { assistant: false, voice: false, reason: 'Isolated fixture' } };
 const writes: HomeLibraryCommand[] = [], opened: typeof reference[] = []; let widgetOpens = 0;
 const controller: Parameters<typeof HomeLibrary>[0]['controller'] = { state: library, error: '', journalError: '', lastSave: undefined, loading: false, busy: false, pending: undefined, async load() {}, async run(command) { writes.push(command); return undefined; } };
 const props: Parameters<typeof HomeLibrary>[0] = { snapshot, controller, openWidgets() { widgetOpens++; }, openResource(ref) { opened.push(ref as typeof reference); } };
 return { hooks, library, snapshot, props, reference, writes, opened, get widgetOpens() { return widgetOpens; } };
}

test('Library search dismisses, reopens and reloads without losing query, exact selection or view scope', () => {
 const f = fixture(), selection = { collectionId: 'collection:one', references: [f.reference] };
 f.hooks.save(viewKey, { mode: 'compact', filter: 'all', collectionId: null, selection });
 let tree = f.hooks.render(f.props);
 button(tree, 'Search Library').props.onClick(); tree = f.hooks.render(f.props);
 elements(tree).find(node => node.type === 'input' && node.props.type === 'search')!.props.onChange({ target: { value: 'Writing' } }); tree = f.hooks.render(f.props);
 button(tree, 'Close Library Search').props.onClick(); tree = f.hooks.render(f.props);
 assert.equal(elements(tree).some(node => node.type === 'input' && node.props.type === 'search'), false);
 assert.ok(button(tree, 'Search: Writing')); assert.deepEqual(f.hooks.read(viewKey).selection, selection);
 button(menu(tree, 'View Options'), 'Cards').props.onClick(); tree = f.hooks.render(f.props);
 assert.equal(f.hooks.read(viewKey).query, 'Writing'); assert.equal(f.hooks.read(viewKey).mode, 'cards');
 const canvas = elements(tree).find(node => node.type?.name === 'CollectionCanvas')!;
 canvas.props.render(f.library.collections[0], null).props.focus(); tree = f.hooks.render(f.props);
 assert.equal(f.hooks.read(viewKey).query, 'Writing'); assert.equal(f.hooks.read(viewKey).collectionId, 'collection:one');
 assert.equal(elements(tree).find(node => node.type === 'h1')!.props['aria-label'], 'Launch Notes'); assert.ok(elements(tree).find(node => node.props?.label === 'Browse Library: Launch Notes'));
 const reloaded = new Hooks(); reloaded.storage = f.hooks.storage; tree = reloaded.render(f.props);
 assert.ok(button(tree, 'Search: Writing')); assert.deepEqual(reloaded.read(viewKey).selection, selection);
 button(tree, 'Search: Writing').props.onClick(); tree = reloaded.render(f.props);
 const input = elements(tree).find(node => node.type === 'input' && node.props.type === 'search')!; assert.equal(input.props.value, 'Writing');
 let prevented = false; elements(tree).find(node => node.props?.className === 'home-library-search-disclosure')!.props.onKeyDown({ key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() {} }); tree = reloaded.render(f.props);
 assert.equal(prevented, true); assert.equal(reloaded.read(viewKey).query, 'Writing');
 let focusOptions: unknown; button(tree, 'Search Library').props.ref.current = { focus(options: unknown) { focusOptions = options; } };
 button(tree, 'Clear Library Search').props.onClick(); tree = reloaded.render(f.props);
 assert.deepEqual(focusOptions, { preventScroll: true });
 assert.equal(reloaded.read(viewKey).query, ''); assert.deepEqual(reloaded.read(viewKey).selection, selection); assert.deepEqual(f.writes, []);
});

test('scope changes merge retained query and storage failure keeps it visible without dispatching work', () => {
 const f = fixture(); f.hooks.save(viewKey, { mode: 'cards', filter: 'all', collectionId: null, selection: null, query: 'Launch' });
 let tree = f.hooks.render(f.props); button(menu(tree, 'Browse Library'), 'Pinned').props.onClick(); tree = f.hooks.render(f.props);
 assert.equal(f.hooks.read(viewKey).query, 'Launch'); assert.equal(f.hooks.read(viewKey).filter, 'pinned');
 f.hooks.failStorage = true; button(tree, 'Search Library').props.onClick(); tree = f.hooks.render(f.props);
 elements(tree).find(node => node.type === 'input' && node.props.type === 'search')!.props.onChange({ target: { value: 'Unsaved Query' } }); tree = f.hooks.render(f.props);
 assert.equal(elements(tree).find(node => node.type === 'input' && node.props.type === 'search')!.props.value, 'Unsaved Query');
 assert.match(text(tree), /View preferences could not be kept/); assert.equal(f.hooks.read(viewKey).query, 'Launch'); assert.deepEqual(f.writes, []);
});

test('Library controls preserve unfinished writing and isolate retained query on workspace change', () => {
 const f = fixture(), writer = { id: 'library:unsaved', revision: 0, destination: 'collection:one', value: { kind: 'note', title: 'Do Not Lose Me', body: 'Unfinished exact writing', archived: false } };
 f.hooks.save(writerKey, writer); f.hooks.save(viewKey, { mode: 'compact', filter: 'all', collectionId: null, selection: null, query: 'Writing' });
 let tree = f.hooks.render(f.props);
 assert.ok(elements(tree).find(node => node.props?.title === 'New note')); assert.deepEqual(f.hooks.read(writerKey), writer);
 const reloaded = new Hooks(); reloaded.storage = f.hooks.storage; tree = reloaded.render(f.props); assert.deepEqual(reloaded.read(writerKey), writer);
 f.props.snapshot = { ...f.snapshot, epoch: 'epoch-two' }; f.props.controller = { ...f.props.controller, state: { ...f.library, epoch: 'epoch-two' } };
 tree = reloaded.render(f.props); tree = reloaded.render(f.props);
 assert.equal(button(tree, 'Search: Writing'), undefined); assert.equal(elements(tree).some(node => node.props?.title === 'New note'), false);
 assert.deepEqual(reloaded.read(writerKey), writer); assert.equal(reloaded.read(viewKey).query, 'Writing'); assert.deepEqual(f.writes, []);
});

test('pending original save remains explicit while view controls and Widgets stay available', async () => {
 const f = fixture(), original: HomeLibraryCommand = { requestId: '11111111-1111-4111-8111-111111111111', epoch: 'epoch-one', type: 'references-order', collection: { id: 'collection:one', expectedRevision: 4 }, references: [f.reference] };
 f.props.controller.pending = original; const before = structuredClone(f.library); let tree = f.hooks.render(f.props);
 assert.equal(button(tree, 'New Collection').props.disabled, true);
 const options = menu(tree, 'View Options'); assert.equal(button(options, 'Paste Links').props.disabled, true); assert.equal(button(options, 'Add To Library').props.disabled, true); assert.equal(button(options, 'Open Tabs').props.disabled, true);
 button(options, 'Compact').props.onClick(); tree = f.hooks.render(f.props); button(menu(tree, 'View Options'), 'Widgets').props.onClick();
 assert.equal(f.widgetOpens, 1); assert.deepEqual(f.writes, []);
 await button(tree, 'Check original save').props.onClick(); assert.equal(f.writes.length, 1); assert.equal(f.writes[0], original); assert.deepEqual(f.library, before);
});

test('compact creation choices still open the original editors and Dialog defaults remain SSR compatible', () => {
 const f = fixture(); let tree = f.hooks.render(f.props); button(menu(tree, 'View Options'), 'Add To Library').props.onClick(); tree = f.hooks.render(f.props);
 const dialog = elements(tree).find(node => node.props?.title === 'Add To Library')!; assert.equal(dialog.props.size, 'choice');
 button(dialog, 'Write A Note').props.onClick(); tree = f.hooks.render(f.props);
 assert.equal(elements(tree).some(node => node.props?.title === 'Add To Library'), false);
 assert.ok(elements(tree).find(node => node.props?.title === 'New note')); assert.deepEqual(f.writes, []);
 const ordinary = renderToStaticMarkup(createElement(Dialog, { title: 'Editor', close() {}, children: 'Writing' }));
 const choice = renderToStaticMarkup(createElement(Dialog, { title: 'Choose', size: 'choice', close() {}, children: 'Choices' }));
 assert.match(ordinary, /class="dialog"/); assert.match(choice, /class="dialog dialog-choice"/);
});

test.after(() => { loader.deregister(); delete (globalThis as any)[key]; if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else delete (globalThis as any).localStorage; });
