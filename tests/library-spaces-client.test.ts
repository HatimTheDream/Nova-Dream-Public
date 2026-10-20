import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { LibrarySpaceDraftOwner, type LibrarySpaceScope } from '../apps/client/src/library-space-draft';
import { admitLibraryTarget, defaultLibraryView, libraryView, libraryViewKey } from '../apps/client/src/home-library-navigation';
import type { HomeShelves, HomeShelvesCommand, HomeShelvesReceipt } from '../packages/domain/home-library';
import type { HomeLibraryController } from '../apps/client/src/HomeLibrary';

const scope: LibrarySpaceScope = { deviceId: 'device', epoch: '11111111-1111-4111-8111-111111111111', windowId: 'window' };
const shelves = (): HomeShelves => ({ format: 1, revision: 2, spaces: [], assignments: [], upNext: [] });
const proposal = () => ({ id: 'space:one', name: '  My Reading  ', expectedRevision: 2 });
const command = (): Extract<HomeShelvesCommand, { type: 'space-save' }> => ({ type: 'space-save', requestId: crypto.randomUUID(), epoch: scope.epoch, ...proposal() });
const result = (input: ReturnType<typeof command>): HomeShelvesReceipt => ({ format: 2, kind: 'shelves', operationId: input.requestId, epoch: scope.epoch, type: input.type, appliedAt: '2026-10-20T10:00:00.000Z', changed: true, shelves: { ...shelves(), revision: 3, spaces: [{ id: input.id, name: input.name, archived: false }] }, undo: { operationId: input.requestId, expectedRevision: 3 } });
class Memory {
 data = new Map<string, string>(); failWrite = false; failRead = false; failReadAfterWrite = false; writes = 0;
 getItem(key: string) { if (this.failRead) throw Error('Read refused');return this.data.get(key) ?? null; }
 setItem(key: string, value: string) { if (this.failWrite) throw Error('Storage full');this.data.set(key, value);this.writes++;if (this.failReadAfterWrite) { this.failReadAfterWrite = false;this.failRead = true; } }
}
test('Space writing remains in memory on failed persistence and acknowledges only its exact prior successful bytes', () => {
 const memory = new Memory(), owner = new LibrarySpaceDraftOwner(memory, scope, () => true);
 assert.equal(owner.open(proposal()), true);memory.failWrite = true;
 assert.equal(owner.edit('Newer unfinished name'), false);assert.equal(owner.value?.name, 'Newer unfinished name');
 assert.equal(owner.keep(), false);assert.equal(new LibrarySpaceDraftOwner(memory, scope, () => true).value?.name, proposal().name);
 memory.failWrite = false;memory.failReadAfterWrite = true;assert.equal(owner.keep(), false);
 memory.failRead = false;const writes = memory.writes;assert.equal(owner.keep(), true);assert.equal(memory.writes, writes);
 assert.equal(new LibrarySpaceDraftOwner(memory, scope, () => true).value?.name, 'Newer unfinished name');
});
test('unknown, foreign and changed name journals are preserved; retirement blocks edits and discard', () => {
 for (const raw of ['{unfinished', JSON.stringify({ format: 1, ...scope, epoch: 'other', draft: proposal() })]) {
  const memory = new Memory(), first = new LibrarySpaceDraftOwner(memory, scope, () => true);memory.data.set(first.key, raw);
  const owner = new LibrarySpaceDraftOwner(memory, scope, () => true);
  assert.equal(owner.invalid, true);assert.equal(owner.open(proposal()), false);assert.equal(owner.discard(), false);assert.equal(memory.data.get(first.key), raw);
 }
 const memory = new Memory();let active = true;const owner = new LibrarySpaceDraftOwner(memory, scope, () => active);
 owner.open(proposal());const changed = JSON.stringify({ format: 1, ...scope, draft: { ...proposal(), name: 'Other writing' } });memory.data.set(owner.key, changed);
 assert.equal(owner.edit('My newer writing'), false);assert.equal(memory.data.get(owner.key), changed);
 active = false;assert.equal(owner.discard(), false);assert.equal(owner.edit('Late'), false);assert.equal(owner.value?.name, 'My newer writing');
});
test('exact confirmation clears only submitted writing; newer name and failed rebase persistence stay recoverable', () => {
 const memory = new Memory(), owner = new LibrarySpaceDraftOwner(memory, scope, () => true), input = command(), reply = result(input);
 owner.open(proposal());owner.edit('New name written while saving');memory.failWrite = true;
 assert.equal(owner.acknowledge(input, reply), false);assert.equal(owner.value?.name, 'New name written while saving');assert.equal(owner.value?.expectedRevision, 3);
 memory.failWrite = false;assert.equal(owner.acknowledge(input, reply), true);
 assert.deepEqual(new LibrarySpaceDraftOwner(memory, scope, () => true).value, { ...proposal(), name: 'New name written while saving', expectedRevision: 3 });
 assert.equal(owner.open({ ...proposal(), id: 'space:different' }), false);assert.equal(owner.value?.id, proposal().id);
});
test('Space route roundtrips through exact Search collection admission and original restoration', () => {
 const original = { ...defaultLibraryView(), route: { kind: 'space' as const, id: 'space:kept' }, query: 'my query', selection: { collectionId: 'collection:one', references: [{ kind: 'note' as const, id: 'note:one', revision: 1 }] } };
 const values = new Map<string, unknown>([[libraryViewKey(scope), original]]), io = { read: (key: string) => values.get(key), write: (key: string, value: unknown) => { values.set(key, value);return true; } };
 const state = { epoch: scope.epoch, collections: [{ id: 'collection:one', revision: 1, archived: false }], items: [] } as any;
 const target = { ...scope, nonce: 'search', target: { kind: 'collection' as const, id: 'collection:one', revision: 1 } };
 assert.equal(admitLibraryTarget(scope, state, target, io), undefined);assert.deepEqual(libraryView(values.get(libraryViewKey(scope)))?.route, { kind: 'all' });
 assert.equal(admitLibraryTarget(scope, state, { ...scope, nonce: 'return', restore: original }, io), undefined);assert.deepEqual(libraryView(values.get(libraryViewKey(scope))), original);
 for (const route of [{ kind: 'space', id: '../bad' }, { kind: 'all', id: 'extra' }, { kind: 'unknown' }]) assert.equal(libraryView({ ...original, route }), undefined);
});

const symbol = Symbol.for('nova.test.library-space-editor'), react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
 resolve(specifier, context, next) {
  if (/\/LibrarySpaceEditor\./.test(context.parentURL ?? '')) {
   if (specifier === 'react') return { url: 'nova-space-test:react', shortCircuit: true };
   if (specifier === './home-draft-navigation') return { url: 'nova-space-test:guard', shortCircuit: true };
  }
  return next(specifier, context);
 },
 load(url, context, next) {
  if (url === 'nova-space-test:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};const f=()=>globalThis[Symbol.for('nova.test.library-space-editor')];export const useState=v=>f().state(v);export const useRef=v=>f().ref(v);export const useEffect=(fn,deps)=>f().effect(fn,deps);` };
  if (url === 'nova-space-test:guard') return { format: 'module', shortCircuit: true, source: `export const registerHomeDraftNavigation=fn=>{const f=globalThis[Symbol.for('nova.test.library-space-editor')];f.guard=fn;return()=>{f.guard=undefined;};};` };
  return next(url, context);
 },
});
const { LibrarySpaceEditor } = await import('../apps/client/src/LibrarySpaceEditor');
class Hooks {
 slots: any[] = []; index = 0; pending: (() => void)[] = []; memory = new Memory(); guard?: () => boolean;
 state(value: any) { const n = this.index++;if (!(n in this.slots)) this.slots[n] = typeof value === 'function' ? value() : value;return [this.slots[n], (v: any) => { this.slots[n] = typeof v === 'function' ? v(this.slots[n]) : v; }]; }
 ref(value: any) { const n = this.index++;return this.slots[n] ??= { current: value }; }
 effect(fn: () => (() => void) | void, deps: any[]) { const n = this.index++, old = this.slots[n];if (!old || deps.some((value, index) => value !== old.deps[index])) this.pending.push(() => { old?.cleanup?.();this.slots[n] = { deps, cleanup: fn() }; }); }
 render<T>(fn: () => T) { (globalThis as any)[symbol] = this;Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: this.memory });this.index = 0;this.pending = [];const tree = fn();for (const effect of this.pending) effect();return tree; }
 close() { for (const slot of this.slots) slot?.cleanup?.(); }
}
function elements(tree: any): any[] { return !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(elements)]; }
const controller = (run: HomeLibraryController['run']): HomeLibraryController => ({ state: undefined, busy: false, pending: undefined, error: '', journalError: '', lastSave: undefined, loading: false, load: async () => {}, run });
test('actual Space dialog Close and Home departure refuse lost writing, then resume the exact draft', () => {
 const f = new Hooks(), request = { ...scope, nonce: 'new', draft: proposal() }, props = { scope, shelves: shelves(), request, controller: controller(async () => undefined) }, render = () => f.render(() => LibrarySpaceEditor(props));
 try {
  render();let tree = render();f.memory.failWrite = true;
  elements(tree).find(row => row.type === 'input').props.onChange({ target: { value: 'Words not yet stored' } });tree = render();
  elements(tree).find(row => row.props.title === 'New Space').props.close();assert.ok(elements(render()).some(row => row.props.title === 'New Space'));assert.equal(f.guard!(), false);
  f.memory.failWrite = false;assert.equal(f.guard!(), true);elements(render()).find(row => row.props.title === 'New Space').props.close();
  tree = render();elements(tree).find(row => row.type === 'button' && row.props.children === 'Resume Space Name').props.onClick();
  assert.equal(elements(render()).find(row => row.type === 'input').props.value, 'Words not yet stored');
 } finally { f.close(); }
});
test('actual confirmed Space save with failed local clear retries locally and retains newer typing', async () => {
 const f = new Hooks();let calls = 0, resolve!: (reply: HomeShelvesReceipt) => void, sent!: ReturnType<typeof command>;
 const props = { scope, shelves: shelves(), request: { ...scope, nonce: 'new', draft: proposal() }, controller: controller(async input => { calls++;sent = input as ReturnType<typeof command>;return new Promise(done => { resolve = done; }); }) }, render = () => f.render(() => LibrarySpaceEditor(props));
 try {
  render();let tree = render();elements(tree).find(row => row.type === 'form').props.onSubmit({ preventDefault() {} });
  f.memory.failWrite = true;resolve(result(sent));for (let n = 0; n < 5; n++) await Promise.resolve();
  tree = render();assert.equal(calls, 1);assert.ok(elements(tree).some(row => row.props.children === 'Keep Confirmed Save'));
  elements(tree).find(row => row.type === 'input').props.onChange({ target: { value: 'A newer separate proposal' } });
  f.memory.failWrite = false;elements(render()).find(row => row.type === 'form').props.onSubmit({ preventDefault() {} });await Promise.resolve();
  assert.equal(calls, 1);assert.equal(elements(render()).find(row => row.type === 'input').props.value, 'A newer separate proposal');
 } finally { f.close(); }
});
test('retired Space owner ignores a late confirmation and a foreign entry request never opens', async () => {
 const f = new Hooks();let resolve!: (reply: HomeShelvesReceipt) => void, sent!: ReturnType<typeof command>;
 const props = { scope, shelves: shelves(), request: { ...scope, nonce: 'new', draft: proposal() }, controller: controller(async input => { sent = input as ReturnType<typeof command>;return new Promise(done => { resolve = done; }); }) };
 const render = () => f.render(() => LibrarySpaceEditor(props));
 try {
  render();elements(render()).find(row => row.type === 'form').props.onSubmit({ preventDefault() {} });
  const before = new Map(f.memory.data);f.close();resolve(result(sent));for (let n = 0; n < 5; n++) await Promise.resolve();
  assert.deepEqual(f.memory.data, before);
  const foreign = new Hooks();
  try {
   const read = () => foreign.render(() => LibrarySpaceEditor({ ...props, scope: { ...scope, epoch: 'other-epoch' } }));
   read();assert.equal(elements(read()).some(row => row.type === 'input'), false);assert.equal(foreign.memory.writes, 0);
  } finally { foreign.close(); }
 } finally { f.close(); }
});
test('actual Space editor survives a denied global storage getter without writing or dispatching', () => {
 const f = new Hooks();let reads = 0, commands = 0;
 const props = { scope, shelves: shelves(), request: { ...scope, nonce: 'blocked', draft: proposal() }, controller: controller(async () => { commands++;return undefined; }) };
 const render = () => f.render(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { reads++;throw Error('Browser storage access denied'); } });
  return LibrarySpaceEditor(props);
 });
 try {
  assert.doesNotThrow(render);const tree = render();
  assert.ok(elements(tree).some(row => row.props.role === 'alert' && row.props.children === 'Browser storage access denied'));
  assert.equal(elements(tree).some(row => row.type === 'input'), false);
  assert.equal(f.memory.writes, 0);assert.equal(commands, 0);assert.equal(reads, 1);
 } finally { f.close(); }
});
test.after(() => { loader.deregister();delete (globalThis as any)[symbol];delete (globalThis as any).localStorage; });
