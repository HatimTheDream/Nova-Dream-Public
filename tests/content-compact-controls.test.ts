import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { defaultLayout, type Snapshot } from '../packages/domain/contracts';
import { blankRecord, type Content } from '../packages/domain/workspace-records';
import type { ContentLibraryItem } from '../packages/domain/content-workspace';

// Exercise the real collection/library handlers with isolated hooks and local data.
// No production workspace, network request, download or agent command is used.
const key = Symbol.for('nova.test.content-compact');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
 resolve(specifier, context, next) { return specifier === 'react' && context.parentURL?.includes('/apps/client/src/') ? { url: 'nova-test:content-compact', shortCircuit: true } : next(specifier, context); },
 load(url, context, next) {
  if (url === 'nova-test:content-compact') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
   const h=()=>globalThis[Symbol.for('nova.test.content-compact')];
   export const useState=v=>h().state(v),useRef=v=>h().ref(v),useId=()=>h().id();
   export const useEffect=(f,d)=>h().effect(f,d),useLayoutEffect=useEffect;
   export const useMemo=(f,d)=>h().memo(f,d),useCallback=(f,d)=>h().memo(()=>f,d);` };
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
  return next(url, context);
 },
});
const { default: RecordsPage } = await import('../apps/client/src/RecordsPage');
const { ContentLibrary } = await import('../apps/client/src/ContentLibrary');
const {ContentExport,cleanContentExport}=await import('../apps/client/src/ContentExport');
const { retainedWindowId } = await import('../apps/client/src/useWorkspace');
loader.deregister();
const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const button = (tree: any, label: string) => nodes(tree).find(node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label));
const menu = (tree: any, label: string) => nodes(tree).find(node => (node.props.label === label || node.props.label?.startsWith(label + ':')) && typeof node.props.children === 'function')!.props.children(() => {});
const select = (tree: any, label: string) => nodes(nodes(tree).find(node => node.type === 'label' && text(node).startsWith(label))).find(node => node.type === 'select');
const search = (tree: any) => nodes(tree).find(node => node.type === 'input' && node.props.type === 'search');
const at = '2026-10-19T12:00:00Z';
function fixture() {
 const value = blankRecord('content', 'UTC') as Content;
 const snapshot: Snapshot = { epoch: 'fixture-epoch', deviceId: 'fixture-device', cursor: 0, tasks: [], drafts: [], projects: [], layout: { id: 'layout', revision: 1, updatedAt: at, deviceId: 'fixture-device', value: { ...structuredClone(defaultLayout), timezone: 'UTC' } }, capabilities: { assistant: false, voice: false, reason: 'Isolated fixture' }, records: { content: [
  { id: 'content:one', revision: 3, updatedAt: at, deviceId: 'fixture-device', value: { ...value, title: 'Keep My Launch', body: 'Original complete writing', stage: 'drafting', collection: 'Launch', tags: ['first'] } },
  { id: 'content:two', revision: 2, updatedAt: at, deviceId: 'fixture-device', value: { ...value, title: 'A Different Draft', stage: 'review' } },
 ], contact: [], agent: [], assignment: [], profile: [] } };
 const props: Parameters<typeof RecordsPage>[0] = { page: 'content', snapshot, refresh: async () => {}, editTask() {}, outputs: [], openContent() {}, openSource() {} };
 return { snapshot, props };
}
const indexKey = (kind = 'content') => `e3:record-index:fixture-device:${kind}:${retainedWindowId}`;
const viewKey = () => indexKey() + ':view';
const journalKey = (id: string) => `e3:journal:fixture-device:${id}:${retainedWindowId}`;
async function collection(app: ReturnType<typeof host>) { await app.flush(); const node = nodes(app.tree).find(node => node.type?.name === 'RecordCollection'); assert.ok(node); await app.mount(node.type, node.props); }
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
    window: Object.assign(new EventTarget(), { innerWidth: 1280 }),
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    requestAnimationFrame: (run: () => void) => { frames.push(run); return frames.length; },
    setInterval: (run: () => void) => { intervals.add(run); return run; }, clearInterval: (run: () => void) => intervals.delete(run),
    fetch: async (path: string, init: RequestInit) => { const body = init.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path, body });const value=await respond(path,body);return value instanceof Response?value:new Response(JSON.stringify(value)); },
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

test('Content preferences merge rapid search/filter/view changes and survive close, reload and reset', async () => {
 const f = fixture(), app = host(RecordsPage, f.props);
 try {
  await collection(app); button(app.tree, 'Search Content').props.onClick(); await app.flush();
  const prior = app.tree;
  search(prior).props.onChange({ target: { value: 'Launch' } });
  select(menu(prior, 'Filter Content'), 'Stage').props.onChange({ target: { value: 'drafting' } });
  button(prior, 'Calendar').props.onClick(); // All three handlers come from one render.
  await app.flush();
  const saved = JSON.parse(app.storage.get(viewKey())!);
  assert.equal(saved.query, 'Launch'); assert.equal(saved.stage, 'drafting'); assert.equal(saved.view, 'calendar');
  assert.equal(text(nodes(app.tree).find(node => node.type === 'h1')), 'Drafting');
  assert.match(text(app.tree), /1 Saved/);
  const planning = nodes(app.tree).find(node => node.type?.name === 'ContentPlanning');
  assert.deepEqual(planning.props.records, [f.snapshot.records!.content[0]]); assert.equal(planning.props.view, 'calendar');
  let prevented = false;
  nodes(app.tree).find(node => node.props.className === 'content-search-disclosure').props.onKeyDown({ key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() {} });
  await app.flush(); assert.equal(prevented, true); assert.equal(search(app.tree), undefined); assert.ok(button(app.tree, 'Search: Launch'));
  await app.mount(); assert.ok(button(app.tree, 'Search: Launch')); assert.equal(JSON.parse(app.storage.get(viewKey())!).view, 'calendar');
  button(menu(app.tree, 'Filter Content'), 'Reset Filters').props.onClick(); await app.flush();
  assert.equal(JSON.parse(app.storage.get(viewKey())!).query, 'Launch');
  let focused = false; button(app.tree, 'Search Content').props.ref.current = { focus() { focused = true; } };
  button(app.tree, 'Clear Content Search').props.onClick(); await app.flush(); assert.equal(focused, true); assert.equal(JSON.parse(app.storage.get(viewKey())!).query, '');
  assert.deepEqual(app.calls, []);
 } finally { app.close(); }
});

test('a full local store keeps the current query visible and does not erase saved preferences', async () => {
 const f = fixture(), app = host(RecordsPage, f.props);
 app.storage.set(viewKey(), JSON.stringify({ query: 'Launch', view: 'board', stage: 'drafting' }));
 try {
  await collection(app); button(app.tree, 'Search Content').props.onClick(); await app.flush();
  app.storage.set = () => { throw new Error('Synthetic quota failure'); };
  search(app.tree).props.onChange({ target: { value: 'Unpersisted query' } }); await app.flush();
  assert.equal(search(app.tree).props.value, 'Unpersisted query'); assert.match(text(app.tree), /This view is kept in the current window only/);
  assert.equal(JSON.parse(app.storage.get(viewKey())!).query, 'Launch'); assert.equal(JSON.parse(app.storage.get(viewKey())!).stage, 'drafting'); assert.deepEqual(app.calls, []);
 } finally { app.close(); }
});

test('view controls and returning from an editor preserve the original local draft and pending command', async () => {
 const f = fixture(), app = host(RecordsPage, f.props), id = 'content:unfinished';
 const journal = { value: { ...(blankRecord('content', 'UTC') as Content), title: 'Unfinished exact title', body: 'Do not discard this writing' }, dirty: true, revision: 0, epoch: f.snapshot.epoch, pending: { requestId: 'original-save', expectedRevision: 0, value: 'original envelope' } };
 const pending = { requestId: 'original-work', epoch: f.snapshot.epoch, type: 'work', contentId: id, expectedRevision: 3 };
 app.storage.set(indexKey(), JSON.stringify({ selected: id, drafts: [id] })); app.storage.set(journalKey(id), JSON.stringify(journal));
 const pendingKey = `e3:content-command:${f.snapshot.deviceId}:${f.snapshot.epoch}:${id}`; app.storage.set(pendingKey, JSON.stringify(pending));
 app.storage.set(viewKey(), JSON.stringify({ query: 'Launch', view: 'list', stage: 'drafting' }));
 try {
  await collection(app); const editor = nodes(app.tree).find(node => node.props.id === id && typeof node.props.close === 'function'); assert.ok(editor);
  editor.props.close(); await app.flush();
  button(menu(app.tree, 'Content View'), 'Board').props.onClick(); await app.flush();
  assert.equal(JSON.parse(app.storage.get(viewKey())!).query, 'Launch');
  button(app.tree, 'Unfinished content 1Kept on this device · resume writing').props.onClick({ currentTarget: null }); await app.flush();
  assert.equal(nodes(app.tree).find(node => node.props.id === id && typeof node.props.close === 'function').props.id, id);
  await app.mount();
  assert.equal(JSON.parse(app.storage.get(indexKey())!).selected, id);
  assert.deepEqual(JSON.parse(app.storage.get(journalKey(id))!), journal); assert.deepEqual(JSON.parse(app.storage.get(pendingKey)!), pending); assert.deepEqual(app.calls, []);
 } finally { app.close(); }
});

test('Start Something New opens existing routes without writing until an explicit blank draft choice', async () => {
 const f = fixture(), app = host(RecordsPage, f.props);
 try {
  await collection(app); const before = new Map(app.storage);
  button(app.tree, 'New Content').props.onClick(); await app.flush();
  const chooser = nodes(app.tree).find(node => node.props.title === 'Start Something New'); assert.equal(chooser.props.size, 'choice');
  assert.deepEqual(app.storage, before); button(chooser, 'Start With A Template').props.onClick(); await app.flush();
  const catalog = nodes(app.tree).find(node => node.props.initialSection === 'templates'); assert.ok(catalog); assert.equal(typeof catalog.props.useTemplate, 'function'); assert.deepEqual(app.storage, before);
  catalog.props.close(); await app.flush(); button(app.tree, 'New Content').props.onClick(); await app.flush(); button(app.tree, 'Use Saved Agent Result').props.onClick(); await app.flush();
  const output = nodes(app.tree).find(node => node.type?.name === 'ContentOutputLibrary'); assert.equal(output.props.outputs, f.props.outputs); assert.deepEqual(app.storage, before);
  output.props.close(); await app.flush(); button(app.tree, 'New Content').props.onClick(); await app.flush(); button(app.tree, 'Blank Draft').props.onClick(); await app.flush();
  const index = JSON.parse(app.storage.get(indexKey())!); assert.equal(index.drafts.length, 1); assert.match(index.selected, /^content:/);
  const journal = JSON.parse(app.storage.get(journalKey(index.selected))!); assert.equal(journal.dirty, true); assert.equal(journal.revision, 0); assert.equal(journal.epoch, f.snapshot.epoch);
  assert.deepEqual(app.calls, []);
 } finally { app.close(); }
});

test('Content-only controls leave the ordinary contact record route unchanged', async () => {
 const f = fixture(), app = host(RecordsPage, { ...f.props, page: 'contacts' });
 try {
  await app.flush(); assert.equal(text(nodes(app.tree).find(node => node.type === 'h1')), 'Contacts');
  await collection(app); assert.ok(button(app.tree, 'New Contact')); assert.ok(nodes(app.tree).find(node => node.props['aria-label'] === 'Search contact records'));
  assert.equal(button(app.tree, 'New Content'), undefined); assert.equal(nodes(app.tree).some(node => node.props.className === 'content-workspace-controls'), false);
  button(app.tree, 'New Contact').props.onClick(); await app.flush(); assert.equal(JSON.parse(app.storage.get(indexKey('contact'))!).drafts.length, 1); assert.deepEqual(app.calls, []);
 } finally { app.close(); }
});

const template: ContentLibraryItem = { id: 'library:template', type: 'template', revision: 7, name: 'Keep This Template', archived: false, guidance: '', brief: 'Exact original brief', body: '# Actual source\n\nFull template body', format: 'markdown', assets: [], platform: 'Article', collection: 'Launch', tags: ['retained'], brandId: 'library:brand' };
const brand: ContentLibraryItem = { ...template, id: 'library:brand', type: 'brand', name: 'Original Brand', guidance: 'Original guidance' };
test('template preview reads actual saved writing and uses that exact item without a library mutation', async () => {
 const f = fixture(), chosen: ContentLibraryItem[] = [], app = host(ContentLibrary, { snapshot: f.snapshot, initialSection: 'templates', close() {}, useTemplate(item: ContentLibraryItem) { chosen.push(item); } }, path => { assert.equal(path, '/api/content/library'); return [template, brand]; });
 try {
  await app.flush(); const card = nodes(app.tree).find(node => node.type === 'article' && text(node).includes(template.name)); assert.ok(card);
  button(card, 'Preview').props.onClick(); await app.flush();
  assert.ok(nodes(app.tree).find(node => node.type === 'pre' && text(node) === template.body)); assert.ok(nodes(app.tree).find(node => node.type === 'pre' && text(node) === template.brief));
  assert.deepEqual(chosen, []); button(app.tree, 'Use Template').props.onClick(); assert.deepEqual(chosen, [template]);
  button(app.tree, 'Back To Templates').props.onClick(); await app.flush(); button(app.tree, 'Brands').props.onClick(); await app.flush();
  assert.match(text(app.tree), /Original Brand/); assert.equal(nodes(app.tree).some(node => node.type === 'article' && text(node).includes(template.name)), false);
  assert.equal(app.calls.filter(call => call.path === '/api/content/workspace').length, 0);
 } finally { app.close(); }
});

test('opening Brands preserves a retained template editor and reconciles the exact pending library command', async () => {
 const f = fixture();f.snapshot.epoch=crypto.randomUUID();const draft = { ...template, body: 'Unfinished template writing' }, original = { type: 'library-save', expectedRevision: 7, item: draft, requestId: crypto.randomUUID(), epoch: f.snapshot.epoch };
 const app = host(ContentLibrary, { snapshot: f.snapshot, initialSection: 'brands', close() {} }, path => { if (path === '/api/content/library') return [template, brand]; throw new Error('Synthetic uncertain response'); });
 const draftKey = `e3:content-library-draft:${f.snapshot.deviceId}:${f.snapshot.epoch}:${retainedWindowId}`, pendingKey = `e3:content-command:${f.snapshot.deviceId}:${f.snapshot.epoch}:library`;
 app.storage.set(draftKey, JSON.stringify(draft)); app.storage.set(pendingKey, JSON.stringify(original));
 try {
  await app.flush(); assert.equal(app.tree.props.title, 'Edit Template'); const body = nodes(nodes(app.tree).find(node => node.type === 'label' && text(node).startsWith('Draft Structure'))).find(node => node.type === 'textarea'); assert.equal(body.props.value, draft.body);
  assert.equal(button(app.tree, 'Archive').props.disabled, true);
  button(app.tree, 'Check Original Library Save').props.onClick(); await app.flush();
  const reads = app.calls.filter(call => call.path === '/api/content/library/receipt'); assert.equal(reads.length, 1); assert.deepEqual(reads[0].body, original);
  assert.equal(app.calls.filter(call => call.path === '/api/content/workspace').length,0);
  button(app.tree,'Retry Original Library Save').props.onClick();await app.flush();assert.deepEqual(app.calls.find(call=>call.path==='/api/content/workspace')!.body,original);
  assert.deepEqual(JSON.parse(app.storage.get(draftKey)!), draft); assert.deepEqual(JSON.parse(app.storage.get(pendingKey)!), original);
  await app.mount(); assert.deepEqual(JSON.parse(app.storage.get(draftKey)!), draft); assert.deepEqual(JSON.parse(app.storage.get(pendingKey)!), original);
 } finally { app.close(); }
});
test('switching templates and Brands keeps independent raw fields and reopens them after reload',async()=>{
 const f=fixture(),app=host(ContentLibrary,{snapshot:f.snapshot,initialSection:'templates',close(){}},()=>[template,brand]);
 const field=(label:string)=>nodes(nodes(app.tree).find(n=>n.type==='label'&&text(n).startsWith(label))).find(n=>n.type==='input'||n.type==='textarea');
 try{
  await app.flush();button(nodes(app.tree).find(n=>n.type==='article'&&text(n).includes(template.name)),'Edit').props.onClick();await app.flush();
  field('Name').props.onChange({target:{value:'  My template  '}});field('Draft Structure').props.onChange({target:{value:'Independent template writing'}});await app.flush();
  const tags=nodes(app.tree).find(n=>n.type?.name==='ContentTagsInput');tags.props.onRawChange('first,  second, ',['first','second']);await app.flush();
  button(app.tree,'Back To Library').props.onClick();await app.flush();button(app.tree,'Brands').props.onClick();await app.flush();
  button(nodes(app.tree).find(n=>n.type==='article'&&text(n).includes(brand.name)),'Edit').props.onClick();await app.flush();
  field('Voice, Audience').props.onChange({target:{value:'Independent\nBrand guidance'}});await app.flush();button(app.tree,'Back To Library').props.onClick();await app.flush();
  button(app.tree,'  My template  ').props.onClick();await app.flush();await app.mount();
  assert.equal(field('Name').props.value,'  My template  ');assert.equal(field('Draft Structure').props.value,'Independent template writing');
  assert.equal(nodes(app.tree).find(n=>n.type?.name==='ContentTagsInput').props.rawValue,'first,  second, ');
  button(app.tree,'Back To Library').props.onClick();await app.flush();button(app.tree,brand.name).props.onClick();await app.flush();
  assert.equal(field('Voice, Audience').props.value,'Independent\nBrand guidance');assert.equal(app.calls.some(c=>c.path==='/api/content/workspace'),false);
 }finally{app.close();}
});
test('a recovered library acknowledgement updates its original base without replacing newer writing',async()=>{
 const f=fixture();f.snapshot.epoch=crypto.randomUUID();let command:any,observed=false,stored=template;
 const app=host(ContentLibrary,{snapshot:f.snapshot,initialSection:'templates',close(){}},(path,body)=>{
  if(path==='/api/content/library')return [stored,brand];
  if(path==='/api/content/workspace'){command=body;stored={...body.item,revision:body.expectedRevision+1};throw Error('Lost response');}
  if(path==='/api/content/library/receipt')return observed?{command,state:'saved',item:stored}:{command,state:'unknown'};
  throw Error(path);
 });
 const writing=()=>nodes(nodes(app.tree).find(n=>n.type==='label'&&text(n).startsWith('Draft Structure'))).find(n=>n.type==='textarea');
 try{
  await app.flush();button(nodes(app.tree).find(n=>n.type==='article'&&text(n).includes(template.name)),'Edit').props.onClick();await app.flush();
  writing().props.onChange({target:{value:'First save'}});await app.flush();nodes(app.tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await app.flush();
  assert(command);assert(button(app.tree,'Check Original Library Save'));writing().props.onChange({target:{value:'Newer unsaved writing'}});await app.flush();
  observed=true;button(app.tree,'Check Original Library Save').props.onClick();await app.flush();assert.equal(writing().props.value,'Newer unsaved writing');
  assert.equal(app.calls.filter(c=>c.path==='/api/content/workspace').length,1);assert.equal(button(app.tree,'Save Template').props.disabled,false);assert.match(text(app.tree),/Changes Kept/);
 }finally{app.close();}
});
test('exports require the exact clean saved version and reject a package that finishes after editing resumes',async()=>{
 const f=fixture(),entity=f.snapshot.records!.content[0];let allowed=true,finish:(r:Response)=>void=()=>{};
 assert(cleanContentExport(entity,entity.value,entity.revision,false));assert(!cleanContentExport(entity,{...entity.value,body:'Changed'},entity.revision,false));
 assert(!cleanContentExport(entity,entity.value,entity.revision,true));assert(!cleanContentExport(entity,entity.value,entity.revision+1,false));
 const app=host(ContentExport,{entity,scope:f.snapshot.epoch,allowed:()=>allowed,close(){},fallbackFocus:()=>null},()=>new Promise<Response>(resolve=>{finish=resolve;}));
 try{await app.flush();button(app.tree,'Prepare Draft And Assets').props.onClick();await app.flush();allowed=false;finish(new Response('original package',{headers:{'Content-Type':'application/zip'}}));await app.flush();
  assert.equal(button(app.tree,'Download Prepared Package'),undefined);assert.match(text(app.tree),/draft changed while preparing/);
 }finally{app.close();}
});
test('prepared exports request versioned exact files and become unavailable after a workspace change',async()=>{
 const f=fixture(),entity=f.snapshot.records!.content[0],downloads:string[]=[],blobs:Blob[]=[];
 const originalDocument=Object.getOwnPropertyDescriptor(globalThis,'document'),create=URL.createObjectURL,revoke=URL.revokeObjectURL;
 Object.defineProperty(globalThis,'document',{configurable:true,value:{body:{appendChild(){}},createElement(){return {href:'',download:'',click(){downloads.push(this.download);},remove(){}};}}});
 URL.createObjectURL=(blob:Blob)=>{blobs.push(blob);return 'blob:synthetic';};URL.revokeObjectURL=()=>{};
 const app=host(ContentExport,{entity,scope:f.snapshot.epoch,allowed:()=>true,close(){},fallbackFocus:()=>null},()=>new Response('exact synthetic ZIP bytes',{headers:{'Content-Type':'application/zip'}}));
 try{
  await app.flush();button(app.tree,'Download Text').props.onClick();await app.flush();assert.match(downloads[0],/-v3\.md$/);assert.equal(await blobs[0].text(),entity.value.body);assert.match(text(app.tree),/Download Requested/);
  button(app.tree,'Prepare Draft And Assets').props.onClick();await app.flush();assert.equal(downloads.length,1);assert.match(text(app.tree),/Prepared ·/);
  button(app.tree,'Download Prepared Package').props.onClick();await app.flush();assert.match(downloads[1],/-v3\.zip$/);assert.equal(await blobs[1].text(),'exact synthetic ZIP bytes');
  await app.update({scope:'different-epoch'});assert.equal(button(app.tree,'Download Prepared Package').props.disabled,true);button(app.tree,'Download Prepared Package').props.onClick();assert.equal(downloads.length,2);
 }finally{app.close();if(originalDocument)Object.defineProperty(globalThis,'document',originalDocument);else Reflect.deleteProperty(globalThis,'document');URL.createObjectURL=create;URL.revokeObjectURL=revoke;}
});
test('Use Template retains a separate complete draft and keeps the library open when its index cannot be retained',async()=>{
 const f=fixture(),app=host(RecordsPage,f.props);
 try{
  await collection(app);button(app.tree,'New Content').props.onClick();await app.flush();button(app.tree,'Start With A Template').props.onClick();await app.flush();
  const catalog=()=>nodes(app.tree).find(n=>n.props.initialSection==='templates'),before=structuredClone(f.snapshot.records!.content);
  const storage=globalThis.localStorage,put=storage.setItem;
  storage.setItem=(key,value)=>{if(key===indexKey())throw Error('Index full');put(key,value);};
  catalog().props.useTemplate(template);await app.flush();assert(catalog());assert.deepEqual(f.snapshot.records!.content,before);
  storage.setItem=put;catalog().props.useTemplate(template);await app.flush();assert.equal(catalog(),undefined);
  const index=JSON.parse(app.storage.get(indexKey())!),kept=JSON.parse(app.storage.get(journalKey(index.selected))!).value;
  assert.notEqual(index.selected,template.id);for(const key of ['brief','body','format','assets','platform','collection','tags','brandId'] as const)assert.deepEqual(kept[key],template[key]);
  assert.equal(kept.title,template.name);assert.deepEqual(f.snapshot.records!.content,before);
 }finally{app.close();}
});


test('Content recovery retains its exact ID and refuses navigation when its local index cannot be written', async () => {
 const f=fixture(),app=host(RecordsPage,f.props),id='content:recovered';
 try {await collection(app);button(app.tree,'Recover Writing').props.onClick();await app.flush();
  const dialog=nodes(app.tree).find(node=>node.type?.name==='RecordDraftRecovery');assert.equal(dialog.props.canOpen,true);
  const set=app.storage.set.bind(app.storage);app.storage.set=()=>{throw Error('Index refused');};assert.equal(dialog.props.open(id),false);await app.flush();assert.equal(JSON.parse(app.storage.get(indexKey())??'{}').selected??null,null);
  app.storage.set=set;assert.equal(nodes(app.tree).find(node=>node.type?.name==='RecordDraftRecovery').props.open(id),true);await app.flush();
  assert.equal(JSON.parse(app.storage.get(indexKey())!).selected,id);assert.deepEqual(JSON.parse(app.storage.get(indexKey())!).drafts,[id]);assert.equal(nodes(app.tree).find(node=>node.type?.name==='RecordDraftRecovery').props.canOpen,false);assert.deepEqual(app.calls,[]);
 } finally {app.close();}
});
