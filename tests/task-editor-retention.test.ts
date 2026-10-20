import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Command, Entity, Snapshot, Task } from '../packages/domain/contracts';

const fixtureKey = Symbol.for('nova.test.task-editor-hooks');
const reactUrl = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
// Exercise the actual editor and Dialog callbacks without a browser or providers.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.css')) return { url: 'nova-test:task-editor-css', shortCircuit: true };
    if (specifier === 'react' && context.parentURL?.includes('/apps/client/src/')) return { url: 'nova-test:task-editor-react', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:task-editor-css') return { format: 'module', shortCircuit: true, source: 'export {}' };
    if (url === 'nova-test:task-editor-react') return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(reactUrl)};
      export const useEffect = (effect, dependencies) => {
        const fixture = globalThis[Symbol.for('nova.test.task-editor-hooks')];
        if (fixture.ignoreEffects) return;
        const index = fixture.index++, previous = fixture.values[index];
        if (!previous || !dependencies || dependencies.some((value, i) => value !== previous.dependencies?.[i])) {
          fixture.effects.push(() => { previous?.cleanup?.(); fixture.values[index] = { dependencies, cleanup: effect() }; });
        }
      };
      export const useId = () => 'fixture-dialog';
      export const useRef = initial => {
        const fixture = globalThis[Symbol.for('nova.test.task-editor-hooks')], index = fixture.index++;
        if (!(index in fixture.values)) fixture.values[index] = { current: initial };
        return fixture.values[index];
      };
      export const useState = initial => {
        const fixture = globalThis[Symbol.for('nova.test.task-editor-hooks')], index = fixture.index++;
        if (!(index in fixture.values)) fixture.values[index] = typeof initial === 'function' ? initial() : initial;
        return [fixture.values[index], value => { fixture.values[index] = typeof value === 'function' ? value(fixture.values[index]) : value; }];
      };
    ` };
    return next(url, context);
  },
});
const { TaskEditor } = await import('../apps/client/src/TaskEditor');
const { TaskDetailsShell } = await import('../apps/client/src/TaskDetailsShell');
hooks.deregister();

function controls(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  return node && typeof node === 'object' && node.props ? [node, ...controls(node.props.children)] : [];
}
function fixture(t: any, trashed = false, pending?: Command, options: Partial<Parameters<typeof TaskEditor>[0]> = {}) {
  const state = { index: 0, values: [] as any[], effects: [] as (() => void)[], ignoreEffects: false }, storage = new Map<string, string>();
  const task: Entity<Task> = { id: 'task:fixture', revision: 2, deviceId: 'device', updatedAt: '', value: { title: 'Saved task', notes: 'Saved notes', status: 'open', planned: '', due: '', trashed, origin: { kind: 'content', id: 'content:source', revision: 1 } } };
  const snapshot = { epoch: 'epoch', deviceId: 'device', layout: { value: { timezone: 'UTC' } }, tasks: [task], projects: [] } as unknown as Snapshot;
  const key = 'e3:task-editor:device:task:fixture';
  storage.set(key, JSON.stringify({ value: task.value, revision: task.revision, epoch: snapshot.epoch, ...(pending ? { pending } : {}) }));
  let full = false;
  const departures: string[] = [];
  for (const [name, value] of [[fixtureKey, state], ['localStorage', {
    getItem: (name: string) => storage.get(name) ?? null,
    setItem: (name: string, value: string) => { if (full) throw Error('QuotaExceededError'); storage.set(name, value); },
  }]] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  let currentTask = task;
  const render = () => {
    state.index = 0;
    const editor = TaskEditor({ task: currentTask, snapshot, close: () => departures.push('close'), saved: () => departures.push('saved'), openOrigin: () => departures.push('source'), openTask: () => departures.push('task'), newTask: () => departures.push('child'), ...options });
    state.ignoreEffects = true; const nodes = controls(TaskDetailsShell(editor.props)); state.ignoreEffects = false;
    for (const effect of state.effects.splice(0)) effect();
    return nodes;
  };
  return { render, departures, task, snapshot, state, setTask: (value: Entity<Task>) => { currentTask = value; snapshot.tasks = [value]; }, unmount: () => { for (const value of state.values) value?.cleanup?.(); state.values = []; }, stored: () => JSON.parse(storage.get(key)!), full: (value: boolean) => { full = value; } };
}
const button = (nodes: any[], label: string) => nodes.find(node => node.type === 'button' && (node.props.children === label || node.props['aria-label'] === label));

const exits = {
  'Keep For Later': (nodes: any[]) => button(nodes, 'Keep For Later').props.onClick(),
  'Close Task Details': (nodes: any[]) => button(nodes, 'Close Task Details').props.onClick(),
  Escape: (nodes: any[]) => nodes[0].props.onCancel({ preventDefault() {} }),
  backdrop: (nodes: any[]) => { const backdrop = {}; nodes[0].props.onClick({ target: backdrop, currentTarget: backdrop }); },
  'Open Source': (nodes: any[]) => button(nodes, 'Open Source').props.onClick(),
  'Open Assistant plan': (nodes: any[]) => nodes.find(node => node.type?.name === 'TaskAssistantWork').props.openOrigin({ kind: 'assignment', id: 'assignment:fixture', revision: 1 }),
  'Open related task': (nodes: any[]) => nodes.find(node => node.type?.name === 'TaskFamily').props.openTask({}),
  'Add child task': (nodes: any[]) => nodes.find(node => node.type?.name === 'TaskFamily').props.newTask({}),
};

for (const [label, leave] of Object.entries(exits)) {
  test(`${label} retains the latest writing before leaving and stays open when storage is full`, t => {
    const f = fixture(t);
    f.full(true);
    f.render().find(node => node.type === 'textarea').props.onChange({ target: { value: 'Latest unsaved writing' } });
    leave(f.render());
    assert.deepEqual(f.departures, []);
    assert.equal(f.stored().value.notes, 'Saved notes');
    const blocked = f.render();
    assert.equal(blocked.find(node => node.type === 'textarea').props.value, 'Latest unsaved writing');
    assert.ok(blocked.some(node => node.type === 'p' && /latest edits are still in this window/.test(node.props.children)));
    assert.ok(blocked.some(node => node.type === 'span' && node.props.children === 'Keep this window open · browser storage is full'));
    f.full(false);
    leave(f.render());
    assert.equal(f.departures.length, 1);
    assert.equal(f.stored().value.notes, 'Latest unsaved writing');
    f.state.values = [];
    assert.equal(f.render().find(node => node.type === 'textarea').props.value, 'Latest unsaved writing');
  });
}

test('closing after storage recovers preserves an original pending save without dispatching a new one', t => {
  const pending = { requestId: 'original-request', epoch: 'epoch', kind: 'task', entityId: 'task:fixture', expectedRevision: 2, payload: { title: 'Captured title' } } as Command;
  const f = fixture(t, false, pending);
  f.full(true); button(f.render(), 'Close Task Details').props.onClick();
  assert.deepEqual(f.departures, []);
  f.full(false); button(f.render(), 'Keep For Later').props.onClick();
  assert.deepEqual(f.stored().pending, pending);
  assert.deepEqual(f.departures, ['close']);
});

test('Back and outside task selection refuse departure when draft or navigation retention fails', t => {
  let leave: (() => boolean) | undefined, moved = 0, allowView = false;
  const f = fixture(t, false, undefined, { back: () => { moved++; }, backLabel: 'Back To Parent', keepView: () => allowView, registerDeparture: guard => { leave = guard; return () => { leave = undefined; }; } });
  f.render(); f.full(true);
  button(f.render(), 'Back To Parent').props.onClick(); assert.equal(moved, 0); assert.equal(leave!(), false);
  f.full(false); button(f.render(), 'Back To Parent').props.onClick(); assert.equal(moved, 0); assert.equal(leave!(), false);
  allowView = true; button(f.render(), 'Back To Parent').props.onClick(); assert.equal(moved, 1); assert.equal(leave!(), true);
});

test('tab changes preserve mounted fields, per-tab scroll and the exact pending command without submitting', t => {
  const pending = { requestId: 'original-request', epoch: 'epoch', kind: 'task', entityId: 'task:fixture', expectedRevision: 2, payload: { title: 'Captured title' } } as Command;
  const f = fixture(t, false, pending), position = { scrollTop: 175 };
  let nodes = f.render(); nodes.find(node => node.props.className === 'task-details-body').props.ref.current = position;
  button(nodes, 'Dates & Reminders').props.onClick(); nodes = f.render(); assert.equal(position.scrollTop, 0);
  assert.equal(nodes.find(node => node.props['data-task-section'] === 'details').props.hidden, true);
  assert.ok(nodes.find(node => node.type === 'textarea')); position.scrollTop = 45;
  button(nodes, 'Details').props.onClick(); f.render(); assert.equal(position.scrollTop, 175);
  button(f.render(), 'Dates & Reminders').props.onClick(); f.render(); assert.equal(position.scrollTop, 45);
  assert.deepEqual(f.stored().pending, pending); assert.deepEqual(f.departures, []);
});

test('invalid field in a hidden tab opens that tab and disclosure before focus', t => {
  const f = fixture(t), previous = globalThis.requestAnimationFrame; let focused = false;
  globalThis.requestAnimationFrame = callback => { callback(0); return 1; };
  t.after(() => { globalThis.requestAnimationFrame = previous; });
  const disclosure = { open: false }, field = { validationMessage: 'Enter a valid reminder time.', closest: (selector: string) => selector === 'details' ? disclosure : { dataset: { taskSection: 'dates' } }, focus: () => { focused = true; } };
  f.render().find(node => node.type === 'form').props.onInvalidCapture({ preventDefault() {}, target: field });
  const nodes = f.render(); assert.equal(nodes.find(node => node.props['data-task-section'] === 'dates').props.hidden, false);
  assert.equal(disclosure.open, true); assert.equal(focused, true);
  assert.ok(nodes.some(node => node.type === 'p' && node.props.children === field.validationMessage));
});

test('Escape or cancel in a nested review dialog does not close the task workspace', t => {
  const f = fixture(t), nodes = f.render(), parent = {}, nested = {};
  nodes[0].props.onCancel({ target: nested, currentTarget: parent, preventDefault() {} });
  nodes[0].props.onKeyDown({ key: 'Escape', target: { closest: () => nested }, currentTarget: parent, preventDefault() {} });
  assert.deepEqual(f.departures, []);
  nodes[0].props.onKeyDown({ key: 'Escape', target: { closest: () => parent }, currentTarget: parent, preventDefault() {} });
  assert.deepEqual(f.departures, ['close']);
});

test('a read-only task in Trash can close without overwriting its earlier journal', t => {
  const f = fixture(t, true), before = f.stored();
  f.full(true); button(f.render(), 'Close').props.onClick();
  assert.deepEqual(f.departures, ['close']);
  assert.deepEqual(f.stored(), before);
});

for (const outcome of ['exact', 'later-revision', 'refresh-unavailable']) test(`reopened same-task editor adopts the original deferred response (${outcome}) without replaying it`, async t => {
  const f = fixture(t); let release!: (value: Response) => void, sent: Command | undefined, requests = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { requests++; sent = JSON.parse(init!.body as string); return new Promise<Response>(resolve => { release = resolve; }); };
  t.after(() => { globalThis.fetch = previous; });
  f.render().find(node => node.type === 'textarea').props.onChange({ target: { value: 'Original captured writing' } });
  f.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(requests, 1); assert.equal(f.stored().pending.requestId, sent!.requestId);
  f.unmount(); assert.ok(f.render().some(node => node.type === 'span' && node.props.children === 'Original save unconfirmed · edits paused'));
  const confirmed = { ...f.task, revision: 3, value: sent!.payload as Task };
  release(new Response(JSON.stringify(confirmed), { status: 200 }));
  for (let attempt = 0; attempt < 10 && f.stored().pending; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.stored().pending, undefined); assert.equal(f.stored().confirmation.requestId, sent!.requestId);
  if (outcome === 'refresh-unavailable') f.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  else f.setTask(outcome === 'later-revision' ? { ...confirmed, revision: 4, value: { ...confirmed.value, notes: 'Later remote writing' } } : confirmed);
  f.render(); const updated = f.render();
  assert.equal(updated.find(node => node.type === 'textarea').props.value, 'Original captured writing');
  assert.equal(updated.some(node => node.type === 'span' && node.props.children === 'Original save unconfirmed · edits paused'), false);
  assert.equal(f.stored().revision, 3); assert.equal(requests, 1);
  if (outcome === 'later-revision') assert.ok(updated.some(node => node.type === 'p' && /newer host version/.test(node.props.children)));
});

test('future schedule entry keeps occurrence writing first and displays original date rather than replanned date', t => {
  let opened = 0, allowView = true;
  const f = fixture(t, false, undefined, { openFutureSchedule: () => { opened++; }, keepView: () => allowView });
  const routineId = 'routine:00000000-0000-4000-8000-000000000001';
  f.snapshot.taskState = { occurrences: [{ taskId: f.task.id, routineId, templateRevision: 1, date: '2026-01-02', timezone: 'Asia/Tokyo', kind: 'task' }], presentation: { [f.task.id]: { recurrence: { cadence: 'daily', interval: 1 } } } } as any;
  f.snapshot.routines = [{ id: routineId, revision: 7, value: { cadence: 'weekly' } }] as any;
  f.task.value.planned = '2026-10-21'; f.full(true);
  f.render().find(node => node.type === 'textarea').props.onChange({ target: { value: 'Occurrence writing only' } });
  button(f.render(), 'Edit Future Schedule').props.onClick(); assert.equal(opened, 0);
  f.full(false); allowView = false; button(f.render(), 'Edit Future Schedule').props.onClick(); assert.equal(opened, 0);
  allowView = true; const nodes = f.render(); button(nodes, 'Edit Future Schedule').props.onClick();
  assert.equal(opened, 1); assert.equal(f.stored().value.notes, 'Occurrence writing only');
  const details = nodes.find(node => node.type?.name === 'TaskOccurrenceDetails'); assert.equal(details.props.occurrence.date, '2026-01-02');
  assert.ok(nodes.some(node => node.type === 'p' && JSON.stringify(node.props.children).includes('Original schedule: every 1 day.')));
});
