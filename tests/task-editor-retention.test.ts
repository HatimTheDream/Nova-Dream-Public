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
    if (specifier === 'react' && context.parentURL?.includes('/apps/client/src/')) return { url: 'nova-test:task-editor-react', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:task-editor-react') return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(reactUrl)};
      export const useEffect = () => {};
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
const { Dialog } = await import('../apps/client/src/ui');
hooks.deregister();

function controls(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  return node && typeof node === 'object' && node.props ? [node, ...controls(node.props.children)] : [];
}
function fixture(t: any, trashed = false, pending?: Command) {
  const state = { index: 0, values: [] as any[] }, storage = new Map<string, string>();
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
  const render = () => {
    state.index = 0;
    const editor = TaskEditor({ task, snapshot, close: () => departures.push('close'), saved: () => departures.push('saved'), openOrigin: () => departures.push('source'), openTask: () => departures.push('task'), newTask: () => departures.push('child') });
    return controls(Dialog(editor.props));
  };
  return { render, departures, task, state, stored: () => JSON.parse(storage.get(key)!), full: (value: boolean) => { full = value; } };
}
const button = (nodes: any[], label: string) => nodes.find(node => node.type === 'button' && (node.props.children === label || node.props['aria-label'] === label));

const exits = {
  'Keep for later': (nodes: any[]) => button(nodes, 'Keep for later').props.onClick(),
  'Close dialog': (nodes: any[]) => button(nodes, 'Close dialog').props.onClick(),
  Escape: (nodes: any[]) => nodes[0].props.onCancel({ preventDefault() {} }),
  backdrop: (nodes: any[]) => { const backdrop = {}; nodes[0].props.onClick({ target: backdrop, currentTarget: backdrop }); },
  'Open source': (nodes: any[]) => button(nodes, 'Open source').props.onClick(),
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
  f.full(true); button(f.render(), 'Close dialog').props.onClick();
  assert.deepEqual(f.departures, []);
  f.full(false); button(f.render(), 'Keep for later').props.onClick();
  assert.deepEqual(f.stored().pending, pending);
  assert.deepEqual(f.departures, ['close']);
});

test('a read-only task in Trash can close without overwriting its earlier journal', t => {
  const f = fixture(t, true), before = f.stored();
  f.full(true); button(f.render(), 'Close').props.onClick();
  assert.deepEqual(f.departures, ['close']);
  assert.deepEqual(f.stored(), before);
});
