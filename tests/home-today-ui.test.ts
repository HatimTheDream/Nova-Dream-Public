import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { defaultLayout, emptyDraft, type Entity, type Snapshot, type Task } from '../packages/domain/contracts';
import { mayLeaveHomeDraft, registerHomeDraftNavigation } from '../apps/client/src/home-draft-navigation';
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const symbol = Symbol.for('nova.test.home-today');
registerHooks({
 resolve(specifier, context, next) {
  if (/\/Home(Today)?\./.test(context.parentURL ?? '')) {
   if (specifier === 'react') return { url: 'home-today-test:react', shortCircuit: true };
   if (['./api', './usePlanningClock', './useWorkspace'].includes(specifier)) return { url: 'home-today-test:' + specifier.slice(2), shortCircuit: true };
   if (/\/Home\./.test(context.parentURL ?? '') && specifier === './HomeLibrary') return { url: 'home-today-test:library', shortCircuit: true };
  }
  return next(specifier, context);
 },
 load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
  if (url === 'home-today-test:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};const f=()=>globalThis[Symbol.for('nova.test.home-today')];export const useState=v=>f().state(v),useRef=v=>f().ref(v),useEffect=(fn,deps)=>f().effect(fn,deps);` };
  if (url === 'home-today-test:api') return { format: 'module', shortCircuit: true, source: 'export const readLocal=key=>{try{return JSON.parse(localStorage.getItem(key));}catch{return null;}};export const saveLocal=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{return false;}};' };
  if (url === 'home-today-test:library') return { format: 'module', shortCircuit: true, source: `export const HomeLibrary=()=>null;export const useHomeLibrary=()=>({});` };
  if (url === 'home-today-test:usePlanningClock') return { format: 'module', shortCircuit: true, source: `export const usePlanningClock=()=>globalThis[Symbol.for('nova.test.home-today')].now;` };
  if (url === 'home-today-test:useWorkspace') return { format: 'module', shortCircuit: true, source: `export const retainedWindowId='this-window';` };
  return next(url, context);
 },
});
const { HomeToday } = await import('../apps/client/src/HomeToday');
const { Home } = await import('../apps/client/src/Home');
class Fixture {
 slots: any[] = []; index = 0; effects: (() => void)[] = []; rows = new Map<string, string>(); writes: string[] = [];
 now = Date.parse('2026-10-19T23:00:00Z'); failed = false; failedRead = ''; failReadback = ''; readbackPending = ''; listeners = new Map<string, (event: any) => void>();
 state(value: any) { const i = this.index++;if (!(i in this.slots)) this.slots[i] = typeof value === 'function' ? value() : value;return [this.slots[i], (v: any) => { this.slots[i] = typeof v === 'function' ? v(this.slots[i]) : v; }]; }
 ref(value: any) { const i = this.index++;return this.slots[i] ??= { current: value }; }
 effect(fn: () => (() => void) | void, deps: unknown[]) { const i = this.index++, prior = this.slots[i];if (!prior || deps.some((v, n) => v !== prior.deps[n])) this.effects.push(() => { prior?.cleanup?.();this.slots[i] = { deps, cleanup: fn() }; }); }
 render<T>(fn: () => T) {
  (globalThis as any)[symbol] = this;this.index = 0;this.effects = [];
  const f = this;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => { if (key === f.failedRead) throw Error('This retained key is unreadable');if (key === f.readbackPending) { f.readbackPending = '';throw Error('Verification read failed'); }return f.rows.get(key) ?? null; }, setItem: (key: string, value: string) => { if (f.failed) throw Error('Browser storage is full');f.writes.push(key);f.rows.set(key, value);if (key === f.failReadback) { f.failReadback = '';f.readbackPending = key; } } } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: (name: string, callback: (event: any) => void) => f.listeners.set(name, callback), removeEventListener: (name: string) => f.listeners.delete(name) } });
  const result = fn();for (const effect of this.effects) effect();return result;
 }
 close() { for (const slot of this.slots) slot?.cleanup?.(); }
}
function nodes(value: any): any[] { if (!value || typeof value !== 'object') return [];return [value, ...[value.props?.children].flat(Infinity).flatMap(nodes)]; }
function text(value: any): string { if (value === null || value === undefined || typeof value === 'boolean') return '';if (Array.isArray(value)) return value.map(text).join('');return typeof value === 'object' ? text(value.props?.children) : String(value); }
const button = (tree: any, label: string) => nodes(tree).find(row => row.type === 'button' && text(row.props.children) === label);
function setup() {
 const f = new Fixture(), epoch = crypto.randomUUID(), deviceId = 'fixture', changed: any[] = [], opened: Entity<Task>[] = [];
 const snapshot: Snapshot = { epoch, deviceId, cursor: 0, layout: { id: 'layout', revision: 1, deviceId, updatedAt: '', value: { ...structuredClone(defaultLayout), timezone: 'America/Los_Angeles' } }, tasks: [], drafts: [], projects: [], capabilities: { assistant: false, voice: false, reason: '' } };
 let proceed: (value: boolean) => void = () => {};
 const actions = { busy: false, state: { queue: [], undo: [], label: '', error: '', notice: '' }, run: async (changes: any, _label: string) => { changed.push(changes);return new Promise<boolean>(resolve => { proceed = resolve; }); }, retry: async () => false, undo: async () => false, dismiss() {} };
 const calls: string[] = [], props = { snapshot, actions, editTask: (task: Entity<Task>) => { opened.push(task); }, openTasks: () => { calls.push('tasks'); }, openLibrary: () => { calls.push('library'); }, openIdeas: () => { calls.push('ideas'); } };
 const render = () => f.render(() => HomeToday(props));
 return { f, props, render, changed, opened, calls, resolve: (value: boolean) => proceed(value), quickKey: `e3:quick-task:${epoch}:${deviceId}` };
}
const capture = (tree: any) => nodes(tree).find(row => row.type === 'input' && row.props.id === 'home-quick-title');
const form = (tree: any) => nodes(tree).find(row => row.type === 'form');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Home opens read-only; failed capture retention blocks all departures and keeps exact text until explicit retry succeeds', () => {
 const { f, render, calls, quickKey } = setup();
 try {
  let tree = render();assert.equal(f.writes.length, 0);button(tree, 'Add').props.onClick();tree = render();
  f.failed = true;capture(tree).props.onChange({ target: { value: 'Keep this unsaved writing 雪' } });tree = render();
  assert.equal(mayLeaveHomeDraft(), false);nodes(tree).find(row => row.type === 'button' && text(row).startsWith('TasksAll')).props.onClick();assert.deepEqual(calls, []);
  const event = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };f.listeners.get('beforeunload')!(event);assert.equal(event.prevented, true);
  assert.equal(capture(tree).props.value, 'Keep this unsaved writing 雪');assert.equal(f.rows.has(quickKey), false);
  f.failed = false;button(tree, 'Retry Keeping Writing').props.onClick();tree = render();
  assert.equal(JSON.parse(f.rows.get(quickKey)!).title, 'Keep this unsaved writing 雪');assert.equal(mayLeaveHomeDraft(), true);
  nodes(tree).find(row => row.type === 'button' && text(row).startsWith('TasksAll')).props.onClick();assert.deepEqual(calls, ['tasks']);
 } finally { f.close(); }
 assert.equal(mayLeaveHomeDraft(), true);
});

test('quick capture adopts richer original editor and preserves newer capture writing after its exact save confirms', async () => {
 const { f, props, render, changed, opened, quickKey, resolve } = setup();
 const quick = { id: 'task:' + crypto.randomUUID(), title: 'Original capture' };f.rows.set(quickKey, JSON.stringify(quick));
 try {
  let tree = render();button(tree, 'Add').props.onClick();tree = render();
  const editorKey = `e3:task-editor:${props.snapshot.deviceId}:${quick.id}`;
  const pending = { requestId: crypto.randomUUID(), epoch: props.snapshot.epoch, kind: 'task', entityId: quick.id, expectedRevision: 0, payload: { title: quick.title, notes: 'Original pending writing', status: 'open', planned: '', due: '' } };
  const editor = JSON.stringify({ epoch: props.snapshot.epoch, revision: 0, pending, value: { title: '', notes: 'Richer writing', status: 'open', planned: 'unfinished date', due: '' } });f.rows.set(editorKey, editor);
  form(tree).props.onSubmit({ preventDefault() {} });assert.equal(opened[0].id, quick.id);assert.equal(changed.length, 0);assert.equal(f.rows.get(editorKey), editor);
  f.rows.delete(editorKey);tree = render();form(tree).props.onSubmit({ preventDefault() {} });assert.equal(changed.length, 1);assert.equal(changed[0][0].task.id, quick.id);
  const newer = { ...quick, title: 'Newer capture in another view' };f.rows.set(quickKey, JSON.stringify(newer));resolve(true);await tick();tree = render();
  assert.deepEqual(JSON.parse(f.rows.get(quickKey)!), newer);assert.match(text(tree), /Newer capture writing remains kept/);
 } finally { f.close(); }
});

test('current Plan Today applies exact revisions through the supplied queue and refuses a stale snapshot before dispatch', async context => {
 const { f, props, render, changed, resolve } = setup();context.mock.method(Date, 'now', () => f.now);
 const task: Entity<Task> = { id: 'task:' + crypto.randomUUID(), revision: 4, deviceId: 'fixture', updatedAt: '', value: { title: 'Future task', notes: 'Keep', status: 'open', planned: '2026-10-25', due: '2026-10-24', timezone: 'Asia/Tokyo' } };
 props.snapshot.tasks = [task];
 try {
  let tree = render();button(tree, 'Plan Today').props.onClick();tree = render();
  nodes(tree).find(row => row.type === 'input' && row.props.type === 'checkbox').props.onChange({ target: { checked: true } });tree = render();
  props.snapshot = { ...props.snapshot, tasks: [{ ...task, revision: 5 }] };tree = render();button(tree, 'Apply Planning Dates').props.onClick();await tick();tree = render();
  assert.equal(changed.length, 0);assert.match(text(tree), /task changed/);
  button(tree, 'Start Fresh Review').props.onClick();tree = render();nodes(tree).find(row => row.type === 'input' && row.props.type === 'checkbox').props.onChange({ target: { checked: true } });tree = render();
  button(tree, 'Apply Planning Dates').props.onClick();assert.equal(changed.length, 1);assert.equal(changed[0][0].task.revision, 5);
  assert.deepEqual(changed[0][0].value, { ...task.value, planned: '2026-10-19' });resolve(true);await tick();tree = render();
  assert.match(text(tree), /Planning dates updated/);
 } finally { f.close(); }
});

test('old scope callbacks cannot dispatch or replace new writing; failed old-scope text stays recoverable under its original key', () => {
 const { f, props, render, changed, quickKey } = setup();
 try {
  let tree = render();button(tree, 'Add').props.onClick();tree = render();const staleChange = capture(tree).props.onChange;
  f.failed = true;staleChange({ target: { value: 'Previous workspace text' } });tree = render();
  props.snapshot = { ...props.snapshot, epoch: crypto.randomUUID() };render();tree = render();
  staleChange({ target: { value: 'Late old callback' } });assert.equal(changed.length, 0);
  assert.match(text(tree), /Previous workspace text/);assert.doesNotMatch(text(tree), /Late old callback/);
  f.failed = false;button(tree, 'Retry Keeping Writing').props.onClick();assert.equal(JSON.parse(f.rows.get(quickKey)!).title, 'Previous workspace text');
  assert.equal(f.rows.has(`e3:quick-task:${props.snapshot.epoch}:${props.snapshot.deviceId}`), false);
  f.close();const before = f.writes.length;staleChange({ target: { value: 'After unmount' } });assert.equal(f.writes.length, before);
 } finally { f.close(); }
});

test('each Home owner keeps its own guard and stale cleanup cannot remove another owner', () => {
 let first = false, second = false;const a = registerHomeDraftNavigation(() => first), b = registerHomeDraftNavigation(() => second);
 try { assert.equal(mayLeaveHomeDraft(), false);first = true;a();a();assert.equal(mayLeaveHomeDraft(), false);second = true;assert.equal(mayLeaveHomeDraft(), true); } finally { a();b(); }
});

test('Home keeps Library mounted, writes tab selection before changing it and refuses unkept/stale tab or continuation callbacks', () => {
 const { f, props } = setup(), opened: string[] = [];
 const homeProps: Parameters<typeof Home>[0] = { snapshot: props.snapshot, layout: props.snapshot.layout.value, saveLayout() {}, open: route => { opened.push(route); }, openSettings() {}, newTask() {}, editTask() {}, complete() {}, draft: structuredClone(emptyDraft), dirty: false, draftStatus: '' };
 const render = () => f.render(() => Home(homeProps)), tab = (tree: any, name: string) => nodes(tree).find(row => row.props?.id === `home-tab-${name}`);
 let kept = false;const unregister = registerHomeDraftNavigation(() => kept);
 try {
  let tree = render();const originalLibrary = nodes(tree).find(row => row.props?.id === 'home-panel-library').props.children;
  tab(tree, 'today').props.onClick();tree = render();assert.equal(tab(tree, 'library').props['aria-selected'], true);assert.equal(f.writes.length, 0);
  kept = true;f.failed = true;tab(tree, 'today').props.onClick();tree = render();assert.equal(tab(tree, 'library').props['aria-selected'], true);
  f.failed = false;tab(tree, 'today').props.onClick();tree = render();assert.equal(tab(tree, 'today').props['aria-selected'], true);
  assert.equal(f.rows.get(`e3:home-view:${props.snapshot.deviceId}`), '"today"');
  const hiddenLibrary = nodes(tree).find(row => row.props?.id === 'home-panel-library');assert.equal(hiddenLibrary.props.hidden, true);assert.equal(hiddenLibrary.props.children.type, originalLibrary.type);
  const oldTab = tab(tree, 'ideas').props.onClick, oldToday = nodes(tree).find(row => row.type === HomeToday).props.openTasks;
  homeProps.snapshot = { ...homeProps.snapshot, epoch: crypto.randomUUID() };render();tree = render();const before = f.writes.length;
  oldTab();oldToday();assert.equal(f.writes.length, before);assert.deepEqual(opened, []);
 } finally { unregister();f.close(); }
});

test('Search derives Library without changing the Home preference and clears its target only after a guarded successful tab write', () => {
 const { f, props } = setup(), key = `e3:home-view:${props.snapshot.deviceId}`;
 f.rows.set(key, '"today"');
 const target: NonNullable<Parameters<typeof Home>[0]['libraryTarget']> = { epoch: props.snapshot.epoch, deviceId: props.snapshot.deviceId, windowId: 'this-window', nonce: 'original-search-target', target: { kind: 'collection', id: 'collection:kept', revision: 2 } };
 let cleared = 0, kept = false;
 const homeProps: Parameters<typeof Home>[0] = { snapshot: props.snapshot, layout: props.snapshot.layout.value, saveLayout() {}, open() {}, openSettings() {}, newTask() {}, editTask() {}, complete() {}, draft: structuredClone(emptyDraft), dirty: false, draftStatus: '', libraryTarget: target,
  clearLibraryTarget() { assert.equal(f.rows.get(key), '"today"');cleared++;homeProps.libraryTarget = undefined; } };
 const render = () => f.render(() => Home(homeProps)), tab = (tree: any, name: string) => nodes(tree).find(row => row.props?.id === `home-tab-${name}`);
 const unregister = registerHomeDraftNavigation(() => kept);
 try {
  let tree = render();assert.equal(tab(tree, 'library').props['aria-selected'], true);assert.equal(f.writes.length, 0);
  const library = nodes(tree).find(row => row.props?.id === 'home-panel-library').props.children;
  assert.equal(library.props.libraryTarget, target);assert.equal(f.rows.get(key), '"today"');
  tab(tree, 'today').props.onClick();tree = render();assert.equal(cleared, 0);assert.equal(f.writes.length, 0);
  kept = true;f.failed = true;tab(tree, 'today').props.onClick();tree = render();assert.equal(cleared, 0);assert.equal(tab(tree, 'library').props['aria-selected'], true);
  f.failed = false;
  // The displayed Library tab, rather than the saved Today preference, owns the keyboard index.
  nodes(tree).find(row => row.props?.role === 'tablist').props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} });
  tree = render();assert.equal(cleared, 1);assert.equal(tab(tree, 'today').props['aria-selected'], true);assert.equal(f.writes.length, 1);
  assert.equal(nodes(tree).find(row => row.props?.id === 'home-panel-library').props.children.type, library.type);
  homeProps.libraryTarget = { ...target, nonce: 'restored-search-view', restore: { query: 'kept', mode: 'compact', filter: 'all', collectionId: null, selection: null } };
  tree = render();assert.equal(tab(tree, 'today').props['aria-selected'], true);assert.equal(f.writes.length, 1);
 } finally { unregister();f.close(); }
});

test('legacy explicit null capture opens a fresh stable draft without touching storage on read', () => {
 const { f, render, quickKey } = setup();f.rows.set(quickKey, 'null');
 try { let tree = render();button(tree, 'Add').props.onClick();tree = render();assert.equal(capture(tree).props.disabled, false);assert.equal(capture(tree).props.value, '');assert.equal(f.writes.length, 0); }
 finally { f.close(); }
});

test('selectively unreadable or malformed retained owners refuse quick commands and preserve the original capture bytes', () => {
 for (const kind of ['unreadable-editor', 'unreadable-routine', 'malformed-editor', 'malformed-routine'] as const) {
  const { f, props, render, changed, opened, quickKey } = setup();
  const quick = { id: 'task:' + crypto.randomUUID(), title: 'Keep my original capture' }, original = JSON.stringify(quick);
  f.rows.set(quickKey, original);
  const key = kind.endsWith('editor') ? `e3:task-editor:${props.snapshot.deviceId}:${quick.id}` : `e3:new-routine:${props.snapshot.deviceId}`;
  const retained = kind.endsWith('editor') ? '{broken original editor' : JSON.stringify({ quickSource: quick, id: 'routine:kept', value: { title: 'Incomplete original', cadence: [] } });
  f.rows.set(key, retained);if (kind.startsWith('unreadable')) f.failedRead = key;
  try {
   let tree = render();button(tree, 'Add').props.onClick();tree = render();form(tree).props.onSubmit({ preventDefault() {} });tree = render();
   assert.equal(changed.length, 0, kind);assert.equal(opened.length, 0, kind);assert.equal(f.rows.get(key), retained);assert.equal(f.rows.get(quickKey), original);
   assert.match(text(tree), /preserved/);assert.equal(f.writes.length, 0);
  } finally { f.close(); }
 }
});

test('valid linked repeating draft keeps its exact source and directs continuation without dispatch', () => {
 const { f, props, render, changed, opened, quickKey } = setup();
 const quick = { id: 'task:' + crypto.randomUUID(), title: 'Repeat this capture' };f.rows.set(quickKey, JSON.stringify(quick));
 const key = `e3:new-routine:${props.snapshot.deviceId}`, retained = JSON.stringify({ id: 'routine:' + crypto.randomUUID(), revision: 0, deviceId: props.snapshot.deviceId, updatedAt: '2026-10-19T23:00:00Z', quickSource: quick, value: { title: '', notes: 'Original routine writing', kind: 'task', state: 'active', startsOn: '2026-10-19', timezone: 'America/Los_Angeles', cadence: 'daily', weekdays: [1, 2, 3, 4, 5], projectId: null, plannedTime: '', priority: 'normal', estimateMinutes: 0 } });
 f.rows.set(key, retained);
 try {
  let tree = render();button(tree, 'Add').props.onClick();tree = render();form(tree).props.onSubmit({ preventDefault() {} });tree = render();
  assert.equal(changed.length, 0);assert.equal(opened.length, 0);assert.equal(f.rows.get(key), retained);assert.match(text(tree), /repeating-task draft already uses this capture/);
 } finally { f.close(); }
});

test('a successful write with failed readback is acknowledged on retry without rewriting, but another version is never overwritten', () => {
 for (const concurrent of [false, true]) {
  const { f, render, quickKey } = setup();
  try {
   let tree = render();button(tree, 'Add').props.onClick();tree = render();f.failReadback = quickKey;
   capture(tree).props.onChange({ target: { value: 'Written but not verified' } });tree = render();
   assert.equal(JSON.parse(f.rows.get(quickKey)!).title, 'Written but not verified');assert.equal(mayLeaveHomeDraft(), false);assert.equal(f.writes.length, 1);
   const exactWritten = f.rows.get(quickKey)!;
   if (concurrent) f.rows.set(quickKey, JSON.stringify({ ...JSON.parse(exactWritten), title: 'Another view’s writing' }));
   button(tree, 'Retry Keeping Writing').props.onClick();tree = render();
   assert.equal(f.writes.length, 1);assert.equal(mayLeaveHomeDraft(), !concurrent);
   assert.equal(capture(tree).props.value, 'Written but not verified');
   assert.equal(JSON.parse(f.rows.get(quickKey)!).title, concurrent ? 'Another view’s writing' : 'Written but not verified');
   assert.match(text(tree), concurrent ? /changed in another view/ : /Writing kept on this device/);
  } finally { f.close(); }
 }
});

test('completion control belongs to its compact hit-area label and preserves the exact task action', () => {
 const { f, props, render, changed } = setup();
 const task: Entity<Task> = { id: 'task:complete-exact', revision: 7, deviceId: 'fixture', updatedAt: '', value: { title: 'Finish this', notes: 'Keep exact notes', status: 'open', planned: '', due: '' } };
 props.snapshot.tasks = [task];
 try {
  const tree = render(), label = nodes(tree).find(row => row.type === 'label' && row.props.className === 'home-today-task-toggle');
  const input = nodes(label).find(row => row.type === 'input');
  assert.equal(input.props['aria-label'], 'Complete Finish this');input.props.onChange();
  assert.equal(changed.length, 1);assert.equal(changed[0][0].task, task);assert.deepEqual(changed[0][0].value, { ...task.value, status: 'done' });
 } finally { f.close(); }
});
