import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Command, Entity, Snapshot } from '../packages/domain/contracts';
import type { Routine } from '../packages/domain/tasks';

const fixtureKey = Symbol.for('nova.test.routine-editor-hooks');
const reactUrl = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
// Exercise the actual editor and Dialog callbacks without a browser or providers.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.css')) return { url: 'nova-test:routine-editor-css', shortCircuit: true };
    if (specifier === 'react' && context.parentURL?.includes('/apps/client/src/')) return { url: 'nova-test:routine-editor-react', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:routine-editor-css') return { format: 'module', shortCircuit: true, source: 'export {}' };
    if (url === 'nova-test:routine-editor-react') return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(reactUrl)};
      export const useEffect = (effect, dependencies) => {
        const fixture = globalThis[Symbol.for('nova.test.routine-editor-hooks')];
        if (fixture.ignoreEffects) return;
        const index = fixture.index++, previous = fixture.values[index];
        if (!previous || !dependencies || dependencies.some((value, i) => value !== previous.dependencies?.[i])) {
          fixture.effects.push(() => { previous?.cleanup?.(); fixture.values[index] = { dependencies, cleanup: effect() }; });
        }
      };
      export const useId = () => 'fixture-dialog';
      export const useRef = initial => {
        const fixture = globalThis[Symbol.for('nova.test.routine-editor-hooks')], index = fixture.index++;
        if (!(index in fixture.values)) fixture.values[index] = { current: initial };
        return fixture.values[index];
      };
      export const useState = initial => {
        const fixture = globalThis[Symbol.for('nova.test.routine-editor-hooks')], index = fixture.index++;
        if (!(index in fixture.values)) fixture.values[index] = typeof initial === 'function' ? initial() : initial;
        return [fixture.values[index], value => { fixture.values[index] = typeof value === 'function' ? value(fixture.values[index]) : value; }];
      };
    ` };
    return next(url, context);
  },
});
const { RoutineEditor } = await import('../apps/client/src/RoutineEditor');
const { Dialog } = await import('../apps/client/src/ui');
hooks.deregister();

function controls(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  return node && typeof node === 'object' && node.props ? [node, ...controls(node.props.children)] : [];
}
function fixture(t: any, options: Partial<Parameters<typeof RoutineEditor>[0]> = {}) {
  const state = { index: 0, values: [] as any[], effects: [] as (() => void)[], ignoreEffects: false }, storage = new Map<string, string>();
  const routine: Entity<Routine> = { id: 'routine:00000000-0000-4000-8000-000000000001', revision: 2, deviceId: 'device', updatedAt: '', value: { title: 'Saved schedule', notes: 'Saved notes', kind: 'task', state: 'active', startsOn: '2026-03-07', timezone: 'UTC', cadence: 'daily', weekdays: [], projectId: null, plannedTime: '', priority: 'normal', estimateMinutes: 0 } };
  const snapshot = { epoch: 'epoch', deviceId: 'device', layout: { value: { timezone: 'UTC' } }, routines: [routine], projects: [], taskState: { routineEvents: [] } } as unknown as Snapshot;
  const key = `e3:routine-editor:device:${routine.id}`;
  storage.set(key, JSON.stringify({ value: routine.value, revision: routine.revision, epoch: snapshot.epoch }));
  let full = false, currentRoutine = routine;
  const departures: string[] = [], responses: { routine: Entity<Routine>; clean: boolean }[] = [];
  for (const [name, value] of [[fixtureKey, state], ['localStorage', {
    getItem: (name: string) => storage.get(name) ?? null,
    setItem: (name: string, value: string) => { if (full) throw Error('QuotaExceededError'); storage.set(name, value); },
    removeItem: (name: string) => { if (full) throw Error('QuotaExceededError'); storage.delete(name); },
  }]] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  const render = () => {
    state.index = 0;
    const editor = RoutineEditor({ routine: currentRoutine, snapshot, close: () => departures.push('close'), saved: (routine, clean) => responses.push({ routine, clean }), occurrenceTitle: 'Original occurrence', ...options });
    state.ignoreEffects = true; const nodes = controls(Dialog(editor.props)); state.ignoreEffects = false;
    for (const effect of state.effects.splice(0)) effect(); return nodes;
  };
  return { render, departures, responses, routine, snapshot, state, setRoutine: (next: Entity<Routine>) => { currentRoutine = next; snapshot.routines = [next]; }, unmount: () => { for (const value of state.values) value?.cleanup?.(); state.values = []; }, stored: () => JSON.parse(storage.get(key)!), write: (value: unknown) => storage.set(key, JSON.stringify(value)), forget: () => storage.delete(key), full: (value: boolean) => { full = value; } };
}
const button = (nodes: any[], label: string) => nodes.find(node => node.type === 'button' && (node.props.children === label || node.props['aria-label'] === label));
const submit = (f: ReturnType<typeof fixture>) => f.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

for (const method of ['back', 'close', 'escape', 'outside']) test(`routine ${method} retains writing and refuses departure on storage failure`, t => {
  let leave: (() => boolean) | undefined;
  const f = fixture(t, { registerDeparture: guard => { leave = guard; return () => { leave = undefined; }; } });
  const close = () => {
    const nodes = f.render();
    if (method === 'back') button(nodes, 'Back To This Occurrence').props.onClick();
    else if (method === 'close') button(nodes, 'Close dialog').props.onClick();
    else if (method === 'escape') nodes[0].props.onCancel({ preventDefault() {} });
    else assert.equal(leave!(), !blocked);
  };
  let blocked = true; f.full(true);
  f.render().find(node => node.type === 'textarea').props.onChange({ target: { value: 'Future writing only' } }); close();
  assert.deepEqual(f.departures, []); assert.equal(f.stored().value.notes, 'Saved notes');
  assert.equal(f.render().find(node => node.type === 'textarea').props.value, 'Future writing only');
  blocked = false; f.full(false); close(); assert.equal(f.stored().value.notes, 'Future writing only');
  f.unmount(); assert.equal(f.render().find(node => node.type === 'textarea').props.value, 'Future writing only');
});

for (const outcome of ['reopened', 'newer-host', 'confirmation-storage-failure']) test(`original routine acknowledgement survives ${outcome} without another POST`, async t => {
  const f = fixture(t); let release!: (response: Response) => void, command!: Command, requests = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { requests++; command = JSON.parse(init!.body as string); return new Promise(resolve => { release = resolve; }); };
  t.after(() => { globalThis.fetch = previous; });
  f.render().find(node => node.type === 'textarea').props.onChange({ target: { value: 'Captured future writing' } }); submit(f);
  assert.equal(requests, 1); assert.equal(f.stored().pending.requestId, command.requestId);
  if (outcome !== 'confirmation-storage-failure') { f.unmount(); f.render(); } else f.full(true);
  const confirmed = { ...f.routine, revision: 3, value: command.payload as Routine };
  release(new Response(JSON.stringify(confirmed))); await settle();
  if (outcome === 'confirmation-storage-failure') f.full(false);
  if (outcome === 'newer-host') f.setRoutine({ ...confirmed, revision: 4, value: { ...confirmed.value, notes: 'Other saved writing' } });
  // An unchanged snapshot/failed refresh must still recover at explicit Check Save.
  submit(f); await settle(); const nodes = f.render();
  assert.equal(requests, 1); assert.equal(f.stored().pending, undefined); assert.equal(f.stored().revision, 3);
  assert.equal(nodes.find(node => node.type === 'textarea').props.value, 'Captured future writing');
  assert.equal(f.responses.at(-1)!.clean, outcome !== 'newer-host');
  if (outcome === 'newer-host') assert.ok(nodes.some(node => node.type === 'p' && /newer saved schedule/i.test(node.props.children)));
});

test('unknown routine response reconciles the same immutable command; late success preserves newer writing', async t => {
  const f = fixture(t), sent: Command[] = []; let release!: (response: Response) => void;
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { sent.push(JSON.parse(init!.body as string)); if (sent.length === 1) throw Error('Connection interrupted'); return new Promise(resolve => { release = resolve; }); };
  t.after(() => { globalThis.fetch = previous; });
  submit(f); await settle(); assert.deepEqual(f.stored().pending, sent[0]); submit(f); assert.deepEqual(sent[1], sent[0]);
  f.write({ ...f.stored(), value: { ...f.stored().value, notes: 'Newer proposal' } });
  release(new Response(JSON.stringify({ ...f.routine, revision: 3, value: sent[0].payload }))); await settle();
  assert.equal(f.stored().value.notes, 'Newer proposal'); assert.equal(f.stored().pending, undefined); assert.equal(f.responses.at(-1)!.clean, false);
});

test('late response after another editor opens keeps exact routine journal and cannot request navigation', async t => {
  const f = fixture(t); let release!: (response: Response) => void, command!: Command;
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { command = JSON.parse(init!.body as string); return new Promise(resolve => { release = resolve; }); };
  t.after(() => { globalThis.fetch = previous; }); submit(f); f.unmount();
  release(new Response(JSON.stringify({ ...f.routine, revision: 3, value: command.payload }))); await settle();
  assert.equal(f.stored().revision, 3); assert.equal(f.responses.at(-1)!.clean, false); assert.deepEqual(f.departures, []);
});

test('missing saved series and old workspace drafts never submit or become revision-zero creates', async t => {
  const f = fixture(t); let requests = 0; const previous = globalThis.fetch;
  globalThis.fetch = async () => { requests++; throw Error('Must not send'); }; t.after(() => { globalThis.fetch = previous; });
  f.snapshot.routines = []; submit(f); await settle(); assert.equal(requests, 0);
  assert.equal(button(f.render(), 'Review my kept proposal'), undefined); assert.equal(f.stored().revision, 2);
  f.snapshot.routines = [f.routine]; f.snapshot.epoch = 'replacement'; submit(f); await settle();
  assert.equal(requests, 0); assert.equal(button(f.render(), 'Review my kept proposal'), undefined); assert.equal(f.stored().epoch, 'epoch');
});

test('a genuine response protects a failed local edit and unavailable stored pending record without another POST', async t => {
  const f = fixture(t); let release!: (response: Response) => void, command!: Command, requests = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { requests++; command = JSON.parse(init!.body as string); return new Promise(resolve => { release = resolve; }); };
  t.after(() => { globalThis.fetch = previous; });
  const change = f.render().find(node => node.type === 'textarea').props.onChange;
  submit(f); f.full(true); change({ target: { value: 'In-memory writing whose storage failed' } }); f.forget();
  release(new Response(JSON.stringify({ ...f.routine, revision: 3, value: command.payload }))); await settle();
  f.full(false); submit(f); await settle();
  assert.equal(requests, 1); assert.equal(f.stored().value.notes, 'In-memory writing whose storage failed');
  assert.equal(f.stored().pending, undefined); assert.equal(f.responses.at(-1)!.clean, false);
});

test('reopened acknowledgement preserves newer retained writing and refuses contradictory local writing', async t => {
  const f = fixture(t); let release!: (response: Response) => void, command!: Command, requests = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { requests++; command = JSON.parse(init!.body as string); return new Promise(resolve => { release = resolve; }); };
  t.after(() => { globalThis.fetch = previous; }); submit(f); f.unmount(); f.render();
  f.write({ ...f.stored(), value: { ...f.stored().value, notes: 'Newer retained proposal' } });
  release(new Response(JSON.stringify({ ...f.routine, revision: 3, value: command.payload }))); await settle();
  f.full(true); f.render().find(node => node.type === 'textarea').props.onChange({ target: { value: 'Different local proposal' } }); f.full(false);
  const before = f.stored(); submit(f); await settle(); button(f.render(), 'Back To This Occurrence').props.onClick();
  assert.equal(requests, 1); assert.deepEqual(f.stored(), before); assert.deepEqual(f.departures, []);
  assert.equal(f.render().find(node => node.type === 'textarea').props.value, 'Different local proposal');
});

for (const newer of ['proposal', 'command']) test(`late definite rejection preserves a newer retained ${newer}`, async t => {
  const f = fixture(t); let release!: (response: Response) => void, command!: Command;
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { command = JSON.parse(init!.body as string); return new Promise(resolve => { release = resolve; }); };
  t.after(() => { globalThis.fetch = previous; }); submit(f);
  const kept = { ...f.stored(), value: { ...f.stored().value, notes: 'Newer writing' }, ...(newer === 'command' ? { pending: { ...command, requestId: 'newer-request' } } : {}) }; f.write(kept);
  release(new Response(JSON.stringify({ code: 'validation', message: 'Review this schedule.' }), { status: 400 })); await settle();
  assert.equal(f.stored().value.notes, 'Newer writing');
  if (newer === 'command') assert.deepEqual(f.stored(), kept);
  else assert.equal(f.stored().pending, undefined);
  assert.deepEqual(f.responses, []); assert.deepEqual(f.departures, []);
});

for (const newer of ['proposal', 'command']) test(`explicit conflict review preserves a newer retained ${newer}`, async t => {
  const f = fixture(t); let release!: (response: Response) => void, command!: Command;
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { command = JSON.parse(init!.body as string); return new Promise(resolve => { release = resolve; }); };
  t.after(() => { globalThis.fetch = previous; }); submit(f);
  release(new Response(JSON.stringify({ code: 'revision_conflict', message: 'A newer host revision exists.' }), { status: 409 })); await settle();
  f.setRoutine({ ...f.routine, revision: 3 }); const buttonBeforeChange = button(f.render(), 'Review my kept proposal'); assert.ok(buttonBeforeChange);
  const kept = { ...f.stored(), value: { ...f.stored().value, notes: 'Newer retained writing' }, ...(newer === 'command' ? { pending: { ...command, requestId: 'newer-request' } } : {}) }; f.write(kept);
  buttonBeforeChange.props.onClick();
  if (newer === 'command') assert.deepEqual(f.stored(), kept);
  else { assert.equal(f.stored().revision, 3); assert.equal(f.stored().pending, undefined); assert.equal(f.stored().value.notes, 'Newer retained writing'); }
  assert.deepEqual(f.responses, []); assert.deepEqual(f.departures, []);
});

test('review storage failure leaves original in-memory and retained pending authority available for the same explicit review', async t => {
  const f = fixture(t); let release!: (response: Response) => void;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Promise(resolve => { release = resolve; }); t.after(() => { globalThis.fetch = previous; });
  submit(f); release(new Response(JSON.stringify({ code: 'revision_conflict', message: 'Review the newer revision.' }), { status: 409 })); await settle();
  f.setRoutine({ ...f.routine, revision: 3 }); const before = f.stored(); f.full(true);
  button(f.render(), 'Review my kept proposal').props.onClick(); assert.deepEqual(f.stored(), before);
  assert.ok(f.render().some(node => node.type === 'span' && node.props.children === 'Checking original save'));
  f.full(false); button(f.render(), 'Review my kept proposal').props.onClick();
  assert.equal(f.stored().pending, undefined); assert.equal(f.stored().revision, 3);
});
