import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import type {MailTriagePlan} from '../packages/domain/mail-triage';

const key=Symbol.for('nova.test.mail-action-card'),react=pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const hooks=registerHooks({resolve(s,c,next){
 if(c.parentURL?.includes('/components/Chat/MailActionCard.')){
  if(s==='react')return{url:'nova-test:mail-card-react',shortCircuit:true};
  if(s==='../../inbox-host')return{url:'nova-test:mail-card-host',shortCircuit:true};
 }
 return next(s,c);
},load(u,c,next){
 if(u==='nova-test:mail-card-react')return{format:'module',shortCircuit:true,source:`export * from ${JSON.stringify(react)};const h=()=>globalThis[Symbol.for('nova.test.mail-action-card')];export const useMemo=f=>f(),useState=v=>h().state(v);`};
 if(u==='nova-test:mail-card-host')return{format:'module',shortCircuit:true,source:`export const useInboxHost=()=>globalThis[Symbol.for('nova.test.mail-action-card')].host;`};
 return next(u,c);
}});
const {MailActionCard}=await import('../apps/client/src/dreamclaw/components/Chat/MailActionCard');hooks.deregister();
const nodes=(n:any):any[]=>Array.isArray(n)?n.flatMap(nodes):n?.props?[n,...nodes(n.props.children)]:[];
const text=(n:any):string=>Array.isArray(n)?n.map(text).join(''):n?.props?text(n.props.children):typeof n==='string'||typeof n==='number'?String(n):'';
const plan=():MailTriagePlan=>({id:randomUUID(),epoch:randomUUID(),writerId:randomUUID(),revision:3,digest:'a'.repeat(64),action:'restore',status:'partial',request:'Restore',destructive:false,summary:'Restore one message',targets:[],scopes:[],targetCount:1,messageCount:1,createdAt:new Date().toISOString(),expiresAt:new Date().toISOString(),incompleteAccounts:[],canContinue:true,canUndo:false,outcomes:[{accountId:'google:fixture',threadId:'thread',messageId:'message',subject:'Saved message',state:'failed',completedSteps:1,totalSteps:2}]});

test('actual Mail review continues only its explicit original identity and displays confirmed partial steps',{timeout:5000},async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,key),calls:any[]=[];let cursor=0;const cells:any[]=[];
 let settled!:(value:any)=>void;const completed=new Promise<any>(r=>{settled=r;});const saved=plan(),result={...saved,status:'completed' as const,canContinue:false};
 Object.defineProperty(globalThis,key,{configurable:true,value:{state(v:any){const i=cursor++;if(!(i in cells))cells[i]=v;return[cells[i],(next:any)=>{cells[i]=next;}];},host:{api:{mailAssistant:{continue:async(input:any)=>{calls.push(input);return{plan:result,message:'Confirmed original Restore'};}}},triage:{open(){}}}}});
 try{
  const tree=MailActionCard({plan:saved,onPlanChange:(next,prose)=>settled({next,prose})});
  assert.deepEqual(calls,[],'Rendering never dispatches a Restore');assert.match(text(tree),/1\/2 Restore Steps Confirmed/);
  assert.doesNotMatch(text(tree),/Undo provider changes/);
  const button=nodes(tree).find(n=>n.type==='button'&&text(n)==='Continue Original Restore');assert.ok(button);button.props.onClick();
  assert.deepEqual(calls,[{planId:saved.id,digest:saved.digest}]);const value=await completed;assert.deepEqual(value.next,result);assert.equal(value.prose,'Confirmed original Restore');
 }finally{if(original)Object.defineProperty(globalThis,key,original);else Reflect.deleteProperty(globalThis,key);}
});

test('uncertain or active Restore offers no continuation; ordinary Delete keeps its original confirmation',()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,key);let calls=0;
 Object.defineProperty(globalThis,key,{configurable:true,value:{state(v:any){return[v,()=>{}];},host:{api:{mailAssistant:{continue(){calls++;throw Error('No auto-dispatch');}}},triage:{open(){}}}}});
 try{
  for(const change of [{canContinue:false,canCheck:true},{status:'applying' as const}])assert.doesNotMatch(text(MailActionCard({plan:{...plan(),...change}})),/Continue Original Restore/);
  const normal=MailActionCard({plan:{...plan(),action:'delete',status:'awaiting_confirmation',canContinue:false}});assert.match(text(normal),/Confirm Move to trash/);assert.equal(calls,0);
 }finally{if(original)Object.defineProperty(globalThis,key,original);else Reflect.deleteProperty(globalThis,key);}
});
