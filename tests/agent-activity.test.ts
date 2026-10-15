import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../apps/service/store.js';
import { AssignmentService } from '../apps/service/assignments.js';
import { HubMeetings } from '../apps/service/hub-meetings.js';
import { AgentActivity } from '../apps/service/agent-activity.js';
import { AgentRoutines } from '../apps/service/agent-routines.js';
import { AgentHub } from '../apps/service/agent-hub.js';
import { blankRecord, type AgentDesign, type Assignment } from '../packages/domain/workspace-records.js';
import { defaultAgentActivityPreferences } from '../packages/domain/agent-activity.js';
import { WorkerTransport } from './fixtures/assignment-worker.js';
import { hubLayoutKey, type HubLayout } from '../packages/domain/hub-layout.js';

const turn = () => new Promise<void>(resolve => setTimeout(resolve, 20));
function setup() {
  const directory=mkdtempSync(join(tmpdir(),'e3-agent-activity-')),store=new Store(directory),device=store.session().deviceId,gateway=new WorkerTransport(directory,store.epoch);
  let now=Date.now();
  const assignments=new AssignmentService(store,gateway),activity=new AgentActivity(store,assignments,()=>now,()=>.2),meetings=new HubMeetings(store,assignments,Date.now,activity);
  activity.attachMeetings(meetings);
  const agents=['Aster','Harbor'].map(name=>store.mutate(device,{requestId:randomUUID(),epoch:store.epoch,kind:'agent',entityId:'agent:'+randomUUID(),expectedRevision:0,payload:{...blankRecord('agent','UTC'),name,position:'Research Partner',instructions:'Ask useful questions and listen to the actual answer.'}}));
  const plans=agents.map((a,i)=>store.mutate(device,{requestId:randomUUID(),epoch:store.epoch,kind:'assignment',entityId:'assignment:'+randomUUID(),expectedRevision:0,payload:{...blankRecord('assignment','UTC'),agentId:a.id,agentRevision:a.revision,title:i?'Compare the saved reading notes':'Review this week’s priorities'}}));
  const command=(id:string,type:'sleep'|'wake')=>activity.command(device,{requestId:randomUUID(),epoch:store.epoch,agentId:id,expectedRevision:activity.preference(id).revision,type});
  const enable=(id:string)=>{const {sleep,...value}=defaultAgentActivityPreferences();return activity.command(device,{requestId:randomUUID(),epoch:store.epoch,agentId:id,expectedRevision:activity.preference(id).revision,type:'preferences',value:{...value,initiative:'proactive',personality:'curious'}});};
  return {directory,store,device,gateway,assignments,activity,meetings,agents,plans,command,enable,now:()=>now,advance:(ms:number)=>{now+=ms;}};
}
async function fixture(run:(f:ReturnType<typeof setup>)=>Promise<void>) {const f=setup();try{await run(f);}finally{f.activity.close();await f.meetings.close();await f.assignments.close();f.gateway.stopJournal?.();f.store.close();rmSync(f.directory,{recursive:true,force:true});}}

test('existing agents receive no proactive grant; explicit preferences retain revisions and request identity',()=>fixture(async f=>{
  assert(f.activity.state().preferences.every(p=>p.revision===0&&p.value.initiative==='on-request'));
  f.advance(86400000);f.activity.tick();assert.equal(f.gateway.nativeCalls.length,0);
  const {sleep,...value}=defaultAgentActivityPreferences(),input={requestId:randomUUID(),epoch:f.store.epoch,agentId:f.agents[0].id,expectedRevision:0,type:'preferences',value:{...value,initiative:'proactive'}};
  const saved=f.activity.command(f.device,input);assert.deepEqual(f.activity.command(f.device,input),saved);
  assert.throws(()=>f.activity.command(f.device,{...input,requestId:randomUUID()}),/changed/);
  const reopened=new AgentActivity(f.store,f.assignments,f.now);assert.equal(reopened.preference(f.agents[0].id).revision,1);assert.equal(reopened.preference(f.agents[0].id).value.initiative,'proactive');reopened.close();
}));

test('opted-in work conversations retain genuine linked replies and share the original prior output',()=>fixture(async f=>{
  f.agents.forEach(a=>f.enable(a.id));f.advance(31*60000);f.activity.tick();await turn();
  assert.equal(f.gateway.nativeCalls.length,1);const first=f.meetings.state().current!;assert.equal(first.attendees.length,2);
  for(let i=0;i<3;i++){
    const meeting=f.meetings.state().current!,attemptId=meeting.turns[i].attemptId!;assert(attemptId);
    const detail=f.assignments.detail(attemptId);assert.match(detail.capture.plan.value.brief,/captured current work|Captured current work/i);
    if(i)assert.match(detail.capture.plan.value.brief,new RegExp('Actual reply '+(i-1)));
    assert.equal(f.assignments.canReviewModule(attemptId,'records.save',{kind:'task'},true),false);
    f.gateway.finish('Actual reply '+i);await f.assignments.reconcile(attemptId);await f.meetings.reconcile();await f.meetings.reconcile();await turn();
  }
  assert.equal(f.meetings.state().current,null);const saved=f.meetings.state().history[0];assert.equal(saved.id,first.id);assert.deepEqual(saved.turns.map(t=>t.result?.text),['Actual reply 0','Actual reply 1','Actual reply 2']);
  assert.equal(f.gateway.nativeCalls.length,3);f.activity.tick();assert.equal(f.gateway.nativeCalls.length,3);
  const recovered=new HubMeetings(f.store,f.assignments,Date.now,f.activity);assert.deepEqual(recovered.state(),f.meetings.state());await recovered.close();
  const hub=new AgentHub(f.store,f.assignments,Date.now,()=>[],f.activity);assert(hub.state().roster.every(a=>a.work?.meetingId===saved.id));
}));

test('oldest due initiative participants rotate rather than starving a third opted-in agent',()=>fixture(async f=>{
  const third=f.store.mutate(f.device,{requestId:randomUUID(),epoch:f.store.epoch,kind:'agent',entityId:'agent:'+randomUUID(),expectedRevision:0,payload:{...blankRecord('agent','UTC'),name:'Juniper',position:'Writing Partner'}});
  const ids=[...f.agents.map(a=>a.id),third.id];ids.forEach(id=>f.enable(id));f.advance(31*60000);f.activity.tick();await turn();const first=f.meetings.state().current!,waiting=ids.find(id=>!first.attendees.some(a=>a.id===id))!;
  for(let i=0;i<3;i++){const turnId=f.meetings.state().current!.turns[i].attemptId!;f.gateway.finish('Actual contribution '+i);await f.assignments.reconcile(turnId);await f.meetings.reconcile();await f.meetings.reconcile();await turn();}
  f.advance(31*60000);f.activity.tick();await turn();assert(f.meetings.state().current?.attendees.some(a=>a.id===waiting));assert.equal(f.gateway.nativeCalls.length,4);
}));

test('Sleep during async admission cancels new native dispatch and parks only after the original attempt settles',()=>fixture(async f=>{
  let release!:()=>void;f.gateway.holdCapabilities=new Promise<void>(resolve=>{release=resolve;});
  f.agents.forEach(a=>f.enable(a.id));f.advance(31*60000);f.activity.tick();
  const sleeping=f.agents[0].id;f.command(sleeping,'sleep');assert.equal(f.activity.preference(sleeping).value.sleep,'after-work');
  release();await turn();assert.equal(f.gateway.nativeCalls.length,0);assert.equal(f.assignments.state().attempts[0].state,'failed');
  await f.meetings.reconcile();f.activity.tick();assert.equal(f.activity.preference(sleeping).value.sleep,'asleep');
  assert.equal(f.assignments.state().attempts.length,1);assert.equal(f.meetings.state().current?.state,'paused');
}));

test('changed captured work pauses before a new reply without replacing the returned attempt',()=>fixture(async f=>{
  f.agents.forEach(a=>f.enable(a.id));f.advance(31*60000);f.activity.tick();await turn();
  const first=f.meetings.state().current!.turns[0].attemptId!;f.gateway.finish('Original question');await f.assignments.reconcile(first);
  const plan=f.plans[1];f.store.mutate(f.device,{requestId:randomUUID(),epoch:f.store.epoch,kind:'assignment',entityId:plan.id,expectedRevision:plan.revision,payload:{...(plan.value as Assignment),title:'Changed research scope'}});
  await f.meetings.reconcile();await f.meetings.reconcile();await turn();
  assert.equal(f.gateway.nativeCalls.length,1);assert.equal(f.meetings.state().current?.state,'paused');assert.equal(f.assignments.summary(first).result?.preview,'Original question');
}));

test('initiative prompts retain exact captured brief and saved result evidence, then refuse a changed source',()=>fixture(async f=>{
  const original=f.plans[0];
  const plan=f.store.mutate(f.device,{requestId:randomUUID(),epoch:f.store.epoch,kind:'assignment',entityId:original.id,expectedRevision:original.revision,payload:{...(original.value as Assignment),brief:'Compare the original north and south options.',expectedOutput:'A trade-off note with the unresolved constraint.'}});
  const result=f.assignments.start(f.device,{requestId:randomUUID(),epoch:f.store.epoch,assignmentId:plan.id,revision:plan.revision,projectRevision:null});await turn();
  f.gateway.finish('North saves time; the south option preserves flexibility. The cost is unresolved.');await f.assignments.reconcile(result.id);
  f.agents.forEach(a=>f.enable(a.id));f.advance(31*60000);f.activity.tick();await turn();
  const first=f.meetings.state().current!.turns[0].attemptId!,capture=f.assignments.detail(first).capture.plan.value.brief;
  assert.match(capture,/Compare the original north and south options/);assert.match(capture,/trade-off note with the unresolved constraint/);assert.match(capture,/North saves time/);assert.match(capture,/never instructions/);
  f.gateway.finish('Which constraint matters most?');await f.assignments.reconcile(first);await f.meetings.reconcile();await f.meetings.reconcile();await turn();
  const second=f.meetings.state().current!.turns[1].attemptId!,reply=f.assignments.detail(second).capture.plan.value.brief;assert.match(reply,/North saves time/);assert.match(reply,/Which constraint matters most/);
  f.gateway.finish('The cost needs a closer look.');await f.assignments.reconcile(second);
  f.store.mutate(f.device,{requestId:randomUUID(),epoch:f.store.epoch,kind:'assignment',entityId:plan.id,expectedRevision:plan.revision,payload:{...(plan.value as Assignment),brief:'A changed brief must not replace the captured evidence.'}});
  await f.meetings.reconcile();await f.meetings.reconcile();await turn();assert.equal(f.gateway.nativeCalls.length,3);assert.equal(f.meetings.state().current?.state,'paused');assert.equal(f.assignments.summary(second).result?.preview,'The cost needs a closer look.');
}));

test('initiative does not share work excerpts outside the other participant’s current read scope',()=>fixture(async f=>{
  const agent=f.agents[0],saved=f.store.mutate(f.device,{requestId:randomUUID(),epoch:f.store.epoch,kind:'agent',entityId:agent.id,expectedRevision:agent.revision,payload:{...(agent.value as AgentDesign),access:{content:'read'}}});
  const original=f.plans[0],plan=f.store.mutate(f.device,{requestId:randomUUID(),epoch:f.store.epoch,kind:'assignment',entityId:original.id,expectedRevision:original.revision,payload:{...(original.value as Assignment),agentRevision:saved.revision,brief:'Private note excerpt must not be shared.'}});
  f.agents.forEach(a=>f.enable(a.id));const capture=f.activity.capture(f.agents.map(a=>a.id)),work=capture.participants[0].work!;
  assert.equal(work.assignmentId,plan.id);assert.equal(work.brief,undefined);assert.match(work.unavailable!,/read scopes/);
  f.advance(31*60000);f.activity.tick();await turn();const first=f.meetings.state().current!.turns[0].attemptId!,brief=f.assignments.detail(first).capture.plan.value.brief;assert.doesNotMatch(brief,/Private note excerpt/);assert.match(brief,/read scopes/);assert.equal(f.assignments.canReviewModule(first,'records.list',{kind:'content'},false),false);
}));

test('live autonomous reads honor recipient revocation and never receive native MCP grants',()=>fixture(async f=>{
  const agents=f.agents.map(a=>f.store.mutate(f.device,{requestId:randomUUID(),epoch:f.store.epoch,kind:'agent',entityId:a.id,expectedRevision:a.revision,payload:{...(a.value as AgentDesign),access:{content:'read'}}}));
  agents.forEach(a=>f.enable(a.id));f.advance(31*60000);f.activity.tick();await turn();
  const attempt=f.meetings.state().current!.turns[0].attemptId!;
  assert.equal(f.assignments.canReviewModule(attempt,'records.list',{kind:'content'},false),true);assert.equal(f.assignments.detail(attempt).attempt.nativeTools,undefined);
  const recipient=agents[1];f.store.mutate(f.device,{requestId:randomUUID(),epoch:f.store.epoch,kind:'agent',entityId:recipient.id,expectedRevision:recipient.revision,payload:{...(recipient.value as AgentDesign),access:{}}});
  assert.equal(f.assignments.canReviewModule(attempt,'records.list',{kind:'content'},false),false);
  f.gateway.finish('The original contribution is retained.');await f.assignments.reconcile(attempt);await f.meetings.reconcile();await f.meetings.reconcile();await turn();assert.equal(f.gateway.nativeCalls.length,1);assert.equal(f.meetings.state().current?.state,'paused');
}));

test('Sleep defers an enabled routine under one occurrence identity; On Request and Wake do not revoke its separate grant',()=>fixture(async f=>{
  const routines=new AgentRoutines(f.store,f.assignments,f.now,id=>f.activity.canStartAutomatic(id));
  try{
    const plan=f.plans[0],id=f.agents[0].id,anchor=new Date(f.now()+60000).toISOString();
    routines.save(f.device,{requestId:randomUUID(),epoch:f.store.epoch,id:randomUUID(),expectedRevision:0,value:{name:'Separate authorized routine',assignmentId:plan.id,assignmentRevision:plan.revision,projectRevision:null,timezone:'UTC',schedule:{kind:'every',minutes:1,anchor},missed:'skip',enabled:true,archived:false}});
    f.command(id,'sleep');f.advance(60000);routines.tick();const pending=routines.state().routines[0].deferred!;assert(pending);assert.equal(f.gateway.nativeCalls.length,0);
    f.advance(240000);routines.tick();assert.equal(routines.state().routines[0].deferred!.id,pending.id);
    routines.close();const reopened=new AgentRoutines(f.store,f.assignments,f.now,a=>f.activity.canStartAutomatic(a));
    f.command(id,'wake');assert.equal(f.activity.preference(id).value.initiative,'on-request');reopened.tick();reopened.tick();await turn();
    const occurrence=reopened.state().history[0];assert.equal(occurrence.id,pending.id);assert.equal(occurrence.scheduledAt,pending.scheduledAt);assert.equal(f.gateway.nativeCalls.length,1);assert.equal(reopened.state().routines[0].deferred,undefined);reopened.close();
  }finally{routines.close();}
}));

for(const wakeBeforeEnable of [false,true])test('deferred one-shot survives pause, '+(wakeBeforeEnable?'Wake then re-enable':'re-enable then Wake')+', and restart without changing occurrence',()=>fixture(async f=>{
  const routines=new AgentRoutines(f.store,f.assignments,f.now,id=>f.activity.canStartAutomatic(id));
  try{
    const plan=f.plans[0],agent=f.agents[0].id,due=Math.ceil((f.now()+1)/60000)*60000,date=new Date(due).toISOString();
    let routine=routines.save(f.device,{requestId:randomUUID(),epoch:f.store.epoch,id:randomUUID(),expectedRevision:0,value:{name:'One original due time',assignmentId:plan.id,assignmentRevision:plan.revision,projectRevision:null,timezone:'UTC',schedule:{kind:'once',date:date.slice(0,10),time:date.slice(11,16)},missed:'skip',enabled:true,archived:false}});
    f.command(agent,'sleep');f.advance(due-f.now());routines.tick();const deferred=routines.state().routines[0].deferred!;assert(deferred);
    f.advance(180000);routine=routines.save(f.device,{requestId:randomUUID(),epoch:f.store.epoch,id:routine.id,expectedRevision:routine.revision,value:{...routine.value,enabled:false}});
    assert.throws(()=>routines.save(f.device,{requestId:randomUUID(),epoch:f.store.epoch,id:routine.id,expectedRevision:routine.revision,value:{...routine.value,enabled:true,schedule:{kind:'once',date:'1999-01-01',time:'09:00'}}}),/no future occurrence/);
    if(wakeBeforeEnable)f.command(agent,'wake');
    routine=routines.save(f.device,{requestId:randomUUID(),epoch:f.store.epoch,id:routine.id,expectedRevision:routine.revision,value:{...routine.value,enabled:true}});assert.equal(routine.deferred?.id,deferred.id);assert.equal(routine.nextAt,due);
    routines.close();const reopened=new AgentRoutines(f.store,f.assignments,f.now,id=>f.activity.canStartAutomatic(id));
    try{if(!wakeBeforeEnable){reopened.tick();assert.equal(f.gateway.nativeCalls.length,0);f.command(agent,'wake');}reopened.tick();reopened.tick();await turn();const occurrence=reopened.state().history[0];assert.equal(occurrence.id,deferred.id);assert.equal(occurrence.scheduledAt,due);assert.equal(reopened.state().routines[0].nextAt,null);assert.equal(f.gateway.nativeCalls.length,1);}finally{reopened.close();}
  }finally{routines.close();}
}));

test('initiative recovers its existing gathered or running meeting across occurrence-save crashes',()=>fixture(async f=>{
  f.agents.forEach(a=>f.enable(a.id));const capture=f.activity.capture(f.agents.map(a=>a.id)),room=f.store.internalRead<HubLayout>(hubLayoutKey)!.rooms.find(r=>r.template==='boardroom')!;
  const occurrence={id:capture.id,epoch:f.store.epoch,device:f.device,capture,gatherRequestId:randomUUID(),startRequestId:randomUUID(),roomId:room.id,state:'prepared'};
  const gathered=f.meetings.command(f.device,{type:'gather',requestId:occurrence.gatherRequestId,epoch:f.store.epoch,roomId:room.id,title:'Recovered work conversation',agenda:'Compare current work.',agentIds:f.agents.map(a=>a.id)},capture);
  f.store.internalWrite('agents:activity:conversation:'+capture.id,occurrence);f.activity.tick();await turn();
  assert.equal(f.meetings.state().current?.id,gathered.id);assert.equal(f.gateway.nativeCalls.length,1);
  // This is the persisted pre-save boundary after the original start receipt.
  f.store.internalWrite('agents:activity:conversation:'+capture.id,occurrence);
  const recovered=new AgentActivity(f.store,f.assignments,f.now);recovered.attachMeetings(f.meetings);recovered.tick();await turn();
  assert.equal(f.gateway.nativeCalls.length,1);assert.equal(f.meetings.state().current?.id,gathered.id);assert.equal(recovered.state().conversations[0].state,'started');recovered.close();
}));

test('Sleep pause intent reconnects after preferences commit and the original discussion revision advances',()=>fixture(async f=>{
  const room=f.store.internalRead<HubLayout>(hubLayoutKey)!.rooms.find(r=>r.template==='boardroom')!,gather=f.meetings.command(f.device,{type:'gather',requestId:randomUUID(),epoch:f.store.epoch,roomId:room.id,title:'Original discussion',agenda:'Discuss the saved work.',agentIds:f.agents.map(a=>a.id)});
  f.meetings.command(f.device,{type:'start',requestId:randomUUID(),epoch:f.store.epoch,meetingId:gather.id,expectedRevision:gather.revision});await turn();
  const before=f.meetings.state().current!,input={type:'sleep',requestId:randomUUID(),epoch:f.store.epoch,agentId:f.agents[0].id,expectedRevision:0,pauseMeeting:{id:before.id,revision:before.revision}},original=f.meetings.command.bind(f.meetings);
  f.meetings.command=((device,raw,auto)=>{if((raw as {type?:string}).type==='pause')throw new Error('Crash before pause admission');return original(device,raw,auto);}) as typeof f.meetings.command;
  assert.throws(()=>f.activity.command(f.device,input),/Crash/);assert.equal(f.activity.preference(f.agents[0].id).value.sleep,'after-work');
  f.meetings.command=original;await f.meetings.reconcile();assert(f.meetings.state().current!.revision>before.revision);
  f.activity.command(f.device,input);const intent=f.activity.state().sleepRequests[0];assert.equal(intent.state,'requested');assert.equal(f.meetings.state().current?.state,'paused');
  f.activity.command(f.device,input);assert.equal(f.gateway.nativeCalls.length,1);assert.equal(f.activity.preference(f.agents[0].id).value.sleep,'after-work');
}));
