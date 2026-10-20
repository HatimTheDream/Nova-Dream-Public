import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, Suspense } from 'react';
import { createModuleRegistry } from '../apps/client/src/preload-lazy';
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Snapshot } from '../packages/domain/contracts.js';
import type { HomeLibraryCommand, HomeLibraryState, HomeLibraryReceipt, HomeCollection, HomeResource, HomeReference } from '../packages/domain/home-library.js';

const symbol = Symbol.for('nova.test.home-library-lifecycle'), react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
 resolve(specifier, context, next) {
  if (/\/apps\/client\/src\/(?:HomeLibrary|Home)\./.test(context.parentURL ?? '')) {
   if (specifier === 'react') return { url: 'nova-home-test:react', shortCircuit: true };
   if (specifier === './api') return { url: 'nova-home-test:api', shortCircuit: true };
   if (specifier === './useWorkspace') return { url: 'nova-home-test:workspace', shortCircuit: true };
   if (/\/Home\./.test(context.parentURL ?? '')) {
    if (['./HomeSpace', './HomeToday', './HomeIdeas', './HomeFeed', './BriefingCard', './HomeAppointmentWidget'].includes(specifier)) return { url: 'nova-home-test:child:' + specifier.slice(2), shortCircuit: true };
    if (specifier.endsWith('.css')) return { url: 'nova-home-test:css', shortCircuit: true };
   }
  }
  return next(specifier, context);
 },
 load(url, context, next) {
  if (url === 'nova-home-test:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
   const fixture=()=>globalThis[Symbol.for('nova.test.home-library-lifecycle')];
   export const useState=value=>fixture().state(value);
   export const useRef=value=>fixture().ref(value);
   export const useId=()=>fixture().id();
   export const useCallback=(fn,deps)=>fixture().callback(fn,deps);
   export const useEffect=(fn,deps)=>fixture().effect(fn,deps);` };
  if (url === 'nova-home-test:api') return { format: 'module', shortCircuit: true, source: `const fixture=()=>globalThis[Symbol.for('nova.test.home-library-lifecycle')];
   export class ApiError extends Error { constructor(code,message,current,status){super(message);this.code=code;this.current=current;this.status=status;} }
   export const readLocal=key=>fixture().storage.get(key);
   export const saveLocal=(key,value)=>{if(fixture().failSave?.(key,value))return false;if(value===null)fixture().storage.delete(key);else fixture().storage.set(key,structuredClone(value));return true;};
   export const request=(path,data)=>fixture().request(path,data);` };
  if (url === 'nova-home-test:workspace') return { format: 'module', shortCircuit: true, source: `export const retainedWindowId='lifecycle-window';` };
  if (url.startsWith('nova-home-test:child:')) return { format: 'module', shortCircuit: true, source: `import {createElement} from ${JSON.stringify(react)};export const ${url.split(':').at(-1)}=()=>createElement('p',null,'Other Home view');` };
  if (url === 'nova-home-test:css') return { format: 'module', shortCircuit: true, source: '' };
  return next(url, context);
 },
});
const { useHomeLibrary, HomeLibrary, previewLibraryLinks, UpNextShelf } = await import('../apps/client/src/HomeLibrary.js');
// The hook and fixture share the exact mocked API error constructor.
// @ts-expect-error test loader owns this virtual module
const { ApiError } = await import('nova-home-test:api');
type Deferred = { data?: unknown; resolve(value: unknown): void; reject(error: Error): void };
class Hooks {
 failSave?: (key: string, value: unknown) => boolean;
 slots: any[] = []; index = 0; scheduled: (() => void)[] = []; storage = new Map<string, unknown>(); raw = new Map<string, string>(); reads: Deferred[] = []; writes: Deferred[] = [];
 state(initial: any) { const index = this.index++;if (!(index in this.slots)) this.slots[index] = typeof initial === 'function' ? initial() : initial;return [this.slots[index], (value: any) => { this.slots[index] = typeof value === 'function' ? value(this.slots[index]) : value; }]; }
 ref(value: unknown) { const index = this.index++;return this.slots[index] ??= { current: value }; }
 id() { const index = this.index++;return this.slots[index] ??= `library-lifecycle-${index}`; }
 same(a: unknown[], b: unknown[]) { return a.length === b.length && a.every((value, index) => Object.is(value, b[index])); }
 callback(fn: unknown, deps: unknown[]) { const index = this.index++, old = this.slots[index];if (!old || !this.same(old.deps, deps)) this.slots[index] = { fn, deps };return this.slots[index].fn; }
 effect(fn: () => (() => void) | void, deps: unknown[]) { const index = this.index++, old = this.slots[index];if (!old || !this.same(old.deps, deps)) this.scheduled.push(() => { old?.cleanup?.();this.slots[index] = { deps, cleanup: fn() }; }); }
 render<T>(fn: () => T) { (globalThis as any)[symbol] = this;Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => this.raw.get(key) ?? (this.storage.has(key) ? JSON.stringify(this.storage.get(key)) : null) } });this.index = 0;this.scheduled = [];const value = fn();for (const run of this.scheduled) run();return value; }
 request(_path: string, data?: unknown) { return new Promise((resolve, reject) => (data === undefined ? this.reads : this.writes).push({ data, resolve, reject })); }
 dispose() { for (const slot of this.slots) slot?.cleanup?.(); }
}
const snapshot = (name: string) => ({ deviceId: `device:${name}`, epoch: name === 'a' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222', tasks: [], projects: [], layout: { value: { timezone: 'UTC' } } }) as unknown as Snapshot;
const state = (value: Snapshot): HomeLibraryState => ({ epoch: value.epoch, collections: [], items: [], resources: [], organization: { revision: 0, collectionIds: [] }, ideaPreferences: { revision: 0, saved: [], hidden: [] } });
const settle = async () => { for (let n = 0; n < 4; n++) await Promise.resolve(); };
test('a retryable Home loader preserves original saves and reopens Library writing after preparation retry', async () => {
 const s = snapshot('a'), f = new Hooks(), reopened = new Hooks(), registry = createModuleRegistry();let release!: () => void, attempts = 0;
 const gate = new Promise<void>(resolve => { release = resolve; }), previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
 Object.defineProperty(globalThis, 'window', { configurable: true, value: { setInterval: () => 1, clearInterval() {} } });
 const key = `e3:home-library-command:${s.deviceId}:${s.epoch}:lifecycle-window`, writerKey = `e3:home-library-writer:${s.deviceId}:${s.epoch}:lifecycle-window:item`;
 const command: Extract<HomeLibraryCommand, {type:'item-save'}> = { type:'item-save', requestId:crypto.randomUUID(), epoch:s.epoch, id:'library:lazy-kept', expectedRevision:0, value:{kind:'note',title:'Kept note',body:'Original submitted words',archived:false} };
 const journal = {format:1,deviceId:s.deviceId,epoch:s.epoch,windowId:'lifecycle-window',command,uncertain:true}, draft = {id:command.id,revision:0,value:{...command.value,body:'Newer writing survives Home loading'}};
 f.storage.set(key,journal);f.storage.set(writerKey,draft);reopened.storage=f.storage;
 const Home = registry.lazy(async () => { await gate;if(++attempts===1)throw Error('Interrupted Home download');const module=await import('../apps/client/src/Home.js');return {default:module.Home}; });
 const props = {snapshot:s,layout:{timezone:'UTC',appIcon:'lynx'},open(){}} as any;
 const render = (owner:Hooks) => owner.render(()=>renderToStaticMarkup(createElement(Suspense,{fallback:'Home is loading'},createElement(Home,props))));
 try {
  assert.match(render(f),/Home is loading/);assert.equal(f.reads.length,0);assert.equal(f.writes.length,0);
  const preparation=registry.prepare();release();await assert.rejects(preparation,/Interrupted Home download/);
  assert.deepEqual(f.storage.get(key),journal);assert.deepEqual(f.storage.get(writerKey),draft);
  await registry.prepare();
  for(const owner of [f,reopened]) {render(owner);owner.reads.shift()!.resolve(state(s));await settle();const html=render(owner);assert.match(html,/Newer writing survives Home loading/);assert.match(html,/Check original save/);assert.doesNotMatch(html,/Home is loading/);assert.equal(owner.writes.length,0);owner.dispose();}
  assert.deepEqual(f.storage.get(key),journal);assert.deepEqual(f.storage.get(writerKey),draft);assert.equal(attempts,2);
 } finally {release();f.dispose();reopened.dispose();if(previousWindow)Object.defineProperty(globalThis,'window',previousWindow);else delete (globalThis as any).window;}
});

test('a document-cached Home import failure needs a new document and keeps original Library writing and requests', async () => {
 const s = snapshot('a'), reopened = new Hooks(), failedRegistry = createModuleRegistry();
 const key = `e3:home-library-command:${s.deviceId}:${s.epoch}:lifecycle-window`, writerKey = `e3:home-library-writer:${s.deviceId}:${s.epoch}:lifecycle-window:item`;
 const command: Extract<HomeLibraryCommand, {type:'item-save'}> = { type:'item-save', requestId:crypto.randomUUID(), epoch:s.epoch, id:'library:document-kept', expectedRevision:0, value:{kind:'note',title:'Kept note',body:'Original submitted words',archived:false} };
 const journal = {format:1,deviceId:s.deviceId,epoch:s.epoch,windowId:'lifecycle-window',command,uncertain:true}, draft = {id:command.id,revision:0,value:{...command.value,body:'Newer writing survives a document reload'}};
 reopened.storage.set(key,journal);reopened.storage.set(writerKey,draft);
 // Native import failures remain rejected for the document even when the
 // registry clears its own pending Promise. Model that browser boundary.
 const cachedFailure = Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
 failedRegistry.lazy(() => cachedFailure);
 const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
 Object.defineProperty(globalThis, 'window', { configurable: true, value: { setInterval: () => 1, clearInterval() {} } });
 try {
  await assert.rejects(failedRegistry.prepare(), /Failed to fetch/);
  await assert.rejects(failedRegistry.prepare(), /Failed to fetch/);
  const nextDocument = createModuleRegistry();
  const Home = nextDocument.lazy(async () => { const module=await import('../apps/client/src/Home.js');return {default:module.Home}; });
  await nextDocument.prepare();
  const props = {snapshot:s,layout:{timezone:'UTC',appIcon:'lynx'},open(){}} as any;
  const render = () => reopened.render(()=>renderToStaticMarkup(createElement(Suspense,{fallback:'Home is loading'},createElement(Home,props))));
  render();reopened.reads.shift()!.resolve(state(s));await settle();const html=render();
  assert.match(html,/Newer writing survives a document reload/);assert.match(html,/Check original save/);assert.doesNotMatch(html,/Home is loading/);
  assert.deepEqual(reopened.storage.get(key),journal);assert.deepEqual(reopened.storage.get(writerKey),draft);assert.equal(reopened.writes.length,0);
 } finally {reopened.dispose();if(previousWindow)Object.defineProperty(globalThis,'window',previousWindow);else delete (globalThis as any).window;}
});
test('late acknowledgement cannot replace a new Library owner or clear either owner’s pending receipt', async () => {
 const f = new Hooks(), a = snapshot('a'), b = snapshot('b'), render = (scope: Snapshot) => f.render(() => useHomeLibrary(scope));
 try {
  render(a);f.reads.shift()!.resolve(state(a));await settle();const readyA = render(a);
  const command = (scope: Snapshot): Extract<HomeLibraryCommand, {type: 'item-save'}> => ({ type: 'item-save', requestId: crypto.randomUUID(), epoch: scope.epoch, id: `library:${scope.deviceId}`, expectedRevision: 0, value: { kind: 'note', title: scope.deviceId, body: 'Kept original writing', archived: false } });
  const inputA = command(a), pendingA = readyA.run(inputA), requestA = f.writes.shift()!;
  render(b);f.reads.shift()!.resolve(state(b));await settle();const readyB = render(b);
  const inputB = command(b), pendingB = readyB.run(inputB), requestB = f.writes.shift()!;
  requestA.resolve({ ...inputA.value, id: inputA.id, revision: 1, updatedAt: new Date().toISOString() });assert.equal(await pendingA, undefined);
  const current = render(b);assert.equal(current.state?.epoch, b.epoch);assert.equal(current.busy, true);assert.equal(current.pending?.requestId, inputB.requestId);assert.equal(f.reads.length, 0);
  assert.equal((f.storage.get(`e3:home-library-command:${a.deviceId}:${a.epoch}:lifecycle-window`) as any).command.requestId, inputA.requestId);
  assert.equal((f.storage.get(`e3:home-library-command:${b.deviceId}:${b.epoch}:lifecycle-window`) as any).command.requestId, inputB.requestId);
  requestB.resolve({ ...inputB.value, id: inputB.id, revision: 1, updatedAt: new Date().toISOString() });await settle();f.reads.shift()!.resolve(state(b));await pendingB;assert.equal(render(b).busy, false);
 } finally { f.dispose(); }
});
test('a reconciled item receipt cannot replace the next collection command from the same render', async () => {
 const f = new Hooks(), a = snapshot('a'), key = `e3:home-library-command:${a.deviceId}:${a.epoch}:lifecycle-window`;
 const original: Extract<HomeLibraryCommand, {type: 'item-save'}> = { type: 'item-save', requestId: crypto.randomUUID(), epoch: a.epoch, id: 'library:kept', expectedRevision: 0, value: { kind: 'note', title: 'Kept Note', body: 'Original writing', archived: false } };
 const next: Extract<HomeLibraryCommand, {type: 'collection-save'}> = { type: 'collection-save', requestId: crypto.randomUUID(), epoch: a.epoch, id: 'collection:kept', expectedRevision: 0, value: { title: 'Kept Collection', subtitle: '', icon: 'folder', pinned: false, archived: false, references: [{ kind: 'note', id: original.id, revision: 1 }] } };
 f.storage.set(key, original);
 try {
  f.render(() => useHomeLibrary(a));f.reads.shift()!.resolve(state(a));await settle();const ready = f.render(() => useHomeLibrary(a));
  const reconciliation = ready.run(original), prior = f.writes.shift()!;assert.deepEqual(prior.data, original);prior.resolve({ ...original.value, id: original.id, revision: 1, updatedAt: '2026-10-19T04:00:00.000Z' });await settle();f.reads.shift()!.resolve(state(a));await reconciliation;assert.equal(f.storage.has(key), false);
  const chained = ready.run(next), current = f.writes.shift()!;assert.deepEqual(current.data, next);current.resolve({ ...next.value, id: next.id, revision: 1, updatedAt: '2026-10-19T04:00:00.000Z' });await settle();f.reads.shift()!.resolve(state(a));await chained;assert.equal(f.storage.has(key), false);
 } finally { f.dispose(); }
});
function elements(node: any): any[] { if (!node || typeof node !== 'object') return [];return [node, ...[node.props?.children].flat(Infinity).flatMap(elements)]; }
test('Library writer switch reads the new scope without copying an earlier form into it', () => {
 const f = new Hooks(), a = snapshot('a'), b = snapshot('b');
 const key = (s: Snapshot) => `e3:home-library-writer:${s.deviceId}:${s.epoch}:lifecycle-window:item`, draft = (title: string) => ({ id: `library:${title}`, revision: 0, value: { kind: 'note', title, body: `Words for ${title}`, archived: false } });
 const originalA = draft('DraftA'), originalB = draft('DraftB');f.storage.set(key(a), originalA);f.storage.set(key(b), originalB);
 const controller = { state: undefined, error: '', journalError: '', lastSave: undefined, loading: false, busy: false, pending: undefined, load: async () => {}, run: async () => undefined };
 const render = (scope: Snapshot) => f.render(() => HomeLibrary({ snapshot: scope, controller, openWidgets() {} }));
 try { assert.ok(elements(render(a)).some(el => el.type === 'input' && el.props.value === 'DraftA'));const switching = render(b);assert.ok(!elements(switching).some(el => el.type === 'input' && el.props.value === 'DraftA'));assert.deepEqual(f.storage.get(key(b)), originalB);assert.ok(elements(render(b)).some(el => el.type === 'input' && el.props.value === 'DraftB'));assert.deepEqual(f.storage.get(key(a)), originalA);assert.deepEqual(f.storage.get(key(b)), originalB); }
 finally { f.dispose(); }
});
test.after(() => { loader.deregister();delete (globalThis as any)[symbol];delete (globalThis as any).localStorage; });
const command = (s: Snapshot): Extract<HomeLibraryCommand, {type:'item-save'}> => ({ type:'item-save',requestId:crypto.randomUUID(),epoch:s.epoch,id:'library:checked',expectedRevision:0,value:{kind:'note',title:'Kept note',body:'Original writing',archived:false} });
const commandKey = (s: Snapshot) => `e3:home-library-command:${s.deviceId}:${s.epoch}:lifecycle-window`;
async function ready(f: Hooks, s: Snapshot) { f.render(() => useHomeLibrary(s));f.reads.shift()!.resolve(state(s));await settle();return f.render(() => useHomeLibrary(s)); }

test('corrupt command storage blocks replacement without erasing its raw bytes', async () => {
 const f=new Hooks(), s=snapshot('a'), key=commandKey(s);f.raw.set(key,'{"requestId":"kept,unfinished');
 try { const controller=await ready(f,s);assert.match(controller.journalError,/cannot be read/);assert.equal(await controller.run(command(s)),undefined);assert.equal(f.writes.length,0);assert.equal(f.raw.get(key),'{"requestId":"kept,unfinished');assert.equal(f.storage.has(key),false); }
 finally { f.dispose(); }
});

test('lost reply followed by authentication refusal preserves the exact original request and prevents a new save', async () => {
 const f=new Hooks(),s=snapshot('a'), input=command(s);
 try { const c=await ready(f,s), first=c.run(input);f.writes.shift()!.reject(new Error('Connection lost'));await first;
  const pending=f.render(()=>useHomeLibrary(s));assert.deepEqual(pending.pending,input);
  const replay=pending.run(input);assert.deepEqual(f.writes[0].data,input);f.writes.shift()!.reject(new ApiError('session_expired','Sign in again',undefined,401));await replay;
  const after=f.render(()=>useHomeLibrary(s));assert.deepEqual(after.pending,input);assert.equal(await after.run({...input,requestId:crypto.randomUUID(),value:{...input.value,body:'Newer writing'}}),undefined);assert.equal(f.writes.length,0);assert.deepEqual((f.storage.get(commandKey(s)) as any).command,input);
 } finally { f.dispose(); }
});

test('a fresh admitted revision refusal releases its request while preserving newer writing and host state', async () => {
 const f=new Hooks(),s=snapshot('a'),input=command(s);
 try { const c=await ready(f,s), save=c.run(input);f.writes.shift()!.reject(new ApiError('home_library_changed','Review the saved version',undefined,409));await save;
  const current=f.render(()=>useHomeLibrary(s));assert.equal(current.pending,undefined);assert.match(current.error,/Review/);assert.equal(f.storage.has(commandKey(s)),false);
 } finally { f.dispose(); }
});

test('a successful receipt with another identity stays unacknowledged', async () => {
 const f=new Hooks(),s=snapshot('a'),input=command(s);
 try { const c=await ready(f,s),save=c.run(input);f.writes.shift()!.resolve({...input.value,id:'library:someone-else',revision:1,updatedAt:'2026-10-19T04:00:00.000Z'});await save;
  const current=f.render(()=>useHomeLibrary(s));assert.deepEqual(current.pending,input);assert.equal(current.lastSave,undefined);assert.equal(f.reads.length,0);
 } finally { f.dispose(); }
});

test('batch preview uses exact historical URL and keeps query, fragment, invalid rows and duplicates visible', () => {
 const reference={kind:'link' as const,id:'library:link',revision:1}, c={id:'collection:one',revision:3,title:'Reading',subtitle:'',icon:'folder',pinned:false,archived:false,references:[reference],updatedAt:'2026-10-19T04:00:00.000Z'} as HomeCollection;
 const resources:HomeResource[]=[{reference,title:'Earlier link',subtitle:'Link',url:'https://example.test/old?q=1#part',availability:'changed',updatedAt:''},{reference:{...reference,revision:2},title:'Newer link',subtitle:'Link',url:'https://example.test/new',availability:'current',updatedAt:''}];
 const rows=previewLibraryLinks('https://example.test/old?q=1#part\nhttps://example.test/new?q=2#part\nnot a link\nhttps://example.test/new?q=2#part\nhttp://example.test/new?q=2#part',c,resources);
 assert.deepEqual(rows.map(r=>r.disposition),['already saved','ready','invalid','duplicate line','ready']);assert.equal(rows[1].url,'https://example.test/new?q=2#part');assert.equal(rows[2].input,'not a link');
 assert.equal(previewLibraryLinks('https://example.test/'+ 'é'.repeat(1000),c,resources)[0].disposition,'invalid');
});

test('view mode and exact selection survive filtering without changing global Home preference', () => {
 const f=new Hooks(),s=snapshot('a'),ref={kind:'note' as const,id:'library:n',revision:1},key=`e3:home-library-view:${s.deviceId}:${s.epoch}`;
 f.storage.set(key,{query:'',mode:'compact',filter:'all',collectionId:null,selection:{collectionId:'collection:one',references:[ref]}});
 const c={state:{...state(s),collections:[{id:'collection:one',revision:1,title:'Research',subtitle:'',icon:'folder' as const,pinned:false,archived:false,references:[ref],updatedAt:'2026-10-19T04:00:00.000Z'}],organization:{revision:1,collectionIds:['collection:one']}},error:'',journalError:'',lastSave:undefined,loading:false,busy:false,pending:undefined,load:async()=>{},run:async()=>undefined};
 try { let tree=f.render(()=>HomeLibrary({snapshot:s,controller:c,openWidgets(){}}));elements(tree).find(el=>el.props['aria-label']==='Search Library').props.onClick();tree=f.render(()=>HomeLibrary({snapshot:s,controller:c,openWidgets(){}}));const search=elements(tree).find(el=>el.type==='input'&&el.props.type==='search');search.props.onChange({target:{value:'hidden'}});tree=f.render(()=>HomeLibrary({snapshot:s,controller:c,openWidgets(){}}));assert.ok(elements(tree).some(el=>el.props['aria-label']==='Selected sources'));assert.deepEqual((f.storage.get(key) as any).selection.references,[ref]);assert.ok(![...f.storage.keys()].some(k=>k.startsWith('e3:home-view:'))); }
 finally { f.dispose(); }
});


test('a verified reply survives failed local acknowledgement and retries locally without another POST', async () => {
 const f=new Hooks(),s=snapshot('a'),input=command(s),key=commandKey(s);
 try {const c=await ready(f,s);f.failSave=(target)=>target===key+':confirmed';const saving=c.run(input);f.writes.shift()!.resolve({...input.value,id:input.id,revision:1,updatedAt:'2026-10-19T04:00:00.000Z'});await saving;const unconfirmed=f.render(()=>useHomeLibrary(s));assert.deepEqual(unconfirmed.pending,input);assert.equal(unconfirmed.lastSave,undefined);assert.match(unconfirmed.error,/Saved on the host/);assert.equal(f.reads.length,0);
  f.failSave=undefined;const checking=unconfirmed.run(input);assert.equal(f.writes.length,0);await settle();f.reads.shift()!.resolve(state(s));await checking;assert.equal(f.render(()=>useHomeLibrary(s)).pending,undefined);assert.equal(f.storage.has(key),false);
 } finally {f.dispose();}
});

test('a forged retained Undo or wrong result kind is not exposed as a confirmed save', async () => {
 const s=snapshot('a'),input=command(s);
 for (const receipt of [
  {command:input,result:{...input.value,id:input.id,revision:1,updatedAt:'2026-10-19T04:00:00.000Z'},undo:{operationId:input.requestId,expected:{collections:[{id:'collection:other',expectedRevision:5}],organizationRevision:null}}},
  {command:input,result:{id:input.id,revision:1,updatedAt:'2026-10-19T04:00:00.000Z',title:'Wrong record',subtitle:'',icon:'folder',references:[],pinned:false,archived:false},undo:null},
 ]) {const f=new Hooks();try {f.storage.set(commandKey(s)+':confirmed',receipt);assert.equal((await ready(f,s)).lastSave,undefined);assert.deepEqual(f.storage.get(commandKey(s)+':confirmed'),receipt);} finally {f.dispose();}}
});

test('a retained new-item draft saves once with its original destination and keeps writing on uncertainty', async () => {
 const f=new Hooks(),s=snapshot('a'),key=`e3:home-library-writer:${s.deviceId}:${s.epoch}:lifecycle-window:item`;
 const draft={id:'library:draft',revision:0,destination:'collection:second',value:{kind:'note',title:'Pending note',body:'Kept words',archived:false}};
 const makeCollection=(id:string):HomeCollection=>({id,revision:4,title:id,subtitle:'',icon:'folder',pinned:false,archived:false,references:[],updatedAt:'2026-10-19T04:00:00.000Z'}),library={...state(s),collections:[makeCollection('collection:first'),makeCollection('collection:second')],organization:{revision:1,collectionIds:['collection:first','collection:second']}};
 const writes:HomeLibraryCommand[]=[];const controller={state:library,error:'',journalError:'',lastSave:undefined,loading:false,busy:false,pending:undefined,load:async()=>{},run:async(input:HomeLibraryCommand)=>{writes.push(input);return undefined;}};
 try {f.storage.set(key,draft);const tree=f.render(()=>HomeLibrary({snapshot:s,controller,openWidgets(){}}));const form=elements(tree).find(el=>el.type==='form');assert.ok(form);form.props.onSubmit({preventDefault(){}});await settle();assert.equal(writes.length,1);assert.equal(writes[0].type,'items-capture');if(writes[0].type!=='items-capture')throw Error('capture');assert.deepEqual(writes[0].destination,{id:'collection:second',expectedRevision:4});assert.equal(writes[0].rows.length,1);assert.deepEqual(writes[0].rows[0].value,draft.value);assert.deepEqual(f.storage.get(key),draft);assert.ok(elements(f.render(()=>HomeLibrary({snapshot:s,controller,openWidgets(){}}))).some(el=>el.type==='input'&&el.props.value==='Pending note'));} finally {f.dispose();}
});


test('late item acknowledgement keeps writing entered after the submitted draft', async () => {
 const f=new Hooks(),s=snapshot('a'),key=`e3:home-library-writer:${s.deviceId}:${s.epoch}:lifecycle-window:item`,draft={id:'library:draft',revision:0,value:{kind:'note' as const,title:'Submitted title',body:'Submitted words',archived:false}};
 let resolve!:(value:any)=>void;const controller={state:state(s),error:'',journalError:'',lastSave:undefined,loading:false,busy:false,pending:undefined,load:async()=>{},run:async()=>new Promise<any>(done=>{resolve=done;})},render=()=>f.render(()=>HomeLibrary({snapshot:s,controller,openWidgets(){}}));
 try {f.storage.set(key,draft);let tree=render();elements(tree).find(el=>el.type==='form').props.onSubmit({preventDefault(){}});elements(tree).find(el=>el.type==='input'&&el.props.value==='Submitted title').props.onChange({target:{value:'Newer title'}});render();resolve({...draft.value,id:draft.id,revision:1,updatedAt:'2026-10-19T04:00:00.000Z'});await settle();tree=render();assert.ok(elements(tree).some(el=>el.type==='input'&&el.props.value==='Newer title'));assert.equal((f.storage.get(key) as any).value.title,'Newer title');} finally {f.dispose();}
});


test('a definitive refusal cannot erase a command that replaced its pending journal', async () => {
 const f=new Hooks(),s=snapshot('a'),input=command(s),key=commandKey(s);
 try {const c=await ready(f,s),saving=c.run(input),replacement={...input,requestId:crypto.randomUUID(),value:{...input.value,body:'A separately retained request'}};f.storage.set(key,{format:1,deviceId:s.deviceId,epoch:s.epoch,windowId:'lifecycle-window',command:replacement,uncertain:true});f.writes.shift()!.reject(new ApiError('home_library_changed','Review the saved version',undefined,409));await saving;assert.deepEqual((f.storage.get(key) as any).command,replacement);assert.equal(f.writes.length,0);} finally {f.dispose();}
});


test('unreadable writer and pasted-link drafts remain byte-for-byte retained without crashing or mount clearing', () => {
 for (const raw of ['{"unfinished":', JSON.stringify({unexpected:'object'})]) {
  const f=new Hooks(),s=snapshot('a'),prefix=`e3:home-library-writer:${s.deviceId}:${s.epoch}:lifecycle-window`;
  for(const suffix of [':item',':collection',':links'])f.raw.set(prefix+suffix,raw);
  const controller={state:state(s),error:'',journalError:'',lastSave:undefined,loading:false,busy:false,pending:undefined,load:async()=>{},run:async()=>undefined},render=()=>f.render(()=>HomeLibrary({snapshot:s,controller,openWidgets(){}}));
  try {render();let tree=render();assert.ok(elements(tree).some(el=>el.props?.role==='alert'&&String(el.props.children).includes('draft cannot be read')));const menu=elements(tree).find(el=>el.props.label==='View Options');elements(menu.props.children(()=>{})).find(el=>el.type==='button'&&el.props.children==='Paste Links').props.onClick();tree=render();const paste=elements(tree).find(el=>el.type==='textarea');assert.equal(paste.props.value,'');assert.equal(paste.props.disabled,true);for(const suffix of [':item',':collection',':links']){assert.equal(f.raw.get(prefix+suffix),raw);assert.equal(f.storage.has(prefix+suffix),false);}}
  finally {f.dispose();}
 }
});

test('confirmed original capture clears only its exact submitted draft and rebases newer retained writing', () => {
 const s=snapshot('a'),prefix=`e3:home-library-writer:${s.deviceId}:${s.epoch}:lifecycle-window`,value={kind:'note' as const,title:'Submitted',body:'Original body',archived:false};
 const input:Extract<HomeLibraryCommand,{type:'items-capture'}>={type:'items-capture',requestId:crypto.randomUUID(),epoch:s.epoch,destination:{id:'collection:target',expectedRevision:1},rows:[{id:'library:created',rowId:'line:0',value}]};
 const item={...value,id:'library:created',revision:1,updatedAt:'2026-10-19T04:00:00.000Z'},collection:HomeCollection={id:'collection:target',revision:2,title:'Destination',subtitle:'',icon:'folder',pinned:false,archived:false,references:[{kind:'note',id:item.id,revision:1}],updatedAt:item.updatedAt};
 const result:HomeLibraryReceipt={format:1,operationId:input.requestId,epoch:s.epoch,type:'items-capture',appliedAt:item.updatedAt,changed:true,collections:[collection],createdItems:[item],outcomes:[{rowId:'line:0',reference:collection.references[0],disposition:'created-and-added'}],undo:{operationId:input.requestId,expected:{collections:[{id:collection.id,expectedRevision:2}],organizationRevision:null}}};
 for(const changed of [false,true]) {const f=new Hooks(),draft={id:item.id,revision:0,destination:collection.id,value:changed?{...value,body:'Newer writing'}:value},controller={state:{...state(s),collections:[collection],items:[item],organization:{revision:1,collectionIds:[collection.id]}},error:'',journalError:'',lastSave:{command:input,result,undo:result.undo},loading:false,busy:false,pending:undefined,load:async()=>{},run:async()=>undefined},render=()=>f.render(()=>HomeLibrary({snapshot:s,controller,openWidgets(){}}));
  try {f.storage.set(prefix+':item',draft);render();render();if(changed){const kept=f.storage.get(prefix+':item') as any;assert.equal(kept.revision,1);assert.equal(kept.value.body,'Newer writing');assert.equal(kept.destination,undefined);}else assert.equal(f.storage.has(prefix+':item'),false);}finally{f.dispose();}
 }
});


test('focused collections have one heading and no overview chrome while keeping source and recovery actions', () => {
 const s=snapshot('a'), c:HomeCollection={id:'collection:research',revision:4,title:'Research shelf',subtitle:'Useful retained work',icon:'folder',pinned:false,archived:false,references:[{kind:'link',id:'library:exact',revision:1},{kind:'task',id:'task:missing',revision:2}],updatedAt:'2026-10-19T04:00:00.000Z'};
 const input:Extract<HomeLibraryCommand,{type:'collection-save'}>={type:'collection-save',requestId:crypto.randomUUID(),epoch:s.epoch,id:c.id,expectedRevision:3,value:{title:c.title,subtitle:c.subtitle,icon:c.icon,pinned:c.pinned,archived:c.archived,references:c.references}};
 const controller={state:{...state(s),collections:[c],organization:{revision:1,collectionIds:[c.id]},resources:[{reference:c.references[0],title:'Exact link',subtitle:'Kept version',url:'https://example.test/kept?q=1#anchor',availability:'changed' as const,updatedAt:c.updatedAt}]},error:'Keep this visible',journalError:'',lastSave:{command:input,result:c,undo:{operationId:input.requestId,expected:{collections:[{id:c.id,expectedRevision:4}],organizationRevision:null}}},loading:false,busy:false,pending:undefined,load:async()=>{},run:async()=>undefined};
 for(const focused of [false,true]) {const f=new Hooks();try {
  f.storage.set(`e3:home-library-view:${s.deviceId}:${s.epoch}`,{query:'',mode:'compact',filter:'all',collectionId:focused?c.id:null,selection:null});
  const html=f.render(()=>renderToStaticMarkup(HomeLibrary({snapshot:s,controller,openWidgets(){}})));
  assert.equal((html.match(/<h1 /g)??[]).length,1);assert.ok(html.includes('home-library-count'));assert.ok(html.includes(focused?'2 Sources':'1 Collection'));
  assert.equal(html.includes('Move collection Research shelf.'),!focused);assert.equal(html.includes('<h2>'),!focused);
  assert.ok(html.includes(focused?'<h1 class="page-title" aria-label="Research shelf">':'<h1 class="page-title" aria-label="All Collections">'));
  assert.equal((html.match(/Useful retained work/g)??[]).length,1);
  for(const label of ['Manage Research shelf','Pin Research shelf','Add links','Rename or edit','Archive collection','Add an existing source','Undo','Keep this visible','Source unavailable · reference kept'])assert.ok(html.includes(label),label);
  assert.ok(html.includes('href="https://example.test/kept?q=1#anchor"'));assert.ok(html.includes('Inspect Saved source'));
 }finally{f.dispose();}}
});

test('Home recovery adopts the existing durable Library writer once and never replaces newer writing or another epoch', () => {
 const f = new Hooks(), s = snapshot('a'), key = `e3:home-library-writer:${s.deviceId}:${s.epoch}:lifecycle-window:item`;
 const controller = { state: state(s), error: '', journalError: '', lastSave: undefined, loading: false, busy: false, pending: undefined, load: async () => {}, run: async () => undefined };
 const render = (current = s) => f.render(() => HomeLibrary({ snapshot: current, controller, openWidgets() {} }));
 try {
  let tree = render();const menu = elements(tree).find(el => el.props.label === 'View Options');
  elements(menu.props.children(() => {})).find(el => el.props.children === 'Recovered Home Writing').props.onClick();
  tree = render();const recovery = elements(tree).find(el => el.type?.name === 'HomeWritingRecovery');
  assert.ok(recovery.props.canAdopt());
  const writer = { id: 'library:' + crypto.randomUUID(), revision: 0 as const, value: { kind: 'note' as const, title: 'Recovered exact title', body: 'Original incomplete writing', archived: false }, homeRecovery: { format: 1 as const, epoch: s.epoch, deviceId: s.deviceId, sourceKey: 'original-kept-key', sourceSha256: 'a'.repeat(64), formId: 'form:note:note', initialSha256: 'b'.repeat(64) } };
  const copy = { key, raw: JSON.stringify(writer), writer };
  f.storage.set(key, writer);assert.equal(recovery.props.adopt(copy), true);
  tree = render();assert.ok(elements(tree).some(el => el.type === 'input' && el.props.value === writer.value.title));
  elements(tree).find(el => el.type === 'textarea' && el.props.value === writer.value.body).props.onChange({ target: { value: 'Newer recovered writing' } });
  render();assert.equal(recovery.props.adopt(copy), false);
  assert.equal((f.storage.get(key) as any).value.body, 'Newer recovered writing');
  render(snapshot('b'));assert.equal(recovery.props.adopt(copy), false);
  assert.equal((f.storage.get(key) as any).value.body, 'Newer recovered writing');assert.equal(f.writes.length, 0);
 } finally { f.dispose(); }
});


test('a known reply cannot acknowledge a replaced journal or dispatch from a retired owner', async () => {
 const f=new Hooks(),s=snapshot('a'),input=command(s),key=commandKey(s);
 try {
  const c=await ready(f,s);f.failSave=target=>target===key+':confirmed';const saving=c.run(input);
  f.writes.shift()!.resolve({...input.value,id:input.id,revision:1,updatedAt:'2026-10-19T04:00:00.000Z'});await saving;
  const replacement={...input,requestId:crypto.randomUUID(),value:{...input.value,body:'Different original request'}};
  f.storage.set(key,{format:1,deviceId:s.deviceId,epoch:s.epoch,windowId:'lifecycle-window',command:replacement,uncertain:true});f.failSave=undefined;
  const current=f.render(()=>useHomeLibrary(s));await current.run(input);await current.run(replacement);
  assert.equal(f.writes.length,0);assert.deepEqual((f.storage.get(key) as any).command,replacement);
  f.dispose();await current.run(input);assert.equal(f.writes.length,0);assert.deepEqual((f.storage.get(key) as any).command,replacement);
 } finally {f.dispose();}
});

test('a persisted exact confirmed reply reopens with local-only pending clearance', async () => {
 const f=new Hooks(),s=snapshot('a'),input=command(s),key=commandKey(s);
 f.storage.set(key,{format:1,deviceId:s.deviceId,epoch:s.epoch,windowId:'lifecycle-window',command:input,uncertain:true});
 f.storage.set(key+':confirmed',{command:input,result:{...input.value,id:input.id,revision:1,updatedAt:'2026-10-19T04:00:00.000Z'},undo:null});
 try {const c=await ready(f,s), saving=c.run(input);assert.equal(f.writes.length,0);await settle();f.reads.shift()!.resolve(state(s));await saving;assert.equal(f.render(()=>useHomeLibrary(s)).pending,undefined);}
 finally {f.dispose();}
});


test('Up Next rendering and complete reordering keep hidden and unavailable exact references without capture', () => {
 const f=new Hooks(), references:HomeReference[]=Array.from({length:53},(_,index)=>({kind:'link' as const,id:'link:'+index,revision:1}));
 const resources:HomeResource[]=[{reference:references[0],title:'Old saved address',subtitle:'Earlier version',url:'https://example.test/old?q=1#part',availability:'changed',updatedAt:''}];
 let ordered: typeof references|undefined, removed: typeof references[number]|undefined, captures=0;
 const props={references,resources,query:'',mode:'cards' as const,blocked:false,inspect(){captures++;},remove(ref:typeof references[number]){removed=ref;},reorder(refs:typeof references){ordered=refs;}};
 const render=()=>f.render(()=>UpNextShelf(props));
 try {
  let tree=render();assert.equal(captures,0);assert.equal(elements(tree).filter(el=>el.props.item).length,40);
  const html=f.render(()=>renderToStaticMarkup(UpNextShelf(props)));assert.match(html,/https:\/\/example.test\/old\?q=1#part/);assert.match(html,/53 saved sources/);assert.match(html,/Source unavailable/);
  tree=render();elements(tree).find(el=>el.props['aria-label']==='Move Old saved address later in Up Next').props.onClick();assert.equal(ordered?.length,53);assert.deepEqual(ordered?.slice(0,2),[references[1],references[0]]);assert.deepEqual(ordered?.slice(2),references.slice(2));
  const missing=elements(tree).find(el=>el.props.item?.reference.id==='link:1');elements(missing).find(el=>el.props.children==='Remove From Up Next').props.onClick();assert.deepEqual(removed,references[1]);assert.equal(captures,0);
  props.query='Old saved address';tree=render();const move=elements(tree).find(el=>el.props['aria-label']==='Move Old saved address later in Up Next');assert.equal(move.props.disabled,true);ordered=undefined;move.props.onClick();assert.equal(ordered,undefined);
 }finally{f.dispose();}
});

test('Space routes keep collection identity, full global order and exact assignment inputs', async () => {
 const f=new Hooks(),s=snapshot('a'),key=`e3:home-library-view:${s.deviceId}:${s.epoch}`;
 const make=(id:string):HomeCollection=>({id,revision:7,title:id,subtitle:'',icon:'folder',archived:false,pinned:false,references:[],updatedAt:'2026-10-20T10:00:00.000Z'});
 const a=make('collection:a'),b=make('collection:b'),c=make('collection:c'),shelf={format:1 as const,revision:4,spaces:[{id:'space:one',name:'Work',archived:false},{id:'space:two',name:'Other',archived:false}],assignments:[{collectionId:a.id,spaceId:'space:one'},{collectionId:c.id,spaceId:'space:one'}],upNext:[]};
 f.storage.set(key,{query:'',mode:'cards',filter:'all',collectionId:null,selection:null,route:{kind:'space',id:'space:one'}});
 const writes:HomeLibraryCommand[]=[];const controller={state:{...state(s),collections:[a,b,c],organization:{revision:3,collectionIds:[a.id,b.id,c.id]},shelves:{status:'ready' as const,value:shelf}},error:'',journalError:'',lastSave:undefined,loading:false,busy:false,pending:undefined,load:async()=>{},run:async(input:HomeLibraryCommand)=>{writes.push(input);return undefined;}};
 const render=()=>f.render(()=>HomeLibrary({snapshot:s,controller}));
 try {let tree=render(), canvas=elements(tree).find(el=>typeof el.props.order==='function');assert.deepEqual(canvas.props.collections.map((row:HomeCollection)=>row.id),[a.id,c.id]);await canvas.props.order([c.id,a.id]);assert.deepEqual((writes[0] as any).collectionIds,[c.id,b.id,a.id]);
  canvas.props.render(a,undefined).props.moveSpace();tree=render();const dialog=elements(tree).find(el=>el.props.title==='Move Collection To Space');elements(dialog).find(el=>el.type==='select').props.onChange({target:{value:'space:two'}});tree=render();await elements(tree).find(el=>el.type==='button'&&el.props.children==='Move Collection').props.onClick();
  const moved=writes[1] as any;assert.equal(moved.type,'collection-assign');assert.equal(moved.expectedRevision,4);assert.deepEqual(moved.collection,{id:a.id,expectedRevision:7});assert.equal(moved.spaceId,'space:two');assert.deepEqual(a.references,[]);assert.equal(f.writes.length,0);
 }finally{f.dispose();}
});


test('late assignment acknowledgement cannot close a replacement collection choice', async () => {
 const f=new Hooks(),s=snapshot('a'),make=(id:string):HomeCollection=>({id,revision:1,title:id,subtitle:'',icon:'folder',archived:false,pinned:false,references:[],updatedAt:'2026-10-20T10:00:00.000Z'}),a=make('collection:a'),b=make('collection:b');
 let resolve!:(value:any)=>void;
 const controller={state:{...state(s),collections:[a,b],organization:{revision:1,collectionIds:[a.id,b.id]},shelves:{status:'ready' as const,value:{format:1 as const,revision:1,spaces:[{id:'space:one',name:'Work',archived:false}],assignments:[],upNext:[]}}},error:'',journalError:'',lastSave:undefined,loading:false,busy:false,pending:undefined,load:async()=>{},run:async()=>new Promise<any>(done=>{resolve=done;})};
 const render=()=>f.render(()=>HomeLibrary({snapshot:s,controller}));
 try {let tree=render();elements(tree).find(el=>typeof el.props.order==='function').props.render(a,undefined).props.moveSpace();tree=render();elements(tree).find(el=>el.type==='select').props.onChange({target:{value:'space:one'}});tree=render();const saving=elements(tree).find(el=>el.type==='button'&&el.props.children==='Move Collection').props.onClick();
  elements(tree).find(el=>el.props.title==='Move Collection To Space').props.close();tree=render();elements(tree).find(el=>typeof el.props.order==='function').props.render(b,undefined).props.moveSpace();render();resolve({confirmed:true});await saving;
  tree=render();const dialog=elements(tree).find(el=>el.props.title==='Move Collection To Space');assert.ok(dialog);assert.ok(elements(dialog).some(el=>el.type==='p'&&el.props.children===b.title));
 }finally{f.dispose();}
});


test('Spaces receipt must confirm the exact original revision and action before clearing its request', async () => {
 for(const changed of ['revision','name','valid'] as const) {
  const f=new Hooks(),s=snapshot('a'),input={type:'space-save' as const,requestId:crypto.randomUUID(),epoch:s.epoch,expectedRevision:2,id:'space:original',name:'Original exact name'};
  const reply={format:2,kind:'shelves',operationId:input.requestId,epoch:s.epoch,type:input.type,appliedAt:'2026-10-20T10:00:00.000Z',changed:true,shelves:{format:1,revision:changed==='revision'?5:3,spaces:[{id:input.id,name:changed==='name'?'Wrong name':input.name,archived:false}],assignments:[],upNext:[]},undo:{operationId:input.requestId,expectedRevision:changed==='revision'?5:3}};
  try {const c=await ready(f,s),saving=c.run(input);f.writes.shift()!.resolve(reply);await settle();if(changed==='valid')f.reads.shift()!.resolve(state(s));await saving;
   const after=f.render(()=>useHomeLibrary(s));assert.equal(after.pending?.requestId,changed==='valid'?undefined:input.requestId);assert.equal(!!after.lastSave,changed==='valid');
   if(changed==='valid')assert.deepEqual(after.lastSave?.undo,{operationId:input.requestId,expectedRevision:3});else assert.equal(f.reads.length,0);
  }finally{f.dispose();}
 }
});


test('unreadable organization never presents a retained shelf as empty or every collection as Unassigned', () => {
 const s=snapshot('a'),c:HomeCollection={id:'collection:kept',revision:1,title:'Original collection',subtitle:'',icon:'folder',archived:false,pinned:false,references:[],updatedAt:'2026-10-20T10:00:00.000Z'};
 for(const route of [{kind:'up-next'},{kind:'unassigned'},{kind:'space',id:'space:kept'}]) {
  const f=new Hooks(),key=`e3:home-library-view:${s.deviceId}:${s.epoch}`,writes:HomeLibraryCommand[]=[];
  f.storage.set(key,{query:'',mode:'cards',filter:'all',collectionId:null,selection:null,route});
  const controller={state:{...state(s),collections:[c],organization:{revision:1,collectionIds:[c.id]},shelves:{status:'needs-review' as const,message:'Original organization cannot be read.'}},error:'',journalError:'',lastSave:undefined,loading:false,busy:false,pending:undefined,load:async()=>{},run:async(input:HomeLibraryCommand)=>{writes.push(input);return undefined;}};
  const render=()=>f.render(()=>HomeLibrary({snapshot:s,controller}));
  try {const html=f.render(()=>renderToStaticMarkup(HomeLibrary({snapshot:s,controller})));assert.match(html,/Organization unavailable/);assert.match(html,/Library Organization Is Unavailable/);assert.doesNotMatch(html,/0 Saved Sources|Choose what comes next|Make room for what matters/);
   elements(render()).find(row=>row.props.title==='Library Organization Is Unavailable').props.action.props.onClick();const tree=render();assert.ok(elements(tree).find(row=>typeof row.props.order==='function').props.collections.some((row:HomeCollection)=>row.id===c.id));assert.equal(writes.length,0);assert.deepEqual(controller.state.shelves,{status:'needs-review',message:'Original organization cannot be read.'});
  }finally{f.dispose();}
 }
});
