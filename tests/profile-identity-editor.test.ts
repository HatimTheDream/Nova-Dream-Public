import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { defaultLayout, type Command, type Entity, type Snapshot } from '../packages/domain/contracts';
import type { PersonalProfile } from '../packages/domain/workspace-records';
import { createMascotAppearance } from '../packages/domain/mascot-appearance';

const key = Symbol.for('nova.test.profile-identity-ui');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (/\/apps\/client\/src\/(?:ProfileIdentityEditor|nova\/square-lynx\/SquareLynxCreator)\./.test(context.parentURL ?? '')) {
      if (specifier === 'react') return { url: 'nova-identity:react', shortCircuit: true };
      if (specifier === './api' || specifier === '../../api') return { url: 'nova-identity:api', shortCircuit: true };
      if (specifier === './useWorkspace') return { url: 'nova-identity:window', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const f = `const f=()=>globalThis[Symbol.for('nova.test.profile-identity-ui')];`;
    if (url === 'nova-identity:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};${f}export const useState=v=>f().state(v);export const useRef=v=>f().ref(v);export const useId=()=>f().id();export const useEffect=(fn,deps)=>f().effect(fn,deps);export const useLayoutEffect=useEffect;` };
    if (url === 'nova-identity:api') return { format: 'module', shortCircuit: true, source: `${f}export const commit=command=>f().request('commands',command);export const fetchSnapshot=()=>f().request('snapshot');export const readLocal=k=>{try{return JSON.parse(f().read(k)||'null')}catch{return null}};export const saveLocal=(k,v)=>{try{f().write(k,JSON.stringify(v));return true}catch{return false}};` };
    if (url === 'nova-identity:window') return { format: 'module', shortCircuit: true, source: `export const retainedWindowId='identity-window';` };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  },
});
const { ProfileIdentityEditor } = await import('../apps/client/src/ProfileIdentityEditor');
const { RecordFields } = await import('../apps/client/src/RecordFields');
const { SquareLynxCreator } = await import('../apps/client/src/nova/square-lynx/SquareLynxCreator');
const { mayLeaveRecordDrafts } = await import('../apps/client/src/record-draft-navigation');
const { profileIdentityKey } = await import('../apps/client/src/profile-identity-client');
type Call = { path: string; command?: Command; resolve(value: unknown): void; reject(problem: unknown): void };
const instances = new Set<Hooks>();
class Hooks {
  slots: any[] = []; index = 0; effects: (() => void)[] = [];
  storage = new Map<string, string>(); failRead = false; failWrite = false; failGetter = false;
  calls: Call[] = []; listeners = new Map<string, Set<Function>>(); frames = new Map<number, FrameRequestCallback>(); nextFrame = 0;
  state(initial: any) { const i = this.index++; if (!(i in this.slots)) this.slots[i] = typeof initial === 'function' ? initial() : initial; return [this.slots[i], (value: any) => { this.slots[i] = typeof value === 'function' ? value(this.slots[i]) : value; }]; }
  ref(initial: any) { return this.slots[this.index++] ??= { current: initial }; }
  id() { const i = this.index++; return this.slots[i] ??= `identity-test-${i}`; }
  effect(fn: () => (() => void) | void, deps: unknown[]) { const i = this.index++, old = this.slots[i]; if (!old || deps.some((value, n) => !Object.is(value, old.deps[n]))) this.effects.push(() => { old?.cleanup?.(); this.slots[i] = { deps, cleanup: fn() }; }); }
  request(path: string, command?: Command) { assert(['commands', 'snapshot'].includes(path)); return new Promise((resolve, reject) => this.calls.push({ path, command, resolve, reject })); }
  read(name: string) { if (this.failRead) throw Error('Synthetic read refusal'); return this.storage.get(name) ?? null; }
  write(name: string, value: string) { if (this.failWrite) throw Error('Synthetic storage full'); this.storage.set(name, value); }
  render<T>(fn: () => T): T { instances.add(this); (globalThis as any)[key] = this; this.index = 0; this.effects = []; const result = fn(); for (const effect of this.effects) effect(); return result; }
  dispose() { (globalThis as any)[key] = this; for (const slot of this.slots) slot?.cleanup?.(); instances.delete(this); }
}
const owner = () => (globalThis as any)[key] as Hooks;
const originals = new Map(['localStorage', 'window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { if (owner().failGetter) throw Error('Synthetic browser storage denied'); return { getItem: (name: string) => owner().read(name), setItem: (name: string, value: string) => owner().write(name, value) }; } });
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  addEventListener: (name: string, fn: Function) => { if (!owner().listeners.has(name)) owner().listeners.set(name, new Set()); owner().listeners.get(name)!.add(fn); },
  removeEventListener: (name: string, fn: Function) => owner().listeners.get(name)?.delete(fn),
} });
Object.defineProperty(globalThis, 'document', { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (fn: FrameRequestCallback) => { const id = ++owner().nextFrame; owner().frames.set(id, fn); return id; } });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => owner().frames.delete(id) });
test.afterEach(() => { for (const instance of [...instances]) instance.dispose(); });
test.after(() => { loader.deregister(); delete (globalThis as any)[key]; for (const [name, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; });
const nodes = (node: any): any[] => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
const text = (node: any): string => typeof node === 'string' || typeof node === 'number' ? String(node) : !node || typeof node !== 'object' ? '' : [node.props?.children].flat(Infinity).map(text).join('');
function button(tree: any, name: string) { const found = nodes(tree).find(row => row.type === 'button' && (row.props['aria-label'] === name || text(row) === name)); assert(found, name); return found; }
function fields(tree: any) { const found = nodes(tree).find(row => row.type === RecordFields); assert(found); return found; }
function submit(tree: any) { nodes(tree).find(row => row.type === 'form').props.onSubmit({ preventDefault() {} }); }
const settle = async () => { for (let n = 0; n < 15; n++) await Promise.resolve(); };
const look = { ...createMascotAppearance(), face: 'adventurous' };
function fixture(saved = true, initialSection: 'identity' | 'look' = 'identity') {
  const hooks = new Hooks(), epoch = randomUUID(), deviceId = randomUUID(), at = '2026-10-20T10:00:00.000Z';
  const entity: Entity<PersonalProfile> = { id: 'profile:owner', revision: 7, deviceId, updatedAt: at, value: { name: 'Original identity', position: 'Original position', about: 'Exact saved biography', appearance: createMascotAppearance() } };
  const snapshot: Snapshot = { epoch, deviceId, cursor: 0, tasks: [], projects: [], drafts: [], layout: { id: 'layout', revision: 1, deviceId, updatedAt: at, value: structuredClone(defaultLayout) }, capabilities: { assistant: false, voice: false, reason: 'Synthetic' } };
  let closed = 0, refreshes = 0, active = true;
  const props = { snapshot, entity: saved ? entity : undefined, initialSection, refresh: async () => { refreshes++; }, close: () => { closed++; }, owns: () => active };
  const render = () => hooks.render(() => ProfileIdentityEditor(props));
  const receipt = (command: Command) => ({ ...entity, revision: command.expectedRevision + 1, value: command.payload as PersonalProfile });
  return { hooks, entity, props, snapshot, render, receipt, closed: () => closed, refreshes: () => refreshes, retire: () => { active = false; } };
}
test('actual section callbacks retain incomplete writing; failed keeping blocks Close, section and departure', () => {
  const f = fixture(); let tree = f.render(); f.hooks.failWrite = true;
  fields(tree).props.change({ ...f.entity.value, name: '', about: 'Keep this unfinished identity\nexactly' });
  tree = f.render(); assert.equal(fields(tree).props.value.name, ''); button(tree, 'Look').props.onClick();
  assert.equal(fields(f.render()).props.profileSection, 'identity'); tree.props.close(); assert.equal(f.closed(), 0); assert.equal(mayLeaveRecordDrafts(), false);
  let prevented = 0; for (const leave of f.hooks.listeners.get('beforeunload') ?? []) leave({ preventDefault() { prevented++; }, returnValue: '' });
  assert.equal(prevented, 1); assert(button(tree, 'Retry Keeping Writing'));
  f.hooks.failWrite = false; button(tree, 'Retry Keeping Writing').props.onClick(); button(f.render(), 'Look').props.onClick();
  tree = f.render(); assert.equal(fields(tree).props.profileSection, 'look'); assert.equal(fields(tree).props.value.about, 'Keep this unfinished identity\nexactly');
  button(tree, 'Keep & Close').props.onClick(); assert.equal(f.closed(), 1); assert.equal(f.hooks.calls.length, 0);
  const kept = [...f.hooks.storage.entries()]; f.hooks.dispose(); const reopened = fixture(); reopened.props.snapshot = f.snapshot; reopened.props.entity = f.entity; reopened.hooks.storage = new Map(kept);
  assert.equal(fields(reopened.render()).props.value.name, '');
});
test('existing Save Look sends only appearance and keeps unrelated identity writing without closing', async () => {
  const f = fixture(); fields(f.render()).props.change({ ...f.entity.value, about: 'Unsent exact biography' });
  button(f.render(), 'Look').props.onClick(); let tree = f.render(); fields(tree).props.appearanceControls.onSaveLook(look);
  assert.equal(f.hooks.calls.length, 1); const command = f.hooks.calls[0].command!;
  assert.deepEqual(command.payload, { ...f.entity.value, appearance: look }); f.hooks.calls[0].resolve(f.receipt(command)); await settle();
  tree = f.render(); assert.equal(fields(tree).props.value.about, 'Unsent exact biography'); assert.deepEqual(fields(tree).props.appearanceControls.savedValue, look);
  assert.equal(f.closed(), 0); assert.equal(f.refreshes(), 1);
  button(tree, 'Profile').props.onClick(); submit(f.render()); assert.equal(f.hooks.calls[1].command!.expectedRevision, 8); assert.equal((f.hooks.calls[1].command!.payload as PersonalProfile).about, 'Unsent exact biography');
});
test('reverting to saved writing with failed storage cannot close over an older kept draft', () => {
  const f = fixture(); fields(f.render()).props.change({ ...f.entity.value, about: 'Earlier kept words' });
  f.hooks.failWrite = true; fields(f.render()).props.change(f.entity.value); let tree = f.render();
  assert.equal(button(tree, 'Save Profile').props.disabled, true); tree.props.close(); assert.equal(f.closed(), 0); assert.equal(mayLeaveRecordDrafts(), false);
  assert(button(tree, 'Retry Keeping Writing')); f.hooks.failWrite = false; button(tree, 'Retry Keeping Writing').props.onClick();
  tree = f.render(); tree.props.close(); assert.equal(f.closed(), 1); assert.equal(JSON.parse([...f.hooks.storage.values()][0]).value.about, f.entity.value.about); assert.equal(f.hooks.calls.length, 0);
});
test('Use Look for new identity makes no host record and hidden full form callbacks cannot save', async () => {
  const f = fixture(false); const oldSubmit = nodes(f.render()).find(row => row.type === 'form').props.onSubmit;
  fields(f.render()).props.change({ name: 'A new identity', position: '', about: '', appearance: null }); button(f.render(), 'Look').props.onClick();
  await fields(f.render()).props.appearanceControls.onSaveLook(look); oldSubmit({ preventDefault() {} }); submit(f.render());
  assert.equal(f.hooks.calls.length, 0); assert.match(text(f.render()), /Look kept in this draft/);
  button(f.render(), 'Profile').props.onClick(); submit(f.render()); assert.equal(f.hooks.calls.length, 1); assert.equal(f.hooks.calls[0].command!.expectedRevision, 0);
});
test('Cancel Look does not claim retained success on storage refusal and keeps other writing', () => {
  const f = fixture(true, 'look'); fields(f.render()).props.change({ ...f.entity.value, about: 'Keep other writing', appearance: look }); f.hooks.failWrite = true;
  fields(f.render()).props.appearanceControls.onCancelLook(); const tree = f.render();
  assert.equal(fields(tree).props.value.about, 'Keep other writing'); assert.deepEqual(fields(tree).props.value.appearance, f.entity.value.appearance);
  assert(!text(tree).includes('Saved look restored')); assert.equal(mayLeaveRecordDrafts(), false); assert.equal(f.hooks.calls.length, 0);
});
test('known save plus failed local acknowledgement retries only storage and reports host success truthfully', async () => {
  const f = fixture(); fields(f.render()).props.change({ ...f.entity.value, name: 'Save once' }); submit(f.render());
  const command = f.hooks.calls[0].command!; f.hooks.failWrite = true; f.hooks.calls[0].resolve(f.receipt(command)); await settle();
  let tree = f.render(); assert.match(text(tree), /confirmed on the host/); assert(!text(tree).includes('awaiting confirmation')); assert.equal(f.closed(), 0);
  f.hooks.failWrite = false; button(tree, 'Retry Keeping Confirmed Save').props.onClick(); await settle(); tree = f.render();
  assert.equal(f.hooks.calls.length, 1); assert.equal(f.refreshes(), 1); assert.equal(f.closed(), 0);
  submit(tree); assert.equal(f.hooks.calls.length, 1);
});
test('refresh failure after saved acknowledgement stays saved and newer typing prevents delayed close', async () => {
  const f = fixture(); f.props.refresh = async () => { throw Error('Offline refresh'); };
  fields(f.render()).props.change({ ...f.entity.value, name: 'Saved identity' }); submit(f.render()); f.hooks.calls[0].resolve(f.receipt(f.hooks.calls[0].command!)); await settle();
  let tree = f.render(); assert.match(text(tree), /Saved. Refresh/); assert(!text(tree).includes('awaiting confirmation')); submit(tree); assert.equal(f.hooks.calls.length, 1);
  let finish!: () => void; f.props.refresh = () => new Promise<void>(resolve => { finish = resolve; });
  fields(tree).props.change({ ...fields(tree).props.value, name: 'Another explicit save' }); submit(f.render()); f.hooks.calls[1].resolve(f.receipt(f.hooks.calls[1].command!)); await settle();
  tree = f.render(); fields(tree).props.change({ ...fields(tree).props.value, about: 'New writing during refresh' }); finish(); await settle();
  assert.equal(f.closed(), 0); assert.equal(fields(f.render()).props.value.about, 'New writing during refresh');
});
test('lost reply and remount check only the exact pending command; stale check does not start a new save', async () => {
  const f = fixture(true, 'look'); fields(f.render()).props.appearanceControls.onSaveLook(look); const original = f.hooks.calls[0].command!;
  f.hooks.calls[0].reject(Error('Lost original reply')); await settle(); const kept = new Map(f.hooks.storage); f.hooks.dispose();
  const g = fixture(true, 'look'); g.props.snapshot = f.snapshot; g.props.entity = f.entity; g.hooks.storage = kept;
  const callback = button(g.render(), 'Check Original Save').props.onClick; callback(); assert.deepEqual(g.hooks.calls[0].command, original);
  g.hooks.calls[0].resolve(f.receipt(original)); await settle(); callback(); await settle(); assert.equal(g.hooks.calls.length, 1);
});
test('fresh review uses plain saved identity; old review cannot overwrite while a newer read is in flight', async () => {
  const f = fixture(); fields(f.render()).props.change({ ...f.entity.value, about: 'My writing' }); button(f.render(), 'Review Saved Profile').props.onClick();
  const fresh = (revision: number, about: string) => ({ ...f.snapshot, records: { profile: [{ ...f.entity, revision, value: { ...f.entity.value, about } }] } });
  f.hooks.calls[0].resolve(fresh(8, 'Reviewed words')); await settle(); let tree = f.render(); const old = button(tree, 'Use Saved Profile').props.onClick;
  assert.match(text(tree), /Reviewed words/); assert(!text(tree).includes('"requestId"'));
  button(tree, 'Review Saved Profile').props.onClick(); old(); assert.equal(fields(f.render()).props.value.about, 'My writing');
  f.hooks.calls[1].resolve(fresh(9, 'Newest words')); await settle(); old(); assert.equal(fields(f.render()).props.value.about, 'My writing');
  button(f.render(), 'Use Saved Profile').props.onClick(); assert.equal(fields(f.render()).props.value.about, 'Newest words');
  assert.equal(f.hooks.calls.filter(call => call.command).length, 0);
});
test('unknown pending outcome has no review authority and retired response cannot close or acknowledge', async () => {
  const f = fixture(); fields(f.render()).props.change({ ...f.entity.value, name: 'Original' }); submit(f.render());
  const command = f.hooks.calls[0].command!, raw = [...f.hooks.storage.values()][0]; f.retire(); f.hooks.calls[0].resolve(f.receipt(command)); await settle();
  assert.equal([...f.hooks.storage.values()][0], raw); assert.equal(f.closed(), 0); assert.equal(f.refreshes(), 0);
  const g = fixture(); fields(g.render()).props.change({ ...g.entity.value, about: 'Held proposal' }); submit(g.render()); g.hooks.calls[0].reject(Object.assign(Error('Recovery held'), { code: 'recovery_required' })); await settle();
  const tree = g.render(); button(tree, 'Review Saved Profile').props.onClick(); assert.equal(g.hooks.calls.length, 1); assert.equal(button(tree, 'Review Saved Profile').props.disabled, true);
});
test('unreadable and foreign journal records remain untouched and disabled without losing access to Close', () => {
  for (const variant of ['getter', 'malformed', 'epoch']) {
    const f = fixture(); if (variant === 'getter') f.hooks.failGetter = true;
    const name = profileIdentityKey(f.snapshot.deviceId, 'identity-window'), raw = variant === 'malformed' ? '{keep' : JSON.stringify({ value: f.entity.value, revision: 7, epoch: randomUUID(), dirty: true });
    if (variant !== 'getter') f.hooks.storage.set(name, raw);
    const tree = f.render(); assert.equal(nodes(tree).find(row => row.type === 'fieldset').props.disabled, true);
    fields(tree).props.change({ ...f.entity.value, about: 'Must refuse' }); submit(tree); tree.props.close();
    assert.equal(f.closed(), 1); assert.equal(f.hooks.calls.length, 0); if (variant !== 'getter') assert.equal(f.hooks.storage.get(name), raw);
    f.hooks.dispose();
  }
});
test('opt-in fields keep the exact creator position mounted while identity/look wrappers hide and become inert', () => {
  const f = fixture(); const common = { kind: 'profile' as const, value: f.entity.value, change() {}, snapshot: f.snapshot };
  const identity = RecordFields({ ...common, profileSection: 'identity' }), lookTree = RecordFields({ ...common, profileSection: 'look' });
  const groups = (tree: any) => nodes(tree).filter(row => row.props?.['data-profile-section']);
  assert.deepEqual(groups(identity).map(row => [row.props['data-profile-section'], row.props.hidden, row.props.inert]), [['identity', false, false], ['look', true, true]]);
  assert.deepEqual(groups(lookTree).map(row => [row.props['data-profile-section'], row.props.hidden, row.props.inert]), [['identity', true, true], ['look', false, false]]);
  assert.equal(groups(identity)[1].props.children.type, groups(lookTree)[1].props.children.type);
  assert.equal(groups(identity)[1].props.children.key, groups(lookTree)[1].props.children.key);
  assert(!nodes(RecordFields(common)).some(row => row.props?.['data-profile-section']), 'other original profile callers keep their default layout');
});
test('actual unchanged creator Undo/Redo and expression survive section changes with one mounted creator', () => {
  const f = fixture(true, 'look'), creator = new Hooks(); creator.storage = f.hooks.storage;
  function renderCreator() {
    const parent = f.render(), props = fields(parent).props;
    const fieldTree = RecordFields(props), picker = nodes(fieldTree).find(row => row.type?.name === 'PortraitPicker'); assert(picker);
    return creator.render(() => SquareLynxCreator(picker.props));
  }
  let tree = renderCreator(); const original = fields(f.render()).props.value.appearance;
  tree = renderCreator(); button(tree, 'Next Face').props.onClick(); tree = renderCreator();
  const edited = fields(f.render()).props.value.appearance; assert.notDeepEqual(edited, original);
  tree = renderCreator(); nodes(tree).find(row => row.type === 'select' && row.props['aria-label'] === 'Preview Expression').props.onChange({ target: { value: 'speaking' } });
  button(f.render(), 'Profile').props.onClick(); assert.equal(fields(f.render()).props.profileSection, 'identity'); button(f.render(), 'Look').props.onClick();
  tree = renderCreator(); assert.equal(nodes(tree).find(row => row.type === 'select').props.value, 'speaking');
  const undo = nodes(tree).find(row => row.type === 'button' && /Undo/.test(row.props['aria-label'] ?? '')); assert(undo && !undo.props.disabled); undo.props.onClick();
  assert.deepEqual(fields(f.render()).props.value.appearance, original);
  tree = renderCreator(); const redo = nodes(tree).find(row => row.type === 'button' && /Redo/.test(row.props['aria-label'] ?? '')); assert(redo && !redo.props.disabled); redo.props.onClick();
  assert.deepEqual(fields(f.render()).props.value.appearance, edited); assert.equal(f.hooks.calls.length, 0);
});
