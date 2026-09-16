import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { TeamWorkService } from '../apps/service/team-work.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import type { AgentDesign } from '../packages/domain/workspace-records.js';
import type { Entity,Project } from '../packages/domain/contracts.js';
import type { AssistantService } from '../apps/service/assistant.js';
import type { AssistantOperation,Conversation } from '../packages/domain/assistant.js';

function fixture(t:any){
  const directory=mkdtempSync(join(tmpdir(),'nova-team-')),store=new Store(directory),device=store.session().deviceId;
  const agents=['Researcher','Builder','Reviewer'].map(name=>store.mutate(device,{requestId:randomUUID(),epoch:store.epoch,kind:'agent',entityId:'agent:'+randomUUID(),expectedRevision:0,payload:{...blankRecord('agent','UTC'),name,position:name,instructions:'Use actual evidence',access:{projects:'read',browser:'read'}}}) as Entity<AgentDesign>);
  const folder=join(directory,'checkout');mkdirSync(folder);
  const project=store.mutate(device,{requestId:randomUUID(),epoch:store.epoch,kind:'project',entityId:'project:'+randomUUID(),expectedRevision:0,payload:{name:'Fixture repository',purpose:'',space:'work',workspace:{folder,environment:'local'}}}) as Entity<Project>;
  const calls:{type:string;raw:any;teamId?:string}[]=[],made=new Map<string,string>();
  const worker={
    conversations:()=>store.internalList<Conversation>('assistant:conversation:'),operations:()=>store.internalList<AssistantOperation>('assistant:operation:'),
    async create(_device:string,raw:any,teamId?:string){calls.push({type:'create',raw,teamId});let id=made.get(raw.requestId);if(!id){id=randomUUID();made.set(raw.requestId,id);store.internalWrite('assistant:conversation:'+id,{...raw,id,revision:1,state:'ready',workspace:project.value.workspace,nativeId:randomUUID()});}return store.internalRead<Conversation>('assistant:conversation:'+id)!;},
    submit(_device:string,raw:any,_steering?:boolean,teamId?:string){const existing=worker.operations().find(o=>o.requestId===raw.requestId);if(existing)return existing;calls.push({type:'submit',raw,teamId});const op={...raw,id:randomUUID(),nativeRunId:randomUUID(),state:'running',text:''} as AssistantOperation;return store.internalWrite('assistant:operation:'+op.id,op);},
    async cancel(_device:string,raw:any){calls.push({type:'cancel',raw});const op=worker.operations().find(o=>o.id===raw.operationId)!;return store.internalWrite('assistant:operation:'+op.id,{...op,cancelRequested:true,state:'cancelled'});},
    async reconcile(){return {} as any;},
  };
  const service=new TeamWorkService(store,worker as unknown as AssistantService);t.after(async()=>{await service.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const input={requestId:randomUUID(),epoch:store.epoch,projectId:project.id,title:'Make the change',brief:'Implement and verify the requested behavior',maxMinutes:10,steps:agents.map((agent,i)=>({agentId:agent.id,role:['research','build','review'][i]}))};
  const current=()=>service.state().runs[0],finish=(text:string,state='completed')=>{const op=worker.operations().find(o=>o.state==='running')!;store.internalWrite('assistant:operation:'+op.id,{...op,state,text});};
  const control=(action:string)=>service.control(device,{requestId:randomUUID(),epoch:store.epoch,id:current().id,revision:current().revision,action});
  return {store,device,agents,project,worker,service,calls,input,current,finish,control};
}
test('team sessions share a checkout, preserve distinct responsibilities, and hand actual output to the next agent',async t=>{
  const f=fixture(t),created=f.service.create(f.device,f.input);assert.equal(f.service.create(f.device,f.input).id,created.id);await f.service.reconcile();
  for(let i=0;i<3;i++){
    const run=f.current(),step=run.steps[i];assert(step.operationId,JSON.stringify(run));assert.equal(f.calls.filter(c=>c.type==='submit').length,i+1);
    const start=f.calls.filter(c=>c.type==='create')[i];assert.equal(start.raw.permissionMode,i===1?'workspace':'read-only');assert.equal(start.teamId,run.id);
    const draft=f.store.readEntity('draft',f.calls.filter(c=>c.type==='submit')[i].raw.draftId)!;assert.match(draft.value.text,new RegExp(f.agents[i].value.name));if(i)assert.match(draft.value.text,new RegExp(`Evidence ${i-1}`));
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
