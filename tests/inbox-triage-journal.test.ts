import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createInboxTriageJournal } from '../apps/client/src/dreamclaw/inbox-triage-journal';
import { ApiError } from '../apps/client/src/api';
import type { MailTriagePlan } from '../packages/domain/mail-triage';

function fixture(){
  const epoch=randomUUID(),diskData=new Map<string,any>();let writable=true;
  const scope={epoch,deviceId:'device',windowId:'window'};
  const disk={read:(key:string)=>structuredClone(diskData.get(key)),write:(key:string,value:any)=>{if(!writable)return false;diskData.set(key,structuredClone(value));return true;}};
  const payload={action:'flag' as const,targets:[{provider:'gmail' as const,accountId:'google:fixture',generation:randomUUID(),threadId:'thread'}]};
  let plan:MailTriagePlan|undefined,lose=false,effects=0;const receipts=new Set<string>(),calls:{action:string;input:any}[]=[];
  const send=async(action:'prepare'|'confirm'|'read'|'reconcile',input:any):Promise<MailTriagePlan>=>{
    calls.push({action,input:structuredClone(input)});
    if(action==='prepare')plan??={id:randomUUID(),epoch,writerId:input.writerId,digest:'a'.repeat(64),revision:1,request:'Flag',action:'flag',status:'awaiting_confirmation',destructive:false,summary:'Flag one conversation',targets:[],scopes:[],targetCount:1,messageCount:1,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),incompleteAccounts:[],outcomes:[]};
    if(action==='confirm'&&!receipts.has(input.requestId)){if(input.expectedRevision!==plan!.revision)throw new ApiError('mail_triage_changed','Review changed',undefined,409);receipts.add(input.requestId);effects++;plan={...plan!,revision:plan!.revision+1,status:input.decision==='cancel'?'cancelled':'completed'};}
    if(lose){lose=false;throw Error('Lost response');}
    return structuredClone(plan!);
  };
  return {scope,disk,payload,calls,send,get effects(){return effects;},set lose(value:boolean){lose=value;},set writable(value:boolean){writable=value;},make:(windowId='window',previousWindowId?:string)=>createInboxTriageJournal({...scope,windowId,previousWindowId},send,disk)};
}
test('lost preparation response survives reload with the same original request and opens one review',async()=>{
  const f=fixture(),journal=f.make();f.lose=true;await assert.rejects(journal.prepare(f.payload),/Lost/);
  const kept=Object.entries(journal.store.getState().records)[0];assert.equal(kept[1].pending,'prepare');
  const reloaded=f.make(),result=await reloaded.check(kept[0]);assert.equal(result.id,Object.values(reloaded.store.getState().records)[0].plan?.id);assert.equal(f.calls[0].input.requestId,f.calls[1].input.requestId);assert.equal(f.effects,0);
});
test('lost confirmation and cloned window recovery retain the exact command, with one effect',async()=>{
  const f=fixture(),journal=f.make(),plan=await journal.prepare(f.payload);f.lose=true;await assert.rejects(journal.act(plan.id,'apply',plan.digest),/Lost/);
  const clone=f.make('clone','window');await assert.rejects(clone.act(plan.id,'apply',plan.digest),/unconfirmed/);await clone.checkPlan(plan.id);
  assert.equal(f.effects,1);const confirmations=f.calls.filter(c=>c.action==='confirm');assert.equal(confirmations[0].input.requestId,confirmations[1].input.requestId);assert.equal(Object.values(clone.store.getState().records)[0].plan?.status,'completed');
});
test('failed cancellation is not invented locally and converges to the stored provider-action status',async()=>{
  const f=fixture(),journal=f.make(),plan=await journal.prepare(f.payload);f.lose=true;await assert.rejects(journal.act(plan.id,'cancel',plan.digest),/Lost/);assert.equal(Object.values(journal.store.getState().records)[0].plan?.status,'awaiting_confirmation');
  await journal.checkPlan(plan.id);assert.equal(Object.values(journal.store.getState().records)[0].plan?.status,'cancelled');assert.equal(f.effects,1);
});
test('full browser storage stops new review and confirmation dispatch while retaining recovery in memory',async()=>{
  const f=fixture(),journal=f.make(),plan=await journal.prepare(f.payload);f.writable=false;await assert.rejects(journal.act(plan.id,'apply',plan.digest),/saved/);assert.equal(f.effects,0);assert.equal(f.calls.length,1);assert.equal(journal.store.getState().storageError,true);await assert.rejects(journal.checkPlan(plan.id),/saved/);assert.equal(f.calls.length,1);
});

test('automatic read saves its exact request before dispatch and can recover a lost response after reload',async()=>{
 const f=fixture(),calls:any[]=[];let lost=true;
 const send=async(input:any)=>{calls.push(structuredClone(input));if(lost){lost=false;throw Error('Lost response');}return {};};
 const make=()=>createInboxTriageJournal(f.scope,f.send,f.disk,send),journal=make();
 await assert.rejects(journal.displayed({target:f.payload.targets[0],messageIds:['m1']}),/Lost/);
 const [id,record]=Object.entries(journal.store.getState().records)[0];assert.equal(record.pending,'prepare');
 await assert.rejects(make().check(id),/already read/);assert.deepEqual(calls[0],calls[1]);
 f.writable=false;await assert.rejects(make().displayed({target:f.payload.targets[0],messageIds:['m1']}),/saved/);assert.equal(calls.length,2);
});
