import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { blankRecord, type Contact } from '../packages/domain/workspace-records';
import { defaultLayout, type Snapshot } from '../packages/domain/contracts';
import { recordJournalKey, type RecoveryScope } from '../apps/client/src/record-draft-recovery';
const key = Symbol.for('nova.test.record-recovery');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
 resolve(specifier, context, next) { return specifier === 'react' && context.parentURL?.includes('/apps/client/src/') ? { url: 'nova-test:record-recovery', shortCircuit: true } : next(specifier, context); },
 load(url, context, next) {
  if (url === 'nova-test:record-recovery') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
   const h=()=>globalThis[Symbol.for('nova.test.record-recovery')];
   export const useState=v=>h().state(v),useRef=v=>h().ref(v),useId=()=>h().id();
   export const useEffect=(f,d)=>h().effect(f,d),useLayoutEffect=useEffect;
   export const useMemo=(f,d)=>h().memo(f,d),useCallback=(f,d)=>h().memo(()=>f,d);` };
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
  return next(url, context);
 },
});
const { RecordDraftRecovery } = await import('../apps/client/src/RecordDraftRecovery');
const { RecordEditor } = await import('../apps/client/src/RecordEditor');
const { retainedWindowId } = await import('../apps/client/src/useWorkspace');
loader.deregister();
const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const button = (tree: any, label: string) => nodes(tree).find(node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label));
function fixture() {
 const scope: RecoveryScope = { kind: 'contact', deviceId: 'device', windowId: 'current', epoch: '00000000-0000-4000-8000-000000000001', records: [] };
 const id='contact:person',value={...blankRecord('contact','UTC'),name:'Kept Person',notes:'Original notes'} as Contact;
 const original={value,revision:0,epoch:scope.epoch,dirty:true};
 return {scope,id,original,sourceKey:recordJournalKey({...scope,windowId:'previous'},id),targetKey:recordJournalKey(scope,id)};
}
function host(initialComponent: (props: any) => any, initialProps: any, respond: (path: string, body: any) => unknown | Promise<unknown> = () => { throw new Error('Unexpected host request'); }) {
  let component = initialComponent, props = initialProps, cursor = 0, dirty = true, tree: any;
  let cells: any[] = [], effects: (() => void)[] = [];
  const frames: (() => void)[] = [], intervals = new Set<() => void>(), storage = new Map<string, string>(), calls: { path: string; body: any }[] = [];
  const values: Record<PropertyKey, unknown> = {
    [key]: {
      state(value: any) { const i = cursor++; if (!cells[i]) cells[i] = { value: typeof value === 'function' ? value() : value }; return [cells[i].value, (next: any) => { const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true; } }]; },
      ref(value: any) { return cells[cursor++] ??= { current: value }; },
      effect(run: () => void | (() => void), deps: unknown[]) { const i = cursor++, prior = cells[i]; if (!prior || deps.some((value, n) => !Object.is(value, prior.deps[n]))) { cells[i] = { deps, cleanup: prior?.cleanup }; effects.push(() => { cells[i].cleanup?.(); cells[i].cleanup = run(); }); } },
      id() { const i = cursor++; return (cells[i] ??= { value: `content-fixture-${i}` }).value; },
      memo(read: () => unknown, deps: unknown[]) { const i = cursor++, prior = cells[i]; if (!prior || deps.some((value, n) => !Object.is(value, prior.deps[n]))) cells[i] = { deps, value: read() }; return cells[i].value; },
    },
    window: { innerWidth: 1280, addEventListener() {}, removeEventListener() {} },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    localStorage: { get length() { return storage.size; }, key: (n: number) => [...storage.keys()][n] ?? null, getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    requestAnimationFrame: (run: () => void) => { frames.push(run); return frames.length; },
    setInterval: (run: () => void) => { intervals.add(run); return run; }, clearInterval: (run: () => void) => intervals.delete(run),
    fetch: async (path: string, init: RequestInit) => { const body = init.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path, body }); return new Response(JSON.stringify(await respond(path, body))); },
  };
  const originals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const flush = async () => { for (let pass = 0; pass < 25; pass++) { if (dirty) { dirty = false; cursor = 0; tree = component(props); while (effects.length) effects.shift()!(); } for (let tick = 0; tick < 10; tick++) await Promise.resolve(); } while (frames.length) frames.shift()!(); };
  const unmount = () => { for (const cell of cells) cell?.cleanup?.(); };
  return {
    flush, calls, storage, get tree() { return tree; },
    async update(next: any) { props = { ...props, ...next }; dirty = true; await flush(); },
    async mount(nextComponent = component, nextProps = props) { unmount(); cells = []; effects = []; component = nextComponent; props = nextProps; dirty = true; await flush(); },
    async poll() { for (const run of [...intervals]) run(); await flush(); },
    close() { unmount(); for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); },
  };
}

const selectFirst = (tree: any) => nodes(tree).find(node => node.type === 'button' && node.props.className === 'card record-list-item').props.onClick();
test('actual dialog previews without effects and copies before its explicit navigation callback', async () => {
 const f=fixture(), opened:string[]=[], app=host(RecordDraftRecovery,{scope:f.scope,canOpen:true,open:(id:string)=>{assert.equal(app.storage.get(f.targetKey),app.storage.get(f.sourceKey));opened.push(id);return true;},close:()=>{}});
 app.storage.set(f.sourceKey,JSON.stringify(f.original));
 try { await app.flush();selectFirst(app.tree);await app.flush();assert.match(text(app.tree),/Kept Person/);assert.equal(app.storage.has(f.targetKey),false);assert.deepEqual(app.calls,[]);
  button(app.tree,'Copy Into This Window').props.onClick();await app.flush();assert.deepEqual(opened,[f.id]);assert.deepEqual(JSON.parse(app.storage.get(f.targetKey)!),f.original);assert.deepEqual(app.calls,[]);
 } finally {app.close();}
});
test('index refusal keeps the copy and retries opening without copying or sending again', async () => {
 const f=fixture();let attempts=0,closed=0;
 const app=host(RecordDraftRecovery,{scope:f.scope,canOpen:true,open:()=>++attempts>1,close:()=>closed++});app.storage.set(f.sourceKey,JSON.stringify(f.original));
 try {await app.flush();selectFirst(app.tree);await app.flush();button(app.tree,'Copy Into This Window').props.onClick();await app.flush();
  assert.match(text(app.tree),/copy is kept/);assert.equal(closed,0);const copy=app.storage.get(f.targetKey);
  app.storage.set(f.sourceKey,JSON.stringify({...f.original,value:{...f.original.value,notes:'Other window continued'}}));
  button(app.tree,'Open Kept Copy').props.onClick();await app.flush();assert.equal(closed,1);assert.equal(attempts,2);assert.equal(app.storage.get(f.targetKey),copy);assert.deepEqual(app.calls,[]);
 } finally {app.close();}
});
test('changed destination after a refused navigation cannot be opened by the retained callback', async () => {
 const f=fixture();let attempts=0;const app=host(RecordDraftRecovery,{scope:f.scope,canOpen:true,open:()=>{attempts++;return false;},close:()=>{}});app.storage.set(f.sourceKey,JSON.stringify(f.original));
 try {await app.flush();selectFirst(app.tree);await app.flush();button(app.tree,'Copy Into This Window').props.onClick();await app.flush();
  const newer=JSON.stringify({...f.original,value:{...f.original.value,notes:'New current writing'}});app.storage.set(f.targetKey,newer);
  button(app.tree,'Open Kept Copy').props.onClick();await app.flush();assert.match(text(app.tree),/kept writing changed/);assert.equal(attempts,1);assert.equal(app.storage.get(f.targetKey),newer);assert.deepEqual(app.calls,[]);
 } finally {app.close();}
});
test('late scope change and a newly opened editor refuse the old recovery action', async () => {
 const f=fixture();let opens=0;const app=host(RecordDraftRecovery,{scope:f.scope,canOpen:true,open:()=>{opens++;return true;},close:()=>{}});app.storage.set(f.sourceKey,JSON.stringify(f.original));
 try {await app.flush();selectFirst(app.tree);await app.flush();await app.update({canOpen:false});
  assert.equal(button(app.tree,'Copy Into This Window').props.disabled,true);button(app.tree,'Copy Into This Window').props.onClick();await app.flush();assert.equal(opens,0);assert.equal(app.storage.has(f.targetKey),false);
  await app.update({canOpen:true,scope:{...f.scope,epoch:'00000000-0000-4000-8000-000000000003'}});button(app.tree,'Copy Into This Window').props.onClick();await app.flush();assert.match(text(app.tree),/earlier workspace/);assert.equal(opens,0);
 } finally {app.close();}
});
test('write refusal leaves the recovery dialog and source intact with no navigation', async () => {
 const f=fixture();let opens=0;const app=host(RecordDraftRecovery,{scope:f.scope,canOpen:true,open:()=>{opens++;return true;},close:()=>{}});const raw=JSON.stringify(f.original);app.storage.set(f.sourceKey,raw);
 try {await app.flush();selectFirst(app.tree);await app.flush();app.storage.set=()=>{throw Error('Synthetic storage refusal');};button(app.tree,'Copy Into This Window').props.onClick();await app.flush();
  assert.match(text(app.tree),/Synthetic storage refusal/);assert.equal(opens,0);assert.equal(app.storage.get(f.sourceKey),raw);assert.equal(app.storage.has(f.targetKey),false);assert.deepEqual(app.calls,[]);
 } finally {app.close();}
});
test('unindexed current-window copy is discoverable after dialog reload without any write', async () => {
 const f=fixture();let opens=0;const app=host(RecordDraftRecovery,{scope:f.scope,canOpen:true,open:()=>{opens++;return true;},close:()=>{}});app.storage.set(f.targetKey,JSON.stringify(f.original));
 try {await app.flush();await app.mount();selectFirst(app.tree);await app.flush();app.storage.set=()=>{throw Error('No write permitted for opening an existing branch');};button(app.tree,'Open This Window’s Writing').props.onClick();await app.flush();assert.equal(opens,1);assert.deepEqual(app.calls,[]);
 } finally {app.close();}
});
test('opening the real retained Contact editor sends no POST and keeps the original uncertain command', async () => {
 const f=fixture();f.scope.windowId=retainedWindowId;f.targetKey=recordJournalKey(f.scope,f.id);
 const pending={kind:'contact',entityId:f.id,requestId:'00000000-0000-4000-8000-000000000002',epoch:f.scope.epoch,expectedRevision:0,payload:f.original.value};
 const raw=JSON.stringify({...f.original,pending}),app=host(RecordDraftRecovery,{scope:f.scope,canOpen:true,open:()=>true,close:()=>{}});app.storage.set(f.sourceKey,raw);
 const snapshot:Snapshot={epoch:f.scope.epoch,deviceId:f.scope.deviceId,cursor:0,tasks:[],drafts:[],projects:[],layout:{id:'layout',revision:1,updatedAt:'',deviceId:f.scope.deviceId,value:{...structuredClone(defaultLayout),timezone:'UTC'}},capabilities:{assistant:false,voice:false,reason:'Isolated'},records:{contact:[],content:[],agent:[],assignment:[],profile:[]}};
 try {await app.flush();selectFirst(app.tree);await app.flush();button(app.tree,'Copy Into This Window').props.onClick();await app.flush();
  await app.mount(RecordEditor,{kind:'contact',id:f.id,snapshot,refresh:async()=>{},editTask:()=>{}});await app.poll();
  assert.deepEqual(app.calls,[]);assert.deepEqual(JSON.parse(app.storage.get(f.targetKey)!).pending,pending);assert.equal(app.storage.get(f.sourceKey),raw);assert.match(text(app.tree),/kept on this device/i);
 } finally {app.close();}
});
