import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ModuleAction } from '../packages/domain/module-actions';
import { consumeAssistantAppAction, type AppActionOutcome, type AppActionWindow } from '../apps/client/src/assistant-app-actions';

const epoch=randomUUID(),deviceId=randomUUID();
function fixture() {
  const seen=new Set<string>(),outcomes=new Map<string,AppActionOutcome>(),acks:AppActionOutcome[]=[];
  let opens=0,saves=0;
  const action={id:randomUUID(),epoch,deviceId,conversationId:randomUUID(),operationId:randomUUID(),inputHash:'a'.repeat(64),title:'Open Calendar',revision:1,external:false,preview:{module:'calendar'},updatedAt:new Date().toISOString(),operation:'app.open',input:{module:'calendar'},createdAt:new Date().toISOString(),state:'unknown',result:{state:'requested'}} satisfies ModuleAction as ModuleAction;
  const window:AppActionWindow={epoch,deviceId,visible:()=>true,authorize:async()=>true,exclusive:async(_name,work)=>{await work();},open:()=>{opens++;return true;},keep:id=>{if(seen.has(id))return false;seen.add(id);return true;},previous:id=>outcomes.get(id),retain:(id,outcome)=>{outcomes.set(id,outcome);},acknowledge:async(_id,outcome)=>{acks.push(outcome);},readAppearance:()=>({interfaceFont:'system',interfaceTextSize:'standard',messageFont:'system',messageTextSize:'standard'}),saveAppearance:()=>{saves++;return true;}};
  return {action,window,acks,get opens(){return opens;},get saves(){return saves;}};
}
test('an app request targets only its original visible device and acknowledged action state',async()=>{
  for(const patch of [{epoch:randomUUID()},{deviceId:randomUUID()},{visible:()=>false}]){
    const f=fixture();await consumeAssistantAppAction(f.action,{...f.window,...patch});assert.equal(f.opens,0);assert.equal(f.acks.length,0);
  }
  const f=fixture();await consumeAssistantAppAction({...f.action,state:'pending'},f.window);assert.equal(f.opens,0);
  await consumeAssistantAppAction(f.action,f.window);assert.equal(f.opens,1);assert.equal(f.acks[0].state,'opened');
});
test('a lost acknowledgement retries only the saved outcome without replaying navigation',async()=>{
  const f=fixture();let fail=true;f.window.acknowledge=async(_id,outcome)=>{if(fail){fail=false;throw Error('Lost acknowledgement');}f.acks.push(outcome);};
  await assert.rejects(consumeAssistantAppAction(f.action,f.window),/Lost/);
  await consumeAssistantAppAction(f.action,f.window);assert.equal(f.opens,1);assert.equal(f.acks[0].state,'opened');
});
test('two windows contend for one exclusive claim and perform only one navigation',async()=>{
 const f=fixture();let held=false,release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
 f.window.exclusive=async(_name,work)=>{if(held)return;held=true;try{await work();}finally{held=false;}};
 f.window.acknowledge=async(_id,outcome)=>{await pending;f.acks.push(outcome);};
 const first=consumeAssistantAppAction(f.action,f.window),second=consumeAssistantAppAction(f.action,{...f.window});
 await second;assert.equal(f.opens,1);release();await first;
 await consumeAssistantAppAction(f.action,f.window);assert.equal(f.opens,1);
});
test('leaving the original window while authorization is pending cannot navigate later',async()=>{
 const f=fixture();let resolve!:(value:boolean)=>void,visible=true;f.window.visible=()=>visible;
 f.window.authorize=()=>new Promise<boolean>(done=>{resolve=done;});
 const running=consumeAssistantAppAction(f.action,f.window);visible=false;resolve(true);await running;
 assert.equal(f.opens,0);assert.equal(f.acks.length,0);
});
test('unsaved writing blocks app navigation and stale requests never open late',async()=>{
  const f=fixture();f.window.open=()=>false;await consumeAssistantAppAction(f.action,f.window);assert.equal(f.acks[0].state,'blocked');assert.match(f.acks[0].message,/unsaved/);
  const g=fixture();g.action.createdAt=new Date(Date.now()-121000).toISOString();await consumeAssistantAppAction(g.action,g.window);assert.equal(g.opens,0);assert.equal(g.acks[0].state,'blocked');
});
test('device appearance preserves unspecified preferences and reports persistence failure honestly',async()=>{
  const f=fixture();f.action.operation='app.appearance';f.action.input={messageTextSize:'large'};let saved:unknown;
  f.window.saveAppearance=preferences=>{saved=preferences;return true;};await consumeAssistantAppAction(f.action,f.window);
  assert.deepEqual(saved,{interfaceFont:'system',interfaceTextSize:'standard',messageFont:'system',messageTextSize:'large'});assert.equal(f.acks[0].state,'saved');
  const g=fixture();g.action.operation='app.appearance';g.action.input={interfaceFont:'serif'};g.window.saveAppearance=()=>false;await consumeAssistantAppAction(g.action,g.window);assert.equal(g.acks[0].state,'blocked');
});
test('invalid app fields and an unretained request cannot perform UI effects',async()=>{
  const f=fixture();f.action.input={module:'settings',token:'never'};await consumeAssistantAppAction(f.action,f.window);assert.equal(f.opens,0);assert.equal(f.acks[0].state,'blocked');
  const g=fixture();g.window.keep=()=>false;await consumeAssistantAppAction(g.action,g.window);assert.equal(g.opens,0);assert.equal(g.acks.length,0);
});
test('revoked permission blocks a queued UI effect while a retained outcome can still be acknowledged',async()=>{
 const f=fixture();f.window.authorize=async()=>false;await consumeAssistantAppAction(f.action,f.window);assert.equal(f.opens,0);assert.equal(f.acks[0].state,'blocked');
 const g=fixture();await consumeAssistantAppAction(g.action,g.window);g.window.authorize=async()=>false;
 await consumeAssistantAppAction(g.action,g.window);assert.equal(g.opens,1);assert.equal(g.acks.at(-1)?.state,'opened');
});
