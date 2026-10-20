import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { defaultLayout, type Snapshot } from '../packages/domain/contracts.js';
import type { KeptHomeWriting } from '../apps/client/src/home-writing-recovery.js';
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const symbol = Symbol.for('nova.test.home-writing-recovery');
registerHooks({
 resolve(specifier, context, next) {
  if (/\/HomeWritingRecovery\./.test(context.parentURL ?? '')) {
   if (specifier === 'react') return { url: 'home-writing-test:react', shortCircuit: true };
   if (specifier === './api') return { url: 'home-writing-test:api', shortCircuit: true };
  }
  return next(specifier, context);
 },
 load(url, context, next) {
  if (url === 'home-writing-test:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};const f=()=>globalThis[Symbol.for('nova.test.home-writing-recovery')];export const useState=v=>f().state(v),useRef=v=>f().ref(v),useEffect=(fn,deps)=>f().effect(fn,deps);` };
  if (url === 'home-writing-test:api') return { format: 'module', shortCircuit: true, source: `export const commit=command=>globalThis[Symbol.for('nova.test.home-writing-recovery')].commit(command);` };
  return next(url, context);
 },
});
const { HomeWritingRecovery } = await import('../apps/client/src/HomeWritingRecovery.js');
class Fixture {
 slots: any[] = []; index = 0; effects: (() => void)[] = [];
 rows = new Map<string, string>(); writes: string[] = []; commands: unknown[] = [];
 resolve?: (value: unknown) => void;
 state(value: any) { const i = this.index++;if (!(i in this.slots)) this.slots[i] = typeof value === 'function' ? value() : value;return [this.slots[i], (v: any) => { this.slots[i] = typeof v === 'function' ? v(this.slots[i]) : v; }]; }
 ref(value: any) { const i = this.index++;return this.slots[i] ??= { current: value }; }
 effect(fn: () => (() => void) | void, deps: unknown[]) { const i = this.index++, prior = this.slots[i];if (!prior || deps.some((v, n) => v !== prior.deps[n])) this.effects.push(() => { prior?.cleanup?.();this.slots[i] = { deps, cleanup: fn() }; }); }
 commit(command: unknown) { this.commands.push(command);return new Promise(resolve => { this.resolve = resolve; }); }
 render<T>(fn: () => T) {
  (globalThis as any)[symbol] = this;this.index = 0;this.effects = [];
  const f = this;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
   get length() { return f.rows.size; }, key: (i: number) => [...f.rows.keys()][i] ?? null,
   getItem: (key: string) => f.rows.get(key) ?? null,
   setItem: (key: string, raw: string) => { f.writes.push(key);f.rows.set(key, raw); },
  } });
  const result = fn();for (const effect of this.effects) effect();return result;
 }
 close() { for (const slot of this.slots) slot?.cleanup?.(); }
}
function nodes(value: any): any[] { if (!value || typeof value !== 'object') return [];return [value, ...[value.props?.children].flat(Infinity).flatMap(nodes)]; }
function text(value: any): string { if (value === null || value === undefined || typeof value === 'boolean') return '';if (Array.isArray(value)) return value.map(text).join('');return typeof value === 'object' ? text(value.props?.children) : String(value); }
const button = (tree: any, label: string) => nodes(tree).find(row => row.type === 'button' && text(row.props.children) === label);
async function settleUntil(predicate: () => boolean) { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));assert.ok(predicate()); }
function setup() {
 const f = new Fixture(), epoch = crypto.randomUUID(), deviceId = 'device:owner', scope = { epoch, deviceId, windowId: 'this-window' };
 const snapshot: Pick<Snapshot, 'epoch' | 'deviceId' | 'layout'> = { epoch, deviceId, layout: { id: 'layout', revision: 2, deviceId, updatedAt: '2026-10-20T05:00:00.000Z', value: structuredClone(defaultLayout) } };
 const key = `e3:home-widget:${epoch}:${deviceId}:old-window:new`;
 const raw = JSON.stringify({ version: 1, forms: { note: { id: 'widget:' + crypto.randomUUID(), type: 'note', hidden: true, size: 'wide', title: 'Original', settings: { text: 'Keep every word\n雪' } } } });
 f.rows.set(key, raw);
 const props = { snapshot, scope, canAdopt: () => true, hasWriter: false, adopt: (_copy: KeptHomeWriting) => false, returnToWriter() {}, openSaved() {}, close() { f.close(); } };
 return { f, props, key, raw };
}
test('actual recovery opens read-only and explicit copy survives refused navigation, then opens exact kept ID without another write', async () => {
 const { f, props, key, raw } = setup();const adopted: KeptHomeWriting[] = [];
 let accept = false;props.adopt = copy => { adopted.push(copy);return accept; };
 const render = () => f.render(() => HomeWritingRecovery(props));
 try {
  let tree = render();assert.equal(f.writes.length, 0);assert.equal(f.commands.length, 0);assert.match(text(tree), /Keep every word/);
  button(tree, 'Continue As Note').props.onClick();button(tree, 'Continue As Note').props.onClick();
  await settleUntil(() => adopted.length === 1);tree = render();
  assert.equal(f.writes.length, 1);assert.equal(f.rows.get(key), raw);assert.match(text(tree), /copy is kept/);
  accept = true;button(tree, 'Open Kept Copy').props.onClick();
  assert.equal(adopted.length, 2);assert.deepEqual(adopted[1], adopted[0]);assert.equal(f.writes.length, 1);assert.equal(f.commands.length, 0);
 } finally { f.close(); }
});
test('actual original Layout reconciliation is explicit, exact and never clears the journal', async () => {
 const { f, props } = setup(), value = structuredClone(defaultLayout);
 const command = { kind: 'layout', entityId: 'layout', epoch: props.scope.epoch, expectedRevision: 2, requestId: crypto.randomUUID(), payload: value };
 const key = `e3:journal:${props.scope.deviceId}:layout:old-window`, raw = JSON.stringify({ value, revision: 2, epoch: props.scope.epoch, dirty: true, pending: command });
 f.rows.set(key, raw);const render = () => f.render(() => HomeWritingRecovery(props));
 try {
  let tree = render();assert.equal(f.commands.length, 0);
  button(tree, 'Reconcile Original Save').props.onClick();button(tree, 'Reconcile Original Save').props.onClick();assert.deepEqual(f.commands, [command]);assert.equal(f.rows.get(key), raw);
  f.resolve!({ id: 'layout', revision: 3, value });await new Promise(resolve => setImmediate(resolve));tree = render();
  assert.match(text(tree), /Original save confirmed at layout revision 3/);assert.equal(f.rows.get(key), raw);assert.equal(f.writes.length, 0);
 } finally { f.close(); }
});
test('stale source, foreign epoch and unmounted callbacks cannot submit the original Layout command', () => {
 for (const condition of ['source', 'epoch', 'unmounted']) {
  const { f, props } = setup(), value = structuredClone(defaultLayout);
  const command = { kind: 'layout', entityId: 'layout', epoch: props.scope.epoch, expectedRevision: 2, requestId: crypto.randomUUID(), payload: value };
  const key = `e3:journal:${props.scope.deviceId}:layout:old-window`;
  f.rows.set(key, JSON.stringify({ value, revision: 2, epoch: props.scope.epoch, dirty: true, pending: command }));
  const tree = f.render(() => HomeWritingRecovery(props)), action = button(tree, 'Reconcile Original Save');
  if (condition === 'source') f.rows.set(key, '{}');
  if (condition === 'epoch') { props.snapshot = { ...props.snapshot, epoch: crypto.randomUUID() };f.render(() => HomeWritingRecovery(props)); }
  if (condition === 'unmounted') f.close();
  action.props.onClick();assert.equal(f.commands.length, 0);assert.equal(f.writes.length, 0);f.close();
 }
});
