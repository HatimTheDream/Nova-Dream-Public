import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { emptyDraft, type Draft, type Entity, type Snapshot } from '../packages/domain/contracts';
import { applyHomeHandoff, homeHandoffProject, prepareWorkHandoff, type HandoffDraftJournal, type KeptHomeHandoff } from '../apps/client/src/home-assistant-handoff';
const source:KeptHomeHandoff={id:'capture:actual',epoch:'epoch',deviceId:'device',value:{title:'A concrete plan',text:'Captured source text',space:'work',workMode:'research',projectId:null,sourceRefs:[]}};
const original:Draft={...emptyDraft,space:'work',workMode:'research',title:'My kept work',text:'My original writing',projectId:'project:kept'};
const fixtureKey=Symbol.for('nova.test.home-handoff-retained'),react=pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader=registerHooks({resolve(specifier,context,next){return specifier==='react'&&context.parentURL?.includes('/apps/client/src/useWorkspace')?{url:'nova-test:home-handoff-react',shortCircuit:true}:next(specifier,context);},load(url,context,next){if(url==='nova-test:home-handoff-react')return{format:'module',shortCircuit:true,source:`export * from ${JSON.stringify(react)};
 export const useState=initial=>{const f=globalThis[Symbol.for('nova.test.home-handoff-retained')],i=f.index++;if(!(i in f.values))f.values[i]=typeof initial==='function'?initial():initial;return[f.values[i],v=>{f.values[i]=typeof v==='function'?v(f.values[i]):v;}];};
 export const useRef=v=>useState(()=>({current:v}))[0];export const useCallback=v=>v;
 export const useEffect=(run,deps)=>globalThis[Symbol.for('nova.test.home-handoff-retained')].effect(run,deps);`};return next(url,context);}});
const{useRetained,retainedWindowId}=await import('../apps/client/src/useWorkspace');loader.deregister();
function fixture(t:any){
 const storage=new Map<string,string>();let full=false,refreshes=0;const properties=[fixtureKey,'localStorage','window'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)] as const);
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>{if(full)throw Error('full');storage.set(k,v);}}});Object.defineProperty(globalThis,'window',{configurable:true,value:new EventTarget()});
 const instances:any[]=[];t.after(()=>{instances.forEach(i=>i.unmount());for(const[k,d]of properties){if(d)Object.defineProperty(globalThis,k,d);else Reflect.deleteProperty(globalThis,k);}});
 const id='draft:device:work',snapshot={epoch:'epoch',deviceId:'device',draftRemovals:[]} as unknown as Snapshot,host={id,revision:3,value:original,updatedAt:'2026-10-15T00:00:00Z'} as Entity<Draft>;
 const refresh=async()=>{refreshes++;};
 function instance(){const state={index:0,values:[] as any[],pending:[] as (()=>void)[],effect(run:()=>void|(()=>void),deps:unknown[]){const i=this.index++,old=this.values[i];if(!old||deps.some((v,n)=>!Object.is(v,old.deps[n]))){this.values[i]={deps,cleanup:old?.cleanup,run};this.pending.push(()=>{this.values[i].cleanup?.();this.values[i].cleanup=run();});}}};
  const current={strictReplay(){for(const cell of state.values)if(cell?.run){cell.cleanup?.();cell.cleanup=cell.run();}},render(){state.index=0;Object.defineProperty(globalThis,fixtureKey,{configurable:true,value:state});const result=useRetained('draft',id,original,host,snapshot,refresh,{autoSave:false});state.pending.splice(0).forEach(run=>run());return result;},unmount(){for(const cell of state.values){if(cell&&typeof cell==='object'){cell.cleanup?.();cell.cleanup=undefined;}}}};instances.push(current);return current;
 }
 return{storage,instance,snapshot,host,id,key:`e3:journal:device:${id}:${retainedWindowId}`,full:(v:boolean)=>{full=v;},refreshes:()=>refreshes};
}
test('Home source append preserves occupied writing, files, project and mode; exact replay is idempotent and oversize refuses',()=>{
 const draft={...original,attachments:[{id:'file',name:'Kept.txt',size:5,sha256:'a'.repeat(64)}]};const next=applyHomeHandoff(draft,source);
 assert.equal(next.projectId,'project:kept');assert.equal(next.title,'My kept work');assert.deepEqual(next.attachments,draft.attachments);assert.equal(next.workMode,'research');assert.ok(next.text.startsWith('My original writing\n\n'));
 assert.equal(applyHomeHandoff(next,source),next);assert.equal(next.text.split('[Nova Source Context capture:actual]').length,2);
 assert.throws(()=>applyHomeHandoff(draft,{...source,value:{...source.value,text:'x'.repeat(100001)}}));assert.equal(draft.text,original.text);
});
test('Discuss retains an originating Work Project as source context without binding an invalid Chat Project',()=>{
 const project={id:'project:source',revision:1,value:{name:'Personal Project',purpose:'A concrete result',space:'work'},updatedAt:'',deviceId:'device'};
 const snapshot={projects:[project],projectOrganization:[]} as unknown as Snapshot;
 const chat=homeHandoffProject({...source.value,space:'chat',projectId:project.id},snapshot);
 assert.equal(chat.projectId,null);assert.ok(chat.text.includes(source.value.text));assert.ok(chat.text.includes(project.id));
 const work=homeHandoffProject({...source.value,space:'work',projectId:project.id},snapshot);assert.equal(work.projectId,project.id);
 const deleted=homeHandoffProject({...source.value,projectId:project.id},{...snapshot,projectOrganization:[{projectId:project.id,revision:1,deleted:true}]});assert.equal(deleted.projectId,null);assert.ok(deleted.text.includes(project.id));
 const titled=applyHomeHandoff(emptyDraft,{...source,value:{...source.value,title:'Long Source Title '.repeat(20)}});assert.equal(titled.title.length,150);assert.ok(titled.text.includes(source.value.text));
});
test('Work handoff chooses the changed host over clean stale local data and preserves dirty immutable receipts',()=>{
 const clean:HandoffDraftJournal={value:original,revision:2,epoch:'epoch',dirty:false};const host={id:'draft:device:work',revision:4,value:{...original,text:'Latest saved work'},updatedAt:''} as Entity<Draft>;
 assert.ok(prepareWorkHandoff(clean,host,0,source).value.text.startsWith('Latest saved work'));
 const pending={kind:'draft',entityId:host.id,requestId:crypto.randomUUID(),epoch:'epoch',expectedRevision:2,payload:original} as const;
 const kept={...clean,dirty:true,pending,value:{...original,text:'Latest unsent work'}};const next=prepareWorkHandoff(kept,host,0,source);assert.equal(next.pending,pending);assert.ok(next.value.text.startsWith('Latest unsent work'));
 for(const blocked of [{...kept,epoch:'old'},{...kept,conflict:{code:'revision_conflict'}}])assert.throws(()=>prepareWorkHandoff(blocked,host,0,source));assert.throws(()=>prepareWorkHandoff(kept,host,3,source));assert.equal(kept.value.text,'Latest unsent work');
});
test('an in-flight mounted journal ack preserves appended Home writing and saves it with the next receipt',async t=>{
 const f=fixture(t),owner=f.instance(),calls:any[]=[];let resolve!:(value:Response)=>void;
 t.mock.method(globalThis,'fetch',async(_url:any,init:RequestInit)=>{const c=JSON.parse(String(init.body));calls.push(c);if(calls.length===1)return new Promise<Response>(done=>{resolve=done;});return Response.json({...f.host,revision:5,value:c.payload});});
 owner.render().change({...original,text:'Pending original writing'});const saving=owner.render().flush();owner.render().change(d=>applyHomeHandoff(d,source));resolve(Response.json({...f.host,revision:4,value:calls[0].payload}));await saving;
 assert.equal(owner.render().dirty,true);assert.ok(owner.render().value.text.includes('Captured source text'));await owner.render().flush();assert.equal(calls[1].expectedRevision,4);assert.equal(calls[1].payload.text.split('[Nova Source Context capture:actual]').length,2);
});
test('late unmounted ack cannot erase a Home Work append; remount reconciles the exact original receipt',async t=>{
 const f=fixture(t),old=f.instance(),calls:any[]=[];let resolve!:(value:Response)=>void;
 t.mock.method(globalThis,'fetch',async(_url:any,init:RequestInit)=>{const c=JSON.parse(String(init.body));calls.push(c);if(calls.length===1)return new Promise<Response>(done=>{resolve=done;});return Response.json({...f.host,revision:c.requestId===calls[0].requestId?4:5,value:c.payload});});
 old.render().change({...original,text:'Pending original writing'});const saving=old.render().flush();old.unmount();
 const next=prepareWorkHandoff(JSON.parse(f.storage.get(f.key)!),f.host,0,source);f.storage.set(f.key,JSON.stringify(next));const retained=f.storage.get(f.key);
 resolve(Response.json({...f.host,revision:4,value:calls[0].payload}));assert.equal(await saving,undefined);assert.equal(f.refreshes(),0);assert.equal(f.storage.get(f.key),retained);
 const fresh=f.instance();await fresh.render().flush();assert.deepEqual(calls[1],calls[0]);assert.equal(fresh.render().dirty,true);assert.ok(fresh.render().value.text.includes('Captured source text'));await fresh.render().flush();assert.equal(calls[2].expectedRevision,4);assert.equal(fresh.render().dirty,false);
});
test('late unmounted failure cannot replace the next owner with stale conflict or network state',async t=>{
 for(const conflict of [true,false]){
  const f=fixture(t),old=f.instance();let fail!:(response:Response)=>void,reject!:(reason:Error)=>void;
  t.mock.method(globalThis,'fetch',async()=>new Promise<Response>((resolve,refuse)=>{fail=resolve;reject=refuse;}));old.render().change(original);const saving=old.render().flush();old.unmount();const next=prepareWorkHandoff(JSON.parse(f.storage.get(f.key)!),f.host,0,source);f.storage.set(f.key,JSON.stringify(next));const retained=f.storage.get(f.key);
  if(conflict)fail(Response.json({code:'revision_conflict',message:'Old request conflict'},{status:409}));else reject(Error('lost response'));
  await saving;assert.equal(f.storage.get(f.key),retained);assert.equal(f.refreshes(),0);
 }
});
test('a failed draft-storage append retains original durable bytes and refuses persistence success',t=>{
 const f=fixture(t),owner=f.instance();owner.render().change(original);const before=f.storage.get(f.key);f.full(true);assert.equal(owner.render().change(d=>applyHomeHandoff(d,source)),false);assert.equal(f.storage.get(f.key),before);assert.ok(owner.render().value.text.includes('Captured source text'));assert.equal(owner.render().storageError,true);
});
test('Strict Mode effect replay cannot let an older response clear the current owner saving flag',async t=>{
 const f=fixture(t),owner=f.instance(),calls:any[]=[],responses:((response:Response)=>void)[]=[];
 t.mock.method(globalThis,'fetch',async(_url:any,init:RequestInit)=>{calls.push(JSON.parse(String(init.body)));return new Promise<Response>(resolve=>responses.push(resolve));});
 owner.render().change(original);const old=owner.render().flush();owner.strictReplay();const fresh=owner.render().flush();assert.deepEqual(calls[1],calls[0]);
 responses[0](Response.json({...f.host,revision:4,value:original}));await old;assert.equal(owner.render().saving,true);assert.ok(owner.render().pending);assert.equal(f.refreshes(),0);
 responses[1](Response.json({...f.host,revision:4,value:original}));await fresh;assert.equal(owner.render().saving,false);assert.equal(owner.render().pending,undefined);assert.equal(f.refreshes(),1);
});
test('an old workspace response cannot overwrite the new scope review journal',async t=>{
 const f=fixture(t),owner=f.instance();let resolve!:(response:Response)=>void;
 t.mock.method(globalThis,'fetch',async()=>new Promise<Response>(done=>{resolve=done;}));owner.render().change(original);const saving=owner.render().flush();
 f.snapshot.epoch='recovered';owner.render();const retained=f.storage.get(f.key);assert.equal(JSON.parse(retained!).conflict.code,'epoch_changed');
 resolve(Response.json({...f.host,revision:4,value:original}));assert.equal(await saving,undefined);assert.equal(f.storage.get(f.key),retained);assert.equal(f.refreshes(),0);
});
