import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Command, Entity, Snapshot } from '../packages/domain/contracts';

// Reuse the actual-hook state/effect/timer approach from assistant-feature-races
// and home-assistant-handoff. Only browser ports and React scheduling are fake.
const fixtureKey = Symbol.for('nova.test.retained-autosave-pending');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
  resolve(specifier, context, next) { return specifier === 'react' && context.parentURL?.includes('/apps/client/src/useWorkspace') ? { url: 'nova-test:retained-autosave-react', shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
    if (url === 'nova-test:retained-autosave-react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      export const useState=v=>globalThis[Symbol.for('nova.test.retained-autosave-pending')].state(v);
      export const useRef=v=>globalThis[Symbol.for('nova.test.retained-autosave-pending')].ref(v);
      export const useCallback=(v,d)=>globalThis[Symbol.for('nova.test.retained-autosave-pending')].memo(v,d);
      export const useEffect=(v,d)=>globalThis[Symbol.for('nova.test.retained-autosave-pending')].effect(v,d);` };
    return next(url, context);
  },
});
const { useRetained, retainedWindowId } = await import('../apps/client/src/useWorkspace');
loader.deregister();

type Writing = { text: string; attachments: string[] };
type WritingCommand = Command & { payload: Writing };
type Journal = ReturnType<typeof useRetained<Writing>>;
function fixture(t: any, options: { autoSave?: boolean; kept?: any } = {}) {
  let cursor = 0, dirty = true, mounted = true, now = 0, nextTimer = 0, full = false, refreshes = 0;
  let cells: any[] = [], journal: Journal;
  const effects: (() => void)[] = [], storage = new Map<string, string>();
  const timers = new Map<number, { at: number; run: () => void; interval?: number }>();
  const calls: { path: string; raw: string; command: WritingCommand }[] = [];
  const snapshot = { epoch: 'epoch', deviceId: 'device', draftRemovals: [] } as unknown as Snapshot;
  const entity: Entity<Writing> = { id: 'draft:device:chat', deviceId: 'device', revision: 7, value: { text: 'Saved writing', attachments: ['kept-file'] }, updatedAt: '2026-10-21T00:00:00Z' };
  const key = `e3:journal:device:${entity.id}:${retainedWindowId}`;
  if (options.kept) storage.set(key, JSON.stringify(options.kept));
  let respond: (command: WritingCommand) => Response | Promise<Response> = command => Response.json({ ...entity, revision: 7 + calls.length, value: command.payload });
  const refresh = async () => { refreshes++; };
  const setTimer = (run: () => void, delay: number, interval?: number) => { const id = ++nextTimer; timers.set(id, { at: now + delay, run, interval }); return id; };
  const changed = (before: unknown[] | undefined, after: unknown[]) => !before || before.length !== after.length || after.some((v, i) => !Object.is(v, before[i]));
  const hooks = {
    state(initial: any) { const i = cursor++; if (!(i in cells)) cells[i] = { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, (next: any) => { const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true; } }]; },
    ref(initial: any) { return cells[cursor++] ??= { current: initial }; },
    memo(value: any, deps: unknown[]) { const i = cursor++, prior = cells[i]; if (changed(prior?.deps, deps)) cells[i] = { value, deps }; return cells[i].value; },
    effect(run: () => void | (() => void), deps: unknown[]) { const i = cursor++, prior = cells[i]; if (changed(prior?.deps, deps)) { cells[i] = { deps, run, cleanup: prior?.cleanup }; effects.push(() => { cells[i].cleanup?.(); cells[i].cleanup = run(); }); } },
  };
  const values: Record<PropertyKey, unknown> = {
    [fixtureKey]: hooks, window: new EventTarget(),
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, value: string) => { if (full) throw Error('Storage full'); storage.set(k, value); } },
    setTimeout: (run: () => void, delay: number) => setTimer(run, delay), clearTimeout: (id: number) => timers.delete(id),
    setInterval: (run: () => void, delay: number) => setTimer(run, delay, delay), clearInterval: (id: number) => timers.delete(id),
    fetch: async (path: string, init: RequestInit) => {
      assert.equal(path, '/api/commands'); assert.equal(init.method, 'POST');
      const raw = String(init.body), command = JSON.parse(raw); calls.push({ path, raw, command });
      assert.deepEqual(JSON.parse(storage.get(key)!).pending, command, 'the original receipt is durable before dispatch');
      return respond(command);
    },
  };
  const descriptors = Reflect.ownKeys(values).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  for (const k of Reflect.ownKeys(values)) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: values[k] });
  const render = () => { dirty = false; cursor = 0; journal = useRetained('draft', entity.id, entity.value, entity, snapshot, refresh, { autoSave: options.autoSave }); while (effects.length) effects.shift()!(); return journal; };
  const settle = async () => { for (let pass = 0; pass < 20; pass++) { if (mounted && dirty) render(); for (let tick = 0; tick < 10; tick++) await Promise.resolve(); } };
  const unmount = () => { for (const cell of cells) { cell?.cleanup?.(); if (cell) cell.cleanup = undefined; } mounted = false; };
  t.after(() => { unmount(); for (const [k, d] of descriptors) if (d) Object.defineProperty(globalThis, k, d); else Reflect.deleteProperty(globalThis, k); });
  render();
  return {
    calls, storage, key, snapshot, entity, settle, unmount, render, get journal() { return journal; }, get refreshes() { return refreshes; },
    respond(next: typeof respond) { respond = next; }, full(value: boolean) { full = value; },
    change(text: string) { return journal.change({ ...journal.value, text }); },
    saved() { return JSON.parse(storage.get(key)!); },
    timerCallbacks() { return [...timers.values()].map(timer => timer.run); },
    strictReplay() { for (const cell of cells) if (cell?.run) { cell.cleanup?.(); cell.cleanup = cell.run(); } },
    async remount() { unmount(); cells = []; dirty = mounted = true; render(); await settle(); },
    async advance(ms: number) {
      await settle(); const until = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break;
        const [id, timer] = next; timers.delete(id); now = timer.at; if (timer.interval) timers.set(id, { ...timer, at: now + timer.interval }); timer.run(); await settle();
      }
      now = until; await settle();
    },
  };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const denied = () => Response.json({ code: 'readonly_fixture', message: 'Write denied' }, { status: 403 });

test('normal first autosave waits for debounce and acknowledges once; clean intervals never write', async t => {
  const f = fixture(t); f.change('First writing'); await f.advance(599); assert.equal(f.calls.length, 0);
  await f.advance(1); assert.equal(f.calls.length, 1); assert.equal(f.journal.dirty, false); assert.equal(f.journal.pending, undefined);
  assert.equal(f.calls[0].command.payload.text, 'First writing'); await f.advance(20000); assert.equal(f.calls.length, 1);
});

test('403 leaves one original receipt held through recurring timers and later edits', async t => {
  const f = fixture(t); f.respond(denied); f.change('Original proposal'); await f.advance(600);
  const pending = f.saved().pending; assert.equal(f.calls.length, 1); assert.ok(f.journal.status.includes('save unconfirmed'));
  f.change('Newer writing'); await f.advance(20000);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.saved().pending, pending); assert.equal(f.saved().value.text, 'Newer writing');
  await assert.rejects(f.journal.flushForSubmit(), /unconfirmed/); assert.equal(f.calls.length, 1);
});

test('timer callbacks check the live receipt even before a pending state rerenders', async t => {
  const f = fixture(t); f.respond(denied); f.change('Captured original'); await f.settle();
  const callbacks = f.timerCallbacks(), saving = f.journal.flush();
  callbacks.forEach(run => run()); await saving; callbacks.forEach(run => run()); await f.settle();
  assert.equal(f.calls.length, 1); assert.ok(f.journal.pending);
});

test('lost response and reload hold exact original bytes and expose unconfirmed status without an ephemeral error flag', async t => {
  const f = fixture(t); f.respond(() => { throw Error('Response lost'); }); f.change('Kept writing'); await f.advance(600);
  const raw = f.storage.get(f.key); await f.remount();
  assert.equal(f.journal.networkError, false); assert.ok(f.journal.status.includes('save unconfirmed')); assert.equal(f.journal.submitBlocked, true);
  await f.advance(20000); assert.equal(f.calls.length, 1); assert.equal(f.storage.get(f.key), raw);
});

test('explicit Retry returns the original acknowledgment before newer writing autosaves with a new receipt', async t => {
  const f = fixture(t); f.respond(denied); f.change('Original proposal'); await f.advance(600); await f.remount();
  f.change('Newer retained proposal'); await f.advance(600);
  f.respond(command => Response.json({ ...f.entity, revision: f.calls.length === 2 ? 8 : 9, value: command.payload }));
  const result = await f.journal.flush({ text: 'Override must not replace original', attachments: [] }); await f.settle();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].raw, f.calls[0].raw); assert.equal(result?.revision, 8); assert.equal(result?.value.text, 'Original proposal');
  assert.equal(f.journal.value.text, 'Newer retained proposal'); assert.equal(f.journal.dirty, true); assert.equal(f.journal.pending, undefined);
  await f.advance(4000); assert.equal(f.calls.length, 3); assert.notEqual(f.calls[2].command.requestId, f.calls[0].command.requestId);
  assert.equal(f.calls[2].command.expectedRevision, 8); assert.equal(f.calls[2].command.payload.text, 'Newer retained proposal'); assert.equal(f.journal.dirty, false);
});

test('in-flight edits do not duplicate a save and resume autosave after the older acknowledgment', async t => {
  const f = fixture(t), gate = deferred<Response>(); f.respond(() => gate.promise); f.change('First'); await f.advance(600);
  f.change('Second'); await f.advance(8000); assert.equal(f.calls.length, 1); assert.equal(f.journal.saving, true);
  f.respond(command => Response.json({ ...f.entity, revision: 9, value: command.payload }));
  gate.resolve(Response.json({ ...f.entity, revision: 8, value: f.calls[0].command.payload })); await f.settle();
  assert.equal(f.journal.value.text, 'Second'); assert.equal(f.journal.dirty, true);
  await f.advance(4000); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].command.expectedRevision, 8); assert.equal(f.calls[1].command.payload.text, 'Second');
});

test('storage refusal prevents dispatch, preserves durable bytes, and requires an explicit retry of the in-window receipt', async t => {
  const f = fixture(t); f.change('Durable prior writing'); await f.settle(); const before = f.storage.get(f.key);
  f.full(true); f.change('Window-only writing'); await f.advance(600);
  assert.equal(f.calls.length, 0); assert.equal(f.storage.get(f.key), before); assert.equal(f.journal.storageError, true); assert.equal(f.journal.value.text, 'Window-only writing');
  const pending = f.journal.pending; f.full(false); await f.advance(12000); assert.equal(f.calls.length, 0); assert.deepEqual(f.journal.pending, pending);
  await f.journal.flush(); await f.settle(); assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].command, pending); assert.equal(f.journal.dirty, false);
});

test('retired owner timer callbacks and late acknowledgments cannot replay or replace the next owner', async t => {
  const f = fixture(t), gate = deferred<Response>(); f.respond(() => gate.promise); f.change('Original'); await f.settle();
  const staleTimers = f.timerCallbacks(); await f.advance(600); const raw = f.storage.get(f.key);
  await f.remount(); staleTimers.forEach(run => run()); await f.advance(8000); assert.equal(f.calls.length, 1);
  gate.resolve(Response.json({ ...f.entity, revision: 8, value: f.calls[0].command.payload })); await f.settle();
  assert.equal(f.storage.get(f.key), raw); assert.equal(f.refreshes, 0); assert.ok(f.journal.pending);
});

test('a clean pending-free retired owner cannot start a save from a queued old timer', async t => {
  const f = fixture(t); f.change('Kept but not sent'); await f.settle(); const staleTimers = f.timerCallbacks(); f.unmount();
  staleTimers.forEach(run => run()); await f.settle(); assert.equal(f.calls.length, 0); assert.equal(f.saved().value.text, 'Kept but not sent');
});

test('workspace replacement and revision conflicts hold writing without automatic rebases', async t => {
  const f = fixture(t); f.respond(() => Response.json({ code: 'revision_conflict', message: 'Review the saved version', current: { ...f.entity, revision: 9 } }, { status: 409 }));
  f.change('Kept conflict'); await f.advance(600); const raw = f.storage.get(f.key); await f.advance(8000);
  assert.equal(f.calls.length, 1); assert.equal(f.storage.get(f.key), raw); assert.equal(f.journal.conflict?.code, 'revision_conflict');
  f.snapshot.epoch = 'replacement'; f.render(); await f.advance(8000); assert.equal(f.calls.length, 1); assert.equal(f.journal.value.text, 'Kept conflict');
});

test('Strict Mode effect replay holds the first original request until explicit retry', async t => {
  const f = fixture(t), gate = deferred<Response>(); f.respond(() => gate.promise); f.change('Original'); await f.advance(600);
  f.strictReplay(); await f.advance(8000); assert.equal(f.calls.length, 1);
  gate.resolve(Response.json({ ...f.entity, revision: 8, value: f.calls[0].command.payload })); await f.settle();
  assert.ok(f.journal.pending); assert.equal(f.refreshes, 0);
});

test('explicit-only editors do not create automatic saves and keep their existing manual flush route', async t => {
  const f = fixture(t, { autoSave: false }); f.change('Manual proposal'); await f.advance(20000); assert.equal(f.calls.length, 0);
  const saved = await f.journal.flush(); await f.settle(); assert.equal(saved?.value.text, 'Manual proposal'); assert.equal(f.calls.length, 1);
});
