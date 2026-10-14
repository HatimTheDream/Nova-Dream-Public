import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {assistantAcceptanceInput} from '../scripts/release-delivery-assistant.mjs';
import {validateInstalledIdentityRequest,buildInstalledIdentityProgram,fullAssistantBinding} from '../scripts/release-delivery-assistant-full.mjs';
function fixture(){
 const requester='15ae855d7025b9cc267b7a7529ac59c5fdcc1cf960e00104578ba79b3007dc06';
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
