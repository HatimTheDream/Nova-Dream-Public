import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Snapshot } from '../packages/domain/contracts.js';
import type { HomeLibraryCommand, HomeLibraryState } from '../packages/domain/home-library.js';

const symbol = Symbol.for('nova.test.home-library-lifecycle'), react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
 resolve(specifier, context, next) {
  if (context.parentURL?.includes('/apps/client/src/HomeLibrary')) {
   if (specifier === 'react') return { url: 'nova-home-test:react', shortCircuit: true };
   if (specifier === './api') return { url: 'nova-home-test:api', shortCircuit: true };
   if (specifier === './useWorkspace') return { url: 'nova-home-test:workspace', shortCircuit: true };
  }
  return next(specifier, context);
 },
 load(url, context, next) {
  if (url === 'nova-home-test:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
   const fixture=()=>globalThis[Symbol.for('nova.test.home-library-lifecycle')];
   export const useState=value=>fixture().state(value);
   export const useRef=value=>fixture().ref(value);
   export const useCallback=(fn,deps)=>fixture().callback(fn,deps);
   export const useEffect=(fn,deps)=>fixture().effect(fn,deps);` };
  if (url === 'nova-home-test:api') return { format: 'module', shortCircuit: true, source: `const fixture=()=>globalThis[Symbol.for('nova.test.home-library-lifecycle')];
   export class ApiError extends Error { constructor(code,message,current,status){super(message);this.code=code;this.current=current;this.status=status;} }
   export const readLocal=key=>fixture().storage.get(key);
   export const saveLocal=(key,value)=>{if(value===null)fixture().storage.delete(key);else fixture().storage.set(key,structuredClone(value));return true;};
   export const request=(path,data)=>fixture().request(path,data);` };
  if (url === 'nova-home-test:workspace') return { format: 'module', shortCircuit: true, source: `export const retainedWindowId='lifecycle-window';` };
  return next(url, context);
 },
});
const { useHomeLibrary, HomeLibrary } = await import('../apps/client/src/HomeLibrary.js');
type Deferred = { data?: unknown; resolve(value: unknown): void; reject(error: Error): void };
class Hooks {
 slots: any[] = []; index = 0; scheduled: (() => void)[] = []; storage = new Map<string, unknown>(); reads: Deferred[] = []; writes: Deferred[] = [];
 state(initial: any) { const index = this.index++;if (!(index in this.slots)) this.slots[index] = typeof initial === 'function' ? initial() : initial;return [this.slots[index], (value: any) => { this.slots[index] = typeof value === 'function' ? value(this.slots[index]) : value; }]; }
 ref(value: unknown) { const index = this.index++;return this.slots[index] ??= { current: value }; }
 same(a: unknown[], b: unknown[]) { return a.length === b.length && a.every((value, index) => Object.is(value, b[index])); }
 callback(fn: unknown, deps: unknown[]) { const index = this.index++, old = this.slots[index];if (!old || !this.same(old.deps, deps)) this.slots[index] = { fn, deps };return this.slots[index].fn; }
 effect(fn: () => (() => void) | void, deps: unknown[]) { const index = this.index++, old = this.slots[index];if (!old || !this.same(old.deps, deps)) this.scheduled.push(() => { old?.cleanup?.();this.slots[index] = { deps, cleanup: fn() }; }); }
 render<T>(fn: () => T) { (globalThis as any)[symbol] = this;this.index = 0;this.scheduled = [];const value = fn();for (const run of this.scheduled) run();return value; }
 request(_path: string, data?: unknown) { return new Promise((resolve, reject) => (data === undefined ? this.reads : this.writes).push({ data, resolve, reject })); }
 dispose() { for (const slot of this.slots) slot?.cleanup?.(); }
}
const snapshot = (name: string) => ({ deviceId: `device:${name}`, epoch: name === 'a' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222', tasks: [], projects: [], layout: { value: { timezone: 'UTC' } } }) as unknown as Snapshot;
const state = (value: Snapshot): HomeLibraryState => ({ epoch: value.epoch, collections: [], items: [], resources: [], ideaPreferences: { revision: 0, saved: [], hidden: [] } });
const settle = async () => { for (let n = 0; n < 4; n++) await Promise.resolve(); };
test('late acknowledgement cannot replace a new Library owner or clear either owner’s pending receipt', async () => {
 const f = new Hooks(), a = snapshot('a'), b = snapshot('b'), render = (scope: Snapshot) => f.render(() => useHomeLibrary(scope));
 try {
  render(a);f.reads.shift()!.resolve(state(a));await settle();const readyA = render(a);
  const command = (scope: Snapshot): Extract<HomeLibraryCommand, {type: 'item-save'}> => ({ type: 'item-save', requestId: crypto.randomUUID(), epoch: scope.epoch, id: `library:${scope.deviceId}`, expectedRevision: 0, value: { kind: 'note', title: scope.deviceId, body: 'Kept original writing', archived: false } });
  const inputA = command(a), pendingA = readyA.run(inputA), requestA = f.writes.shift()!;
  render(b);f.reads.shift()!.resolve(state(b));await settle();const readyB = render(b);
  const inputB = command(b), pendingB = readyB.run(inputB), requestB = f.writes.shift()!;
  requestA.resolve({ ...inputA.value, id: inputA.id, revision: 1, updatedAt: '' });assert.equal(await pendingA, undefined);
  const current = render(b);assert.equal(current.state?.epoch, b.epoch);assert.equal(current.busy, true);assert.equal(current.pending?.requestId, inputB.requestId);assert.equal(f.reads.length, 0);
  assert.equal((f.storage.get(`e3:home-library-command:${a.deviceId}:${a.epoch}:lifecycle-window`) as HomeLibraryCommand).requestId, inputA.requestId);
  assert.equal((f.storage.get(`e3:home-library-command:${b.deviceId}:${b.epoch}:lifecycle-window`) as HomeLibraryCommand).requestId, inputB.requestId);
  requestB.resolve({ ...inputB.value, id: inputB.id, revision: 1, updatedAt: '' });await settle();f.reads.shift()!.resolve(state(b));await pendingB;assert.equal(render(b).busy, false);
 } finally { f.dispose(); }
});
test('a reconciled item receipt cannot replace the next collection command from the same render', async () => {
 const f = new Hooks(), a = snapshot('a'), key = `e3:home-library-command:${a.deviceId}:${a.epoch}:lifecycle-window`;
 const original: Extract<HomeLibraryCommand, {type: 'item-save'}> = { type: 'item-save', requestId: crypto.randomUUID(), epoch: a.epoch, id: 'library:kept', expectedRevision: 0, value: { kind: 'note', title: 'Kept Note', body: 'Original writing', archived: false } };
 const next: Extract<HomeLibraryCommand, {type: 'collection-save'}> = { type: 'collection-save', requestId: crypto.randomUUID(), epoch: a.epoch, id: 'collection:kept', expectedRevision: 0, value: { title: 'Kept Collection', subtitle: '', icon: 'folder', pinned: false, archived: false, references: [{ kind: 'note', id: original.id, revision: 1 }] } };
 f.storage.set(key, original);
 try {
  f.render(() => useHomeLibrary(a));f.reads.shift()!.resolve(state(a));await settle();const ready = f.render(() => useHomeLibrary(a));
  const reconciliation = ready.run(original), prior = f.writes.shift()!;assert.deepEqual(prior.data, original);prior.resolve({ ...original.value, id: original.id, revision: 1, updatedAt: '' });await settle();f.reads.shift()!.resolve(state(a));await reconciliation;assert.equal(f.storage.has(key), false);
  const chained = ready.run(next), current = f.writes.shift()!;assert.deepEqual(current.data, next);current.resolve({ ...next.value, id: next.id, revision: 1, updatedAt: '' });await settle();f.reads.shift()!.resolve(state(a));await chained;assert.equal(f.storage.has(key), false);
 } finally { f.dispose(); }
});
function elements(node: any): any[] { if (!node || typeof node !== 'object') return [];return [node, ...[node.props?.children].flat(Infinity).flatMap(elements)]; }
test('Library writer switch reads the new scope without copying an earlier form into it', () => {
 const f = new Hooks(), a = snapshot('a'), b = snapshot('b');
 const key = (s: Snapshot) => `e3:home-library-writer:${s.deviceId}:${s.epoch}:lifecycle-window:item`, draft = (title: string) => ({ id: `library:${title}`, revision: 0, value: { kind: 'note', title, body: `Words for ${title}`, archived: false } });
 const originalA = draft('DraftA'), originalB = draft('DraftB');f.storage.set(key(a), originalA);f.storage.set(key(b), originalB);
 const controller = { state: undefined, error: '', loading: false, busy: false, pending: undefined, load: async () => {}, run: async () => undefined };
 const render = (scope: Snapshot) => f.render(() => HomeLibrary({ snapshot: scope, controller, openWidgets() {} }));
 try { assert.ok(elements(render(a)).some(el => el.type === 'input' && el.props.value === 'DraftA'));const switching = render(b);assert.ok(!elements(switching).some(el => el.type === 'input' && el.props.value === 'DraftA'));assert.deepEqual(f.storage.get(key(b)), originalB);assert.ok(elements(render(b)).some(el => el.type === 'input' && el.props.value === 'DraftB'));assert.deepEqual(f.storage.get(key(a)), originalA);assert.deepEqual(f.storage.get(key(b)), originalB); }
 finally { f.dispose(); }
});
test.after(() => { loader.deregister();delete (globalThis as any)[symbol]; });
