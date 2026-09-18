import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { TeamWorkService } from '../apps/service/team-work.js';
import { legacyTeamBrief } from '../apps/service/team-brief.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import type { AgentDesign } from '../packages/domain/workspace-records.js';
import type { Draft,Entity,Project } from '../packages/domain/contracts.js';
import type { AssistantService } from '../apps/service/assistant.js';
import type { AssistantOperation,Conversation } from '../packages/domain/assistant.js';
import type { TeamConversationAccess } from '../packages/domain/team-work.js';

function fixture(t:any){
  const directory=mkdtempSync(join(tmpdir(),'nova-team-')),store=new Store(directory),device=store.session().deviceId;
  let time=1_800_000_000_000;const now=()=>time,generation=randomUUID();
  const agents=['Researcher','Builder','Reviewer'].map(name=>store.mutate(device,{requestId:randomUUID(),epoch:store.epoch,kind:'agent',entityId:'agent:'+randomUUID(),expectedRevision:0,payload:{...blankRecord('agent','UTC'),name,position:name,instructions:'Use actual evidence',access:{projects:'read',browser:'read'}}}) as Entity<AgentDesign>);
  const folder=join(directory,'checkout');mkdirSync(folder);
  const project=store.mutate(device,{requestId:randomUUID(),epoch:store.epoch,kind:'project',entityId:'project:'+randomUUID(),expectedRevision:0,payload:{name:'Fixture repository',purpose:'',space:'work',workspace:{folder,environment:'local'}}}) as Entity<Project>;
  const calls:{type:string;raw:any;teamId?:string}[]=[],made=new Map<string,string>();
  const worker={
    conversations:()=>store.internalList<Conversation>('assistant:conversation:'),operations:()=>store.internalList<AssistantOperation>('assistant:operation:'),
    async create(_device:string,raw:any,teamId?:string){calls.push({type:'create',raw,teamId});let id=made.get(raw.requestId);if(!id){id=randomUUID();made.set(raw.requestId,id);store.internalWrite('assistant:conversation:'+id,{...raw,id,revision:1,state:'ready',workspace:project.value.workspace,nativeKey:'agent:main:fixture:'+id,nativeId:randomUUID(),connectionGeneration:generation,archived:false,model:null,thinking:null,createdAt:new Date(time).toISOString(),updatedAt:new Date(time).toISOString()});}return store.internalRead<Conversation>('assistant:conversation:'+id)!;},
    submit(_device:string,raw:any,_steering?:boolean,teamId?:string){
      const existing=worker.operations().find(o=>o.requestId===raw.requestId);if(existing)return existing;
      calls.push({type:'submit',raw,teamId});const draft=store.readEntity('draft',raw.draftId)!,conversation=worker.conversations().find(c=>c.id===raw.conversationId)!;
      const binding=store.internalRead<TeamConversationAccess>('team:conversation:'+conversation.id);
      const op:AssistantOperation={...raw,id:randomUUID(),deviceId:_device,connectionGeneration:conversation.connectionGeneration,nativeKey:conversation.nativeKey,nativeId:conversation.nativeId!,input:draft.value.text,context:{draftId:draft.id,draftRevision:draft.revision,project:{id:project.id,revision:project.revision,...project.value},attachments:[],digest:'fixture',...(binding?{teamHandoffs:{teamId:binding.teamId,ids:[...(binding.handoffIds??[])]}}:{})},nativeRunId:randomUUID(),state:'running',text:'',model:null,thinking:null,lastSequence:0,createdAt:new Date(time).toISOString(),updatedAt:new Date(time).toISOString()};
      return store.internalWrite('assistant:operation:'+op.id,op);
    },
    async cancel(_device:string,raw:any){calls.push({type:'cancel',raw});const op=worker.operations().find(o=>o.id===raw.operationId)!;return store.internalWrite('assistant:operation:'+op.id,{...op,cancelRequested:true,state:'cancelled'});},
    async reconcile(){return {} as any;},
  };
  const service=new TeamWorkService(store,worker as unknown as AssistantService,now);t.after(async()=>{await service.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const input={requestId:randomUUID(),epoch:store.epoch,projectId:project.id,title:'Make the change',brief:'Implement and verify the requested behavior',maxMinutes:10,steps:agents.map((agent,i)=>({agentId:agent.id,role:['research','build','review'][i]}))};
  const current=()=>service.state().runs[0],finish=(text:string,state:AssistantOperation['state']='completed')=>{const op=worker.operations().find(o=>o.state==='running')!;assert(op,'Fixture has an active operation');store.internalWrite('assistant:operation:'+op.id,{...op,state,text,updatedAt:new Date(time).toISOString(),...(state==='failed'?{error:'Fixture execution failed'}:{})});};
  const control=(action:string)=>service.control(device,{requestId:randomUUID(),epoch:store.epoch,id:current().id,revision:current().revision,action});
  return {store,device,agents,project,worker,service,calls,input,current,finish,control,folder,now,elapse:(milliseconds:number)=>{time+=milliseconds;}};
}

function deferred(){let resolve!:()=>void,reject!:(reason:unknown)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fullHandoff(service:TeamWorkService,teamId:string,id:string){let text='',offset=0;for(;;){const page=service.handoff(teamId,{id,offset,limit:7000});text+=page.text;if(page.nextOffset===null)return text;offset=page.nextOffset;}}
async function failedStage(t:any){const f=fixture(t);f.service.create(f.device,f.input);await f.service.reconcile();f.finish('Retained failed attempt','failed');await f.service.reconcile();assert.equal(f.current().steps[0].state,'failed');return f;}
async function legacyDraft(t:any){
  const f=fixture(t);f.service.create(f.device,f.input);await f.service.reconcile();
  f.finish('Legacy research evidence. '.repeat(1000)+'Retain the final constraint.');f.control('pause');await f.service.reconcile();
  const key='team:run:'+f.current().id,saved=f.store.internalRead<any>(key),index=saved.next,request=saved.requests[index];
  const conversation=await f.worker.create(f.device,{requestId:request.create,epoch:f.store.epoch,space:'work',title:'Prepared legacy build',projectId:f.project.id,permissionMode:'workspace'},saved.id);
  saved.steps[index].conversationId=conversation.id;delete saved.steps[index].attempt;f.store.internalWrite(key,saved);
  const text=legacyTeamBrief({team:saved,captured:saved.agents[index].value,step:saved.steps[index]});
  const draft=f.store.mutate(f.device,{requestId:request.draft,epoch:f.store.epoch,kind:'draft',entityId:`draft:${f.device}:${conversation.id}`,expectedRevision:0,payload:{space:'work',title:'Retained draft title',text,projectId:f.project.id,conversationId:conversation.id,attachments:[]}}) as Entity<Draft>;
  assert.doesNotMatch(text,/team.handoffs.read/);return {...f,draft,legacyText:text};
}
test('team sessions share a checkout, preserve distinct responsibilities, and hand actual output to the next agent',async t=>{
  const f=fixture(t),created=f.service.create(f.device,f.input);assert.equal(f.service.create(f.device,f.input).id,created.id);await f.service.reconcile();
  for(let i=0;i<3;i++){
    const run=f.current(),step=run.steps[i];assert(step.operationId,JSON.stringify(run));assert.equal(f.calls.filter(c=>c.type==='submit').length,i+1);
    const start=f.calls.filter(c=>c.type==='create')[i];assert.equal(start.raw.permissionMode,i===1?'workspace':'read-only');assert.equal(start.teamId,run.id);
    const draft=f.store.readEntity('draft',f.calls.filter(c=>c.type==='submit')[i].raw.draftId)!;assert.equal(draft.value.text,'');const operation=f.worker.operations().find(o=>o.id===step.operationId)!;assert.match(operation.input,new RegExp(f.agents[i].value.name));if(i)assert.match(operation.input,new RegExp(`Evidence ${i-1}`));
    f.finish(`Evidence ${i}`);await f.service.reconcile();await f.service.reconcile();
  }
  assert.equal(f.current().state,'complete');assert.equal(f.calls.filter(c=>c.type==='submit').length,3);assert(f.current().steps.every(s=>s.state==='complete'));
});
test('pause waits for the current stage, restart cannot replay it, and stop cancels only its original operation',async t=>{
  const f=fixture(t);f.service.create(f.device,f.input);await f.service.reconcile();f.control('pause');await f.service.reconcile();assert.equal(f.calls.filter(c=>c.type==='cancel').length,0);
  f.finish('Research done');await f.service.reconcile();assert.equal(f.current().state,'paused');assert.equal(f.current().next,1);assert.equal(f.calls.filter(c=>c.type==='submit').length,1);
  f.control('resume');await f.service.reconcile();assert.equal(f.calls.filter(c=>c.type==='submit').length,2);
  const recovered=new TeamWorkService(f.store,f.worker as unknown as AssistantService);assert.equal(recovered.state().runs[0].state,'paused');await recovered.reconcile();assert.equal(f.calls.filter(c=>c.type==='submit').length,2);await recovered.close();
  f.control('stop');await f.service.reconcile();assert.equal(f.current().state,'cancelled');assert.equal(f.calls.filter(c=>c.type==='cancel').length,1);assert.equal(f.calls.filter(c=>c.type==='submit').length,2);
});
test('unknown work blocks the next stage and cannot be skipped; concurrent checkout work is rejected',async t=>{
  const f=fixture(t);f.service.create(f.device,f.input);await f.service.reconcile();assert.throws(()=>f.service.create(f.device,{...f.input,requestId:randomUUID()}),/running team/);
  f.finish('Unconfirmed','unknown');await f.service.reconcile();assert.equal(f.current().state,'attention');assert.equal(f.calls.filter(c=>c.type==='submit').length,1);assert.throws(()=>f.control('skip'),/unknown run/);assert.throws(()=>f.control('resume'),/Inspect/);
});

test('stopping while a session is being created prevents submission and keeps its saved conversation',async t=>{
  const f=fixture(t),create=f.worker.create;let release!:()=>void;const held=new Promise<void>(r=>release=r);
  f.worker.create=async(...args:Parameters<typeof create>)=>{await held;return create(...args);};
  f.service.create(f.device,f.input);f.control('stop');release();await f.service.reconcile();await f.service.reconcile();
  assert.equal(f.current().state,'cancelled');assert.equal(f.calls.filter(c=>c.type==='submit').length,0);
});
test('a missing access binding is repaired before resuming a saved stage, and unknown polls do not churn its revision',async t=>{
  const f=fixture(t),submit=f.worker.submit;let reject=true;
  f.worker.submit=(...args:Parameters<typeof submit>)=>{if(reject)throw Error('Before dispatch');return submit(...args);};
  f.service.create(f.device,f.input);await f.service.reconcile();const id=f.current().steps[0].conversationId!;
  assert(id);f.store.internalDelete('team:conversation:'+id);reject=false;f.control('resume');await f.service.reconcile();
  assert.equal(f.store.internalRead<any>('team:conversation:'+id)?.agentId,f.agents[0].id);
  f.finish('Still checking','unknown');await f.service.reconcile();const revision=f.current().revision;await f.service.reconcile();assert.equal(f.current().revision,revision);
});

test('submitted team briefings leave an empty composer and preserve later owner writing through restart',async t=>{
 const f=fixture(t);f.service.create(f.device,f.input);await f.service.reconcile();
 const operation=f.worker.operations()[0],draft=f.store.readEntity('draft',operation.context.draftId)!;
 assert.equal(draft.value.text,'');assert.match(operation.input,/Owner request/);
 f.store.mutate(f.device,{requestId:randomUUID(),epoch:f.store.epoch,kind:'draft',entityId:draft.id,expectedRevision:draft.revision,payload:{...draft.value,text:'My unsent follow-up'}});
 const recovered=new TeamWorkService(f.store,f.worker as unknown as AssistantService);
 assert.equal(f.store.readEntity('draft',draft.id)!.value.text,'My unsent follow-up');
 await recovered.close();
});

test('retry replays one new execution across restart and retains failed output, owner writing and checkout changes',async t=>{
  const f=fixture(t);f.service.create(f.device,f.input);await f.service.reconcile();
  f.finish('Research checked the existing files');await f.service.reconcile();await f.service.reconcile();
  const original=f.worker.operations().find(o=>o.id===f.current().steps[1].operationId)!;
  const text='Partial implementation evidence.\n'.repeat(1200)+'KEEP THE FINAL CONSTRAINT AND UNFINISHED CHECK';
  const file=join(f.folder,'partial-change.txt');writeFileSync(file,'Existing change left by the failed implementation');
  f.finish(text,'failed');await f.service.reconcile();
  const failed=f.current(),old=failed.steps[1],draft=f.store.readEntity('draft',original.context.draftId)!;
  const ownerDraft=f.store.mutate(f.device,{requestId:randomUUID(),epoch:f.store.epoch,kind:'draft',entityId:draft.id,expectedRevision:draft.revision,payload:{...draft.value,text:'My unsent instructions after the failed attempt'}});
  assert(old.handoff);assert.equal(fullHandoff(f.service,failed.id,old.handoff.id),text);
  const command={requestId:randomUUID(),epoch:f.store.epoch,id:failed.id,revision:failed.revision,action:'retry'};
  const admitted=f.service.control(f.device,command);assert.deepEqual(f.service.control(f.device,command),admitted);
  await f.service.reconcile();
  const retried=f.current(),step=retried.steps[1],current=f.worker.operations().find(o=>o.id===step.operationId)!;
  const {agentId,agentName,agentRevision,role,...retained}=old;
  assert.equal(step.attempt,2);assert.deepEqual(step.attempts,[retained]);
  assert.equal(step.agentId,agentId);assert.equal(step.agentName,agentName);assert.equal(step.agentRevision,agentRevision);assert.equal(step.role,role);
  assert.notEqual(current.id,original.id);assert.notEqual(current.requestId,original.requestId);assert.notEqual(current.conversationId,original.conversationId);
  assert.equal(current.context.teamHandoffs?.ids.includes(old.handoff.id),true);
  assert.match(current.input,/previous failed attempt 1/);assert.match(current.input,new RegExp(old.handoff.id));assert.doesNotMatch(current.input,/KEEP THE FINAL CONSTRAINT/);
  assert.equal(f.calls.filter(c=>c.type==='create').at(-1)!.raw.permissionMode,'workspace');
  assert.equal(f.worker.conversations().find(c=>c.id===current.conversationId)!.workspace?.folder,f.folder);
  assert.equal(f.worker.operations().find(o=>o.id===original.id)!.text,text);
  assert.deepEqual(f.store.readEntity('draft',ownerDraft.id),ownerDraft);
  assert.equal(readFileSync(file,'utf8'),'Existing change left by the failed implementation');
  assert.equal(f.calls.filter(c=>c.type==='submit').length,3);
  await f.service.close();
  const recovered=new TeamWorkService(f.store,f.worker as unknown as AssistantService,f.now);
  try{
    assert.deepEqual(recovered.control(f.device,command),admitted);await recovered.reconcile();
    assert.equal(f.calls.filter(c=>c.type==='submit').length,3);
    assert.equal(recovered.state().runs[0].steps[1].attempt,2);
    assert.equal(fullHandoff(recovered,failed.id,old.handoff.id),text);
    assert.deepEqual(f.store.readEntity('draft',ownerDraft.id),ownerDraft);
    assert.equal(readFileSync(file,'utf8'),'Existing change left by the failed implementation');
  }finally{await recovered.close();}
});

test('complete handoffs beyond the old cutoff remain paged and captured by the next stage after restart',async t=>{
  const f=fixture(t);f.service.create(f.device,f.input);await f.service.reconcile();
  const result='Detailed evidence. '.repeat(1500)+'\nDo not remove the backwards-compatibility path. 🔎';
  f.finish(result);await f.service.reconcile();await f.service.reconcile();
  const run=f.current(),handoff=run.steps[0].handoff!,next=f.worker.operations().find(o=>o.id===run.steps[1].operationId)!;
  assert.equal(fullHandoff(f.service,run.id,handoff.id),result);
  assert.equal(next.context.teamHandoffs?.ids.includes(handoff.id),true);
  assert.match(next.input,/only an excerpt/);assert.match(next.input,/team.handoffs.read/);assert.doesNotMatch(next.input,/backwards-compatibility path/);
  await f.service.close();f.store.internalDelete('assistant:operation:'+run.steps[0].operationId);
  const recovered=new TeamWorkService(f.store,f.worker as unknown as AssistantService,f.now);
  try{assert.equal(fullHandoff(recovered,run.id,handoff.id),result);assert.equal(f.calls.filter(c=>c.type==='submit').length,2);}finally{await recovered.close();}
});

test('a failed legacy handoff backfill leaves the workspace open with its original excerpt and references',async t=>{
  const f=fixture(t);f.service.create(f.device,f.input);await f.service.reconcile();
  const output='Original legacy execution evidence. '.repeat(900)+'LAST RETAINED CONSTRAINT';
  f.finish(output);f.control('pause');await f.service.reconcile();await f.service.close();
  const key='team:run:'+f.current().id,legacy=f.store.internalRead<any>(key),step=legacy.steps[0];
  f.store.internalDelete('team:handoff:'+step.handoff.id);delete step.handoff;f.store.internalWrite(key,legacy);
  const before=f.current(),write=f.store.internalWrite.bind(f.store);let captures=0;
  f.store.internalWrite=<T>(id:string,value:T):T=>{if(id.startsWith('team:handoff:')){captures++;throw new Error('Injected unavailable handoff storage');}return write(id,value);};
  let recovered:TeamWorkService|undefined;
  try{
    recovered=new TeamWorkService(f.store,f.worker as unknown as AssistantService,f.now);
    assert.equal(captures,1);assert.deepEqual(recovered.state().runs[0],before);
    const retained=recovered.state().runs[0].steps[0];
    assert.equal(retained.handoff,undefined);assert.equal(retained.result,output.slice(0,20000));
    assert.equal(retained.operationId,step.operationId);assert.equal(retained.conversationId,step.conversationId);
    assert.equal(f.worker.operations().find(o=>o.id===step.operationId)!.text,output);
    await recovered.reconcile();assert.equal(f.calls.filter(c=>c.type==='submit').length,1);
  }finally{f.store.internalWrite=write;await recovered?.close();}
});

test('repeated missing-operation observations keep the same attention revision and never resubmit',async t=>{
  const f=await failedStage(t);f.store.internalDelete('assistant:operation:'+f.current().steps[0].operationId);
  await f.service.reconcile();const attention=f.current();assert.match(attention.message,/original execution is unavailable/);
  f.elapse(6000);await f.service.reconcile();await f.service.reconcile();
  assert.deepEqual(f.current(),attention);assert.equal(f.calls.filter(c=>c.type==='submit').length,1);
});

for(const changed of ['unknown','running','cancelled','missing','request','conversation','epoch','operation'] as const){
  test(`retry rejects execution with ${changed} state or identity without creating another session`,async t=>{
    const f=await failedStage(t),step=f.current().steps[0],op=f.worker.operations().find(o=>o.id===step.operationId)!;
    if(changed==='missing')f.store.internalDelete('assistant:operation:'+op.id);
    else if(changed==='operation'){
      const key='team:run:'+f.current().id,run=f.store.internalRead<any>(key);run.steps[0].operationId=randomUUID();f.store.internalWrite(key,run);
    }else f.store.internalWrite('assistant:operation:'+op.id,{...op,...(changed==='request'?{requestId:randomUUID()}:changed==='conversation'?{conversationId:randomUUID()}:changed==='epoch'?{epoch:randomUUID()}:{state:changed})});
    assert.throws(()=>f.control('retry'),/Only a confirmed failed execution/);
    assert.equal(f.current().steps[0].attempt,1);assert.equal(f.current().steps[0].attempts,undefined);
    assert.equal(f.calls.filter(c=>c.type==='create').length,1);assert.equal(f.calls.filter(c=>c.type==='submit').length,1);
  });
}

test('retry rejects stale workflow revisions and changed captured project context',async t=>{
  const f=await failedStage(t),old=f.current();f.control('pause');
  assert.throws(()=>f.service.control(f.device,{requestId:randomUUID(),epoch:f.store.epoch,id:old.id,revision:old.revision,action:'retry'}),/workflow advanced/);
  f.store.mutate(f.device,{requestId:randomUUID(),epoch:f.store.epoch,kind:'project',entityId:f.project.id,expectedRevision:f.project.revision,payload:{...f.project.value,purpose:'Different captured context'}});
  assert.throws(()=>f.control('retry'),/Project settings changed/);
  assert.equal(f.current().steps[0].attempt,1);assert.equal(f.calls.filter(c=>c.type==='submit').length,1);
});

for(const action of ['pause','stop'] as const){
  test(`${action} during retry session creation keeps both conversations and prevents new dispatch`,async t=>{
    const f=await failedStage(t),old=f.current().steps[0],create=f.worker.create,held=deferred(),entered=deferred();
    f.worker.create=async(...args:Parameters<typeof create>)=>{entered.resolve();await held.promise;return create(...args);};
    f.control('retry');await entered.promise;f.control(action);held.resolve();await f.service.reconcile();
    const current=f.current();assert.equal(current.state,action==='stop'?'cancelled':'paused');
    assert.equal(current.steps[0].attempt,2);assert.equal(current.steps[0].attempts?.[0].conversationId,old.conversationId);
    assert(current.steps[0].conversationId);assert.notEqual(current.steps[0].conversationId,old.conversationId);
    assert.equal(current.steps[0].operationId,undefined);assert.equal(f.worker.conversations().length,2);assert.equal(f.calls.filter(c=>c.type==='submit').length,1);
  });
}

for(const rejected of [false,true]){
  test(`a delayed old reconciliation ${rejected?'failure':'result'} cannot overwrite a newly admitted retry`,async t=>{
    const f=await failedStage(t),old=f.worker.operations()[0],held=deferred(),entered=deferred(),reconcile=f.worker.reconcile;
    // A retained legacy failure may have an in-flight reconciliation when its
    // exact terminal outcome arrives. The owner's retry must supersede it.
    f.store.internalWrite('assistant:operation:'+old.id,{...old,state:'unknown'});
    f.worker.reconcile=async()=>{entered.resolve();await held.promise;return {} as any;};
    const reading=f.service.reconcile();await entered.promise;
    f.store.internalWrite('assistant:operation:'+old.id,old);f.control('retry');
    if(rejected)held.reject(new Error('Late old observation failed'));else held.resolve();
    await reading;
    assert.equal(f.current().state,'running');assert.equal(f.current().steps[0].attempt,2);assert.equal(f.current().steps[0].state,'waiting');assert.equal(f.current().steps[0].operationId,undefined);
    f.worker.reconcile=reconcile;await f.service.reconcile();
    assert.equal(f.current().steps[0].state,'running');assert.notEqual(f.current().steps[0].operationId,old.id);assert.equal(f.calls.filter(c=>c.type==='submit').length,2);
  });
}

test('context changed while the retry session is being prepared cannot cross the submission boundary',async t=>{
  const f=await failedStage(t),create=f.worker.create,held=deferred(),entered=deferred();
  f.worker.create=async(...args:Parameters<typeof create>)=>{entered.resolve();await held.promise;return create(...args);};
  f.control('retry');await entered.promise;
  f.store.mutate(f.device,{requestId:randomUUID(),epoch:f.store.epoch,kind:'project',entityId:f.project.id,expectedRevision:f.project.revision,payload:{...f.project.value,purpose:'Changed during retry preparation'}});
  held.resolve();await f.service.reconcile();
  assert.equal(f.current().state,'attention');assert.match(f.current().message,/Project settings changed/);
  assert.equal(f.current().steps[0].attempt,2);assert.equal(f.current().steps[0].attempts?.[0].state,'failed');
  assert.equal(f.current().steps[0].operationId,undefined);assert.equal(f.calls.filter(c=>c.type==='submit').length,1);
});

test('retry starts a fresh time limit and timeout cancels only the new execution',async t=>{
  const f=fixture(t);f.service.create(f.device,f.input);await f.service.reconcile();f.elapse(9*60000);
  f.finish('Stopped before the first limit','failed');await f.service.reconcile();const old=f.current().steps[0];
  f.control('retry');await f.service.reconcile();const retried=f.current().steps[0];
  assert.equal(retried.startedAt,f.now());assert(retried.startedAt!>old.startedAt!);
  f.elapse(2*60000);await f.service.reconcile();assert.equal(f.calls.filter(c=>c.type==='cancel').length,0);
  f.elapse(9*60000);await f.service.reconcile();
  const cancelled=f.calls.filter(c=>c.type==='cancel');assert.equal(cancelled.length,1);assert.equal(cancelled[0].raw.operationId,retried.operationId);assert.equal(f.current().steps[0].state,'cancelled');
  assert.equal(f.current().steps[0].attempts?.[0].operationId,old.operationId);
});

test('an exact legacy generated draft upgrades its complete handoff guidance and submits once',async t=>{
  const f=await legacyDraft(t),submit=f.worker.submit;let preparedTitle:string|undefined;
  f.worker.submit=(...args:Parameters<typeof submit>)=>{preparedTitle=f.store.readEntity('draft',f.draft.id)?.value.title;return submit(...args);};
  f.control('resume');await f.service.reconcile();await f.service.reconcile();
  const op=f.worker.operations().find(o=>o.id===f.current().steps[1].operationId)!;
  assert(op);assert.match(op.input,/team.handoffs.read/);assert.match(op.input,new RegExp(f.current().steps[0].handoff!.id));
  assert.equal(op.context.draftRevision,f.draft.revision+1);assert.equal(preparedTitle,'Retained draft title');
  assert.equal(f.calls.filter(c=>c.type==='submit').length,2);assert.equal(f.store.readEntity('draft',f.draft.id)!.value.text,'');
});

test('owner changes to a legacy generated draft remain untouched and prevent automatic submission',async t=>{
  const f=await legacyDraft(t),draft=f.store.mutate(f.device,{requestId:randomUUID(),epoch:f.store.epoch,kind:'draft',entityId:f.draft.id,expectedRevision:f.draft.revision,payload:{...f.draft.value,text:f.legacyText+'\nOwner amendment: wait for my additional requirements.'}});
  f.control('resume');await f.service.reconcile();
  assert.equal(f.current().state,'attention');assert.match(f.current().message,/changed draft/);
  assert.deepEqual(f.store.readEntity('draft',draft.id),draft);assert.equal(f.current().steps[1].operationId,undefined);
  assert.equal(f.calls.filter(c=>c.type==='submit').length,1);
});

test('restart after a legacy draft upgrade reuses the saved revision and submits its original request once',async t=>{
  const f=await legacyDraft(t),submit=f.worker.submit;
  f.worker.submit=()=>{throw new Error('Interrupted after upgrading but before submitting');};
  f.control('resume');await f.service.reconcile();
  const upgraded=f.store.readEntity('draft',f.draft.id)!;assert.equal(upgraded.revision,f.draft.revision+1);assert.match(upgraded.value.text,/team.handoffs.read/);
  assert.equal(f.calls.filter(c=>c.type==='submit').length,1);await f.service.close();f.worker.submit=submit;
  const recovered=new TeamWorkService(f.store,f.worker as unknown as AssistantService,f.now);
  try{
    const current=recovered.state().runs[0],command={requestId:randomUUID(),epoch:f.store.epoch,id:current.id,revision:current.revision,action:'resume'};
    recovered.control(f.device,command);await recovered.reconcile();recovered.control(f.device,command);await recovered.reconcile();
    const op=f.worker.operations().find(o=>o.id===recovered.state().runs[0].steps[1].operationId)!;
    assert.equal(op.input,upgraded.value.text);assert.equal(op.context.draftRevision,upgraded.revision);
    assert.equal(f.store.readEntity('draft',f.draft.id)!.revision,upgraded.revision+1);
    assert.equal(f.calls.filter(c=>c.type==='submit').length,2);assert.equal(f.calls.filter(c=>c.type==='create').length,2);
  }finally{await recovered.close();}
});
