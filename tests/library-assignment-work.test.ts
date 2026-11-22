import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { AssignmentService } from '../apps/service/assignments.js';
import { WorkerTransport } from './fixtures/assignment-worker.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import type { AssignmentAttempt } from '../packages/domain/assignments.js';
import type { Command } from '../packages/domain/contracts.js';

async function setup() {
  const directory=mkdtempSync(join(tmpdir(),'nova-connected-work-'));
  let store=new Store(directory);
  const gateway=new WorkerTransport(directory,store.epoch);
  let service=new AssignmentService(store,gateway);
  const device=store.session().deviceId, epoch=store.epoch;
  const write=(kind:Command['kind'],id:string,version:number,payload:unknown)=>store.mutate(device,{epoch,requestId:randomUUID(),kind,entityId:id,expectedRevision:version,payload} as Command);
  const project=write('project','project:'+randomUUID(),0,{name:'Project',purpose:'Private project details never sent by default'});
  const agent=(name:string)=>write('agent','agent:'+randomUUID(),0,{...blankRecord('agent','UTC'),name,position:name,access:{content:'read'}});
  const lead=agent('Lead'), reviewer=agent('Reviewer');
  const source=write('content','content:'+randomUUID(),0,{...blankRecord('content','UTC'),title:'Selected source',body:'Source as captured',projectId:project.id});
  const plan=write('assignment','assignment:'+randomUUID(),0,{...blankRecord('assignment','UTC'),title:'Draft',brief:'Use only the supplied inputs.',agentId:lead.id,agentRevision:lead.revision,
    executionMode:'proposal',projectId:project.id,workSources:[{reference:{kind:'content',id:source.id,revision:source.revision}}]});
  const start={epoch,requestId:randomUUID(),assignmentId:plan.id,revision:plan.revision,projectRevision:project.revision};
  const cmd=(attempt:AssignmentAttempt)=>({epoch,requestId:randomUUID(),attemptId:attempt.id,sha256:attempt.result!.file.sha256});
  async function settle(id:string,state:string) {
    for(let count=0;count<160;count++){
      const item=service.summary(id);
      if (item.state===state)return item;
      if (item.state==='failed')assert.fail(item.message);
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.fail('Original attempt did not reach '+state+': '+service.summary(id).message);
  }
  async function finish(id:string,text:string) {
    await settle(id,'running');
    gateway.finish(text);
    return service.reconcile(id);
  }
  return {directory,get store(){return store;},gateway,get service(){return service;},device,epoch,lead,reviewer,source,plan,write,start,cmd,settle,finish,
    review:(result:AssignmentAttempt)=>service.startConnectedAction(device,'review',{...cmd(result),reviewerId:reviewer.id,reviewerRevision:1}),
    restart:async()=>{await service.close();store.close();store=new Store(directory);assert.equal(store.epoch,epoch);service=new AssignmentService(store,gateway);},
    close:async()=>{await service.close();gateway.stopJournal?.();store.close();rmSync(directory,{recursive:true,force:true});}};
}

test('real assignments retain full revisions, independent findings and one exact editable Content through restart and retries',async()=>{
  const f=await setup();
  try {
    const first=f.service.start(f.device,f.start);
    assert.equal(f.service.start(f.device,{...f.start,requestId:randomUUID()}).id,first.id);
    const originalText='\uFEFF'+('Full original 🐾\r\n'.repeat(350))+'only-at-the-end';
    const original=await f.finish(first.id,originalText);
    assert.equal(f.gateway.nativeCalls.length,1);
    assert.equal(f.gateway.nativeCalls[0].disableTools,true);
    assert.doesNotMatch(f.gateway.nativeCalls[0].message,/Private project details/);
    const subject=f.cmd(original);
    assert.throws(()=>f.store.createContentFromAssignment(f.device,subject),/Accept the reviewed result/);
    assert.throws(()=>f.service.connected.save(f.device,subject),/Accept this exact/);
    assert.equal(f.service.connectedDetail(first.id).document,originalText);
    const reviewOne=f.review(original);
    await f.finish(reviewOne.id,JSON.stringify({summary:'Wrong conclusion',findings:[{id:'wrong',severity:'blocking',detail:'Fix the conclusion'}]}));
    assert.match(f.gateway.nativeCalls[1].message,/only-at-the-end/);
    const firstDetail=f.service.connectedDetail(original.id);
    const reviewCommand={reviewAttemptId:reviewOne.id,reviewSha256:firstDetail.review.attempt!.result!.file.sha256,acknowledgedFindingIds:['wrong']};
    assert.throws(()=>f.service.connected.accept(f.device,{...subject,...reviewCommand}),/blocking/);
    f.write('content',f.source.id,1,{...f.store.readEntity('content',f.source.id)!.value,body:'Later source edit'});
    const correction={...subject,requestId:randomUUID(),correction:'Replace the conclusion while retaining all evidence.'};
    const revision=f.service.startConnectedAction(f.device,'revise',correction);
    assert.equal(f.service.startConnectedAction(f.device,'revise',{...correction,requestId:randomUUID()}).id,revision.id);
    const revised=await f.finish(revision.id,'\uFEFFCorrected opening.\r\nOriginal evidence.\nRecommendation 🐾');
    assert.match(f.gateway.nativeCalls[2].message,/only-at-the-end/);
    assert.match(f.gateway.nativeCalls[2].message,/Source as captured/);
    assert.match(f.gateway.nativeCalls[2].message,/Fix the conclusion/);
    assert.equal(revised.connected!.baseReviewAttemptId,reviewOne.id);
    assert.doesNotMatch(f.gateway.nativeCalls[2].message,/Later source edit/);
    assert.equal(revised.connected!.baseAttemptId,original.id);
    const secondReview=f.review(revised);
    const report=await f.finish(secondReview.id,JSON.stringify({summary:'Exact revised document',findings:[{id:'style',severity:'advisory',detail:'Consider an optional shorter title.'}]}));
    const accept={...f.cmd(revised),reviewAttemptId:report.id,reviewSha256:report.result!.file.sha256,acknowledgedFindingIds:['style']};
    assert.throws(()=>f.service.connected.accept(f.device,{...accept,reviewSha256:original.result!.file.sha256}),/exact result/);
    assert.throws(()=>f.service.connected.accept(f.device,{...accept,acknowledgedFindingIds:[]}),/Acknowledge/);
    f.service.connected.accept(f.device,accept);
    const before=f.service.connectedDetail(revised.id);
    assert.equal(before.review.report!.findings.length,1);
    assert.equal(before.savedContentId,null);
    const command=f.cmd(revised);
    const {DatabaseSync}=await import('node:sqlite');
    const failpoint=new DatabaseSync(join(f.directory,'workspace.sqlite'));
    try {
      failpoint.exec("CREATE TRIGGER fail_connected_blob BEFORE INSERT ON blob_refs BEGIN SELECT RAISE(ABORT,'fixture blob failure'); END;");
      assert.throws(()=>f.service.connected.save(f.device,command),/fixture blob failure/);
      assert.equal(f.service.connectedDetail(revised.id).savedContentId,null);
      assert.equal(f.store.readEntity('content',before.acceptance!.contentId),undefined);
      failpoint.exec('DROP TRIGGER fail_connected_blob');
    } finally {failpoint.close();}
    const draft=f.service.connected.save(f.device,command);
    assert.equal(draft.id,before.acceptance!.contentId);
    assert.equal(draft.value.body,before.document);
    assert.equal(draft.value.source?.kind,'assignment');
    // Ordinary work has no durable input lineage for this document or its
    // result attachment. Its native tools cannot copy those bytes sideways.
    assert.equal(f.store.withUntrackedAgentWork(()=>f.store.readEntity('content',draft.id)),undefined);
    const existingPlan=f.store.readEntity('assignment',f.plan.id)!;
    const {workSources,...ordinary}=existingPlan.value;
    const legacy=f.write('assignment','assignment:'+randomUUID(),0,{...ordinary,sources:[{kind:'content',id:draft.id,revision:draft.revision}]});
    assert.throws(()=>f.service.start(f.device,{...f.start,requestId:randomUUID(),assignmentId:legacy.id}),/preserve its input permissions/);
    const projectWithCopy=f.write('project','project:'+randomUUID(),0,{name:'Copied attachment',purpose:'',attachments:[draft.value.assets![0]]});
    const alternate=f.write('assignment','assignment:'+randomUUID(),0,{...ordinary,projectId:projectWithCopy.id});
    assert.throws(()=>f.service.start(f.device,{...f.start,requestId:randomUUID(),assignmentId:alternate.id}),/preserve its input permissions/);
    f.write('content',draft.id,1,{...draft.value,body:'Owner edits must survive.'});
    await f.restart();
    for(const [device,requestId] of [[f.device,command.requestId],[randomUUID(),randomUUID()]]) {
      const existing=f.service.connected.save(device,{...command,requestId});
      assert.equal(existing.id,draft.id);assert.equal(existing.value.body,'Owner edits must survive.');
    }
    assert.equal(f.service.connectedDetail(revised.id).document,before.document);
    assert.equal(f.store.listEntities('content').filter(c=>c.value.source?.kind==='assignment').length,1);
    assert.equal(f.service.summary(revised.id).connectedStatus,'saved');
    const list=f.service.connectedWorkList().items;assert.equal(list.length,1);assert.equal(list[0].attemptId,revised.id);assert.equal(list[0].savedContentId,draft.id);
    assert.equal(f.service.connectedDetail(original.id).review.report!.findings[0].severity,'blocking');
    const fork=f.service.startConnectedAction(f.device,'revise',{...correction,requestId:randomUUID(),correction:'Try a different conclusion from the first result.'});
    assert.equal(fork.connected?.number,3);assert.equal(fork.connected?.baseAttemptId,original.id);
    await f.finish(fork.id,'Another result.');
    const reviewerDesign=f.store.readEntity('agent',f.reviewer.id)!;
    f.write('agent',reviewerDesign.id,1,{...reviewerDesign.value,access:{}});
    assert.equal(f.service.connectedDetail(original.id).document,originalText);
    assert.equal(f.service.connectedDetail(original.id).review.report,null);
    assert.equal(f.service.connectedDetail(revised.id).document,null);
    assert.equal(f.store.readEntity('content',draft.id),undefined);
    f.write('agent',reviewerDesign.id,2,reviewerDesign.value);
    assert.equal(f.service.connectedDetail(revised.id).document,before.document);
    assert.equal(f.store.readEntity('content',draft.id)?.value.body,'Owner edits must survive.');
    const denied={...f.store.readEntity('agent',f.lead.id)!.value,access:{}};
    f.write('agent',f.lead.id,1,denied);
    assert.equal(f.service.connectedDetail(revised.id).document,null);
    assert.equal(f.service.summary(revised.id).result,undefined);
    assert.equal(f.store.readEntity('content',draft.id),undefined);
    assert.equal(f.store.snapshot(f.device).records!.content.some(item=>item.id===draft.id),false);
    assert.equal(f.store.readEntityVersion('content',draft.id,1),undefined);
    assert.throws(()=>f.write('content',draft.id,2,{...draft.value,body:'Stale request'}),/retained/);
    assert.throws(()=>f.store.recordHistory({kind:'content',id:draft.id}),/retained/);
    assert.throws(()=>f.service.connected.save(f.device,command),/no longer available/);
    assert.throws(()=>f.store.download(revised.result!.file.id),/cannot use/);
  } finally {await f.close();}
});

test('an interrupted connected admission resumes only its real native identity and will not accept a malformed review',async()=>{
  const f=await setup();
  try {
    f.gateway.loseAck=true;
    const first=f.service.start(f.device,f.start);
    await f.settle(first.id,'unknown');
    await f.restart();
    assert.equal(f.service.start(f.device,{...f.start,requestId:randomUUID()}).id,first.id);
    assert.equal(f.gateway.nativeCalls.length,1);
    f.gateway.loseAck=false;
    f.gateway.finish('Reconciled original.');
    const returned=await f.service.reconcile(first.id);
    assert.equal(returned.state,'returned');
    assert.equal(f.service.connectedDetail(first.id).document,'Reconciled original.');
    const badReview=f.review(returned);await f.finish(badReview.id,'A commentary with no structured findings.');
    assert.equal(f.service.connectedDetail(first.id).review.state,'invalid');
    const actualReview=f.review(returned);
    assert.notEqual(actualReview.id,badReview.id);
    const good=await f.finish(actualReview.id,JSON.stringify({summary:'Checked the brief and inputs.',findings:[]}));
    assert.throws(()=>f.service.connected.accept(f.device,{...f.cmd(returned),reviewAttemptId:badReview.id,reviewSha256:good.result!.file.sha256,acknowledgedFindingIds:[]}),/exact result/);
    assert.equal(f.service.connectedDetail(first.id).review.attempt!.id,actualReview.id);
    assert.equal(f.gateway.nativeCalls.length,3);
  } finally {await f.close();}
});

test('source or access changes during native capability negotiation prevent first dispatch',async()=>{
  for (const change of ['edit','revoke'] as const) {
    const f=await setup();
    let resume!:()=>void;
    try {
      f.gateway.holdCapabilities=new Promise<void>(yes=>{resume=yes;});
      const first=f.service.start(f.device,f.start);
      if(change==='edit') f.write('content',f.source.id,1,{...f.store.readEntity('content',f.source.id)!.value,body:'Edited before dispatch'});
      else f.write('agent',f.lead.id,1,{...f.store.readEntity('agent',f.lead.id)!.value,access:{}});
      resume();
      const stopped=await f.settle(first.id,'failed');
      assert.equal(stopped.runId,undefined);assert.equal(f.gateway.nativeCalls.length,0);
      assert.equal(f.service.start(f.device,f.start).id,first.id);
      assert.equal(f.store.readEntity('assignment',f.plan.id)!.revision,1);
      if(change==='revoke')assert.equal(f.service.connectedDetail(first.id).inputs[0].material,undefined);
    } finally {resume?.();await f.close();}
  }
});
