import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {randomUUID} from 'node:crypto';
import {defaultLayout,type Snapshot} from '../packages/domain/contracts';
import {blankRecord} from '../packages/domain/workspace-records';
import {builtinContentTemplates} from '../packages/domain/content-workspace';

const symbol=Symbol.for('nova.test.content-panel-retention'),react=import.meta.resolve('react');
const loader=registerHooks({
 resolve(name,context,next){return name==='react'&&context.parentURL?.includes('/apps/client/src/')?{url:'content-panel:react',shortCircuit:true}:next(name,context);},
 load(url,context,next){
  if(url==='content-panel:react')return {format:'module',shortCircuit:true,source:`export * from ${JSON.stringify(react)};
   const h=()=>globalThis[Symbol.for('nova.test.content-panel-retention')];
   export const useState=v=>h().state(v),useRef=v=>h().ref(v),useMemo=(f,d)=>h().memo(f,d),useEffect=(f,d)=>h().effect(f,d),useLayoutEffect=useEffect,useCallback=(f,d)=>h().memo(()=>f,d),useId=()=>h().memo(()=>crypto.randomUUID(),[]);`};
  if(url.endsWith('.css'))return {format:'module',shortCircuit:true,source:''};
  return next(url,context);
 }
});
const {default:ContentEditor}=await import('../apps/client/src/ContentEditor');
const {default:RecordsPage}=await import('../apps/client/src/RecordsPage');
const {ContentReviews}=await import('../apps/client/src/ContentReviews');
const {ContentAgentWork}=await import('../apps/client/src/ContentAgentWork');
const {ContentLibrary}=await import('../apps/client/src/ContentLibrary');
const {ContentPanelDraftNotice}=await import('../apps/client/src/useContentPanelDraft');
const {ContentRecoveryDetails,ContentCopy}=await import('../apps/client/src/ContentRecoveryPanel');
const {mayLeaveRecordDrafts}=await import('../apps/client/src/record-draft-navigation');
const {useWorkspace,retainedWindowId}=await import('../apps/client/src/useWorkspace');
loader.deregister();
const nodes=(node:any):any[]=>Array.isArray(node)?node.flatMap(nodes):node?.props?[node,...nodes(node.props.children)]:[];
const text=(node:any):string=>Array.isArray(node)?node.map(text).join(''):node?.props?text(node.props.children):typeof node==='string'||typeof node==='number'?String(node):'';
const button=(tree:any,label:string)=>nodes(tree).find(node=>node.type==='button'&&text(node)===label);
const field=(tree:any,label:string)=>nodes(nodes(tree).find(node=>node.type==='label'&&text(node).startsWith(label))).find(node=>node.type==='textarea');
const notice=(tree:any)=>nodes(tree).find(node=>node.type===ContentPanelDraftNotice).props.draft;
const settle=async()=>{for(let i=0;i<6;i++)await new Promise<void>(resolve=>setImmediate(resolve));};
class Hooks{
 cursor=0;cells:any[]=[];effects:(()=>void)[]=[];closed=false;
 state(v:any){const i=this.cursor++;this.cells[i]??={value:typeof v==='function'?v():v};return[this.cells[i].value,(next:any)=>{this.cells[i].value=typeof next==='function'?next(this.cells[i].value):next;}];}
 ref(v:any){return this.cells[this.cursor++]??={current:v};}
 memo(make:()=>any,deps:unknown[]){const i=this.cursor++,old=this.cells[i];if(!old||deps.some((v,k)=>!Object.is(v,old.deps[k])))this.cells[i]={value:make(),deps};return this.cells[i].value;}
 effect(run:()=>any,deps:unknown[]){const i=this.cursor++,old=this.cells[i];if(!old||deps.some((v,k)=>!Object.is(v,old.deps[k]))){this.cells[i]={deps,cleanup:old?.cleanup};this.effects.push(()=>{old?.cleanup?.();this.cells[i].cleanup=run();});}}
 render<T>(make:()=>T){Reflect.set(globalThis,symbol,this);this.cursor=0;const value=make();while(this.effects.length)this.effects.shift()!();return value;}
 close(){if(this.closed)return;this.closed=true;for(const cell of this.cells)cell?.cleanup?.();}
}
function fixture(){
 const rows=new Map<string,string>(),hooks:Hooks[]=[],calls:{url:string;method:string}[]=[];
 let fail=false,failMain=false,denied=false,closed=0;
 const epoch=randomUUID(),deviceId=randomUUID(),entity:any={id:'content:kept',revision:3,deviceId,updatedAt:'2026-10-20T00:00:00Z',value:{...blankRecord('content','UTC'),title:'Kept Content',body:'Saved body'}};
 const agent:any={id:'agent:maker',revision:1,deviceId,value:{name:'Maker',position:'Maker',archived:false}};
 const snapshot:Snapshot={epoch,deviceId,cursor:1,tasks:[],drafts:[],projects:[],layout:{id:'layout',revision:1,deviceId,updatedAt:entity.updatedAt,value:defaultLayout},capabilities:{assistant:false,voice:false,reason:'Fixture'},records:{content:[entity],agent:[agent],assignment:[],contact:[],profile:[]}};
 let remote=snapshot;
 const windowPort=Object.assign(new EventTarget(),{innerWidth:1280}),documentPort=Object.assign(new EventTarget(),{hidden:false,querySelector:()=>null});
 const globals:Record<PropertyKey,unknown>={window:windowPort,document:documentPort,navigator:{onLine:true},location:{protocol:'http:'},
  localStorage:{getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{if(fail&&/e3:content-(review|work)-draft:/.test(key)||failMain&&key.startsWith('e3:journal:'))throw Error('Storage denied');rows.set(key,value);}},
  setInterval:()=>0,clearInterval:()=>{},requestAnimationFrame:(run:()=>void)=>{run();return 0;},fetch:async(url:string,options:RequestInit={})=>{
   calls.push({url,method:options.method??'GET'});
   if(url==='/api/access/context')return Response.json(denied?{surface:'phone',requiresPairing:true}:{surface:'desktop',workspaceEpoch:remote.epoch});
   if(url==='/api/session')return Response.json({deviceId,apiVersion:1});
   if(url==='/api/snapshot')return Response.json(remote);
   if(url==='/api/content/library')return Response.json([]);
   if(url.startsWith('/api/content/state?'))return Response.json({jobs:[],reviews:[],canStart:false,reason:'Fixture'});
   throw Error('Unexpected fixture request: '+url);
  }};
 const old=Reflect.ownKeys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 for(const key of Reflect.ownKeys(globals))Object.defineProperty(globalThis,key,{configurable:true,value:globals[key]});
 const editorProps={id:entity.id,entity,snapshot,refresh:async()=>{},editTask(){},close(){closed++;},removeDraft(){},openSource(){}};
 const reviewProps:any={entity,snapshot,reviews:[{id:randomUUID(),revision:1,contentId:entity.id,sourceRevision:3,reviewerId:null,reviewerName:'You',state:'requested',comments:[]}],blocked:false,run:async()=>undefined};
 const workProps:any={entity,snapshot,state:{jobs:[],reviews:[],canStart:true,reason:''},blocked:false,run:async()=>undefined};
 return {rows,calls,snapshot,editorProps,reviewProps,workProps,windowPort,reviewKey:`e3:content-review-draft:${deviceId}:${epoch}:${entity.id}`,workKey:`e3:content-work-draft:${deviceId}:${epoch}:${entity.id}`,
  hooks(){const h=new Hooks();hooks.push(h);return h;},fail(value:boolean){fail=value;},failMain(value:boolean){failMain=value;},deny(value:boolean){denied=value;},replace(){remote={...snapshot,epoch:randomUUID(),cursor:2};return remote;},get closed(){return closed;},
  close(){hooks.forEach(h=>h.close());for(const[key,value]of old)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);Reflect.deleteProperty(globalThis,symbol);}};
}

test('failed Review retention blocks tab, close and shared navigation; tools preserve the mounted writer and current fields',async()=>{
 const f=fixture(),editor=f.hooks(),review=f.hooks();
 try{
  const renderEditor=()=>editor.render(()=>ContentEditor(f.editorProps));let tree=renderEditor();await settle();tree=renderEditor();button(tree,'Review').props.onClick();tree=renderEditor();
  f.reviewProps.leaveRef=nodes(tree).find(node=>node.type===ContentReviews).props.leaveRef;
  const renderReview=()=>review.render(()=>ContentReviews(f.reviewProps));let panel=renderReview();f.fail(true);
  field(panel,'Feedback').props.onChange({target:{value:'Unsent feedback'}});panel=renderReview();
  field(panel,'Quoted passage').props.onChange({target:{value:'Unsent quote'}});panel=renderReview();
  field(panel,'Decision note').props.onChange({target:{value:'Unsent decision'}});panel=renderReview();
  button(tree,'Write').props.onClick();tree=renderEditor();assert(nodes(tree).some(node=>node.type===ContentReviews));
  button(tree,'Files And Images').props.onClick();tree=renderEditor();assert(nodes(tree).some(node=>node.type===ContentReviews));
  const tools=nodes(tree).find(node=>node.type?.name==='ContentRecoveryPanel');assert(tools);tools.props.close();tree=renderEditor();
  button(tree,'Keep & Close').props.onClick();assert.equal(f.closed,0);assert.equal(mayLeaveRecordDrafts(),false);
  const current=notice(renderReview());assert.match(current.copy(),/Unsent feedback/);assert.match(current.copy(),/Unsent quote/);assert.match(current.copy(),/Unsent decision/);
  const unload=new Event('beforeunload',{cancelable:true});f.windowPort.dispatchEvent(unload);assert(unload.defaultPrevented);
  assert.equal(f.rows.has(f.reviewKey),false);assert.equal(f.calls.some(call=>call.url.includes('/content/workspace')),false);
  f.fail(false);assert(current.retain());button(renderEditor(),'Keep & Close').props.onClick();assert.equal(f.closed,1);
  assert.deepEqual(JSON.parse(f.rows.get(f.reviewKey)!),{text:'Unsent feedback',quote:'Unsent quote',note:'Unsent decision',reviewer:''});
 }finally{f.close();}
});

test('main draft storage failure still permits Details and complete-writing copy-out',()=>{
 const f=fixture(),h=f.hooks(),detailsHook=f.hooks();
 try{
  const render=()=>h.render(()=>ContentEditor(f.editorProps));let tree=render();f.failMain(true);
  nodes(tree).find(node=>node.type?.name==='ContentWriting').props.change({body:'Complete main writing that could not persist'});tree=render();
  button(tree,'Details').props.onClick();tree=render();const details=nodes(tree).find(node=>node.type===ContentRecoveryDetails);assert(details);assert.equal(details.props.editor.storageError,true);
  const body=detailsHook.render(()=>ContentRecoveryDetails(details.props));const copy=nodes(body).find(node=>node.type===ContentCopy&&node.props.title==='Your Current Writing');
  assert.equal(copy.props.value.body,'Complete main writing that could not persist');assert.equal(f.closed,0);
 }finally{f.close();}
});

test('Agent Work directions retain synchronously and block departure and dispatch while storage is denied',async()=>{
 const f=fixture(),h=f.hooks();let runs=0;f.workProps.run=async()=>{runs++;};
 try{
  const render=()=>h.render(()=>ContentAgentWork(f.workProps));let tree=render();f.fail(true);
  field(tree,'Directions').props.onChange({target:{value:'Complete unsent directions'}});tree=render();
  assert.equal(mayLeaveRecordDrafts(),false);assert.match(notice(tree).copy(),/Complete unsent directions/);
  await button(tree,'Draft version 3').props.onClick();assert.equal(runs,0);
  f.fail(false);assert(notice(tree).retain());tree=render();await button(tree,'Draft version 3').props.onClick();assert.equal(runs,1);
  assert.equal(JSON.parse(f.rows.get(f.workKey)!).instructions,'Complete unsent directions');assert(mayLeaveRecordDrafts());
 }finally{f.close();}
});

test('failed local directions retention does not block checking or stopping the existing original run',async()=>{
 const f=fixture(),h=f.hooks(),commands:any[]=[];f.workProps.run=async(input:any)=>{commands.push(input);};
 f.workProps.state.jobs=[{id:randomUUID(),agentId:'agent:maker',agentName:'Maker',mode:'draft',sourceRevision:3,createdAt:0,attempt:{id:randomUUID(),state:'running'}}];
 try{
  const render=()=>h.render(()=>ContentAgentWork(f.workProps));let tree=render();f.fail(true);field(tree,'Directions').props.onChange({target:{value:'Unsent next-run directions'}});tree=render();
  assert.equal(button(tree,'Draft version 3').props.disabled,true);assert.equal(button(tree,'Check status').props.disabled,false);assert.equal(button(tree,'Stop run').props.disabled,false);
  await button(tree,'Check status').props.onClick();await button(tree,'Stop run').props.onClick();
  assert.deepEqual(commands.map(command=>[command.type,command.action,command.jobId]),[['work-control','check',f.workProps.state.jobs[0].id],['work-control','stop',f.workProps.state.jobs[0].id]]);
  assert.match(notice(render()).copy(),/Unsent next-run directions/);assert.equal(mayLeaveRecordDrafts(),false);
 }finally{f.close();}
});

test('valid legacy raw bytes survive unchanged mount/close; malformed and competing drafts are never overwritten',()=>{
 const f=fixture();
 try{
  const raw='{\n "text":"Legacy feedback", "quote":"", "note":"", "reviewer":""\n}';f.rows.set(f.reviewKey,raw);
  const a=f.hooks();a.render(()=>ContentReviews(f.reviewProps));assert(mayLeaveRecordDrafts());a.close();assert.equal(f.rows.get(f.reviewKey),raw);
  f.rows.set(f.reviewKey,'{invalid original');const bad=f.hooks();let tree=bad.render(()=>ContentReviews(f.reviewProps));
  field(tree,'Feedback').props.onChange({target:{value:'Copyable newer writing'}});tree=bad.render(()=>ContentReviews(f.reviewProps));
  assert(!mayLeaveRecordDrafts());assert.match(notice(tree).copy(),/invalid original/);assert.match(notice(tree).copy(),/Copyable newer writing/);bad.close();assert.equal(f.rows.get(f.reviewKey),'{invalid original');
  f.rows.set(f.reviewKey,raw);const b=f.hooks();tree=b.render(()=>ContentReviews(f.reviewProps));const foreign=JSON.stringify({text:'Another window',quote:'',note:'',reviewer:''});f.rows.set(f.reviewKey,foreign);
  field(tree,'Feedback').props.onChange({target:{value:'This window'}});tree=b.render(()=>ContentReviews(f.reviewProps));assert(!mayLeaveRecordDrafts());assert.match(notice(tree).copy(),/This window/);assert.equal(f.rows.get(f.reviewKey),foreign);
 }finally{f.close();}
});

test('clean malformed recovery permits departure and explicit discard releases only new window writing',async()=>{
 const f=fixture(),h=f.hooks();let commands=0;f.reviewProps.run=async()=>{commands++;};
 try{
  const original='{malformed legacy writing';f.rows.set(f.reviewKey,original);
  const render=()=>h.render(()=>ContentReviews(f.reviewProps));let tree=render();assert.equal(mayLeaveRecordDrafts(),true);assert.equal(f.rows.get(f.reviewKey),original);
  await button(tree,'Request review').props.onClick();assert.equal(commands,0,'leaving unreadable recovery never authorizes a new command');
  field(tree,'Feedback').props.onChange({target:{value:'New window-only feedback'}});tree=render();assert.equal(mayLeaveRecordDrafts(),false);assert.match(notice(tree).copy(),/New window-only feedback/);
  const oldEdit=field(tree,'Feedback').props.onChange;
  const recovery=ContentPanelDraftNotice({draft:notice(tree)});button(recovery,'Discard This Window’s Changes').props.onClick();tree=render();
  assert.equal(mayLeaveRecordDrafts(),true);assert.equal(field(tree,'Feedback').props.value,'');assert.equal(f.rows.get(f.reviewKey),original);assert.match(notice(tree).copy(),/malformed legacy writing/);
  oldEdit({target:{value:'A stale callback must not recreate discarded writing'}});tree=render();assert.equal(field(tree,'Feedback').props.value,'');assert.equal(f.rows.get(f.reviewKey),original);
 }finally{f.close();}
});

test('Library can close an unreadable book with no current editor while retaining the exact original pending save',()=>{
 const f=fixture(),h=f.hooks();let closed=0;
 try{
  const key=`e3:content-library-drafts-v2:${f.snapshot.deviceId}:${f.snapshot.epoch}:${retainedWindowId}`,original='{malformed library draft book';f.rows.set(key,original);
  const requestKey=`e3:content-library-request-v2:${f.snapshot.deviceId}:${f.snapshot.epoch}`;
  const request=JSON.stringify({format:1,legacy:null,command:{type:'library-save',requestId:randomUUID(),epoch:f.snapshot.epoch,expectedRevision:0,item:{...builtinContentTemplates[0],id:'library:original'}}});f.rows.set(requestKey,request);
  const tree=h.render(()=>ContentLibrary({snapshot:f.snapshot,close(){closed++;}}));assert.equal(mayLeaveRecordDrafts(),true);tree.props.close();assert.equal(closed,1);
  assert.equal(f.rows.get(key),original);assert.equal(f.rows.get(requestKey),request);assert.equal(f.calls.some(call=>call.method==='POST'),false);
 }finally{f.close();}
});

test('late original comment receipts preserve newer writing and cannot clear a retired draft owner',async()=>{
 const f=fixture(),h=f.hooks();let finish!:(value:unknown)=>void;f.reviewProps.run=()=>new Promise(resolve=>{finish=resolve;});
 try{
  const render=()=>h.render(()=>ContentReviews(f.reviewProps));let tree=render();field(tree,'Feedback').props.onChange({target:{value:'Original'}});tree=render();
  const original=button(tree,'Add comment').props.onClick();field(tree,'Feedback').props.onChange({target:{value:'Newer'}});tree=render();finish({id:'original-receipt'});await original;
  assert.equal(field(render(),'Feedback').props.value,'Newer');
  const retired=button(render(),'Add comment').props.onClick();assert(mayLeaveRecordDrafts());h.close();const before=f.rows.get(f.reviewKey);finish({id:'later-original'});await retired;assert.equal(f.rows.get(f.reviewKey),before);
  const next=f.hooks();assert.equal(field(next.render(()=>ContentReviews(f.reviewProps)),'Feedback').props.value,'Newer');
 }finally{f.close();}
});

test('otherwise authorized epoch replacement waits for kept writing, then proceeds under its exact new scope',async()=>{
 const f=fixture(),workspace=f.hooks(),review=f.hooks();
 try{
  const render=()=>workspace.render(()=>useWorkspace());render();await settle();assert.equal(render().snapshot?.epoch,f.snapshot.epoch);
  let panel=review.render(()=>ContentReviews(f.reviewProps));f.fail(true);field(panel,'Feedback').props.onChange({target:{value:'Before recovery'}});panel=review.render(()=>ContentReviews(f.reviewProps));
  const next=f.replace();await render().refresh();let held=render();assert.equal(held.snapshot?.epoch,f.snapshot.epoch);assert.equal(held.online,false);assert.match(held.error,/current writing/);assert.match(notice(panel).copy(),/Before recovery/);
  f.fail(false);await held.refresh();held=render();assert.equal(held.snapshot?.epoch,next.epoch);assert.equal(held.online,true);assert.equal(JSON.parse(f.rows.get(f.reviewKey)!).text,'Before recovery');
  assert(![...f.rows.keys()].some(key=>key.startsWith('e3:content-review-draft:')&&key.includes(next.epoch)));
 }finally{f.close();}
});

test('pairing denial is immediate despite failed retention and never leaves stale workspace access usable',async()=>{
 const f=fixture(),workspace=f.hooks(),review=f.hooks();
 try{
  const render=()=>workspace.render(()=>useWorkspace());render();await settle();assert(render().snapshot);
  let panel=review.render(()=>ContentReviews(f.reviewProps));f.fail(true);field(panel,'Feedback').props.onChange({target:{value:'Private unsent feedback'}});panel=review.render(()=>ContentReviews(f.reviewProps));assert(!mayLeaveRecordDrafts());
  f.replace();f.deny(true);await render().refresh();const denied=render();assert.equal(denied.snapshot,undefined);assert.equal(denied.online,false);assert.equal(denied.access?.requiresPairing,true);assert.equal(f.rows.get('e3:snapshot'),'null');
  const before=f.calls.length;await denied.refresh();assert.equal(f.calls.length,before,'denied refresh cannot continue reading the prior workspace');
 }finally{f.close();}
});

test('same-route Content target keeps the selected writer on failure and opens the requested item after successful retention',()=>{
 const f=fixture(),page=f.hooks(),collection=f.hooks(),review=f.hooks();
 try{
  const other={...f.editorProps.entity,id:'content:other',value:{...f.editorProps.entity.value,title:'Other Content'}};f.snapshot.records!.content.push(other);
  const indexKey=`e3:record-index:${f.snapshot.deviceId}:content:${retainedWindowId}`,original=JSON.stringify({selected:f.editorProps.id,drafts:[]});f.rows.set(indexKey,original);
  const props:any={page:'content',snapshot:f.snapshot,refresh:async()=>{},editTask(){},outputs:[],openContent(){},openSource(){}};
  const shell=page.render(()=>RecordsPage(props)),node=nodes(shell).find(node=>node.type?.name==='RecordCollection');assert(node);let target:any;
  const render=()=>collection.render(()=>node.type({...node.props,target}));render();
  let panel=review.render(()=>ContentReviews(f.reviewProps));f.fail(true);field(panel,'Feedback').props.onChange({target:{value:'Do not lose this same-route feedback'}});panel=review.render(()=>ContentReviews(f.reviewProps));
  target={kind:'content',id:other.id,nonce:randomUUID()};render();let tree=render();
  assert.equal(nodes(tree).find(node=>node.type?.name==='ContentPlanning').props.selected,f.editorProps.id);assert.equal(f.rows.get(indexKey),original);assert.match(notice(panel).copy(),/same-route feedback/);
  f.fail(false);target={...target,nonce:randomUUID()};render();tree=render();
  assert.equal(nodes(tree).find(node=>node.type?.name==='ContentPlanning').props.selected,other.id);assert.equal(JSON.parse(f.rows.get(indexKey)!).selected,other.id);assert.equal(JSON.parse(f.rows.get(f.reviewKey)!).text,'Do not lose this same-route feedback');
 }finally{f.close();}
});

test('direct Content selection and publication callbacks cannot replace a writer whose draft failed to retain',async()=>{
 const f=fixture(),page=f.hooks(),collection=f.hooks(),review=f.hooks(),editor=f.hooks();
 try{
  const other={...f.editorProps.entity,id:'content:other',value:{...f.editorProps.entity.value,title:'Other Content'}};f.snapshot.records!.content.push(other);
  const indexKey=`e3:record-index:${f.snapshot.deviceId}:content:${retainedWindowId}`,original=JSON.stringify({selected:f.editorProps.id,drafts:[]});f.rows.set(indexKey,original);
  const props:any={page:'content',snapshot:f.snapshot,refresh:async()=>{},editTask(){},outputs:[],openContent(){},openSource(){}};
  const shell=page.render(()=>RecordsPage(props)),node=nodes(shell).find(node=>node.type?.name==='RecordCollection');const renderCollection=()=>collection.render(()=>node.type(node.props));let tree=renderCollection();
  let editorProps:any=f.editorProps;const renderEditor=()=>editor.render(()=>ContentEditor(editorProps));let editorTree=renderEditor();await settle();editorTree=renderEditor();button(editorTree,'Review').props.onClick();editorTree=renderEditor();f.reviewProps.leaveRef=nodes(editorTree).find(node=>node.type===ContentReviews).props.leaveRef;
  let panel=review.render(()=>ContentReviews(f.reviewProps));f.fail(true);field(panel,'Decision note').props.onChange({target:{value:'Unsent decision'}});panel=review.render(()=>ContentReviews(f.reviewProps));
  nodes(tree).find(node=>node.type?.name==='ContentPlanning').props.open(other.id);tree=renderCollection();assert.equal(f.rows.get(indexKey),original);
  editorProps={...editorProps,requestPublication:randomUUID()};renderEditor();editorTree=renderEditor();assert(nodes(editorTree).some(node=>node.type===ContentReviews));assert.match(notice(panel).copy(),/Unsent decision/);
  f.fail(false);assert(notice(panel).retain());nodes(tree).find(node=>node.type?.name==='ContentPlanning').props.open(other.id);assert.equal(JSON.parse(f.rows.get(indexKey)!).selected,other.id);
 }finally{f.close();}
});
