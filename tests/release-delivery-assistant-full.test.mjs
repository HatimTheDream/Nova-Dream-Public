import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {assistantAcceptanceInput} from '../scripts/release-delivery-assistant.mjs';
import {validateInstalledIdentityRequest,buildInstalledIdentityProgram,fullAssistantBinding,createFullAssistantHostTransport,SAME_SCHEMA60_REQUESTER} from '../scripts/release-delivery-assistant-full.mjs';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sha256} from '../scripts/release-plan.mjs';
function fixture(){
 const requester='1b146d6d0b09738595bc6c86a27b4384f09e4b7f4491325c3d2750e1ee99d941';
 const operation={format:1,operationId:randomUUID(),idempotencyKey:randomUUID(),candidateId:'a'.repeat(64),priorCandidateId:'b'.repeat(64),workspaceEpoch:randomUUID(),version:'2.3.0',buildVersion:'1.0.287',priorVersion:'2.2.4',priorBuildVersion:'1.0.285',schemaVersion:55,apiVersion:1,agentVersion:'2026.9.8',priorAgentVersion:'2026.9.8',bundleSha256:'c'.repeat(64),rehearsalLeaseId:randomUUID(),rehearsalProofSha256:'d'.repeat(64)};
 const runtime={startupReview:{path:'/opt/nova-release-tools/actual/startup-review.json',sha256:'e'.repeat(64)},hostConfig:{path:'/etc/nova-update/config.json',sha256:'f'.repeat(64)}};
 const request={format:1,operation,jobId:randomUUID(),requester:{path:`/opt/nova-release-tools/${requester}/request_install.py`,sha256:requester},runtime};
 const identity={format:1,kind:'maintained-installed-acceptance-identity',operationId:operation.operationId,candidateId:operation.candidateId,jobId:request.jobId,idempotencyKey:operation.idempotencyKey,request,health:{candidateId:operation.candidateId,epoch:operation.workspaceEpoch,processIdentity:randomUUID(),frontend:{source:'bundled'}},readOnly:true,savedReplyAccepted:false,browserUiVerified:false};
 const prior={route:{route:'full',targetCandidateId:operation.candidateId},installation:{controllerCompleted:true,coordinatorOperationId:operation.operationId,idempotencyKey:operation.idempotencyKey,jobId:request.jobId,acceptanceIdentity:identity}};
 const descriptor={operation:{id:operation.operationId}},input=assistantAcceptanceInput({descriptor,prior}),intent={key:randomUUID(),inputSha256:'1'.repeat(64),input};
 return{request,runtime,context:{descriptor,prior,input,intent,journal:{deliveryPhase:()=>({...intent,createdAtMs:1000})}}};
}
test('full identity program embeds exact reviewed support and read-only producer',()=>{
 const f=fixture();validateInstalledIdentityRequest(f.request);const p=buildInstalledIdentityProgram(f.request);
 assert.match(p,/result=m\.observe/);assert.match(p,/signal\.alarm\(90\)/);assert.doesNotMatch(p,/systemd-run/);
 const value=JSON.parse(Buffer.from(p.match(/b64decode\('([^']+)'/)[1],'base64'));
 assert.equal(value.supportSha,'8146ea044aaec3e06c29f663ddab5aabcab59a3b9e88c15bd7576ef1fc305d0d');assert.deepEqual(value.value.binding,f.request);
});
test('full binding retains original parent deadline/job/runtime and refuses changed identity',()=>{
 const f=fixture(),b=fullAssistantBinding(f.context,f.runtime.startupReview,f.runtime.hostConfig);assert.equal(b.deadlineAtMs,301000);assert.deepEqual(b.fullRequest,f.request);
 for(const change of [c=>c.prior.installation.jobId=randomUUID(),c=>c.prior.installation.idempotencyKey=randomUUID(),c=>c.prior.installation.acceptanceIdentity.readOnly=false]){
  const c={...f.context,prior:structuredClone(f.context.prior)};change(c);assert.throws(()=>fullAssistantBinding(c,f.runtime.startupReview,f.runtime.hostConfig));
 }
});
test('unsupported requester or mutable runtime path is refused before any transport',()=>{
 const f=fixture();for(const change of [v=>v.requester.sha256='0'.repeat(64),v=>v.runtime.hostConfig.path='/tmp/config.json']){const v=structuredClone(f.request);change(v);assert.throws(()=>validateInstalledIdentityRequest(v));}
});
test('original accepted55 requester remains historical authority only; original39 migration retains its exact pin',()=>{
 const f=fixture(),current='1b146d6d0b09738595bc6c86a27b4384f09e4b7f4491325c3d2750e1ee99d941';
 const old='15ae855d7025b9cc267b7a7529ac59c5fdcc1cf960e00104578ba79b3007dc06';
 f.request.requester={path:`/opt/nova-release-tools/${old}/request_install.py`,sha256:old};
 validateInstalledIdentityRequest(f.request,{allowLegacyProfile:true});
 assert.throws(()=>validateInstalledIdentityRequest(f.request),/maintained-requester/);
 assert.throws(()=>buildInstalledIdentityProgram(f.request),/maintained-requester/);
 const changed=structuredClone(f.request);
 changed.operation.schemaVersion=60;changed.operation.applicationQualification={priorSchemaVersion:55,reviewedPairSha256:'a'.repeat(64),projectionSha256:'b'.repeat(64)};
 assert.throws(()=>validateInstalledIdentityRequest(changed),/maintained-requester/);
 assert.throws(()=>validateInstalledIdentityRequest(changed,{allowLegacyProfile:true}),/maintained-requester/);
 changed.requester={path:`/opt/nova-release-tools/${current}/request_install.py`,sha256:current};
 assert.deepEqual(validateInstalledIdentityRequest(changed),changed);
 changed.operation.schemaVersion=55;delete changed.operation.applicationQualification;
 assert.deepEqual(validateInstalledIdentityRequest(changed),changed);
});

test('full observation wire binds new producer and rejects every effect mode before transport',async t=>{
 const f=fixture(),root=mkdtempSync(join(tmpdir(),'nova-existing-wire-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(name,bytes)=>{const path=join(root,name);writeFileSync(path,bytes);return{path,sha256:sha256(bytes)};};
 const ssh=put('ssh.conf','Host fixture\n HostName example.invalid\n'),config=put('transport.json',JSON.stringify({format:1,hostAlias:'fixture',sshConfig:ssh}));
 const r={path:'/fixture/evidence.json',sha256:'a'.repeat(64)};
 f.context.descriptor.existingAssistantReply={kind:'nova-existing-saved-reply-observation',originalReceipt:r,originalInstallation:r,originalBrowserInput:r,session:r,conversation:r,submission:r,savedReply:r};
 f.context.input=assistantAcceptanceInput(f.context);f.context.intent.input=f.context.input;
 let calls=0;const transport=createFullAssistantHostTransport({transport:config,...f.runtime,storeReceipt:()=>{throw Error('unexpected-failure');},run:async(_target,program)=>{
  calls++;const wire=JSON.parse(Buffer.from(program.match(/b64decode\('([^']+)'/)[1],'base64'));
  assert.equal(wire.value.mode,'existing-reply');assert.equal(wire.supportSha,'8146ea044aaec3e06c29f663ddab5aabcab59a3b9e88c15bd7576ef1fc305d0d');assert.equal(sha256(Buffer.from(wire.existing,'base64')),wire.existingSha);
  assert.deepEqual(Buffer.from(wire.existing,'base64'),readFileSync(new URL('../scripts/release-assistant-existing-reply.py',import.meta.url)));
  return{exitCode:0,stdout:JSON.stringify({ok:true,value:{observed:true}})};
 }});
 await transport.validate(f.context);const b=fullAssistantBinding(f.context,f.runtime.startupReview,f.runtime.hostConfig),common={operationId:b.operationId,parentKey:b.parentKey,inputSha256:b.inputSha256,input:b.input,deadlineAtMs:b.deadlineAtMs};
 assert.deepEqual(await transport.observeExisting(common),{observed:true});
 for(const method of ['session','postExact','readDraft','observeSubmit','readReady'])await assert.rejects(()=>transport[method](common),/observation-mode/);
 assert.equal(calls,1);
});

test('same schema60 identity selects only the reviewed new requester while original39 stays historical',()=>{
 const f=fixture(),old=structuredClone(f.request),digest=sha256(readFileSync(new URL('../deploy/update-runner/request_install.py',import.meta.url)));
 assert.equal(digest,SAME_SCHEMA60_REQUESTER);
 old.operation.schemaVersion=60;old.operation.applicationQualification={priorSchemaVersion:55,reviewedPairSha256:'a'.repeat(64),projectionSha256:'b'.repeat(64)};
 assert.deepEqual(validateInstalledIdentityRequest(old),old);
 const current=structuredClone(old);current.operation.applicationQualification.priorSchemaVersion=60;
 assert.throws(()=>validateInstalledIdentityRequest(current,{allowLegacyProfile:true}),/maintained-requester/);
 current.requester={path:'/opt/nova-release-tools/'+digest+'/request_install.py',sha256:digest};
 assert.deepEqual(validateInstalledIdentityRequest(current),current);assert.match(buildInstalledIdentityProgram(current),/result=m\.observe/);
 for(const priorSchemaVersion of [55]){const wrong=structuredClone(current);wrong.operation.applicationQualification.priorSchemaVersion=priorSchemaVersion;assert.throws(()=>validateInstalledIdentityRequest(wrong),/maintained-requester/);}
 const wrong=structuredClone(current);wrong.requester.path='/opt/nova-release-tools/wrong/request_install.py';assert.throws(()=>validateInstalledIdentityRequest(wrong),/maintained-requester/);
});
