import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { WeekNote, WeekNoteCommand, WeekNoteState } from '../packages/domain/profile-week-note';
import { weekNoteIdentityKey } from '../packages/domain/profile-week-note';
import { shiftProfileDay } from '../packages/domain/profile-week';
import { weekNoteDraftKey } from '../apps/client/src/profile-week-note-client';

const key = Symbol.for('nova.test.week-note-ui');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (/\/apps\/client\/src\/(?:ProfileWeekNotes|useWeekNoteDraft)\./.test(context.parentURL ?? '')) {
      if (specifier === 'react') return { url: 'nova-week-note:react', shortCircuit: true };
      if (specifier === './api') return { url: 'nova-week-note:api', shortCircuit: true };
      if (specifier === './useWorkspace') return { url: 'nova-week-note:window', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const f = `const f=()=>globalThis[Symbol.for('nova.test.week-note-ui')];`;
    if (url === 'nova-week-note:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};${f}export const useState=v=>f().state(v);export const useRef=v=>f().ref(v);export const useEffect=(fn,deps)=>f().effect(fn,deps);` };
    if (url === 'nova-week-note:api') return { format: 'module', shortCircuit: true, source: `${f}export const request=(path,input)=>f().request(path,input);` };
    if (url === 'nova-week-note:window') return { format: 'module', shortCircuit: true, source: `export const retainedWindowId='current-window';` };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  },
});
const { ProfileWeekNotes, WeekNoteEditor, WeekNotesList, WeekNoteRecovery } = await import('../apps/client/src/ProfileWeekNotes');
const { mayLeaveRecordDrafts } = await import('../apps/client/src/record-draft-navigation');
type Call = { path: string; input?: WeekNoteCommand; resolve(value: unknown): void; reject(problem: unknown): void };
const instances = new Set<Hooks>();
class Hooks {
  slots: any[] = []; index = 0; effects: (() => void)[] = [];
  storage = new Map<string, string>(); failRead = false; failWrite = false; failGetter = false;
  calls: Call[] = []; listeners = new Map<string, Set<Function>>(); frames = new Map<number, FrameRequestCallback>(); nextFrame = 0;
  state(initial: any) { const index = this.index++; if (!(index in this.slots)) this.slots[index] = typeof initial === 'function' ? initial() : initial; return [this.slots[index], (value: any) => { this.slots[index] = typeof value === 'function' ? value(this.slots[index]) : value; }]; }
  ref(initial: any) { return this.slots[this.index++] ??= { current: initial }; }
  effect(fn: () => (() => void) | void, deps: unknown[]) { const index = this.index++, old = this.slots[index]; if (!old || deps.some((value, n) => !Object.is(value, old.deps[n]))) this.effects.push(() => { old?.cleanup?.(); this.slots[index] = { deps, cleanup: fn() }; }); }
  request(path: string, input?: WeekNoteCommand) { assert(path.startsWith('profile/week/note'), 'Only note metadata routes are allowed'); return new Promise((resolve, reject) => this.calls.push({ path, input, resolve, reject })); }
  read(name: string) { if (this.failRead) throw Error('Synthetic storage read refused'); return this.storage.get(name) ?? null; }
  write(name: string, value: string) { if (this.failWrite) throw Error('Synthetic storage write refused'); this.storage.set(name, value); }
  render<T>(fn: () => T): T { instances.add(this); (globalThis as any)[key] = this; this.index = 0; this.effects = []; const result = fn(); for (const effect of this.effects) effect(); return result; }
  dispose() { for (const slot of this.slots) slot?.cleanup?.(); instances.delete(this); }
  flushFocus() { const frames = [...this.frames.values()]; this.frames.clear(); for (const frame of frames) frame(0); }
}
const owner = () => (globalThis as any)[key] as Hooks;
const originals = new Map(['localStorage', 'window', 'requestAnimationFrame', 'cancelAnimationFrame'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() {
  if (owner().failGetter) throw Error('Synthetic browser storage denied');
  return { get length() { return owner().storage.size; }, key: (index: number) => [...owner().storage.keys()][index] ?? null,
    getItem: (name: string) => owner().read(name), setItem: (name: string, value: string) => owner().write(name, value) };
} });
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  addEventListener: (name: string, fn: Function) => { if (!owner().listeners.has(name)) owner().listeners.set(name, new Set()); owner().listeners.get(name)!.add(fn); },
  removeEventListener: (name: string, fn: Function) => owner().listeners.get(name)?.delete(fn),
} });
Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (fn: FrameRequestCallback) => { const id = ++owner().nextFrame; owner().frames.set(id, fn); return id; } });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => owner().frames.delete(id) });
test.afterEach(() => { for (const instance of [...instances]) { (globalThis as any)[key] = instance; instance.dispose(); } });
test.after(() => { loader.deregister(); delete (globalThis as any)[key]; for (const [name, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; });
const nodes = (node: any): any[] => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
const text = (node: any): string => typeof node === 'string' || typeof node === 'number' ? String(node) : !node || typeof node !== 'object' ? '' : [node.props?.children].flat(Infinity).map(text).join('');
function button(tree: any, name: string) { const node = nodes(tree).find(row => row.type === 'button' && (row.props['aria-label'] === name || text(row) === name)); assert(node, name); return node; }
const textarea = (tree: any) => { const node = nodes(tree).find(row => row.type === 'textarea'); assert(node); return node; };
const settle = async () => { for (let n = 0; n < 15; n++) await Promise.resolve(); };
function fixture(saved = false) {
  const hooks = new Hooks(), epoch = randomUUID(), deviceId = randomUUID(), identity = { start: '2026-10-19', timezone: 'UTC' };
  const note: WeekNote = { format: 1, identity, revision: 1, text: 'Original saved writing', trashed: false, updatedAt: '2026-10-20T09:00:00Z' };
  const state: WeekNoteState = { epoch, identity, note: saved ? note : null };
  let closed = 0, savedCount = 0;
  const props = { state, deviceId, windowId: 'current-window', close: () => { closed++; }, saved: () => { savedCount++; } };
  const render = () => hooks.render(() => WeekNoteEditor(props));
  const receipt = (command: WeekNoteCommand, oldText = note.text) => ({ requestId: command.requestId, epoch, action: command.action,
    note: { ...note, revision: command.expectedRevision + 1, text: command.action === 'save' ? command.text : oldText, trashed: command.action === 'trash' } });
  return { hooks, epoch, deviceId, identity, state, note, props, render, receipt, closed: () => closed, saved: () => savedCount };
}
test('actual typing survives failed retention and blocks both dialog close and navigation', () => {
  const f = fixture(); let tree = f.render(); f.hooks.failWrite = true;
  textarea(tree).props.onChange({ target: { value: 'Keep the exact unfinished paragraph\nNext line' } }); tree = f.render();
  assert.equal(textarea(tree).props.value, 'Keep the exact unfinished paragraph\nNext line');
  tree.props.close(); button(tree, 'Keep & Close').props.onClick(); assert.equal(f.closed(), 0); assert.equal(mayLeaveRecordDrafts(), false);
  let prevented = 0; for (const leave of f.hooks.listeners.get('beforeunload') ?? []) leave({ preventDefault() { prevented++; }, returnValue: '' });
  assert.equal(prevented, 1); assert.equal(f.hooks.calls.length, 0);
  f.hooks.failWrite = false; button(f.render(), 'Keep & Close').props.onClick(); assert.equal(f.closed(), 1);
  assert.equal(JSON.parse([...f.hooks.storage.values()][0]).text, 'Keep the exact unfinished paragraph\nNext line');
});
test('actual original save acknowledges a known receipt without a second POST after failed storage', async () => {
  const f = fixture(); textarea(f.render()).props.onChange({ target: { value: 'One original note' } });
  const callback = button(f.render(), 'Save Note').props.onClick; callback(); callback(); assert.equal(f.hooks.calls.length, 1);
  const command = f.hooks.calls[0].input!; f.hooks.failWrite = true; f.hooks.calls[0].resolve(f.receipt(command)); await settle();
  let tree = f.render(); assert.equal(f.saved(), 0); assert(button(tree, 'Retry Keeping Confirmed Result')); assert.equal(textarea(tree).props.readOnly, true);
  assert.match(text(tree), /host confirmed the original request/); assert(!text(tree).includes('awaiting confirmation'));
  f.hooks.failWrite = false; button(tree, 'Retry Keeping Confirmed Result').props.onClick(); await settle(); tree = f.render();
  assert.equal(f.hooks.calls.length, 1); assert.equal(f.saved(), 1); assert.match(text(tree), /Your note is saved/); assert.equal(button(tree, 'Save Note').props.disabled, true);
});
test('known stale save reviews plain saved writing before an explicit local choice', async () => {
  const f = fixture(true); textarea(f.render()).props.onChange({ target: { value: 'My local version' } });
  button(f.render(), 'Save Note').props.onClick(); f.hooks.calls[0].reject(Object.assign(Error('A newer note is saved'), { code: 'week_note_changed' })); await settle();
  let tree = f.render(); assert.equal(textarea(tree).props.value, 'My local version'); button(tree, 'Review Saved Version').props.onClick();
  const newer = { ...f.state, note: { ...f.note, text: 'Other window’s plain saved text', revision: 2 } }; f.hooks.calls[1].resolve(newer); await settle(); tree = f.render();
  assert.match(text(tree), /Other window’s plain saved text/); assert(!text(tree).includes('"expectedRevision"')); assert(!text(tree).includes('"requestId"'));
  button(tree, 'Keep My Writing').props.onClick(); tree = f.render(); assert.equal(textarea(tree).props.value, 'My local version'); assert.equal(f.hooks.calls.filter(call => call.input).length, 1);
  button(tree, 'Save Note').props.onClick(); const next = f.hooks.calls[2].input!; assert.equal(next.expectedRevision, 2); assert.notEqual(next.requestId, f.hooks.calls[0].input!.requestId);
});
test('Use Saved Writing is an explicit local replacement; unresolved requests cannot be rebased', async () => {
  const f = fixture(true); textarea(f.render()).props.onChange({ target: { value: 'Unsaved choice' } });
  button(f.render(), 'Review Saved Version').props.onClick(); f.hooks.calls[0].resolve({ ...f.state, note: { ...f.note, revision: 2, text: 'Reviewed saved choice' } }); await settle();
  button(f.render(), 'Use Saved Writing').props.onClick(); let tree = f.render(); assert.equal(textarea(tree).props.value, 'Reviewed saved choice'); assert.equal(f.hooks.calls.filter(call => call.input).length, 0);
  textarea(tree).props.onChange({ target: { value: 'Original uncertain text' } }); button(f.render(), 'Save Note').props.onClick();
  const original = f.hooks.calls[1].input!; f.hooks.calls[1].reject(Object.assign(Error('Recovery held'), { code: 'recovery_required', status: 409 })); await settle();
  button(f.render(), 'Review Saved Version').props.onClick(); f.hooks.calls[2].resolve({ ...f.state, note: { ...f.note, revision: 3, text: 'Another confirmed note' } }); await settle();
  tree = f.render(); assert(!nodes(tree).some(row => row.type === 'button' && text(row) === 'Keep My Writing'));
  button(tree, 'Check Original Save').props.onClick(); assert.deepEqual(f.hooks.calls[3].input, original);
});
test('a captured old review choice cannot replace writing while a newer read is in flight', async () => {
  const f = fixture(true); textarea(f.render()).props.onChange({ target: { value: 'Keep current writing' } });
  button(f.render(), 'Review Saved Version').props.onClick();
  f.hooks.calls[0].resolve({ ...f.state, note: { ...f.note, revision: 2, text: 'Earlier reviewed text' } }); await settle();
  let tree = f.render(); const staleChoice = button(tree, 'Use Saved Writing').props.onClick;
  button(tree, 'Review Saved Version').props.onClick(); staleChoice(); tree = f.render();
  assert.equal(textarea(tree).props.value, 'Keep current writing'); assert(!nodes(tree).some(row => row.type === 'button' && text(row) === 'Use Saved Writing'));
  f.hooks.calls[1].resolve({ ...f.state, note: { ...f.note, revision: 3, text: 'Newest reviewed text' } }); await settle();
  staleChoice(); tree = f.render(); assert.equal(textarea(tree).props.value, 'Keep current writing');
  button(tree, 'Use Saved Writing').props.onClick(); assert.equal(textarea(f.render()).props.value, 'Newest reviewed text');
  assert.equal(f.hooks.calls.filter(call => call.input).length, 0);
});
test('Trash has a separate explicit confirmation and Restore preserves the saved text', async () => {
  const f = fixture(true); let tree = f.render(); button(tree, 'Trash Note').props.onClick(); assert.equal(f.hooks.calls.length, 0);
  button(f.render(), 'Keep Note').props.onClick(); assert.equal(f.hooks.calls.length, 0); button(f.render(), 'Trash Note').props.onClick();
  button(f.render(), 'Move Note To Trash').props.onClick(); const trash = f.hooks.calls[0].input!; assert.equal(trash.action, 'trash'); assert(!('text' in trash));
  f.hooks.calls[0].resolve(f.receipt(trash)); await settle(); tree = f.render(); assert.equal(textarea(tree).props.value, f.note.text); assert.equal(textarea(tree).props.readOnly, true);
  button(tree, 'Restore Note').props.onClick(); const restore = f.hooks.calls[1].input!; assert.equal(restore.action, 'restore'); assert.equal(restore.expectedRevision, 2);
  f.hooks.calls[1].resolve(f.receipt(restore)); await settle(); tree = f.render(); assert.equal(textarea(tree).props.value, f.note.text); assert.equal(textarea(tree).props.readOnly, false);
  textarea(tree).props.onChange({ target: { value: 'Unfinished edit' } }); assert.equal(button(f.render(), 'Trash Note').props.disabled, true);
});
test('late review and original save responses cannot acknowledge a retired or replaced owner', async () => {
  const f = fixture(true); textarea(f.render()).props.onChange({ target: { value: 'Keep original pending' } }); button(f.render(), 'Save Note').props.onClick();
  const command = f.hooks.calls[0].input!, raw = [...f.hooks.storage.values()][0]; f.hooks.dispose();
  f.hooks.calls[0].resolve(f.receipt(command)); await settle(); assert.equal([...f.hooks.storage.values()][0], raw); assert.equal(f.saved(), 0);
  const g = fixture(true); button(g.render(), 'Review Saved Version').props.onClick(); g.props.state = { ...g.state, epoch: randomUUID() }; g.render();
  g.hooks.calls[0].resolve({ ...g.state, note: { ...g.note, revision: 2, text: 'Old owner response' } }); await settle();
  assert(!text(g.render()).includes('Old owner response')); assert.equal(g.hooks.calls.length, 1);
});
test('denied browser storage getter is readable and leaves the editor read-only without a command', () => {
  const f = fixture(true); f.hooks.failGetter = true; const tree = f.render();
  assert.match(text(tree), /Synthetic browser storage denied/); assert.equal(textarea(tree).props.readOnly, true);
  assert.equal(button(tree, 'Save Note').props.disabled, true); tree.props.close(); assert.equal(f.closed(), 1); assert.equal(f.hooks.calls.length, 0);
});
test('recovery callback copies exact pending writing, never posts, and refuses occupied destination', () => {
  const f = fixture(true), original = { format: 1, epoch: f.epoch, identity: f.identity, base: f.note, text: 'Original pending writing', dirty: true,
    pending: { requestId: randomUUID(), epoch: f.epoch, identity: f.identity, action: 'save', expectedRevision: 1, text: 'Original pending writing' } };
  const source = weekNoteDraftKey(f.deviceId, 'earlier-window', f.identity), target = weekNoteDraftKey(f.deviceId, 'current-window', f.identity), raw = JSON.stringify(original);
  f.hooks.storage.set(source, raw); let opened: unknown[] = [];
  const props = { epoch: f.epoch, deviceId: f.deviceId, windowId: 'current-window', close() {}, open: (identity: unknown) => opened.push(identity) };
  const render = () => f.hooks.render(() => WeekNoteRecovery(props)); render(); let tree = render();
  f.hooks.storage.set(target, '{"keep":"occupied"}'); button(tree, 'Copy Original & Open').props.onClick(); tree = render(); assert.match(text(tree), /already has writing/); assert.deepEqual(opened, []);
  f.hooks.storage.delete(target); button(tree, 'Copy Original & Open').props.onClick(); assert.equal(f.hooks.storage.get(source), raw); assert.equal(f.hooks.storage.get(target), raw); assert.deepEqual(opened, [f.identity]); assert.equal(f.hooks.calls.length, 0);
  const oldCallback = button(tree, 'Copy Original & Open').props.onClick; f.hooks.dispose(); oldCallback(); assert.equal(opened.length, 1);
});
test('recovery refresh keeps earlier rows on storage failure and original unknown/foreign writing stays unavailable', () => {
  const f = fixture(true), source = weekNoteDraftKey(f.deviceId, 'earlier-window', f.identity);
  const raw = JSON.stringify({ format: 1, epoch: randomUUID(), identity: f.identity, base: f.note, text: 'Earlier workspace writing', dirty: true });
  f.hooks.storage.set(source, raw); const render = () => f.hooks.render(() => WeekNoteRecovery({ epoch: f.epoch, deviceId: f.deviceId, windowId: 'current-window', close() {}, open() { throw Error('Must not open foreign work'); } }));
  render(); let tree = render(); assert.match(text(tree), /Earlier workspace writing/); assert.match(text(tree), /earlier workspace/);
  assert(!nodes(tree).some(row => row.type === 'button' && text(row) === 'Copy Original & Open'));
  f.hooks.failRead = true; button(tree, 'Refresh Kept Writing').props.onClick(); tree = render();
  assert.match(text(tree), /Earlier workspace writing/); assert.match(text(tree), /Synthetic storage read refused/); assert.equal(f.hooks.storage.get(source), raw);
});
test('saved notes page beyond fifty retains exact timezone identity and retired callbacks cannot open', async () => {
  const f = fixture(), opened: unknown[] = [], rows = Array.from({ length: 53 }, (_, n) => ({
    identity: { start: shiftProfileDay(f.identity.start, -7 * n), timezone: n % 2 ? 'Asia/Tokyo' : 'UTC' }, revision: 1,
    trashed: n === 51, updatedAt: f.note.updatedAt,
  }));
  const render = () => f.hooks.render(() => WeekNotesList({ epoch: f.epoch, close() {}, open: identity => opened.push(identity) }));
  render(); const version = 'a'.repeat(64);
  f.hooks.calls[0].resolve({ epoch: f.epoch, version, rows: rows.slice(0, 50), next: weekNoteIdentityKey(rows[49].identity), total: 53 }); await settle();
  button(render(), 'Load Earlier Notes').props.onClick(); assert(f.hooks.calls[1].path.includes('version=' + version)); assert(!f.hooks.calls[1].input);
  f.hooks.calls[1].resolve({ epoch: f.epoch, version, rows: rows.slice(50), next: null, total: 53 }); await settle();
  const tree = render(), links = nodes(tree).filter(row => row.type === 'button' && row.props.className === 'text-button'); assert.equal(links.length, 53);
  links[51].props.onClick(); assert.deepEqual(opened, [rows[51].identity]); assert.match(text(tree), /53 of 53 notes/);
  f.hooks.dispose(); links[52].props.onClick(); assert.equal(opened.length, 1);
});
test('current note open rejects wrong identity and closing returns focus to the visible week action', async () => {
  const f = fixture(), props = { epoch: f.epoch, deviceId: f.deviceId, identity: f.identity, active: true };
  const render = () => f.hooks.render(() => ProfileWeekNotes(props)); let tree = render();
  f.hooks.calls[0].resolve(f.state); await settle(); button(render(), 'Write My Note').props.onClick();
  const wrong = { ...f.state, identity: { start: '2026-10-12', timezone: 'UTC' } }; f.hooks.calls[1].resolve(wrong); await settle(); tree = render();
  assert(!nodes(tree).some(row => row.type === WeekNoteEditor)); assert.match(text(tree), /another workspace or week/);
  let focused = 0; button(tree, 'Write My Note').props.ref.current = { focus() { focused++; } };
  button(tree, 'Back To Your Week').props.onClick(); render(); f.hooks.flushFocus(); assert.equal(focused, 1); assert.equal(f.hooks.calls.filter(call => call.input).length, 0);
});
test('pending selection read is retired when Your Week becomes inactive', async () => {
  const f = fixture(), props = { epoch: f.epoch, deviceId: f.deviceId, identity: f.identity, active: true };
  const render = () => f.hooks.render(() => ProfileWeekNotes(props)); render(); f.hooks.calls[0].resolve(f.state); await settle();
  button(render(), 'Write My Note').props.onClick(); props.active = false; render(); f.hooks.calls[1].resolve(f.state); await settle();
  assert(!nodes(render()).some(row => row.type === WeekNoteEditor)); assert.equal(f.hooks.calls.filter(call => call.input).length, 0);
});


test('closing a reviewed note refreshes the current week preview without a command', async () => {
  const f = fixture(true), props = { epoch: f.epoch, deviceId: f.deviceId, identity: f.identity, active: true };
  const render = () => f.hooks.render(() => ProfileWeekNotes(props)); render();
  f.hooks.calls[0].resolve(f.state); await settle();
  button(render(), 'Edit My Note').props.onClick();
  const newer = { ...f.state, note: { ...f.note, revision: 5, text: 'Newer saved reflection from another window' } };
  f.hooks.calls[1].resolve(newer); await settle();
  const editor = nodes(render()).find(row => row.type === WeekNoteEditor); assert(editor);
  editor.props.close(); assert.equal(f.hooks.calls.length, 3);
  f.hooks.calls[2].resolve(newer); await settle();
  assert.match(text(render()), /Newer saved reflection from another window/);
  assert(!text(render()).includes('Original saved writing'));
  assert.equal(f.hooks.calls.filter(call => call.input).length, 0);
});
