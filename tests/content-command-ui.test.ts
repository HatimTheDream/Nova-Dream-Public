import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {randomUUID} from 'node:crypto';
import {ApiError} from '../apps/client/src/api';
import type {Snapshot} from '../packages/domain/contracts';
const symbol=Symbol.for('nova.test.content-command-ui'),react=import.meta.resolve('react');
const loader=registerHooks({
 resolve(name,context,next){
  if(/\/(?:useContentWorkspace|ContentReviews|useContentPanelDraft)\.tsx?$/u.test(context.parentURL??'')){
   if(name==='react')return {url:'content-command:react',shortCircuit:true};
   if(name==='./api')return {url:'content-command:api',shortCircuit:true};
  }return next(name,context);
 },
 load(url,context,next){
  if(url==='content-command:react')return {format:'module',shortCircuit:true,source:`export * from ${JSON.stringify(react)};
   const h=()=>globalThis[Symbol.for('nova.test.content-command-ui')];
   export const useState=v=>h().state(v),useRef=v=>h().ref(v),useMemo=(f,d)=>h().memo(f,d),useEffect=(f,d)=>h().effect(f,d),useCallback=(f,d)=>h().memo(()=>f,d);`};
  if(url==='content-command:api')return {format:'module',shortCircuit:true,source:`const h=()=>globalThis[Symbol.for('nova.test.content-command-ui')];export const request=(...args)=>h().request(...args),readLocal=()=>undefined,saveLocal=()=>true;`};
  return next(url,context);
 }
});
const {useContentCommand,useContentState}=await import('../apps/client/src/useContentWorkspace');
const {ContentReviews}=await import('../apps/client/src/ContentReviews');loader.deregister();
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const nodes=(node:any):any[]=>Array.isArray(node)?node.flatMap(nodes):node?.props?[node,...nodes(node.props.children)]:[];
const text=(node:any):string=>Array.isArray(node)?node.map(text).join(''):node?.props?text(node.props.children):typeof node==='string'?node:'';
class Hooks{
 cursor=0;cells:any[]=[];effects:(()=>void)[]=[];calls:any[]=[];
 state(v:any){const i=this.cursor++;this.cells[i]??={value:typeof v==='function'?v():v};return[this.cells[i].value,(next:any)=>{this.cells[i].value=typeof next==='function'?next(this.cells[i].value):next;}];}
 ref(v:any){return this.cells[this.cursor++]??={current:v};}
 memo(make:()=>any,deps:unknown[]){const i=this.cursor++,old=this.cells[i];if(!old||deps.some((v,k)=>!Object.is(v,old.deps[k])))this.cells[i]={value:make(),deps};return this.cells[i].value;}
 effect(run:()=>any,deps:unknown[]){const i=this.cursor++,old=this.cells[i];if(!old||deps.some((v,k)=>!Object.is(v,old.deps[k]))){this.cells[i]={deps,cleanup:old?.cleanup};this.effects.push(()=>{old?.cleanup?.();this.cells[i].cleanup=run();});}}
 request(path:string,data?:unknown){return new Promise((resolve,reject)=>this.calls.push({path,data,resolve,reject}));}
 render<T>(make:()=>T){Reflect.set(globalThis,symbol,this);this.cursor=0;const value=make();while(this.effects.length)this.effects.shift()!();return value;}
 close(){for(const cell of this.cells)cell?.cleanup?.();}
}
function fixture(){
 const records=new Map<string,string>(),hooks:Hooks[]=[];let full=false;
 const globals:Record<PropertyKey,unknown>={localStorage:{getItem:(key:string)=>records.get(key)??null,setItem:(key:string,value:string)=>{if(full)throw Error('Storage full');records.set(key,value);}},document:{hidden:false},setInterval:()=>0,clearInterval:()=>{}};
 const old=Reflect.ownKeys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 for(const key of Reflect.ownKeys(globals))Object.defineProperty(globalThis,key,{configurable:true,value:globals[key]});
 return {records,full:(value:boolean)=>{full=value;},hooks:()=>{const h=new Hooks();hooks.push(h);return h;},
  close(){hooks.forEach(h=>h.close());for(const[key,value]of old)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);Reflect.deleteProperty(globalThis,symbol);}};
}
const snapshot=()=>({deviceId:randomUUID(),epoch:randomUUID()} as Snapshot);
const input={type:'review-request',contentId:'content:a',expectedRevision:4,reviewerId:null};
test('lost acknowledgements and 4xx errors keep the original; Check only reads and Retry keeps its ID',async()=>{
 const env=fixture(),h=env.hooks(),s=snapshot();let refreshed=0;
 try{
  const render=()=>h.render(()=>useContentCommand(s,'content:a',async()=>{refreshed++;}));
  const pending=render().run(input),post=h.calls.shift();post.reject(new ApiError('unknown','Disconnected',undefined,409));
  await settle();const read=h.calls.shift();assert.equal(read.path,'content/workspace/receipt');assert.deepEqual(read.data,post.data);
  read.resolve({command:post.data,state:'unknown',message:'Unconfirmed'});await pending;assert(render().pending);
  const check=render().check(),readAgain=h.calls.shift();assert.equal(readAgain.path,'content/workspace/receipt');readAgain.resolve({command:post.data,state:'unknown',message:'Unconfirmed'});await check;
  const retry=render().retry(),repost=h.calls.shift();assert.equal(repost.path,'content/workspace');assert.deepEqual(repost.data,post.data);repost.resolve({});
  await settle();h.calls.shift().resolve({command:post.data,state:'recorded',message:'Recorded',result:{id:randomUUID(),revision:1,contentId:'content:a',sourceRevision:4}});
  const result=await retry;assert.equal(result.contentId,'content:a');assert(!render().pending);assert.equal(refreshed,3);
 }finally{env.close();}
});
test('failed request retention prevents dispatch and failed receipt retention keeps the original pending',async()=>{
 const env=fixture(),h=env.hooks(),s=snapshot();
 try{
  const render=()=>h.render(()=>useContentCommand(s,'content:a',async()=>{}));
  env.full(true);await render().run(input);assert.equal(h.calls.length,0);
  env.full(false);const pending=render().run(input),post=h.calls.shift();post.resolve({});await settle();
  env.full(true);h.calls.shift().resolve({command:post.data,state:'rejected',code:'changed',message:'Changed'});
  await pending;assert(render().pending);assert.match(render().error,/Storage full/);
 }finally{env.close();}
});
test('reload never posts a kept request and a retired workspace cannot accept its late acknowledgement',async()=>{
 const env=fixture(),h=env.hooks();let s=snapshot();const originalScope=s;
 try{
  const render=()=>h.render(()=>useContentCommand(s,'content:a',async()=>{}));
  const first=render().run(input),post=h.calls.shift(),oldEpoch=s.epoch;s=snapshot();render();post.resolve({});await first;
  assert.equal(h.calls.length,0);assert(!render().pending);
  const oldKey=[...env.records.keys()].find(key=>key.includes(oldEpoch))!;assert(JSON.parse(env.records.get(oldKey)!).command);
  const old=env.hooks(),reloaded=old.render(()=>useContentCommand(originalScope,'content:a',async()=>{}));assert(reloaded.pending);assert.equal(old.calls.length,0);
 }finally{env.close();}
});
test('an old Content state read cannot populate a different selected item or workspace',async()=>{
 const env=fixture(),h=env.hooks();let id='content:a',epoch='a';
 try{
  const render=()=>h.render(()=>useContentState(id,true,epoch));render();const old=h.calls.shift();
  id='content:b';epoch='b';render();const next=h.calls.shift();
  old.resolve({jobs:[{id:'wrong'}],reviews:[],canStart:true,reason:''});await settle();assert.equal(render().state,undefined);
  next.resolve({jobs:[{id:'right'}],reviews:[],canStart:true,reason:''});await settle();assert.equal(render().state!.jobs[0].id,'right');
 }finally{env.close();}
});
test('a late review acknowledgement preserves newer feedback, quote and decision writing',async()=>{
 const env=fixture(),h=env.hooks(),s=snapshot();let finish!:(value:unknown)=>void;
 try{
  const props:any={snapshot:s,entity:{id:'content:a',revision:4},reviews:[{id:randomUUID(),revision:1,contentId:'content:a',sourceRevision:4,reviewerId:null,reviewerName:'You',state:'requested',comments:[]}],blocked:false,run:()=>new Promise(resolve=>{finish=resolve;})};
  const render=()=>h.render(()=>ContentReviews(props));let tree=render();
  const edit=(label:string,value:string)=>{const parent=nodes(tree).find(node=>node.type==='label'&&text(node).startsWith(label));nodes(parent).find(node=>node.type==='textarea').props.onChange({target:{value}});tree=render();};
  edit('Feedback','Original feedback');edit('Quoted passage','Original quote');
  const saving=nodes(tree).find(node=>node.type==='button'&&text(node)==='Add comment').props.onClick();
  edit('Feedback','Newer feedback');edit('Quoted passage','Newer quote');edit('Decision note','Newer decision');
  finish({id:'confirmed'});await saving;tree=render();
  const values=nodes(tree).filter(node=>node.type==='textarea').map(node=>node.props.value);
  assert(values.includes('Newer feedback'));assert(values.includes('Newer quote'));assert(values.includes('Newer decision'));
 }finally{env.close();}
});
