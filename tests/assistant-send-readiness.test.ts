import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Entity, Snapshot } from '../packages/domain/contracts';

const key = Symbol.for('nova.test.send-readiness');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const hooks = registerHooks({
  resolve(specifier, context, next) { return specifier === 'react' && context.parentURL?.includes('/apps/client/src/') ? { url: 'nova-test:send-readiness-react', shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
    if (url === 'nova-test:send-readiness-react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      export const useEffect=()=>{}; export const useCallback=v=>v;
      export const useState=initial=>{const f=globalThis[Symbol.for('nova.test.send-readiness')],i=f.index++;if(!(i in f.values))f.values[i]=typeof initial==='function'?initial():initial;return[f.values[i],v=>{f.values[i]=typeof v==='function'?v(f.values[i]):v;}];};
      export const useRef=v=>useState(()=>({current:v}))[0];` };
    return next(url, context);
  },
});
const { useRetained, retainedWindowId } = await import('../apps/client/src/useWorkspace');
hooks.deregister();
type Draft = { text: string; attachments: unknown[] };
function fixture(t: any) {
  const storage = new Map<string, string>(), state = { index: 0, values: [] as any[] };
  const properties = [key, 'localStorage', 'window'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  let full = false;
  Object.defineProperty(globalThis, key, { configurable: true, value: state });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { if (full) throw Error('full'); storage.set(k, v); } } });
  t.after(() => { for (const [k, d] of properties) { if (d) Object.defineProperty(globalThis, k, d); else Reflect.deleteProperty(globalThis, k); } });
  const snapshot = { epoch: 'epoch', deviceId: 'device', draftRemovals: [] } as unknown as Snapshot;
  const entity: Entity<Draft> = { id: 'draft:device:chat', deviceId: 'device', revision: 7, value: { text: 'Saved', attachments: [] }, updatedAt: '2026-10-15T00:00:00Z' };
  const render = () => { state.index = 0; return useRetained('draft', entity.id, entity.value, entity, snapshot, async () => {}, { autoSave: false }); };
  const change = (text: string) => render().change({ text, attachments: [] });
  const journalKey = `e3:journal:device:${entity.id}:${retainedWindowId}`;
  return { render, change, snapshot, entity, storage, journalKey, full: () => { full = true; }, remount: () => { state.values = []; return render(); } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

test('Send saves debounce-pending typing immediately and returns its acknowledged revision', async t => {
  const f = fixture(t), calls: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: any, init: RequestInit) => { const c = JSON.parse(String(init.body)); calls.push(c); assert.deepEqual(JSON.parse(f.storage.get(f.journalKey)!).pending, c, 'write-ahead receipt precedes the request'); return Response.json({ ...f.entity, revision: 8, value: c.payload }); });
  f.change('Finished typing');
  assert.equal(f.render().dirty, true); assert.equal(f.render().submitBlocked, false);
  const saving = f.render().flushForSubmit(); assert.equal(calls.length, 1, 'no debounce timer needs to elapse');
  assert.deepEqual(await saving, { value: { text: 'Finished typing', attachments: [] }, revision: 8, epoch: 'epoch' });
  assert.equal(f.render().dirty, false);
});

test('Send joins an active save without duplicating its immutable request', async t => {
  const f = fixture(t), gate = deferred(), calls: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: any, init: RequestInit) => { const c = JSON.parse(String(init.body)); calls.push(c); await gate.promise; return Response.json({ ...f.entity, revision: 8, value: c.payload }); });
  f.change('Sending'); const autoSave = f.render().flush();
  assert.equal(f.render().submitBlocked, false); const sending = f.render().flushForSubmit();
  assert.equal(calls.length, 1); gate.resolve(); await autoSave;
  assert.equal((await sending).revision, 8); assert.equal(calls.length, 1);
});

test('Send finishes an older active save then saves the exact text present when pressed', async t => {
  const f = fixture(t), gate = deferred(), calls: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: any, init: RequestInit) => { const c = JSON.parse(String(init.body)); calls.push(c); const revision = 7 + calls.length; if (calls.length === 1) await gate.promise; return Response.json({ ...f.entity, revision, value: c.payload }); });
  f.change('Earlier typing'); const autoSave = f.render().flush(); f.change('Finished typing');
  const sending = f.render().flushForSubmit(); gate.resolve(); await autoSave;
  const acknowledged = await sending;
  assert.equal(calls.length, 2); assert.equal(calls[1].expectedRevision, 8); assert.equal(calls[1].payload.text, 'Finished typing');
  assert.equal(acknowledged.revision, 9); assert.equal(acknowledged.value.text, 'Finished typing');
});

test('typing after Send keeps the newer draft and refuses to submit a stale capture', async t => {
  const f = fixture(t), gate = deferred(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: any, init: RequestInit) => { calls++; const c = JSON.parse(String(init.body)); await gate.promise; return Response.json({ ...f.entity, revision: 8, value: c.payload }); });
  f.change('At Send'); const sending = f.render().flushForSubmit(); f.change('Still typing');
  gate.resolve(); await assert.rejects(sending, /changed while it was saving/);
  assert.equal(calls, 1); assert.equal(f.render().value.text, 'Still typing'); assert.equal(f.render().dirty, true);
});

test('a lost save response remains locked and Send does not replay or replace its receipt', async t => {
  const f = fixture(t), calls: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: any, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); throw Error('lost'); });
  f.change('Kept'); await f.render().flush(); const pending = f.render().pending;
  assert.equal(f.render().submitBlocked, true); await assert.rejects(f.render().flushForSubmit(), /unconfirmed/);
  assert.deepEqual(f.render().pending, pending); assert.equal(calls.length, 1);
  const restored = f.remount(); await assert.rejects(restored.flushForSubmit(), /unconfirmed/); assert.equal(calls.length, 1);
});

test('loss during the save joined by Send never yields a sendable draft', async t => {
  const f = fixture(t), gate = deferred(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; await gate.promise; throw Error('lost'); });
  f.change('Kept'); const save = f.render().flush(), sending = f.render().flushForSubmit(); gate.resolve(); await save;
  await assert.rejects(sending, /unconfirmed/); assert.equal(calls, 1); assert.ok(f.render().pending);
});

test('storage refusal prevents the draft write and does not yield a captured submission', async t => {
  const f = fixture(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('unexpected'); });
  f.change('Keep locally'); f.full();
  await assert.rejects(f.render().flushForSubmit(), /could not be saved/);
  assert.equal(calls, 0); assert.equal(f.render().value.text, 'Keep locally'); assert.equal(f.render().storageError, true);
});

test('a revision conflict during Send preserves writing and blocks submission', async t => {
  const f = fixture(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ code: 'revision_conflict', message: 'Another edit needs review', current: { ...f.entity, revision: 9 } }, { status: 409 }); });
  f.change('My writing'); await assert.rejects(f.render().flushForSubmit(), /needs review/);
  assert.equal(f.render().submitBlocked, true); await assert.rejects(f.render().flushForSubmit(), /needs review/); assert.equal(calls, 1);
  assert.equal(f.render().value.text, 'My writing');
});

test('a workspace switch while saving prevents the old owner from providing a submission', async t => {
  const f = fixture(t), gate = deferred();
  t.mock.method(globalThis, 'fetch', async (_url: any, init: RequestInit) => { const c = JSON.parse(String(init.body)); await gate.promise; return Response.json({ ...f.entity, revision: 8, value: c.payload }); });
  f.change('Kept'); const sending = f.render().flushForSubmit(); f.snapshot.epoch = 'recovered'; f.render(); gate.resolve();
  await assert.rejects(sending, /changed location/); assert.ok(f.render().pending);
});

test('an already acknowledged draft needs no additional write', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => { throw Error('must not write'); });
  assert.deepEqual(await f.render().flushForSubmit(), { value: f.entity.value, revision: 7, epoch: 'epoch' });
});
