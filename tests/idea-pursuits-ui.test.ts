import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {randomUUID} from 'node:crypto';
import type {Snapshot} from '../packages/domain/contracts';
import type {IdeaCommand,IdeaPursuit,IdeaEntry} from '../packages/domain/idea-pursuits';
const symbol=Symbol.for('nova.test.idea-pursuits'),react=import.meta.resolve('react');
const loader=registerHooks({
 resolve(name,context,next){
  if(/\/(?:useIdeaPursuits|IdeaPursuits)\.tsx?$/u.test(context.parentURL??'')){
   if(name==='react')return {url:'idea-pursuits:react',shortCircuit:true};
   if(name==='./api')return {url:'idea-pursuits:api',shortCircuit:true};
   if(name==='./useWorkspace')return {url:'idea-pursuits:workspace',shortCircuit:true};
  }return next(name,context);
 },
 load(url,context,next){
  if(url==='idea-pursuits:react')return {format:'module',shortCircuit:true,source:`export * from ${JSON.stringify(react)};
   const h=()=>globalThis[Symbol.for('nova.test.idea-pursuits')];
   export const useState=v=>h().state(v),useRef=v=>h().ref(v),useMemo=(f,d)=>h().memo(f,d),useEffect=(f,d)=>h().effect(f,d);`};
  if(url==='idea-pursuits:api')return {format:'module',shortCircuit:true,source:`export const request=(...args)=>globalThis[Symbol.for('nova.test.idea-pursuits')].request(...args);`};
  if(url==='idea-pursuits:workspace')return {format:'module',shortCircuit:true,source:`export const retainedWindowId='pursuit-window';`};
  if(url.endsWith('.css'))return {format:'module',shortCircuit:true,source:''};
  return next(url,context);
 }
});
const {useIdeaPursuits}=await import('../apps/client/src/useIdeaPursuits');
const {IdeaPursuits}=await import('../apps/client/src/IdeaPursuits');
const {mayLeaveHomeDraft}=await import('../apps/client/src/home-draft-navigation');loader.deregister();
const settle=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
const nodes=(node:any):any[]=>Array.isArray(node)?node.flatMap(nodes):node?.props?[node,...nodes(node.props.children)]:[];
const text=(node:any):string=>Array.isArray(node)?node.map(text).join(''):node?.props?text(node.props.children):typeof node==='string'?node:'';
function button(tree:any,label:string){const item=nodes(tree).find(n=>n.type==='button'&&text(n)===label);assert(item,label);return item;}
class Hooks{
 cursor=0;cells:any[]=[];effects:(()=>void)[]=[];calls:any[]=[];
 state(v:any){const i=this.cursor++;this.cells[i]??={value:typeof v==='function'?v():v};return [this.cells[i].value,(next:any)=>{this.cells[i].value=typeof next==='function'?next(this.cells[i].value):next;}];}
 ref(v:any){return this.cells[this.cursor++]??={current:v};}
 memo(make:()=>any,deps:unknown[]){const i=this.cursor++,old=this.cells[i];if(!old||deps.some((v,k)=>!Object.is(v,old.deps[k])))this.cells[i]={value:make(),deps};return this.cells[i].value;}
 effect(run:()=>any,deps:unknown[]){const i=this.cursor++,old=this.cells[i];if(!old||deps.some((v,k)=>!Object.is(v,old.deps[k]))){this.cells[i]={deps,cleanup:old?.cleanup};this.effects.push(()=>{old?.cleanup?.();this.cells[i].cleanup=run();});}}
 request(path:string,data?:unknown){return new Promise((resolve,reject)=>this.calls.push({path,data,resolve,reject}));}
 render<T>(fn:()=>T){Reflect.set(globalThis,symbol,this);this.cursor=0;const value=fn();while(this.effects.length)this.effects.shift()!();return value;}
 close(){for(const c of this.cells)c?.cleanup?.();}
}
function environment(){
 const records=new Map<string,string>(),hooks:Hooks[]=[];let full=false;
 const values:Record<string,unknown>={window:new EventTarget(),localStorage:{getItem:(k:string)=>records.get(k)??null,setItem:(k:string,v:string)=>{if(full)throw Error('Storage full');records.set(k,v);}}};
 const old=Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 for(const[key,value]of Object.entries(values))Object.defineProperty(globalThis,key,{configurable:true,value});
 return {records,full:(value:boolean)=>{full=value;},hooks:()=>{const h=new Hooks();hooks.push(h);return h;},close(){hooks.forEach(h=>h.close());for(const[key,value]of old)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);Reflect.deleteProperty(globalThis,symbol);}};
}
const snapshot=()=>({epoch:randomUUID(),deviceId:randomUUID()} as Snapshot);
const empty=(s:Snapshot)=>({epoch:s.epoch,rows:[],next:null});
const command=(s:Snapshot):IdeaCommand=>({requestId:randomUUID(),epoch:s.epoch,type:'review',id:randomUUID(),expectedRevision:1,reviewed:true});
test('uncertain save survives reload; Check is read-only and explicit Retry uses exactly the original request',async()=>{
 const env=environment(),h=env.hooks(),s=snapshot();
 try{
  const render=()=>h.render(()=>useIdeaPursuits(s));let ui=render();h.calls.shift().resolve(empty(s));await settle();
  const input=command(s),pending=render().run(input),post=h.calls.shift();assert.equal(post.path,'home/ideas');post.reject(Error('Lost response'));
  await settle();let check=h.calls.shift();assert.equal(check.path,'home/ideas/receipt');check.resolve({state:'unknown',command:input});await pending;
  assert.deepEqual(render().journal.pending,input);h.close();
  const re=env.hooks(),again=()=>re.render(()=>useIdeaPursuits(s));ui=again();assert.equal(re.calls.length,1);assert.equal(re.calls[0].data,undefined);re.calls.shift().resolve(empty(s));await settle();
  const read=again().check();check=re.calls.shift();assert.equal(check.path,'home/ideas/receipt');check.resolve({state:'unknown',command:input});await read;
  const retry=again().retry(),repeat=re.calls.shift();assert.equal(repeat.path,'home/ideas');assert.deepEqual(repeat.data,input);repeat.resolve({});
  await settle();check=re.calls.shift();check.resolve({state:'rejected',command:input,code:'changed',message:'Review current state'});await retry;assert.equal(again().journal.pending,undefined);
 }finally{env.close();}
});
test('failed retention prevents sending; retired workspace cannot settle or overwrite its original request',async()=>{
 const env=environment(),h=env.hooks();let s=snapshot();
 try{
  const render=()=>h.render(()=>useIdeaPursuits(s));let ui=render();h.calls.shift().resolve(empty(s));await settle();
  env.full(true);await render().run(command(s));assert.equal(h.calls.length,0);env.full(false);
  ui=render();const key=ui.journal.key,input=command(s),pending=ui.run(input),post=h.calls.shift();
  s=snapshot();render();post.resolve({});await pending;
  assert.deepEqual(JSON.parse(env.records.get(key)!).command,input);assert.equal(h.calls.filter(c=>c.data!==undefined).length,0);
 }finally{env.close();}
});
test('failed receipt retention keeps the original pending and complete recoverable bytes',async()=>{
 const env=environment(),h=env.hooks(),s=snapshot();
 try{
  const render=()=>h.render(()=>useIdeaPursuits(s));render();h.calls.shift().resolve(empty(s));await settle();
  const input=command(s),pending=render().run(input);h.calls.shift().resolve({});await settle();
  env.full(true);h.calls.shift().resolve({state:'rejected',command:input,code:'changed',message:'Old version'});await pending;
  assert.deepEqual(render().journal.pending,input);assert.match(render().journal.copy(),/Old version/);
 }finally{env.close();}
});
test('question writing survives failed storage, Back and reload; a late save keeps newer writing and never sends',async()=>{
 const env=environment(),outer=env.hooks(),h=env.hooks(),s=snapshot(),id=randomUUID(),entryId=randomUUID();
 const pursuit:IdeaPursuit={id,epoch:s.epoch,revision:1,starterId:'draft-notes',title:'Original Pursuit',createdAt:'2026-10-21T02:00:00Z',updatedAt:'2026-10-21T02:00:00Z',initialEntryId:entryId,reviewed:false};
 const entry:IdeaEntry={id:entryId,pursuitId:id,epoch:s.epoch,createdAt:pursuit.createdAt,handoff:{title:pursuit.title,text:'Complete source brief',space:'chat',projectId:null,sourceCaptureId:randomUUID(),sourceRefs:[],ideaId:'draft-notes',outputs:['draft']}};
 const requests:any[]=[],handoffs:any[]=[],controller={journal:{value:{},invalid:false,error:'',pending:undefined},page:empty(s),error:'',busy:false,load:async()=>{},run:(input:unknown)=>new Promise(resolve=>requests.push({input,resolve}))};
 try{
  env.records.set(`e3:idea-pursuits-view:${s.deviceId}:${s.epoch}:pursuit-window`,JSON.stringify({selected:id}));
  const root=outer.render(()=>IdeaPursuits({snapshot:s,controller:controller as any,onAssistantHandoff:v=>{handoffs.push(v);}}));
  const detail=nodes(root).find(n=>typeof n.type==='function'&&n.props.id===id);assert(detail);
  const render=()=>h.render(()=>detail.type(detail.props));const respond=()=>{h.calls.shift().resolve({epoch:s.epoch,pursuit});h.calls.shift().resolve({epoch:s.epoch,rows:[entry],next:null});h.calls.shift().resolve(empty(s));};
  render();respond();await settle();let tree=render();
  const field=()=>nodes(tree).find(n=>n.type==='textarea'&&!n.props.readOnly);
  env.full(true);field().props.onChange({target:{value:'Original question\nExact text'}});tree=render();assert.equal(mayLeaveHomeDraft(),false);
  assert.equal(field().props.value,'Original question\nExact text');assert.equal(handoffs.length,0);
  env.full(false);assert.equal(mayLeaveHomeDraft(),true);
  button(tree,'Keep Question For Review').props.onClick();assert.equal(requests.length,1);assert.equal(requests[0].input.text,'Original question\nExact text');
  field().props.onChange({target:{value:'New question typed while saving'}});tree=render();
  requests[0].resolve({state:'saved',pursuit:{...pursuit,revision:2},entryId:randomUUID()});await settle();respond();await settle();tree=render();
  assert.equal(field().props.value,'New question typed while saving');assert.equal(handoffs.length,0);
  h.close();const reopened=env.hooks();const next=reopened.render(()=>detail.type(detail.props));
  assert.equal(nodes(next).find(n=>n.type==='textarea'&&!n.props.readOnly).props.value,'New question typed while saving');
 }finally{env.close();}
});
