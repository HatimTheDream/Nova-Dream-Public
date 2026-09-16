import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store';
import { AssignmentService } from '../apps/service/assignments';
import { HubMeetings } from '../apps/service/hub-meetings';
import { WorkerTransport } from './fixtures/assignment-worker';
import { blankRecord } from '../packages/domain/workspace-records';
import { hubLayoutKey, type HubLayout } from '../packages/domain/hub-layout';
const tick=()=>new Promise<void>(r=>setTimeout(r,15));
async function fixture(run:(f:ReturnType<typeof setup>)=>Promise<void>){const f=setup();try{await run(f);}finally{await f.meetings.close();await f.assignments.close();f.gateway.stopJournal?.();f.store.close();rmSync(f.dir,{recursive:true,force:true});}}
function setup(){const dir=mkdtempSync(join(tmpdir(),'e3-meetings-')),store=new Store(dir),device=store.session().deviceId,gateway=new WorkerTransport(dir,store.epoch),assignments=new AssignmentService(store,gateway),meetings=new HubMeetings(store,assignments);const agents=['A','B'].map(name=>store.mutate(device,{requestId:randomUUID(),epoch:store.epoch,kind:'agent',entityId:'agent:'+randomUUID(),expectedRevision:0,payload:{...blankRecord('agent','UTC'),name,position:'Generalist',access:{tasks:'edit'}}}));const room=store.internalRead<HubLayout>(hubLayoutKey)!.rooms.find(r=>r.template==='boardroom')!;const gather={type:'gather',requestId:randomUUID(),epoch:store.epoch,roomId:room.id,title:'Decision discussion',agenda:'Compare the supplied options.',agentIds:agents.map(a=>a.id)};const change=(type:'start'|'pause'|'end')=>{const current=meetings.state().current!;return meetings.command(device,{type,requestId:randomUUID(),epoch:store.epoch,meetingId:current.id,expectedRevision:current.revision});};return {dir,store,device,gateway,assignments,meetings,agents,gather,change};}
test('gathering is durable and idempotent; discussions share real prior output and return a summary',()=>fixture(async f=>{
 const gathered=f.meetings.command(f.device,f.gather);assert.deepEqual(f.meetings.command(f.device,f.gather),gathered);assert.equal(f.gateway.nativeCalls.length,0);
 f.change('start');await f.meetings.reconcile();await tick();
 for(let i=0;i<3;i++){
  const current=f.meetings.state().current!,turn=current.turns[i];assert(turn.attemptId);const detail=f.assignments.detail(turn.attemptId!);
  assert.equal(detail.capture.agent.revision,1);assert.equal(detail.capture.plan.value.executionMode,'discussion');
  if(i>0)assert.match(detail.capture.plan.value.brief,new RegExp(`Evidence from speaker ${i-1}`));
  assert.equal(f.assignments.canReviewModule(turn.attemptId!,'records.save',{kind:'task'},true),false);
  assert.equal(f.assignments.canReviewModule(turn.attemptId!,'records.list',{kind:'task'},false),true);
  f.gateway.finish(`Evidence from speaker ${i}`);await f.assignments.reconcile(turn.attemptId!);await f.meetings.reconcile();await f.meetings.reconcile();await tick();
 }
 const complete=f.meetings.state().current!;assert.equal(complete.state,'complete');assert.equal(complete.turns.at(-1)?.kind,'summary');assert.equal(f.gateway.nativeCalls.length,3);
 assert(complete.turns.every(t=>t.result?.text.startsWith('Evidence from speaker')));assert(f.store.listEntities('assignment').every(a=>a.value.archived));
 f.change('end');assert.equal(f.meetings.state().current,null);assert.equal(f.meetings.state().history.length,1);
 const reloaded=new HubMeetings(f.store,f.assignments);assert.deepEqual(reloaded.state(),f.meetings.state());await reloaded.close();
}));
test('a restarted meeting controller reconciles the original turn instead of dispatching a duplicate',()=>fixture(async f=>{
 f.meetings.command(f.device,f.gather);f.change('start');await f.meetings.reconcile();await tick();const count=f.gateway.nativeCalls.length;
 const recovered=new HubMeetings(f.store,f.assignments);await recovered.reconcile();await tick();assert.equal(f.gateway.nativeCalls.length,count);assert.equal(recovered.state().current!.turns[0].attemptId,f.meetings.state().current!.turns[0].attemptId);await recovered.close();
}));
test('stale meeting edits, repeated attendees and an unavailable room are rejected',()=>fixture(async f=>{
 assert.throws(()=>f.meetings.command(f.device,{...f.gather,agentIds:[f.agents[0].id,f.agents[0].id]}));
 assert.throws(()=>f.meetings.command(f.device,{...f.gather,roomId:'room:commons'}),/boardroom/);
 const m=f.meetings.command(f.device,f.gather);f.change('start');await f.meetings.reconcile();await tick();
 assert.throws(()=>f.meetings.command(f.device,{type:'end',requestId:randomUUID(),epoch:f.store.epoch,meetingId:m.id,expectedRevision:1}),/changed/);
}));
test('failed speakers pause the discussion and continuation moves to the next speaker once',()=>fixture(async f=>{
 f.meetings.command(f.device,f.gather);f.change('start');await f.meetings.reconcile();await tick();const first=f.meetings.state().current!.turns[0];
 f.gateway.finish('Could not finish','error');await f.assignments.reconcile(first.attemptId!);await f.meetings.reconcile();assert.equal(f.meetings.state().current!.state,'paused');assert.equal(f.meetings.state().current!.next,1);
 f.change('start');await f.meetings.reconcile();await tick();assert.equal(f.gateway.nativeCalls.length,2);assert(f.meetings.state().current!.turns[1].attemptId);
}));

test('ending an active meeting stops the original run and reconciles its history after restart',()=>fixture(async f=>{
 f.meetings.command(f.device,f.gather);f.change('start');await f.meetings.reconcile();await tick();
 const before=f.meetings.state().current!,attempt=before.turns[0].attemptId!;
 const input={type:'end',requestId:randomUUID(),epoch:f.store.epoch,meetingId:before.id,expectedRevision:before.revision};
 f.meetings.command(f.device,input);f.meetings.command(f.device,input);await tick();
 assert.equal(f.meetings.state().current,null);assert.equal(f.gateway.nativeCalls.length,1);
 f.gateway.finish('Stopped on request','error');await f.assignments.reconcile(attempt);
 const recovered=new HubMeetings(f.store,f.assignments);await recovered.reconcile();
 const history=recovered.state().history[0];assert.equal(history.state,'ended');assert.equal(history.next,1);assert.notEqual(history.turns[0].state,'running');
 assert.equal(f.store.readEntity('assignment',history.turns[0].planId)?.value.archived,true);assert.equal(f.gateway.nativeCalls.length,1);await recovered.close();
}));
