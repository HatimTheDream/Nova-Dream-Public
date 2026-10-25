import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';
import { defaultLayout, type Entity, type Snapshot } from '../packages/domain/contracts';
import { blankRecord, type Content } from '../packages/domain/workspace-records';

const hookKey = Symbol.for('nova.test.content-recovery'), react = import.meta.resolve('react');
const loader = registerHooks({
  resolve(name, context, next) {
    return name === 'react' && context.parentURL?.includes('/apps/client/src/')
      ? { url: 'nova-test:content-recovery', shortCircuit: true } : next(name, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:content-recovery') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      const h=()=>globalThis[Symbol.for('nova.test.content-recovery')];
      export const useState=v=>h().state(v),useRef=v=>h().ref(v),useId=()=>h().memo(()=>crypto.randomUUID(),[]);
      export const useEffect=(f,d)=>h().effect(f,d),useLayoutEffect=useEffect;
      export const useMemo=(f,d)=>h().memo(f,d),useCallback=(f,d)=>h().memo(()=>f,d);` };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  },
});
const { default: ContentEditor } = await import('../apps/client/src/ContentEditor');
const { retainedWindowId } = await import('../apps/client/src/useWorkspace');
loader.deregister();
const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const button = (tree: any, label: string) => nodes(tree).find(n => n.type === 'button' && text(n) === label);

// Real editor and retained hook with synthetic event/hook ports. No browser or host acceptance.
function fixture() {
  let cursor = 0, dirty = true, tree: any, full = false, offline = false, loseReply = false, closed = 0, holdReply = false, failAckRetention = false;
  let finishReply: (() => void) | undefined;
  let cells: any[] = [], effects: (() => void)[] = [];
  const rows = new Map<string, string>(), calls: any[] = [], epoch = randomUUID(), deviceId = randomUUID();
  const value = { ...blankRecord('content', 'UTC') as Content, title: 'Content Original', body: 'Complete original writing', brief: 'A brief' };
  let remote: Entity<Content> = { id: 'content:original', revision: 3, value, deviceId, updatedAt: '2026-10-20T00:00:00.000Z' };
  let entity = remote;
  const snapshot: Snapshot = { epoch, deviceId, cursor: 0, tasks: [], drafts: [], projects: [],
    layout: { id: 'layout', revision: 1, value: defaultLayout, deviceId, updatedAt: remote.updatedAt },
    capabilities: { assistant: false, voice: false, reason: 'Synthetic fixture' },
    records: { content: [remote], agent: [], assignment: [], profile: [], contact: [] } };
  const windowPort = new EventTarget();
  const values: Record<PropertyKey, unknown> = {
    [hookKey]: {
      state(value: any) { const i = cursor++; cells[i] ??= { value: typeof value === 'function' ? value() : value }; return [cells[i].value, (next: any) => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next; dirty = true; }]; },
      ref(value: any) { return cells[cursor++] ??= { current: value }; },
      memo(read: () => unknown, deps: unknown[]) { const i = cursor++, prior = cells[i]; if (!prior || deps.some((v, k) => !Object.is(v, prior.deps[k]))) cells[i] = { deps, value: read() }; return cells[i].value; },
      effect(run: () => void | (() => void), deps: unknown[]) { const i = cursor++, prior = cells[i]; if (!prior || deps.some((v, k) => !Object.is(v, prior.deps[k]))) { cells[i] = { deps, cleanup: prior?.cleanup }; effects.push(() => { cells[i].cleanup?.(); cells[i].cleanup = run(); }); } },
    },
    window: windowPort, navigator: { get onLine() { return !offline; } }, document: { hidden: false },
    localStorage: { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, raw: string) => { if (full) throw Error('Full storage'); rows.set(key, raw); } },
    setInterval: () => 0, clearInterval: () => {},
    fetch: async (path: string, init: RequestInit) => {
      if (path.endsWith('/content/library')) return Response.json([]);
      if (path.includes('/content/state?')) return Response.json({ jobs: [], reviews: [] });
      assert.equal(path, '/api/commands'); const c = JSON.parse(String(init.body)); calls.push(c);
      if (c.expectedRevision !== remote.revision) {
        const original = calls.find(old => old.requestId === c.requestId && old !== c);
        if (original) return Response.json(remote);
        return Response.json({ code: 'revision_conflict', message: 'A newer saved version is available.', current: remote }, { status: 409 });
      }
      remote = { ...remote, revision: remote.revision + 1, value: c.payload, updatedAt: '2026-10-20T01:00:00.000Z' };
      if (failAckRetention) { failAckRetention = false; full = true; }
      if (loseReply) { loseReply = false; throw Error('Lost acknowledgement'); }
      if (holdReply) { holdReply = false; const captured = remote; return new Promise<Response>(resolve => { finishReply = () => resolve(Response.json(captured)); }); }
      return Response.json(remote);
    },
  };
  const originals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, value: values[key] });
  const props = () => ({ id: entity.id, entity, snapshot, refresh: async () => { entity = remote; snapshot.records!.content = [remote]; dirty = true; },
    editTask() {}, close() { closed++; }, removeDraft() {}, openSource() {} });
  const cleanup = () => { for (const cell of cells) cell?.cleanup?.(); };
  return { rows, calls, snapshot, get tree() { return tree; }, get entity() { return entity; },
    key: `e3:journal:${deviceId}:${entity.id}:${retainedWindowId}`,
    recovery: () => JSON.parse([...rows.entries()].find(([key]) => key.startsWith('e3:content-recovery:'))![1]),
    async flush() { for (let n = 0; n < 25; n++) { if (dirty) { dirty = false; cursor = 0; tree = ContentEditor(props()); while (effects.length) effects.shift()!(); } await new Promise(resolve => setImmediate(resolve)); } },
    full(value: boolean) { full = value; },
    offline(value: boolean) { offline = value; windowPort.dispatchEvent(new Event(value ? 'offline' : 'online')); },
    loseReply() { loseReply = true; },
    holdReply() { holdReply = true; },
    failAckRetention() { failAckRetention = true; },
    completeReply() { assert(finishReply); finishReply(); finishReply = undefined; },
    remoteChange() { remote = { ...remote, revision: remote.revision + 1, value: { ...remote.value, body: 'Newer host writing' } }; },
    refresh() { entity = remote; snapshot.records!.content = [remote]; dirty = true; },
    remount() { cleanup(); cells = []; effects = []; dirty = true; },
    close() { cleanup(); for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); },
  };
}
const writing = (tree: any) => nodes(tree).find(n => n.type?.name === 'ContentWriting');
const details = (tree: any) => nodes(tree).find(n => n.type?.name === 'ContentRecoveryDetails');

test('Content keeps local/offline status independent, details close preserves writing and reconnect never saves', async () => {
  const f = fixture();
  try {
    await f.flush(); writing(f.tree).props.change({ body: 'New unsaved writing' }); await f.flush();
    assert.match(text(f.tree), /Changes Kept On This Device/);
    f.offline(true); await f.flush(); assert.match(text(f.tree), /Changes Kept On This Device · Offline/);
    button(f.tree, 'Details').props.onClick(); await f.flush(); assert.equal(details(f.tree).props.editor.value.body, 'New unsaved writing');
    nodes(f.tree).find(n => n.type?.name === 'ContentRecoveryPanel').props.close(); await f.flush();
    assert.equal(writing(f.tree).props.value.body, 'New unsaved writing');
    f.offline(false); await f.flush(); assert.equal(f.calls.length, 0);
    assert.equal(button(f.tree, 'Archive Content').props.disabled, true);
  } finally { f.close(); }
});

test('Content archive acknowledgement enables exact Undo, which creates its explicit inverse version once', async () => {
  const f = fixture();
  try {
    await f.flush(); button(f.tree, 'Archive Content').props.onClick(); await f.flush();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].payload.archived, true);
    assert.equal(button(f.tree, 'Undo Archive').props.disabled, false);
    const archive = f.recovery().archives[0];
    assert.equal(archive.acknowledgement.command.requestId, f.calls[0].requestId);
    f.remount(); await f.flush(); assert(button(f.tree, 'Undo Archive'));
    button(f.tree, 'Undo Archive').props.onClick(); await f.flush();
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].expectedRevision, 4); assert.equal(f.calls[1].payload.archived, false);
    assert.equal(button(f.tree, 'Undo Archive'), undefined); assert.equal(f.recovery().archives[0].undo.command.requestId, f.calls[1].requestId);
  } finally { f.close(); }
});

test('unconfirmed archived save remains locked but can reconcile its exact original request after reload', async () => {
  const f = fixture();
  try {
    await f.flush(); f.loseReply(); button(f.tree, 'Archive Content').props.onClick(); await f.flush();
    assert.equal(f.calls.length, 1); assert.match(text(f.tree), /Save Unconfirmed/); assert.equal(button(f.tree, 'Undo Archive'), undefined);
    assert.equal(nodes(f.tree).find(n => n.type === 'fieldset').props.disabled, true);
    f.remount(); await f.flush();
    assert.equal(button(f.tree, 'Check Original Save').props.disabled, false);
    button(f.tree, 'Check Original Save').props.onClick(); await f.flush();
    assert.deepEqual(f.calls[1], f.calls[0]); assert.equal(f.entity.revision, 4); assert(button(f.tree, 'Undo Archive'));
  } finally { f.close(); }
});

test('Content conflict comparison retains both originals and prepares writing without another save', async () => {
  const f = fixture();
  try {
    await f.flush(); writing(f.tree).props.change({ body: 'My kept writing' }); await f.flush();
    f.remoteChange(); button(f.tree, 'Save Version').props.onClick(); await f.flush();
    assert.equal(f.calls.length, 1); button(f.tree, 'Compare Versions').props.onClick(); await f.flush();
    const view = details(f.tree);
    assert.equal(view.props.editor.value.body, 'My kept writing'); assert.equal(view.props.latest.value.body, 'Newer host writing');
    assert.equal(view.props.canPrepare, true); view.props.prepare(false); await f.flush();
    assert.equal(f.calls.length, 1); assert.equal(writing(f.tree).props.value.body, 'My kept writing');
    const copy = f.recovery().copies[0];
    assert.equal(JSON.parse(copy.original).value.body, 'My kept writing'); assert.equal(copy.saved.value.body, 'Newer host writing');
    button(f.tree, 'Save Version').props.onClick(); await f.flush();
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].expectedRevision, 4); assert.equal(f.calls[1].payload.body, 'My kept writing');
  } finally { f.close(); }
});

test('Content conflict retention failure keeps the unresolved editor and blocks archive and rebase', async () => {
  const f = fixture();
  try {
    await f.flush(); writing(f.tree).props.change({ body: 'Window writing' }); await f.flush();
    f.remoteChange(); button(f.tree, 'Save Version').props.onClick(); await f.flush();
    button(f.tree, 'Compare Versions').props.onClick(); await f.flush(); f.full(true);
    details(f.tree).props.prepare(true); await f.flush();
    assert.equal(details(f.tree).props.editor.value.body, 'Window writing');
    assert(details(f.tree).props.editor.conflict); assert.equal(f.calls.length, 1);
    assert.equal(button(f.tree, 'Archive Content').props.disabled, true);
  } finally { f.close(); }
});

test('a later saved revision removes stale archive Undo and pending Content commands guard archive actions', async () => {
  const f = fixture();
  try {
    await f.flush(); button(f.tree, 'Archive Content').props.onClick(); await f.flush(); assert(button(f.tree, 'Undo Archive'));
    f.remoteChange(); f.refresh(); await f.flush(); assert.equal(button(f.tree, 'Undo Archive'), undefined);
    f.rows.set(`e3:content-command:${f.snapshot.deviceId}:${f.snapshot.epoch}:${f.entity.id}`, JSON.stringify({ action: 'kept', requestId: randomUUID() }));
    f.remount(); await f.flush(); assert.equal(button(f.tree, 'Restore Content').props.disabled, true);
  } finally { f.close(); }
});

test('failed recovery intent storage prevents archive before any remote command', async () => {
  const f = fixture();
  try {
    await f.flush(); f.full(true); button(f.tree, 'Archive Content').props.onClick(); await f.flush();
    assert.equal(f.calls.length, 0); assert.equal(writing(f.tree).props.value.archived, false);
    assert(details(f.tree).props.recovery.error);
  } finally { f.close(); }
});

test('a late archive acknowledgement cannot create Undo in a replacement editor; original reconciliation can', async () => {
  const f = fixture();
  try {
    await f.flush(); f.holdReply(); button(f.tree, 'Archive Content').props.onClick(); await f.flush();
    assert.equal(f.calls.length, 1); const original = f.calls[0];
    f.remount(); await f.flush(); f.completeReply(); await f.flush();
    assert.equal(f.recovery().archives[0].acknowledgement, undefined);
    assert.equal(JSON.parse(f.rows.get(f.key)!).pending.requestId, original.requestId);
    assert.equal(button(f.tree, 'Undo Archive'), undefined);
    button(f.tree, 'Check Original Save').props.onClick(); await f.flush();
    assert.deepEqual(f.calls[1], original); assert(button(f.tree, 'Undo Archive'));
  } finally { f.close(); }
});

test('choosing a compared saved version prepares the editor and preserves the local original without saving', async () => {
  const f = fixture();
  try {
    await f.flush(); writing(f.tree).props.change({ body: 'My original retained text' }); await f.flush();
    f.remoteChange(); button(f.tree, 'Save Version').props.onClick(); await f.flush();
    button(f.tree, 'Compare Versions').props.onClick(); await f.flush(); details(f.tree).props.prepare(true); await f.flush();
    assert.equal(f.calls.length, 1); assert.equal(writing(f.tree).props.value.body, 'Newer host writing');
    assert.equal(button(f.tree, 'Save Version').props.disabled, false);
    assert.equal(JSON.parse(f.recovery().copies[0].original).value.body, 'My original retained text');
    assert.equal(button(f.tree, 'Archive Content').props.disabled, true);
  } finally { f.close(); }
});

test('an acknowledged archive whose local retention fails can keep its receipt without sending again', async () => {
  const f = fixture();
  try {
    await f.flush(); f.failAckRetention(); button(f.tree, 'Archive Content').props.onClick(); await f.flush();
    assert.equal(f.calls.length, 1); assert.equal(f.entity.value.archived, true);
    assert.match(text(f.tree), /Kept In This Window/); assert.equal(button(f.tree, 'Undo Archive'), undefined);
    button(f.tree, 'Details').props.onClick(); await f.flush(); f.full(false); details(f.tree).props.retry(); await f.flush();
    assert.equal(f.calls.length, 1); assert(button(f.tree, 'Undo Archive'));
    assert.equal(f.recovery().archives[0].acknowledgement.command.requestId, f.calls[0].requestId);
  } finally { f.close(); }
});
