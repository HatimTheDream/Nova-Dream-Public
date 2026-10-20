import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { defaultLayout, type Snapshot } from '../packages/domain/contracts';
import { readProjectDraftIdentity, retainProjectDraftIdentity, retainProjectDraftLocation, finishProjectDraftIdentity } from '../apps/client/src/project-editor-draft';

const key = Symbol.for('nova.test.project-retention');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && context.parentURL?.includes('/apps/client/src/')) return { url: 'nova-test:project-hooks', shortCircuit: true };
    if (specifier === './useAttachments' && context.parentURL?.endsWith('/ProjectEditor.tsx')) return { url: 'nova-test:project-uploads', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:project-hooks') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      const h=()=>globalThis[Symbol.for('nova.test.project-retention')];
      export const useState=v=>h().state(v),useRef=v=>h().ref(v),useId=()=>h().id();
      export const useEffect=(f,d)=>h().effect(f,d),useLayoutEffect=useEffect;
      export const useMemo=(f,d)=>h().memo(f,d),useCallback=(f,d)=>h().memo(()=>f,d);` };
    if (url === 'nova-test:project-uploads') return { format: 'module', shortCircuit: true, source: `export const useAttachments=()=>globalThis[Symbol.for('nova.test.project-retention')].uploads;` };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  },
});
const { ProjectEditor, RetainedProjectEditor } = await import('../apps/client/src/ProjectEditor');
const { retainedWindowId } = await import('../apps/client/src/useWorkspace');
const { mayLeaveRecordDrafts } = await import('../apps/client/src/record-draft-navigation');
loader.deregister();
const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const button = (tree: any, label: string) => nodes(tree).find(node => node.type === 'button' && text(node) === label);
const field = (tree: any, label: string) => nodes(tree).find(node => node.type === 'label' && text(node).startsWith(label)).props.children.find((child: any) => child?.props?.onChange);
function snapshot(): Snapshot { return { epoch: randomUUID(), deviceId: 'device', cursor: 0, tasks: [], drafts: [], projects: [], layout: { id: 'layout', revision: 1, updatedAt: '', deviceId: 'device', value: structuredClone(defaultLayout) }, capabilities: { assistant: false, voice: false, reason: 'Synthetic client only' } }; }
function host(component: (props: any) => any, initialProps: any, respond: (body: any) => unknown | Promise<unknown> = () => { throw Error('Unexpected command'); }) {
  let props=initialProps,cursor=0,dirty=true,tree:any;
  const cells:any[]=[],effects:(()=>void)[]=[],storage=new Map<string,string>(),calls:any[]=[],listeners=new Map<string,Set<Function>>();
  const uploads={pending:[] as any[],staging:false,errors:{},notice:'',add:async()=>{},retry:async()=>{},remove:async()=>{}};
  const faults={read:false,readKey:'',write:false,remove:false,drop:false};
  const io={getItem:(k:string)=>{if(faults.read || faults.readKey===k)throw Error('Synthetic denied storage');return storage.get(k)??null;},setItem:(k:string,v:string)=>{if(faults.write)throw Error('Synthetic full storage');if(!faults.drop)storage.set(k,v);},removeItem:(k:string)=>{if(faults.remove)throw Error('Synthetic cleanup refusal');storage.delete(k);}};
  const values:Record<PropertyKey,unknown>={
    [key]:{uploads,
      state(value:any){const i=cursor++;if(!cells[i])cells[i]={value:typeof value==='function'?value():value};return[cells[i].value,(next:any)=>{const v=typeof next==='function'?next(cells[i].value):next;if(!Object.is(v,cells[i].value)){cells[i].value=v;dirty=true;}}];},
      ref(value:any){return cells[cursor++]??={current:value};},
      effect(run:()=>void|(()=>void),deps:unknown[]){const i=cursor++,prior=cells[i];if(!prior||deps.some((v,n)=>!Object.is(v,prior.deps[n]))){cells[i]={deps,cleanup:prior?.cleanup};effects.push(()=>{cells[i].cleanup?.();cells[i].cleanup=run();});}},
      id(){const i=cursor++;return(cells[i]??={value:`project-field-${i}`}).value;},
      memo(read:()=>unknown,deps:unknown[]){const i=cursor++,prior=cells[i];if(!prior||deps.some((v,n)=>!Object.is(v,prior.deps[n])))cells[i]={deps,value:read()};return cells[i].value;},
    },
    window:{addEventListener:(k:string,fn:Function)=>{if(!listeners.has(k))listeners.set(k,new Set());listeners.get(k)!.add(fn);},removeEventListener:(k:string,fn:Function)=>listeners.get(k)?.delete(fn)},
    localStorage:io,
    fetch:async(path:string,init:RequestInit)=>{assert.equal(path,'/api/commands');const body=JSON.parse(String(init.body));calls.push(body);return new Response(JSON.stringify(await respond(body)));},
  };
  const originals=Reflect.ownKeys(values).map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]as const);
  for(const k of Reflect.ownKeys(values))Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:values[k]});
  const flush=async()=>{for(let pass=0;pass<25;pass++){if(dirty){dirty=false;cursor=0;tree=component(props);while(effects.length)effects.shift()!();}for(let tick=0;tick<10;tick++)await Promise.resolve();}};
  return{flush,calls,storage,io,faults,uploads,listeners,get tree(){return tree;},async update(next:any){props={...props,...next};dirty=true;await flush();},close(){for(const cell of cells)cell?.cleanup?.();for(const[k,descriptor]of originals)if(descriptor)Object.defineProperty(globalThis,k,descriptor);else Reflect.deleteProperty(globalThis,k);}};
}
function editorFixture(respond?: (body:any)=>unknown|Promise<unknown>) {
  const saved=snapshot(),id='project:retained',identity={id,indexKey:`e3:new-project:${saved.deviceId}:${retainedWindowId}:chat`,indexRaw:JSON.stringify(id)};
  let closed=0,finished=0,refreshes=0,refreshFailure=false;
  const app=host(RetainedProjectEditor,{snapshot:saved,identity,close:()=>closed++,saved:()=>finished++,refresh:async()=>{refreshes++;if(refreshFailure)throw Error('Synthetic refresh failure');}},respond??(body=>({id:body.entityId,revision:1,deviceId:saved.deviceId,updatedAt:'',value:body.payload})));
  app.storage.set(identity.indexKey,identity.indexRaw);
  const journalKey=`e3:journal:${saved.deviceId}:${id}:${retainedWindowId}`;
  return{app,saved,id,identity,journalKey,get closed(){return closed;},get finished(){return finished;},get refreshes(){return refreshes;},set refreshFailure(v:boolean){refreshFailure=v;}};
}
const writeName=async(app:ReturnType<typeof host>,value='Keep Project writing')=>{field(app.tree,'Project name').props.onChange({target:{value}});await app.flush();};
const submit=async(app:ReturnType<typeof host>)=>{nodes(app.tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await app.flush();};

test('new Project refuses an unreadable or malformed identity without replacing storage',async()=>{
  for(const mode of ['read','malformed']as const){const saved=snapshot(),app=host(ProjectEditor,{snapshot:saved,close(){},saved(){},refresh:async()=>{}});const index=`e3:new-project:device:${retainedWindowId}:chat`;if(mode==='read')app.faults.read=true;else app.storage.set(index,'{"unknown":"original"}');
    try{const before=[...app.storage];await app.flush();assert.ok(button(app.tree,'Try opening again'));assert.deepEqual([...app.storage],before);assert.deepEqual(app.calls,[]);}finally{app.close();}}
});
test('failed initial index write retries the same new identity and verifies readback before editing',async()=>{
  const app=host(ProjectEditor,{snapshot:snapshot(),close(){},saved(){},refresh:async()=>{}});app.faults.drop=true;
  try{await app.flush();assert.ok(button(app.tree,'Try opening again'));app.faults.drop=false;button(app.tree,'Try opening again').props.onClick();await app.flush();assert.equal(app.tree.type,RetainedProjectEditor);const identity=app.tree.props.identity;assert.equal(app.storage.get(identity.indexKey),identity.indexRaw);assert.deepEqual(app.calls,[]);}finally{app.close();}
});
test('legacy migration retains its exact original command and never replaces a conflicting journal',()=>{
  const saved=snapshot(),scope={...saved,windowId:retainedWindowId,space:'chat'as const};const original={kind:'project',entityId:'project:legacy',requestId:randomUUID(),epoch:saved.epoch,expectedRevision:3,payload:{name:'Submitted name',purpose:''}};
  const legacy=JSON.stringify({value:{name:'Newer writing',purpose:''},command:original}),map=new Map([['e3:project-editor:device',legacy]]),io={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>map.set(k,v),removeItem:(k:string)=>map.delete(k)};
  const identity=readProjectDraftIdentity(scope,io);retainProjectDraftIdentity(identity,io);assert.deepEqual(JSON.parse(map.get(identity.legacy!.journalKey)!).pending,original);assert.equal(map.get(identity.legacy!.key),legacy);
  const newer=JSON.stringify({...JSON.parse(identity.legacy!.journalRaw),value:{name:'Newer kept journal',purpose:'',attachments:[]}});map.set(identity.legacy!.journalKey,newer);assert.throws(()=>retainProjectDraftIdentity(identity,io),/already has kept changes/);assert.equal(map.get(identity.legacy!.journalKey),newer);
});

test('new and existing Project wrappers refuse damaged or denied journals before mounting an empty editor',async()=>{
  for(const existing of [false,true])for(const mode of ['malformed','shape','read']as const){
    const saved=snapshot(),id='project:original',app=host(ProjectEditor,{snapshot:saved,projectId:existing?id:undefined,close(){},saved(){},refresh:async()=>{}});
    const journal=`e3:journal:device:${id}:${retainedWindowId}`;
    app.storage.set(`e3:new-project:device:${retainedWindowId}:chat`,JSON.stringify(id));
    app.storage.set(journal,mode==='malformed'?'original damaged {':JSON.stringify({value:{name:'Original writing',purpose:''},revision:'unknown',dirty:true,epoch:saved.epoch}));
    if(mode==='read')app.faults.readKey=journal;
    try{const original=[...app.storage];await app.flush();assert.ok(button(app.tree,'Try opening again'));assert.deepEqual([...app.storage],original);assert.deepEqual(app.calls,[]);}finally{app.close();}
  }
});

test('Project journal preflight refuses mismatched pending identity and invalid payload without replacing it',async()=>{
  for(const mismatch of ['entity','kind','epoch','revision','payload','dirty']as const){
    const saved=snapshot(),id='project:original',app=host(ProjectEditor,{snapshot:saved,projectId:id,close(){},saved(){},refresh:async()=>{}});
    const command:any={kind:'project',entityId:id,requestId:randomUUID(),epoch:saved.epoch,expectedRevision:2,payload:{name:'Submitted Project',purpose:''}};
    const value:any={value:{name:'Newer writing',purpose:''},revision:2,epoch:saved.epoch,dirty:true,pending:command};
    if(mismatch==='entity')command.entityId='project:other';if(mismatch==='kind')command.kind='task';if(mismatch==='epoch')command.epoch=randomUUID();if(mismatch==='revision')command.expectedRevision=3;if(mismatch==='payload')command.payload={unknown:'original'};if(mismatch==='dirty')value.dirty=false;
    const key=`e3:journal:device:${id}:${retainedWindowId}`,raw=JSON.stringify(value);app.storage.set(key,raw);
    try{await app.flush();assert.ok(button(app.tree,'Try opening again'));assert.equal(app.storage.get(key),raw);assert.deepEqual(app.calls,[]);}finally{app.close();}
  }
});

test('interrupted legacy import reloads the same durable identity before copying its original writing',()=>{
  const saved=snapshot(),scope={...saved,windowId:retainedWindowId,space:'chat'as const};
  const legacy=JSON.stringify({value:{name:'Original legacy',purpose:'Keep exact body'}}),map=new Map([['e3:project-editor:device',legacy]]);let refuseJournal=true;
  const io={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{if(refuseJournal&&k.startsWith('e3:journal:'))throw Error('Synthetic journal refusal');map.set(k,v);},removeItem:(k:string)=>map.delete(k)};
  const first=readProjectDraftIdentity(scope,io);assert.throws(()=>retainProjectDraftIdentity(first,io),/journal refusal/);assert.equal(map.get(first.indexKey!),first.indexRaw);assert.equal(map.has(first.journalKey!),false);
  const resumed=readProjectDraftIdentity(scope,io);assert.equal(resumed.id,first.id);refuseJournal=false;retainProjectDraftIdentity(resumed,io);
  assert.equal(resumed.initialJournal?.value?.value.purpose,'Keep exact body');assert.equal(map.get('e3:project-editor:device'),legacy);
});

test('legacy reload, edit, save and New Project retire only the original imported source',async()=>{
  const saved=snapshot(),scope={...saved,windowId:retainedWindowId,space:'chat'as const},map=new Map([['e3:project-editor:device',JSON.stringify({value:{name:'Legacy writing',purpose:'Original body'}})]]);
  const io={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>map.set(k,v),removeItem:(k:string)=>map.delete(k)};
  const first=readProjectDraftIdentity(scope,io);retainProjectDraftIdentity(first,io);
  const journal=JSON.parse(map.get(first.journalKey!)!);journal.value.purpose='Newer kept body';map.set(first.journalKey!,JSON.stringify(journal));
  const resumed=readProjectDraftIdentity(scope,io);retainProjectDraftIdentity(resumed,io);assert.equal(resumed.id,first.id);
  let completed=0;const app=host(RetainedProjectEditor,{snapshot:saved,identity:resumed,close(){},saved(){completed++;},refresh:async()=>{}},body=>({id:body.entityId,revision:1,deviceId:saved.deviceId,updatedAt:'',value:body.payload}));
  for(const [key,value]of map)app.storage.set(key,value);
  try{await app.flush();assert.equal(field(app.tree,'Purpose & context').props.value,'Newer kept body');await submit(app);assert.equal(completed,1);assert.equal(app.calls.length,1);assert.equal(app.storage.has('e3:project-editor:device'),false);const next=readProjectDraftIdentity(scope,app.io);assert.notEqual(next.id,first.id);assert.equal(next.legacy,undefined);}finally{app.close();}
});

test('verified journal is consumed directly when a later convenience read would fail',async()=>{
  const saved=snapshot(),id='project:read-once',scope={...saved,windowId:retainedWindowId,space:'chat'as const,projectId:id};
  const map=new Map([[`e3:journal:device:${id}:${retainedWindowId}`,JSON.stringify({value:{name:'Kept before denial',purpose:'Original writing'},revision:0,epoch:saved.epoch,dirty:true})]]);
  const io={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>map.set(k,v),removeItem:(k:string)=>map.delete(k)};
  const identity=readProjectDraftIdentity(scope,io);retainProjectDraftIdentity(identity,io);
  const app=host(RetainedProjectEditor,{snapshot:saved,identity,close(){},saved(){},refresh:async()=>{}});app.faults.read=true;
  try{await app.flush();assert.equal(field(app.tree,'Project name').props.value,'Kept before denial');assert.equal(field(app.tree,'Purpose & context').props.value,'Original writing');assert.deepEqual(app.calls,[]);}finally{app.close();}
});

test('older Project conflicts keep their full saved proposal and normalize only optional attachment lists',()=>{
  const saved=snapshot(),id='project:conflict',scope={...saved,windowId:retainedWindowId,space:'chat'as const,projectId:id};
  const value={value:{name:'My kept Project',purpose:'My complete writing'},revision:1,epoch:saved.epoch,dirty:true,conflict:{code:'revision_conflict',message:'Review saved changes',current:{id,revision:2,updatedAt:'',deviceId:'other',value:{name:'Saved name',purpose:'Saved complete body'}}}};
  const key=`e3:journal:device:${id}:${retainedWindowId}`,raw=JSON.stringify(value),map=new Map([[key,raw]]),io={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>map.set(k,v),removeItem:(k:string)=>map.delete(k)};
  const identity=readProjectDraftIdentity(scope,io);retainProjectDraftIdentity(identity,io);assert.equal(map.get(key),raw);assert.deepEqual(identity.initialJournal?.value?.value,{...value.value,attachments:[]});assert.deepEqual(identity.initialJournal?.value?.conflict?.current,{...value.conflict.current,value:{...value.conflict.current.value,attachments:[]}});
});

test('old string Project pointers adopt only their exact original legacy request, never another save for the same Project',()=>{
  for(const mode of ['exact','different-request','different-epoch','acknowledged-unproved']as const){
    const saved=snapshot(),id='project:old-pointer',scope={...saved,windowId:retainedWindowId,space:'chat'as const};
    const pending={kind:'project',entityId:id,requestId:randomUUID(),epoch:saved.epoch,expectedRevision:0,payload:{name:'Original submitted name',purpose:'Original submitted body'}};
    const journal={value:{name:'Newer kept name',purpose:'My newer body',attachments:[]},revision:0,epoch:saved.epoch,dirty:true,...(mode==='acknowledged-unproved'?{}:{pending})};
    const legacyCommand={...pending,...(mode==='different-request'?{requestId:randomUUID()}:{}),...(mode==='different-epoch'?{epoch:randomUUID()}: {})};
    const legacy=JSON.stringify({value:{name:'Old writing',purpose:''},command:legacyCommand});
    const index=`e3:new-project:device:${retainedWindowId}:chat`,key=`e3:journal:device:${id}:${retainedWindowId}`;
    const map=new Map([[index,JSON.stringify(id)],[key,JSON.stringify(journal)],['e3:project-editor:device',legacy]]),before=[...map];
    const io={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>map.set(k,v),removeItem:(k:string)=>map.delete(k)};
    if(mode==='exact'){const identity=readProjectDraftIdentity(scope,io);retainProjectDraftIdentity(identity,io);assert.equal(identity.legacy?.raw,legacy);assert.deepEqual(identity.initialJournal?.value?.pending,pending);assert.equal(map.get(key),JSON.stringify(journal));assert.equal(map.get('e3:project-editor:device'),legacy);}
    else{assert.throws(()=>readProjectDraftIdentity(scope,io),/Both original copies are preserved/);assert.deepEqual([...map],before);}
  }
});

test('confirmed Project finish preserves a legacy source changed since its exact imported provenance',()=>{
  const saved=snapshot(),scope={...saved,windowId:retainedWindowId,space:'chat'as const},map=new Map([['e3:project-editor:device',JSON.stringify({value:{name:'Imported original',purpose:'Original'}})]]);
  const io={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>map.set(k,v),removeItem:(k:string)=>map.delete(k)};
  const identity=readProjectDraftIdentity(scope,io);retainProjectDraftIdentity(identity,io);const newer=JSON.stringify({value:{name:'Another kept draft',purpose:'Keep this'}});map.set('e3:project-editor:device',newer);
  const resumed=readProjectDraftIdentity(scope,io);retainProjectDraftIdentity(resumed,io);finishProjectDraftIdentity(resumed,io);assert.equal(map.get('e3:project-editor:device'),newer);assert.equal(map.has(identity.indexKey!),false);
});
test('close, global departure and beforeunload keep failed writing in its actual editor',async()=>{
  const f=editorFixture();try{await f.app.flush();f.app.faults.write=true;await writeName(f.app);button(f.app.tree,'Keep for later').props.onClick();await f.app.flush();assert.equal(f.closed,0);assert.equal(field(f.app.tree,'Project name').props.value,'Keep Project writing');assert.equal(mayLeaveRecordDrafts(),false);let prevented=false;for(const fn of f.app.listeners.get('beforeunload')??[])fn({preventDefault(){prevented=true;},returnValue:undefined});assert.equal(prevented,true);f.app.faults.write=false;button(f.app.tree,'Keep for later').props.onClick();await f.app.flush();assert.equal(f.closed,1);assert.equal(JSON.parse(f.app.storage.get(f.journalKey)!).value.name,'Keep Project writing');assert.deepEqual(f.app.calls,[]);}finally{f.app.close();}
});
test('staging prevents both close and host save until the actual attachment owner settles',async()=>{
  const f=editorFixture();try{await f.app.flush();await writeName(f.app);f.app.uploads.staging=true;await f.app.update({});button(f.app.tree,'Keep for later').props.onClick();await submit(f.app);assert.equal(f.closed,0);assert.equal(f.finished,0);assert.deepEqual(f.app.calls,[]);}finally{f.app.close();}
});
test('known host save with pointer cleanup failure finishes locally without another POST',async()=>{
  const f=editorFixture();try{await f.app.flush();await writeName(f.app);f.app.faults.remove=true;await submit(f.app);assert.equal(f.app.calls.length,1);assert.equal(f.finished,0);const pending=JSON.parse(f.app.storage.get(f.journalKey)!);assert.equal(pending.dirty,false);assert.equal(pending.pending,undefined);f.app.faults.remove=false;await submit(f.app);assert.equal(f.app.calls.length,1);assert.equal(f.finished,1);assert.equal(f.app.storage.has(f.identity.indexKey),false);}finally{f.app.close();}
});
test('known host save whose snapshot refresh failed retries refresh without a new command',async()=>{
  const f=editorFixture();try{await f.app.flush();await writeName(f.app);f.refreshFailure=true;await submit(f.app);assert.equal(f.app.calls.length,1);assert.equal(f.finished,0);f.refreshFailure=false;await submit(f.app);assert.equal(f.app.calls.length,1);assert.equal(f.finished,1);}finally{f.app.close();}
});
test('late saved reply cannot close an editor already left through its retained close callback',async()=>{
  let reply!:(value:unknown)=>void;const gate=new Promise(resolve=>{reply=resolve;});const f=editorFixture(()=>gate);
  try{await f.app.flush();await writeName(f.app);await submit(f.app);assert.equal(f.app.calls.length,1);button(f.app.tree,'Keep for later').props.onClick();await f.app.flush();assert.equal(f.closed,1);const command=f.app.calls[0];reply({id:f.id,revision:1,deviceId:f.saved.deviceId,updatedAt:'',value:command.payload});await f.app.flush();assert.equal(f.finished,0);assert.equal(f.app.storage.get(f.identity.indexKey),f.identity.indexRaw);}finally{f.app.close();}
});
test('local index conflict cannot overwrite another Project on close, save or cleanup',async()=>{
  const f=editorFixture();try{await f.app.flush();await writeName(f.app);const newer=JSON.stringify('project:newer');f.app.storage.set(f.identity.indexKey,newer);button(f.app.tree,'Keep for later').props.onClick();await submit(f.app);assert.equal(f.closed,0);assert.deepEqual(f.app.calls,[]);assert.equal(f.app.storage.get(f.identity.indexKey),newer);finishProjectDraftIdentity(f.identity,f.app.io);assert.equal(f.app.storage.get(f.identity.indexKey),newer);assert.throws(()=>retainProjectDraftLocation(f.identity,f.app.io),/Another Project/);}finally{f.app.close();}
});
test('a failed local acknowledgement is kept in memory and completed without a second POST',async()=>{
  let reply!:(value:unknown)=>void;const gate=new Promise(resolve=>{reply=resolve;});const f=editorFixture(()=>gate);
  try{await f.app.flush();await writeName(f.app);await submit(f.app);const command=f.app.calls[0];f.app.faults.write=true;reply({id:f.id,revision:1,deviceId:f.saved.deviceId,updatedAt:'',value:command.payload});await f.app.flush();assert.equal(f.finished,0);assert.deepEqual(JSON.parse(f.app.storage.get(f.journalKey)!).pending,command);f.app.faults.write=false;await submit(f.app);assert.equal(f.finished,1);assert.equal(f.app.calls.length,1);assert.equal(JSON.parse(f.app.storage.get(f.journalKey)!).pending,undefined);}finally{f.app.close();}
});
test('an original legacy pending request is reconciled unchanged rather than recaptured from newer writing',async()=>{
  const f=editorFixture();const command={kind:'project',entityId:f.id,requestId:randomUUID(),epoch:f.saved.epoch,expectedRevision:0,payload:{name:'Original request',purpose:'Original payload',attachments:[]}};
  const newer={name:'Writing after request',purpose:'Keep this too',attachments:[]};f.app.storage.set(f.journalKey,JSON.stringify({value:newer,revision:0,epoch:f.saved.epoch,dirty:true,pending:command}));
  try{await f.app.flush();await submit(f.app);assert.deepEqual(f.app.calls,[command]);assert.equal(JSON.parse(f.app.storage.get(f.journalKey)!).value.name,newer.name);assert.equal(JSON.parse(f.app.storage.get(f.journalKey)!).dirty,true);assert.equal(f.finished,0,'newer writing must stay reachable instead of clearing its new-Project pointer');assert.equal(f.app.storage.has(f.identity.indexKey),true);}finally{f.app.close();}
});
test('cross-window conflict does not overwrite the other journal during a guarded close',async()=>{
  const f=editorFixture();try{await f.app.flush();await writeName(f.app);const other=JSON.stringify({value:{name:'Other window',purpose:'',attachments:[]},revision:0,epoch:f.saved.epoch,dirty:true});f.app.storage.set(f.journalKey,other);for(const fn of f.app.listeners.get('storage')??[])fn({key:f.journalKey,newValue:other});await f.app.flush();button(f.app.tree,'Keep for later').props.onClick();await f.app.flush();assert.equal(f.closed,0);assert.equal(f.app.storage.get(f.journalKey),other);assert.equal(field(f.app.tree,'Project name').props.value,'Keep Project writing');}finally{f.app.close();}
});
