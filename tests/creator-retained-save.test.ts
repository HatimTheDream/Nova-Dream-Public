import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Entity, Snapshot } from '../packages/domain/contracts';
import type { PersonalProfile, RecordValue } from '../packages/domain/workspace-records';
import { createMascotAppearance, defaultMascotAppearance } from '../packages/domain/mascot-appearance';
const key=Symbol.for('nova.test.creator-retained');
const react=pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const hooks=registerHooks({
 resolve(specifier,context,next){return specifier==='react'&&context.parentURL?.includes('/apps/client/src/')?{url:'nova-test:creator-retained-react',shortCircuit:true}:next(specifier,context);},
 load(url,context,next){if(url==='nova-test:creator-retained-react')return{format:'module',shortCircuit:true,source:`export * from ${JSON.stringify(react)};
 export const useEffect=()=>{};export const useCallback=v=>v;
 export const useState=initial=>{const f=globalThis[Symbol.for('nova.test.creator-retained')],i=f.index++;if(!(i in f.values))f.values[i]=typeof initial==='function'?initial():initial;return[f.values[i],v=>{f.values[i]=typeof v==='function'?v(f.values[i]):v;}];};
 export const useRef=v=>useState(()=>({current:v}))[0];`};if(url.endsWith('.css'))return{format:'module',shortCircuit:true,source:''};return next(url,context);}
});
const {useRetained,retainedWindowId}=await import('../apps/client/src/useWorkspace');
const {RecordEditor}=await import('../apps/client/src/RecordEditor');
hooks.deregister();
const saved:PersonalProfile={name:'Saved Name',position:'Designer',about:'Saved biography',appearance:{...createMascotAppearance()}};
const changed={...createMascotAppearance({...defaultMascotAppearance,face:'adventurous'})};
function fixture(t:any){
 const storage=new Map<string,string>(),state={index:0,values:[] as any[]};
 const properties=[key,'localStorage','window'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)] as const);
 let full=false;Object.defineProperty(globalThis,key,{configurable:true,value:state});Object.defineProperty(globalThis,'window',{configurable:true,value:new EventTarget()});
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>{if(full)throw Error('full');storage.set(k,v);}}});
 t.after(()=>{for(const[k,d]of properties){if(d)Object.defineProperty(globalThis,k,d);else Reflect.deleteProperty(globalThis,k);}});
 const snapshot={epoch:'epoch',deviceId:'device',layout:{value:{timezone:'UTC'}}} as unknown as Snapshot;
 let entity={id:'profile:owner',revision:7,value:saved,updatedAt:'2026-10-15T00:00:00Z'} as Entity<RecordValue>;
 const render=()=>{state.index=0;return useRetained<RecordValue>('profile',entity.id,saved,entity,snapshot,async()=>{},{autoSave:false});};
 const journalKey=`e3:journal:device:${entity.id}:${retainedWindowId}`;
 return{state,storage,snapshot,journalKey,render,full:(v:boolean)=>{full=v;},entity:()=>entity,update:(next:Entity<RecordValue>)=>{entity=next;},remount:()=>{state.values=[];return render();}};
}
function nodes(node:any):any[]{return Array.isArray(node)?node.flatMap(nodes):node?.props?[node,...nodes(node.props.children)]:[];}
test('scoped flush saves only appearance and keeps unrelated edits across ack, reload and the next full save',async t=>{
 const f=fixture(t),calls:any[]=[];
 t.mock.method(globalThis,'fetch',async(_url:any,init:RequestInit)=>{const c=JSON.parse(String(init.body));calls.push(c);return Response.json({...f.entity(),revision:7+calls.length,value:c.payload});});
 f.render().change({...saved,name:'Unsent Name',about:'Unsent biography',appearance:changed});
 const result=await f.render().flush({...saved,appearance:changed});assert.ok(result);
 assert.deepEqual(calls[0].payload,{...saved,appearance:changed});assert.equal(calls[0].expectedRevision,7);
 assert.equal(f.render().revision,8);assert.equal(f.render().dirty,true);assert.equal((f.render().value as PersonalProfile).name,'Unsent Name');
 f.update(result);const restored=f.remount();assert.equal((restored.value as PersonalProfile).about,'Unsent biography');assert.equal(restored.dirty,true);
 await restored.flush();assert.equal(calls[1].expectedRevision,8);assert.equal(calls[1].payload.name,'Unsent Name');assert.deepEqual(calls[1].payload.appearance,changed);assert.equal(f.render().dirty,false);
});
test('lost scoped-save response retains the exact receipt and never substitutes newer fields on retry',async t=>{
 const f=fixture(t),calls:any[]=[];let fail=true;
 t.mock.method(globalThis,'fetch',async(_url:any,init:RequestInit)=>{const c=JSON.parse(String(init.body));calls.push(c);if(fail)throw Error('lost response');return Response.json({...f.entity(),revision:8,value:c.payload});});
 f.render().change({...saved,name:'Keep this draft',appearance:changed});await f.render().flush({...saved,appearance:changed});
 assert.ok(f.render().pending);assert.equal(f.render().networkError,true);
 fail=false;const restored=f.remount();await restored.flush({...saved,name:'Must not replace pending',appearance:null});
 assert.deepEqual(calls[1],calls[0]);assert.equal(f.render().pending,undefined);assert.equal(f.render().dirty,true);assert.equal((f.render().value as PersonalProfile).name,'Keep this draft');
});
test('storage failure and revision conflict block scoped writes without losing the kept draft',async t=>{
 const f=fixture(t);let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({code:'revision_conflict',message:'Changed',current:{...f.entity(),revision:9}},{status:409});});
 f.render().change({...saved,name:'Keep me',appearance:changed});f.full(true);await f.render().flush({...saved,appearance:changed});assert.equal(calls,0);assert.equal(f.render().storageError,true);
 f.full(false);await f.render().flush({...saved,appearance:changed});assert.equal(calls,1);assert.equal(f.render().conflict?.code,'revision_conflict');await f.render().flush({...saved,appearance:null});assert.equal(calls,1);assert.equal((f.render().value as PersonalProfile).name,'Keep me');
});
test('RecordEditor wires the actual saved preview, appearance-only Save/Cancel, and draft-only Use Look',async t=>{
 const f=fixture(t),calls:any[]=[];
 f.storage.set(f.journalKey,JSON.stringify({value:{...saved,name:'Kept unsaved name',appearance:changed},revision:7,epoch:'epoch',dirty:true}));
 t.mock.method(globalThis,'fetch',async(_url:any,init:RequestInit)=>{const c=JSON.parse(String(init.body));calls.push(c);return Response.json({...f.entity(),revision:8,value:c.payload});});
 const render=(entity:Entity<RecordValue>|undefined=f.entity())=>{f.state.index=0;return RecordEditor({kind:'profile',id:entity?.id??'profile:new',entity,snapshot:f.snapshot,refresh:async()=>{},editTask:()=>{}});};
 const controls=()=>nodes(render()).find(n=>n.type?.name==='RecordFields').props.appearanceControls;
 assert.deepEqual(controls().savedValue,saved.appearance);assert.equal(controls().saveLabel,'Save Look');await controls().onSaveLook(changed);assert.equal(calls[0].payload.name,'Saved Name');
 controls().onCancelLook();const fields=nodes(render()).find(n=>n.type?.name==='RecordFields');assert.equal(fields.props.value.name,'Kept unsaved name');assert.deepEqual(fields.props.value.appearance,changed);
 f.state.values=[];f.state.index=0;const newTree=RecordEditor({kind:'profile',id:'profile:new',snapshot:f.snapshot,refresh:async()=>{},editTask:()=>{}});
 const draft=nodes(newTree).find(n=>n.type?.name==='RecordFields').props.appearanceControls;assert.equal(draft.saveLabel,'Use Look');await draft.onSaveLook(changed);assert.equal(calls.length,1,'incomplete new identity must not be sent to host');
});

test('acknowledged appearance remains the saved base while snapshot refresh is delayed, then newer host and epoch win',async t=>{
 const f=fixture(t),calls:any[]=[],second=createMascotAppearance({...defaultMascotAppearance,face:'confident'}),remote=createMascotAppearance({...defaultMascotAppearance,face:'calm'});
 f.storage.set(f.journalKey,JSON.stringify({value:{...saved,name:'Kept unsaved name',appearance:changed},revision:7,epoch:'epoch',dirty:true}));
 t.mock.method(globalThis,'fetch',async(_url:any,init:RequestInit)=>{const c=JSON.parse(String(init.body));calls.push(c);return Response.json({...f.entity(),revision:7+calls.length,value:c.payload});});
 const render=()=>{f.state.index=0;return RecordEditor({kind:'profile',id:f.entity().id,entity:f.entity(),snapshot:f.snapshot,refresh:async()=>{},editTask:()=>{}});};
 const fields=()=>nodes(render()).find(n=>n.type?.name==='RecordFields').props,controls=()=>fields().appearanceControls;
 await controls().onSaveLook(changed);assert.equal(f.entity().revision,7,'refresh deliberately leaves the snapshot behind');assert.deepEqual(controls().savedValue,changed);
 fields().change({...fields().value,appearance:second});controls().onCancelLook();assert.deepEqual(fields().value.appearance,changed);assert.equal(fields().value.name,'Kept unsaved name');
 await controls().onSaveLook(second);assert.equal(calls.length,2);assert.equal(calls[1].expectedRevision,8);assert.equal(calls[1].payload.name,'Saved Name');assert.deepEqual(controls().savedValue,second);
 f.update({...f.entity(),revision:10,value:{...saved,name:'New host name',appearance:remote}});assert.deepEqual(controls().savedValue,remote);controls().onCancelLook();assert.deepEqual(fields().value.appearance,remote);assert.equal(fields().value.name,'Kept unsaved name');
 f.snapshot.epoch='recovered-epoch';f.update({...f.entity(),revision:1,value:saved});assert.deepEqual(controls().savedValue,saved.appearance,'the earlier epoch acknowledgement cannot become a recovered-host base');
});

test('reconciling a lost appearance-only acknowledgement through Save Changes updates Saved without discarding other writing',async t=>{
 const f=fixture(t),calls:any[]=[];let lost=true,closed=0;
 f.storage.set(f.journalKey,JSON.stringify({value:{...saved,name:'Kept unsaved name',appearance:changed},revision:7,epoch:'epoch',dirty:true}));
 t.mock.method(globalThis,'fetch',async(_url:any,init:RequestInit)=>{const c=JSON.parse(String(init.body));calls.push(c);if(lost)throw Error('lost acknowledgement');return Response.json({...f.entity(),revision:8,value:c.payload});});
 const render=()=>{f.state.index=0;return RecordEditor({kind:'profile',id:f.entity().id,entity:f.entity(),snapshot:f.snapshot,refresh:async()=>{},editTask:()=>{},onSaved:()=>{closed++;}});};
 const fields=()=>nodes(render()).find(n=>n.type?.name==='RecordFields').props;
 await fields().appearanceControls.onSaveLook(changed);lost=false;
 nodes(render()).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await new Promise(resolve=>setTimeout(resolve,0));
 assert.deepEqual(calls[1],calls[0],'reconciliation uses the original appearance receipt');assert.equal(closed,0);assert.deepEqual(fields().appearanceControls.savedValue,changed);
 fields().appearanceControls.onCancelLook();assert.deepEqual(fields().value.appearance,changed);assert.equal(fields().value.name,'Kept unsaved name');
});
