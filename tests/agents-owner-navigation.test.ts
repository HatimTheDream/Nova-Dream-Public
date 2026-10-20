import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { defaultLayout, type Snapshot } from '../packages/domain/contracts';
import { blankRecord } from '../packages/domain/workspace-records';
import { defaultAgentActivityPreferences } from '../packages/domain/agent-activity';
import { mayLeaveAgentDrafts } from '../apps/client/src/agent-workspace-navigation';

const symbol = Symbol.for('nova.test.agents-owner');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const owned = (url: string) => /\/(AgentHub|HubMeetingPanel|Headquarters)\.tsx$/.test(url);
registerHooks({
  resolve(specifier, context, next) {
    if (owned(context.parentURL ?? '')) {
      if (specifier === 'react') return { url: 'agents-test:react', shortCircuit: true };
      if (specifier.endsWith('/api')) return { url: 'agents-test:api', shortCircuit: true };
      if (specifier.endsWith('/useWorkspace')) return { url: 'agents-test:workspace', shortCircuit: true };
      if (specifier.endsWith('/prepared-views')) return { url: 'agents-test:prepared', shortCircuit: true };
      if (specifier.endsWith('/useHubMeetingControls')) return { url: 'agents-test:meeting', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    if (url.endsWith('.png')) return { format: 'module', source: 'export default "fixture-art";', shortCircuit: true };
    if (url === 'agents-test:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};const f=()=>globalThis[Symbol.for('nova.test.agents-owner')];export const useState=v=>f().state(v),useRef=v=>f().ref(v),useEffect=(fn,deps)=>f().effect(fn,deps);` };
    if (url === 'agents-test:workspace') return { format: 'module', shortCircuit: true, source: `export const retainedWindowId='window';` };
    if (url === 'agents-test:prepared') return { format: 'module', shortCircuit: true, source: `export const readPreparedView=()=>globalThis[Symbol.for('nova.test.agents-owner')].hub;` };
    if (url === 'agents-test:meeting') return { format: 'module', shortCircuit: true, source: `export const useHubMeetingControls=()=>({busy:false,error:'',pending:null,command:async()=>{throw Error('Navigation may not dispatch a meeting');}});` };
    if (url === 'agents-test:api') return { format: 'module', shortCircuit: true, source: `export class ApiError extends Error{};export const readLocal=key=>{try{return JSON.parse(localStorage.getItem(key))??undefined;}catch{return undefined;}};export const saveLocal=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{return false;}};export const request=async(path,body)=>{try{return await globalThis[Symbol.for('nova.test.agents-owner')].request(path,body);}catch(reason){if(reason?.code)throw Object.assign(new ApiError(reason.message),reason);throw reason;}};` };
    return next(url, context);
  },
});
const { default: AgentHub, AgentWork } = await import('../apps/client/src/AgentHub');
const { HubMeetingPanel } = await import('../apps/client/src/HubMeetingPanel');
const { Headquarters, PersonalityDialog, headquartersWorkTarget } = await import('../apps/client/src/nova/hub/Headquarters');
const nodes = (value: any): any[] => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)];
const text = (value: any): string => value == null || typeof value === 'boolean' ? '' : Array.isArray(value) ? value.map(text).join('') : typeof value === 'object' ? text(value.props?.children) : String(value);
const button = (tree: any, title: string) => { const result = nodes(tree).find(node => node.type === 'button' && (node.props['aria-label'] === title || text(node) === title)); assert.ok(result, title); return result; };
class Fixture {
  cells: any[] = []; cursor = 0; effects: (() => void)[] = []; dirty = true; tree: any;
  rows = new Map<string, string>(); writes: string[] = []; failedKey = ''; unreadableKey = '';
  calls: { path: string; body: unknown }[] = [];
  hub = { observedAt: 1, runtimeReady: false, runtimeReason: 'Disconnected', agents: [], roster: [], layout: { version: 1 as const, revision: 1, rooms: [], placements: {}, previousPlacements: {} }, total: 0, nextCursor: null, activeAgentId: null };
  globals: [PropertyKey, PropertyDescriptor | undefined][] = [];
  state(value: any) { const i = this.cursor++; if (!this.cells[i]) this.cells[i] = { value: typeof value === 'function' ? value() : value }; return [this.cells[i].value, (next: any) => { const v = typeof next === 'function' ? next(this.cells[i].value) : next; if (!Object.is(v, this.cells[i].value)) { this.cells[i].value = v; this.dirty = true; } }]; }
  ref(value: any) { return this.cells[this.cursor++] ??= { current: value }; }
  effect(run: () => void | (() => void), deps: unknown[]) { const i = this.cursor++, old = this.cells[i]; if (!old || deps.some((v, n) => v !== old.deps[n])) this.effects.push(() => { old?.cleanup?.(); this.cells[i] = { deps, cleanup: run() }; }); }
  async request(path: string, body: unknown): Promise<any> { this.calls.push({ path, body }); assert.equal(body, undefined, 'No navigation command'); return path === 'agents/meetings' ? { current: null, history: [] } : this.hub; }
  open() {
    const values: Record<PropertyKey, unknown> = {
      [symbol]: this, window: new EventTarget(),
      localStorage: { getItem: (key: string) => { if (key === this.unreadableKey) throw Error('Unreadable'); return this.rows.get(key) ?? null; }, setItem: (key: string, value: string) => { if (key === this.failedKey) throw Error('Full'); this.rows.set(key, value); this.writes.push(key); } },
    };
    this.globals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, value: values[key] });
  }
  async render(make: () => any) { for (let pass = 0; pass < 10; pass++) { if (this.dirty) { this.dirty = false; this.cursor = 0; this.effects = []; this.tree = make(); for (const run of this.effects) run(); } await Promise.resolve(); } return this.tree; }
  close() { for (const cell of this.cells) cell?.cleanup?.(); for (const [key, value] of this.globals) if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
}
const snapshot: Snapshot = { epoch: 'epoch', deviceId: 'device', cursor: 0, tasks: [], drafts: [], projects: [], records: { agent: [], assignment: [], contact: [], content: [], profile: [] }, layout: { id: 'layout', revision: 1, deviceId: 'device', updatedAt: '', value: structuredClone(defaultLayout) }, capabilities: { assistant: false, voice: false, reason: '' } };
const scope = 'epoch:device:window', hubKey = 'e3:hub:epoch:device:window';
const actions = { openAgent() {}, assignWork() {}, openPlan() {}, openRoutine() {}, openContent() {}, editTask() {} };

test('Team search disclosure retains exact query through Escape and reopen without commands', async () => {
  const f = new Fixture(); f.open();
  const make = () => AgentHub({ snapshot, presentation: 'team', setPresentation() {}, manage() {}, unfinished: [], ...actions });
  try {
    await f.render(make); assert.equal(f.writes.length, 0);
    button(f.tree, 'Search Team').props.onClick(); await f.render(make);
    let field = nodes(f.tree).find(node => node.type === 'input' && node.props['aria-label'] === 'Find An Agent');
    field.props.onChange({ target: { value: 'Saved query 雪' } }); await f.render(make);
    field = nodes(f.tree).find(node => node.type === 'input' && node.props['aria-label'] === 'Find An Agent');
    field.props.onKeyDown({ key: 'Escape', stopPropagation() {} }); await f.render(make);
    assert.equal(JSON.parse(f.rows.get(hubKey + ':view')!).query, 'Saved query 雪');
    assert.equal(JSON.parse(f.rows.get(hubKey + ':view')!).searchOpen, false);
    button(f.tree, 'Search: Saved query 雪').props.onClick(); await f.render(make);
    assert.equal(nodes(f.tree).find(node => node.type === 'input').props.value, 'Saved query 雪');
    assert.ok(f.calls.every(call => call.body === undefined));
  } finally { f.close(); }
});
test('failed room writing stays in its original owner and blocks departure until exact retention succeeds', async () => {
  const f = new Fixture(); f.open(); f.failedKey = hubKey + ':room-form';
  const make = () => AgentHub({ snapshot, presentation: 'hub', setPresentation() {}, manage() {}, unfinished: [], ...actions });
  try {
    await f.render(make); button(f.tree, 'Add Room').props.onClick(); await f.render(make);
    const field = nodes(f.tree).find(node => node.type === 'input' && node.props.value === 'Private office');
    field.props.onChange({ target: { value: '   unfinished room 雪   ' } }); await f.render(make);
    assert.equal(mayLeaveAgentDrafts(scope), false); assert.equal(f.rows.has(hubKey + ':room-form'), false);
    assert.ok(nodes(f.tree).some(node => node.type === 'input' && node.props.value === '   unfinished room 雪   '));
    f.failedKey = ''; button(f.tree, 'Retry Keeping Writing').props.onClick(); await f.render(make);
    assert.equal(mayLeaveAgentDrafts(scope), true);
    assert.equal(JSON.parse(f.rows.get(hubKey + ':room-form')!).name, '   unfinished room 雪   ');
    assert.ok(f.calls.every(call => call.body === undefined));
  } finally { f.close(); }
  assert.equal(mayLeaveAgentDrafts(scope), true);
});
test('unreadable original room data is not replaced by a default or later new-room proposal', async () => {
  const f = new Fixture(); f.rows.set(hubKey + ':room-form', '{"name":"Original","template":"private"}'); f.unreadableKey = hubKey + ':room-form'; f.open();
  const make = () => AgentHub({ snapshot, presentation: 'hub', setPresentation() {}, manage() {}, unfinished: [], ...actions });
  try {
    await f.render(make); assert.equal(f.writes.length, 0);
    f.unreadableKey = ''; button(f.tree, 'Add Room').props.onClick(); await f.render(make);
    assert.equal(mayLeaveAgentDrafts(scope), true); // No new writing was admitted over the unreadable original.
    assert.equal(nodes(f.tree).some(node => node.type === 'input' && node.props.value === 'Private office'), false);
    assert.equal(f.rows.get(hubKey + ':room-form'), '{"name":"Original","template":"private"}');
  } finally { f.close(); }
});
test('discussion close and top-level departure use the same agenda owner and keep failed writing', async () => {
  const f = new Fixture(); f.open(); const key = hubKey + ':meeting-draft'; let closed = 0;
  const make = () => HubMeetingPanel({ epoch: 'epoch', navigationScope: scope, draftKey: key, roster: [], layout: { version: 1 as const, revision: 1, rooms: [], placements: {}, previousPlacements: {} }, refresh() {}, close() { closed++; } });
  try {
    await f.render(make); f.failedKey = key;
    nodes(f.tree).find(node => node.type === 'textarea').props.onChange({ target: { value: 'Keep the full unfinished agenda 雪' } }); await f.render(make);
    button(f.tree, 'Close').props.onClick(); await f.render(make);
    assert.equal(closed, 0); assert.equal(mayLeaveAgentDrafts(scope), false); assert.equal(f.rows.has(key), false);
    f.failedKey = ''; button(f.tree, 'Retry Keeping Writing').props.onClick(); await f.render(make);
    button(f.tree, 'Close').props.onClick(); assert.equal(closed, 1);
    assert.equal(JSON.parse(f.rows.get(key)!).agenda, 'Keep the full unfinished agenda 雪'); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});
test('personality departure keeps the existing retained journal without invoking its save controller', async () => {
  const f = new Fixture(); f.open(); const key = hubKey + ':personality:agent'; let saved = 0;
  const make = () => PersonalityDialog({ navigationScope: scope, name: 'Agent', value: defaultAgentActivityPreferences(), revision: 1, draftKey: key, nextAt: null, attempts: 0, busy: false, error: '', close() {}, async save() { saved++; return true; } });
  try {
    await f.render(make); f.failedKey = key;
    nodes(f.tree).find(node => node.type === 'input').props.onChange({ target: { value: 'Patient, deliberate 雪' } }); await f.render(make);
    assert.equal(mayLeaveAgentDrafts(scope), false); assert.equal(saved, 0);
    f.failedKey = ''; assert.equal(mayLeaveAgentDrafts(scope), true);
    assert.equal(JSON.parse(f.rows.get(key)!).value.traits, 'Patient, deliberate 雪'); assert.equal(saved, 0);
  } finally { f.close(); }
});
test('profile review, active work and returned result links preserve their own exact attempts', () => {
  const calls: unknown[][] = [], openPlan = (...args: unknown[]) => calls.push(args);
  const base: any = { ...blankRecord('agent', 'UTC'), id: 'agent', revision: 1, name: 'Agent', position: '', status: 'idle', reason: '', plans: [{ id: 'assignment:saved', title: 'Saved Brief' }], tasks: [], content: [], routines: [], reviews: [{ attemptId: 'old-review', assignmentId: 'assignment:one', title: 'Review One', count: 1 }], returned: 1, appliedChanges: 0, unresolved: 1, active: { assignmentId: 'assignment:one', id: 'active-exact' }, latest: { assignmentId: 'assignment:one', id: 'returned-old', title: 'Returned', message: 'Original output' } };
  let tree = AgentWork({ current: base, actions: { ...actions, openPlan }, inspect() {}, async openTask() {}, manage() {} });
  button(tree, 'Review Changes · Review One1 to review').props.onClick(); button(tree, 'Open Assignment').props.onClick(); button(tree, 'Saved Brief').props.onClick();
  tree = AgentWork({ current: { ...base, active: null }, actions: { ...actions, openPlan }, inspect() {}, async openTask() {}, manage() {} });
  button(tree, 'Open Result & History').props.onClick();
  assert.deepEqual(calls, [['assignment:one', 'old-review'], ['assignment:one', 'active-exact'], ['assignment:saved'], ['assignment:one', 'returned-old']]);
});


test('room Close and Dialog Escape retain the proposal; failed storage leaves writing visible and Add/Edit resumes it', async () => {
  const f = new Fixture(); f.open();
  const make = () => AgentHub({ snapshot, presentation: 'hub', setPresentation() {}, manage() {}, unfinished: [], ...actions });
  const roomDialog = () => nodes(f.tree).find(node => typeof node.type === 'function' && ['Add Room', 'Room Settings'].includes(node.props.title));
  try {
    await f.render(make); button(f.tree, 'Add Room').props.onClick(); await f.render(make);
    f.failedKey = hubKey + ':room-form';
    nodes(f.tree).find(node => node.type === 'input' && node.props.value === 'Private office').props.onChange({ target: { value: '  Keep this room 雪  ' } }); await f.render(make);
    button(f.tree, 'Close').props.onClick(); await f.render(make); assert.ok(roomDialog());
    roomDialog().props.close(); await f.render(make); assert.ok(roomDialog(), 'same callback used by Dialog Escape refuses failed retention');
    assert.ok(nodes(f.tree).some(node => node.type === 'input' && node.props.value === '  Keep this room 雪  '));
    f.failedKey = ''; roomDialog().props.close(); await f.render(make); assert.equal(roomDialog(), undefined);
    const kept = f.rows.get(hubKey + ':room-form'); assert.equal(JSON.parse(kept!).name, '  Keep this room 雪  ');
    button(f.tree, 'Add Room').props.onClick(); await f.render(make);
    assert.ok(nodes(f.tree).some(node => node.type === 'input' && node.props.value === '  Keep this room 雪  '));
    button(f.tree, 'Close').props.onClick(); await f.render(make);
    nodes(f.tree).find(node => node.type === Headquarters).props.editRoom({ id: 'other-room', name: 'Other', template: 'studio' }); await f.render(make);
    assert.match(text(f.tree), /before editing a different room/); assert.equal(f.rows.get(hubKey + ':room-form'), kept);
    f.failedKey = hubKey + ':room-form'; button(f.tree, 'Discard Kept Writing').props.onClick(); await f.render(make); assert.ok(roomDialog());
    f.failedKey = ''; button(f.tree, 'Discard Kept Writing').props.onClick(); await f.render(make); assert.equal(roomDialog(), undefined); assert.equal(f.rows.get(hubKey + ':room-form'), 'null');
    assert.ok(f.calls.every(call => call.body === undefined));
  } finally { f.close(); }
});

test('reopened room writing keeps an unavailable original readable without replacement or a command', async () => {
  const f = new Fixture(); f.rows.set(hubKey + ':room-form', JSON.stringify({ id: 'missing-room', name: 'Original unfinished 雪', template: 'private' })); f.open();
  const make = () => AgentHub({ snapshot, presentation: 'hub', setPresentation() {}, manage() {}, unfinished: [], ...actions });
  try {
    await f.render(make); assert.match(text(f.tree), /original room is unavailable/);
    assert.ok(nodes(f.tree).some(node => node.type === 'input' && node.props.value === 'Original unfinished 雪'));
    assert.equal(button(f.tree, 'Save Name').props.disabled, true);
    nodes(f.tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await f.render(make);
    assert.ok(f.calls.every(call => call.body === undefined)); assert.equal(JSON.parse(f.rows.get(hubKey + ':room-form')!).id, 'missing-room');
  } finally { f.close(); }
});

test('Headquarters work identity is one tuple; a missing attempt never falls through to unrelated work or meeting', () => {
  const member: any = { work: { assignmentId: 'member-work', attemptId: 'member-attempt', meetingId: 'member-meeting' } };
  const current: any = { reviews: [{ assignmentId: 'review-work' }], active: { assignmentId: 'active-work', id: 'active-attempt' }, latest: { assignmentId: 'latest-work', id: 'latest-attempt' } };
  assert.deepEqual(headquartersWorkTarget(current, member), { assignmentId: 'review-work', attemptId: undefined, meetingId: undefined });
  assert.deepEqual(headquartersWorkTarget({ ...current, reviews: [] }, member), { assignmentId: 'active-work', attemptId: 'active-attempt', meetingId: undefined });
  assert.deepEqual(headquartersWorkTarget({ ...current, reviews: [], active: null, latest: null }, member), member.work);
});


test('a confirmed room save cannot clear newer writing and a failed clear keeps the matching proposal', async () => {
  const f = new Fixture(); f.open();
  const make = () => AgentHub({ snapshot, presentation: 'hub', setPresentation() {}, manage() {}, unfinished: [], ...actions });
  const originalRequest = f.request.bind(f); let settle: (value: unknown) => void = () => {}, commands: any[] = [];
  f.request = async (path, body) => {
    if (body === undefined) return originalRequest(path, body);
    assert.equal(path, 'agents/hub/layout'); commands.push(body);
    return new Promise(resolve => { settle = resolve; });
  };
  try {
    await f.render(make); button(f.tree, 'Add Room').props.onClick(); await f.render(make);
    nodes(f.tree).find(node => node.type === 'input' && node.props.value === 'Private office').props.onChange({ target: { value: 'Original request name' } }); await f.render(make);
    nodes(f.tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await f.render(make);
    assert.equal(commands.length, 1); assert.equal(commands[0].action.name, 'Original request name');
    nodes(f.tree).find(node => node.type === 'input' && node.props.value === 'Original request name').props.onChange({ target: { value: 'Newer writing before reply 雪' } }); await f.render(make);
    settle({ ...f.hub.layout, revision: 2 }); await f.render(make);
    assert.ok(nodes(f.tree).some(node => node.type === 'input' && node.props.value === 'Newer writing before reply 雪'));
    assert.equal(JSON.parse(f.rows.get(hubKey + ':room-form')!).name, 'Newer writing before reply 雪');
    nodes(f.tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await f.render(make);
    assert.equal(commands.length, 2); assert.notEqual(commands[0].requestId, commands[1].requestId);
    f.failedKey = hubKey + ':room-form'; settle({ ...f.hub.layout, revision: 3 }); await f.render(make);
    assert.ok(nodes(f.tree).some(node => node.type === 'input' && node.props.value === 'Newer writing before reply 雪'));
    assert.equal(JSON.parse(f.rows.get(hubKey + ':room-form')!).name, 'Newer writing before reply 雪');
    assert.deepEqual(JSON.parse(f.rows.get(hubKey + ':pending')!), commands[1]);
    const form = nodes(f.tree).find(node => node.type === 'form');
    form.props.onSubmit({ preventDefault() {} }); await f.render(make); assert.equal(commands.length, 2, 'confirmed proposal never becomes a new command');
    button(f.tree, 'Keep Confirmed Change').props.onClick(); await f.render(make); assert.equal(commands.length, 2);
    f.failedKey = hubKey + ':pending'; button(f.tree, 'Keep Confirmed Change').props.onClick(); await f.render(make);
    assert.equal(f.rows.get(hubKey + ':room-form'), 'null'); assert.deepEqual(JSON.parse(f.rows.get(hubKey + ':pending')!), commands[1]);
    assert.ok(button(f.tree, 'Keep Confirmed Change')); assert.equal(mayLeaveAgentDrafts(scope), true);
    f.failedKey = ''; button(f.tree, 'Keep Confirmed Change').props.onClick(); await f.render(make);
    assert.equal(f.rows.get(hubKey + ':pending'), 'null'); assert.equal(commands.length, 2); assert.equal(nodes(f.tree).some(node => node.type === 'form'), false);
  } finally { f.close(); }
});


test('a refused original room change retains its pending identity when clearing local storage fails', async () => {
  const f = new Fixture(); f.open();
  const make = () => AgentHub({ snapshot, presentation: 'hub', setPresentation() {}, manage() {}, unfinished: [], ...actions });
  const originalRequest = f.request.bind(f); const commands: any[] = []; let reject: (reason: unknown) => void = () => {};
  f.request = async (path, body) => {
    if (body === undefined) return originalRequest(path, body);
    assert.equal(path, 'agents/hub/layout'); commands.push(body);
    return new Promise((_resolve, refuse) => { reject = refuse; });
  };
  try {
    await f.render(make); button(f.tree, 'Add Room').props.onClick(); await f.render(make);
    nodes(f.tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await f.render(make);
    assert.equal(commands.length, 1); const original = f.rows.get(hubKey + ':pending');
    f.failedKey = hubKey + ':pending'; reject(Object.assign(new Error('Original room refused'), { code: 'room_missing' })); await f.render(make);
    assert.equal(f.rows.get(hubKey + ':pending'), original); assert.equal(button(f.tree, 'Add Room').props.disabled, true);
    assert.ok(button(f.tree, 'Reconcile Change')); assert.match(text(f.tree), /saved marker could not be cleared/);
    f.failedKey = ''; button(f.tree, 'Reconcile Change').props.onClick(); await f.render(make);
    assert.deepEqual(commands[1], commands[0]); assert.equal(commands.length, 2);
    reject(Object.assign(new Error('Original room refused'), { code: 'room_missing' })); await f.render(make);
    assert.equal(f.rows.get(hubKey + ':pending'), 'null'); assert.equal(commands.length, 2);
    assert.equal(JSON.parse(f.rows.get(hubKey + ':room-form')!).name, 'Private office');
  } finally { f.close(); }
});
