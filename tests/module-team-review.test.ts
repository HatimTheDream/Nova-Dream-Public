import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { ModuleActions, type ModuleServices } from '../apps/service/module-actions.js';
import { captureTeamHandoff } from '../apps/service/team-handoffs.js';
import { completedTeamReview, readCompletedTeamReview } from '../apps/service/team-review.js';
import { blankRecord, type AgentDesign } from '../packages/domain/workspace-records.js';
import type { Entity } from '../packages/domain/contracts.js';
import type { AssistantOperation, Conversation } from '../packages/domain/assistant.js';
import type { ModuleAction } from '../packages/domain/module-actions.js';
import type { TeamConversationAccess, TeamWork } from '../packages/domain/team-work.js';
import type { TeamReviewInput, TeamReviewScope } from '../packages/domain/team-review.js';

const needsChanges:TeamReviewInput={verdict:'needs_changes',summary:'The submission can lose an unsent draft.',findings:[{id:'draft-preservation',priority:'high',title:'Preserve newer writing',detail:'Clear only the exact submitted draft revision.',location:'apps/service/assistant.ts'}],checks:[{name:'Draft replacement regression',outcome:'failed',detail:'The newer text was cleared.'}]};
const ready:TeamReviewInput={verdict:'ready_for_review',summary:'The reviewed behavior passes the requested checks.',findings:[],checks:[{name:'Draft preservation regression',outcome:'passed',detail:'Newer writing is retained.'}]};

function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'nova-module-review-')),store=new Store(directory),device=store.session().deviceId,generation=randomUUID(),teamId=randomUUID();
  const agent=store.mutate(device,{requestId:randomUUID(),epoch:store.epoch,kind:'agent',entityId:'agent:'+randomUUID(),expectedRevision:0,payload:{...blankRecord('agent','UTC'),name:'Reviewer',position:'Reviewer',access:{}}}) as Entity<AgentDesign>;
  const conversation:Conversation={id:randomUUID(),revision:1,title:'Review',projectId:null,archived:false,permissionMode:'read-only',model:null,thinking:null,createdAt:'',updatedAt:'',connectionGeneration:generation,nativeKey:'agent:main:e3:'+randomUUID(),nativeId:randomUUID(),state:'ready'};
  const scope:TeamReviewScope={teamId,stage:0,attempt:1,agentId:agent.id,agentRevision:agent.revision,submitRequestId:randomUUID()};
  const operation:AssistantOperation={id:randomUUID(),requestId:scope.submitRequestId,deviceId:device,epoch:store.epoch,conversationId:conversation.id,conversationRevision:1,connectionGeneration:generation,nativeKey:conversation.nativeKey,nativeId:conversation.nativeId!,nativeRunId:randomUUID(),state:'running',input:'Review prior work',context:{project:null,attachments:[],draftId:'fixture',draftRevision:1,digest:'a'.repeat(64),teamHandoffs:{teamId,ids:[]},teamReview:{...scope}},model:null,thinking:null,createdAt:'',updatedAt:'',text:'',lastSequence:0};
  const binding:TeamConversationAccess={epoch:store.epoch,teamId,agentId:agent.id,agentRevision:agent.revision,access:{},role:'review',handoffIds:[],review:{...scope}};
  const team:TeamWork&{epoch:string;requests:{submit:string}[];agents:Entity<AgentDesign>[]}={id:teamId,epoch:store.epoch,revision:1,projectId:'project:fixture',projectName:'Fixture',title:'Inspect writing',brief:'Preserve saved work',folder:directory,maxMinutes:10,state:'running',message:'Reviewing',steps:[{agentId:agent.id,agentName:agent.value.name,agentRevision:agent.revision,role:'review',state:'running',attempt:1,conversationId:conversation.id,operationId:operation.id}],next:0,createdAt:1000,updatedAt:1000,requests:[{submit:operation.requestId}],agents:[agent]};
  const persist=()=>{store.internalWrite('team:conversation:'+conversation.id,binding);store.internalWrite('team:run:'+teamId,team);};persist();
  let assignmentCalls=0;
  const deps={store,assistant:{conversations:()=>[conversation],operations:()=>[operation]},gateway:{status:()=>({generation})},assignments:{authorizeModule:()=>{assignmentCalls++;throw Error('Assignment authority must not run');}}} as unknown as ModuleServices;
  let service=new ModuleActions(deps);
  const input=(name='team.review.submit',value:unknown=needsChanges,write=true)=>({operation:name,input:value,epoch:store.epoch,nativeKey:conversation.nativeKey,nativeId:conversation.nativeId,toolCallId:randomUUID(),permissionMode:conversation.permissionMode,write});
  const invoke=(raw=input())=>service.invoke(raw) as Promise<ModuleAction>;
  const complete=()=>{operation.state='completed';captureTeamHandoff(store,{epoch:store.epoch,teamId,stage:0,attempt:1,operation});return completedTeamReview(store,{teamId,stage:0,attempt:1,operation});};
  const check=(action:ModuleAction)=>service.decide(device,{requestId:randomUUID(),epoch:store.epoch,actionId:action.id,expectedRevision:action.revision,decision:'check'});
  t.after(async()=>{await service.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,device,conversation,operation,scope,teamId,agent,binding,team,persist,input,invoke,complete,check,get service(){return service;},get assignmentCalls(){return assignmentCalls;},async restart(){await service.close();service=new ModuleActions(deps);}};
}

test('read-only reviewers submit one immutable report without gaining workspace writes',async t=>{
  const f=fixture(t),input=f.input(),[a,b]=await Promise.all([f.invoke(input),f.invoke(input)]);
  assert.equal(a.state,'applied');assert.equal(a.id,b.id);assert.equal(f.store.internalList('team:review:').length,1);
  const report=(a.result as any).report;assert.equal(report.verdict,'needs_changes');assert.equal(report.operationId,f.operation.id);
  assert.equal((await f.invoke()).state,'applied');assert.deepEqual((await f.invoke()).result,a.result);
  assert.equal(completedTeamReview(f.store,{teamId:f.teamId,stage:0,attempt:1,operation:f.operation}),undefined);
  await assert.rejects(f.invoke(f.input('records.save',{kind:'task',expectedRevision:0,changes:{title:'Unauthorized'}})),/capability/);
  await assert.rejects(f.invoke(f.input('agents.start',{})),/capability/);
  const changed=await f.invoke(f.input('team.review.submit',ready));assert.equal(changed.state,'failed');assert.match(changed.error!,/cannot be replaced/);
  assert.equal(f.store.internalList('team:review:').length,1);assert.equal(f.store.listEntities('task').length,0);
  assert.deepEqual(f.complete(),report);
});

test('contradictory, oversized, duplicate-id and authority-selecting reports are rejected before persistence',async t=>{
  const f=fixture(t),invalid=[{...needsChanges,findings:[]},{...ready,findings:needsChanges.findings},{...ready,checks:needsChanges.checks},{...needsChanges,findings:[needsChanges.findings[0],needsChanges.findings[0]]},{...ready,checks:[]},{...ready,summary:'x'.repeat(2001)},{...ready,teamId:randomUUID()},{...ready,operationId:randomUUID()}];
  for(const report of invalid)await assert.rejects(f.invoke(f.input('team.review.submit',report)));
  assert.equal(f.store.internalList('team:review:').length,0);
  const schema:any=await f.service.invoke(f.input('catalog',{operation:'team.review.submit'},false));assert.equal(schema.schema.type,'object');assert.equal(schema.schema.additionalProperties,false);
});

test('reports bind the original active execution, native identity and captured stage',async t=>{
  const f=fixture(t),reject=()=>assert.rejects(f.invoke(),/original|running|workspace|active/);
  for(const patch of [{state:'unknown'},{state:'completed'},{cancelRequested:true},{nativeKey:'foreign'},{connectionGeneration:randomUUID()},{requestId:randomUUID()}]){
    const previous={...f.operation};Object.assign(f.operation,patch);await reject();Object.assign(f.operation,previous);delete f.operation.cancelRequested;
  }
  f.operation.context.teamReview=undefined;await reject();f.operation.context.teamReview={...f.scope};
  f.operation.context.teamReview.attempt=2;await reject();f.operation.context.teamReview={...f.scope};
  f.conversation.pendingSettings={requestId:randomUUID()};await reject();delete f.conversation.pendingSettings;
  f.team.state='stopping';f.persist();await reject();f.team.state='running';
  f.team.requests[0].submit=randomUUID();f.persist();await reject();f.team.requests[0].submit=f.operation.requestId;
  f.team.next=1;f.persist();await reject();f.team.next=0;
  f.team.steps[0].operationId=randomUUID();f.persist();await reject();f.team.steps[0].operationId=f.operation.id;
  f.binding.review={...f.scope,agentId:'agent:foreign'};f.persist();await reject();
  assert.equal(f.store.internalList('team:review:').length,0);
});

test('agent archive, current binding revocation, and assignments cannot submit a team report',async t=>{
  const f=fixture(t);
  f.binding.role='build';f.persist();await assert.rejects(f.invoke(),/capability/);f.binding.role='review';
  f.binding.access={projects:'edit'};f.persist();await assert.rejects(f.invoke(),/authority changed/);f.binding.access={};f.persist();
  await assert.rejects(f.invoke({...f.input(),nativeKey:'agent:edition3-assignment:e3-assignment-'+randomUUID()}),/original team stage/);assert.equal(f.assignmentCalls,0);
  f.store.mutate(f.device,{requestId:randomUUID(),epoch:f.store.epoch,kind:'agent',entityId:f.agent.id,expectedRevision:f.agent.revision,payload:{...f.agent.value,archived:true}});
  await assert.rejects(f.invoke(),/capability/);assert.equal(f.store.internalList('team:review:').length,0);
});

test('a paused stage can finish reporting, while cancellation before the queued apply saves no report',async t=>{
  const f=fixture(t);f.team.state='paused';f.team.steps[0].operationId=undefined;f.persist();
  assert.equal((await f.invoke()).state,'applied');
  f.store.internalDelete('team:review:'+f.operation.id);
  const pending=f.invoke();f.operation.cancelRequested=true;await assert.rejects(pending,/no longer running/);
  assert.equal(f.store.internalList('team:review:').length,0);
});

test('a lost report response reconciles its immutable receipt after completion and restart without resubmitting',async t=>{
  const f=fixture(t),write=f.store.internalWrite.bind(f.store);let reportWrites=0,lose=true;
  f.store.internalWrite=(key,value)=>{const result=write(key,value);if(key.startsWith('team:review:')){reportWrites++;if(lose){lose=false;throw Error('Lost saved report response');}}return result;};
  const action=await f.invoke();assert.equal(action.state,'unknown');assert.equal(reportWrites,1);
  await f.restart();f.complete();const checked=await f.check(action);assert.equal(checked.state,'applied');assert.equal(reportWrites,1);
  await assert.rejects(f.invoke(),/no longer running/);assert.equal(reportWrites,1);
  assert.deepEqual((checked.result as any).report,readCompletedTeamReview(f.store,f.teamId,f.operation.id));
});

test('checking a submission that never reached storage cannot create a report after completion',async t=>{
  const f=fixture(t),write=f.store.internalWrite.bind(f.store);let attempts=0;
  f.store.internalWrite=(key,value)=>{if(key.startsWith('team:review:')){attempts++;throw Error('Storage unavailable before commit');}return write(key,value);};
  const action=await f.invoke();assert.equal(action.state,'unknown');assert.equal(attempts,1);
  await f.restart();f.operation.state='completed';const checked=await f.check(action);assert.equal(checked.state,'failed');assert.match(checked.error!,/unconfirmed/);
  assert.equal(attempts,1);assert.equal(f.store.internalList('team:review:').length,0);
});

test('failed and unknown executions never become accepted reviews and mismatched completed identity is rejected',async t=>{
  const f=fixture(t);await f.invoke();
  for(const state of ['failed','cancelled','unknown'] as const){f.operation.state=state;assert.equal(completedTeamReview(f.store,{teamId:f.teamId,stage:0,attempt:1,operation:f.operation}),undefined);}
  f.operation.state='failed';captureTeamHandoff(f.store,{epoch:f.store.epoch,teamId:f.teamId,stage:0,attempt:1,operation:f.operation});
  assert.throws(()=>readCompletedTeamReview(f.store,f.teamId,f.operation.id),/confirmed completed/);
  f.operation.state='completed';f.operation.nativeKey+='-changed';assert.throws(()=>completedTeamReview(f.store,{teamId:f.teamId,stage:0,attempt:1,operation:f.operation}),/different review execution/);
});

test('completed reports remain bound to their immutable handoff after conversation removal and reject corruption',async t=>{
  const f=fixture(t);await f.invoke();const report=f.complete()!;
  f.store.removeConversationData(f.conversation.id);await f.restart();assert.deepEqual(readCompletedTeamReview(f.store,f.teamId,f.operation.id),report);
  assert.throws(()=>readCompletedTeamReview(f.store,randomUUID(),f.operation.id),/unavailable/);
  const value=f.store.internalRead<any>('team:review:'+f.operation.id);f.store.internalWrite('team:review:'+f.operation.id,{...value,report:ready});
  assert.throws(()=>readCompletedTeamReview(f.store,f.teamId,f.operation.id),/original content/);
});

test('fix-stage tools read only captured completed structured reports and suppress late revoked reads',async t=>{
  const f=fixture(t);await f.invoke();const report=f.complete()!,originalId=f.operation.id;
  f.operation.id=randomUUID();f.operation.requestId=randomUUID();f.operation.state='running';delete f.operation.context.teamReview;
  f.operation.context.teamHandoffs={teamId:f.teamId,ids:[originalId]};f.binding.handoffIds=[originalId];f.binding.role='build';f.persist();
  assert.deepEqual(await f.service.invoke(f.input('team.reviews.read',{id:originalId},false)),report);
  await assert.rejects(f.service.invoke(f.input('team.reviews.read',{id:randomUUID()},false)),/not captured/);
  await assert.rejects(f.service.invoke(f.input('team.reviews.read',{id:originalId},true)),/capability/);
  const late=f.service.invoke(f.input('team.reviews.read',{id:originalId},false));f.binding.handoffIds=[];f.persist();await assert.rejects(late,/changed before reading/);
});
