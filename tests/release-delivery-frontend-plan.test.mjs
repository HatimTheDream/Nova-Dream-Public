import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { frontendPlanArguments,verifyFrontendPlanResult,requestFrontendPlan,frontendPromotionIntegrationGaps,buildFrontendPlanProgram,createFrontendRecoveryPlanAdapter } from '../scripts/release-delivery-frontend-plan.mjs';
import { sha256 } from '../scripts/release-plan.mjs';
function fixture(){
  const operationId=randomUUID(),root=`/var/lib/nova-update/frontend/operator-inputs/${operationId}`,ref=(path,char)=>({path,sha256:char.repeat(64)});
  const input={format:1,operationId,baseVersion:'2.3.0',baseCandidateId:'a'.repeat(64),serviceInputsSha256:'b'.repeat(64),frontendId:'c'.repeat(64),sourceRevision:'d'.repeat(40),version:'2.3.1',buildVersion:'1.0.288',
    worker:{path:'/opt/nova-updater-2.3.0-aaaaaaaaaaaa/deploy/update-runner/frontend.py',sha256:'73ca5399f703f20512a925b0cdb10dde1dfa9b733966d47b5cbdd1f20c34b171'},config:ref('/etc/nova-update/frontend.json','e'),operation:ref(`${root}/operation.json`,'f'),
    assets:{manifest:ref(`${root}/frontend.json`,'1'),signature:ref(`${root}/frontend.sig`,'2'),archive:ref(`${root}/frontend.tgz`,'3')},processIdentity:randomUUID(),workspaceEpoch:randomUUID()};
  const base={candidateId:input.baseCandidateId,serviceInputsSha256:input.serviceInputsSha256,apiVersion:1,schemaVersion:55};
  const plan={format:1,operationId,operationSha256:input.operation.sha256,configSha256:input.config.sha256,manifestSha256:input.assets.manifest.sha256,signatureSha256:input.assets.signature.sha256,archiveSha256:input.assets.archive.sha256,frontendId:input.frontendId,
    live:{...base,epoch:input.workspaceEpoch,processIdentity:randomUUID(),active:false},health:{...base,epoch:input.workspaceEpoch,processIdentity:input.processIdentity},priorRecovery:{base}};
  const envelope=p=>{const bytes=Buffer.from(JSON.stringify(p)+'\n');return {format:1,kind:'nova-maintained-frontend-plan',operationId,workerSha256:input.worker.sha256,plan:p,planRawBase64:bytes.toString('base64'),planSha256:sha256(bytes),readOnly:true,capacityQualified:false,effectDispatchQualified:false};};
  return {input,root,plan,envelope,result:envelope(plan)};
}
test('all three modes match maintained CLI and resume never adds a new plan or intent',()=>{
  const f=fixture(),common=['/usr/bin/python3','-B',f.input.worker.path];
  assert.deepEqual(frontendPlanArguments(f.input,'plan'),[...common,'--plan',f.input.operation.path,'--config',f.input.config.path]);
  assert.deepEqual(frontendPlanArguments(f.input,'resume'),[...common,'--resume',f.input.operation.path,'--config',f.input.config.path]);
  const proof={path:f.root+'/plan.json',sha256:'a'.repeat(64)},intent={path:f.root+'/intent.json',sha256:'b'.repeat(64)};
  assert.deepEqual(frontendPlanArguments(f.input,'execute',{plan:proof,intent}),[...common,'--execute',f.input.operation.path,'--config',f.input.config.path,'--plan-receipt',proof.path,'--intent',intent.path]);
  assert.throws(()=>frontendPlanArguments(f.input,'execute'),/exact-plan-and-intent/);assert.throws(()=>frontendPlanArguments(f.input,'resume',{plan:proof,intent}),/original-inputs/);
});
test('wrong installed worker, alternate operation path and caller command fields refused',()=>{
  for(const mutate of [x=>x.worker.sha256='9'.repeat(64),x=>x.worker.path='/opt/other/frontend.py',x=>x.operation.path=x.operation.path.replace(x.operationId,randomUUID()),x=>x.command='execute-anything']){const f=fixture();mutate(f.input);assert.throws(()=>buildFrontendPlanProgram(f.input));}
});

test('format 2 separates installed worker identity without changing signed/live service checks',()=>{
  const f=fixture();Object.assign(f.input,{format:2,baseVersion:'2.3.1',workerInstallation:{version:'2.3.0',candidateId:'e'.repeat(64)}});
  f.input.worker.path='/opt/nova-updater-2.3.0-eeeeeeeeeeee/deploy/update-runner/frontend.py';
  assert.equal(frontendPlanArguments(f.input,'plan')[2],f.input.worker.path);
  assert.equal(frontendPlanArguments(f.input,'resume')[3],'--resume');
  assert.doesNotThrow(()=>verifyFrontendPlanResult(f.result,f.input));
  const wrong=structuredClone(f.plan);wrong.health.candidateId=f.input.workerInstallation.candidateId;
  assert.throws(()=>verifyFrontendPlanResult(f.envelope(wrong),f.input),/service-changed/);
  for(const mutate of [v=>v.workerInstallation.version='2.3.1',v=>v.workerInstallation.candidateId='f'.repeat(64),v=>v.worker.path='/opt/other/frontend.py',v=>v.worker.sha256='f'.repeat(64),v=>delete v.workerInstallation,v=>v.workerInstallation.path='/opt/other',v=>v.format=1]){
    const input=structuredClone(f.input);mutate(input);assert.throws(()=>buildFrontendPlanProgram(input));assert.throws(()=>verifyFrontendPlanResult(f.result,input));
  }
});
test('plan binds raw receipt, selected service process, epoch, source and recovery without claiming capacity',()=>{
  const f=fixture();assert.equal(verifyFrontendPlanResult(f.result,f.input).toString(),JSON.stringify(f.plan)+'\n');
  for(const mutate of [p=>p.health.processIdentity=randomUUID(),p=>p.live.epoch=randomUUID(),p=>p.health.candidateId='9'.repeat(64),p=>p.archiveSha256='9'.repeat(64),p=>p.live.active=true,p=>p.priorRecovery.base.serviceInputsSha256='9'.repeat(64)]){const value=structuredClone(f.plan);mutate(value);assert.throws(()=>verifyFrontendPlanResult(f.envelope(value),f.input));}
  assert.throws(()=>verifyFrontendPlanResult({...f.result,capacityQualified:true},f.input),/producer-changed/);
  assert.throws(()=>verifyFrontendPlanResult({...f.result,planSha256:'9'.repeat(64)},f.input),/raw-changed/);
});
test('lost transport response stays uncertain; a second read-only plan uses the same operation without effects',async()=>{
  const f=fixture(),root=fileURLToPath(new URL(`../support/fixtures/frontend-plan-${randomUUID()}/`,import.meta.url));mkdirSync(root,{recursive:true});
  const put=(name,value)=>{const path=join(root,name),bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value)+'\n');writeFileSync(path,bytes);return {path,sha256:sha256(bytes)};};
  const ssh=put('ssh.conf','Host fixed\n HostName example.invalid\n'),transport=put('transport.json',{format:1,sshConfig:ssh,hostAlias:'fixed'});let calls=0;
  const run=async(target,program)=>{calls++;assert.equal(target.hostAlias,'fixed');assert.ok(program.includes("n['plan']"));return calls===1?{uncertain:true,reasonCode:'timeout'}:{stdout:JSON.stringify(f.result),exitCode:0};};
  const one=await requestFrontendPlan({transport,input:f.input},{run});assert.equal(one.state,'uncertain');assert.equal(one.externalId,f.input.operationId);
  const two=await requestFrontendPlan({transport,input:f.input},{run});assert.equal(two.state,'completed');assert.equal(two.externalId,one.externalId);assert.equal(two.output.effectDispatchQualified,false);assert.equal(calls,2);
  assert.ok(frontendPromotionIntegrationGaps.includes('frontend-finite-worker-dispatch-and-original-observation-not-integrated'));
});
test('delivery adapter requires producer-owned capacity/stage output and retains exact original worker bytes',async()=>{
  const f=fixture(),root=fileURLToPath(new URL(`../support/fixtures/frontend-plan-adapter-${randomUUID()}/`,import.meta.url));mkdirSync(root,{recursive:true});
  const put=(name,bytes)=>{const path=join(root,name);writeFileSync(path,bytes,{flag:'wx'});return {path,sha256:sha256(bytes)};};
  const ssh=put('ssh.conf',Buffer.from('Host fixed\n HostName example.invalid\n')),transport=put('transport.json',Buffer.from(JSON.stringify({format:1,sshConfig:ssh,hostAlias:'fixed'})));
  let calls=0;const adapter=createFrontendRecoveryPlanAdapter({transport,run:async()=>{calls++;return {stdout:JSON.stringify(f.result),exitCode:0};},storeReceipt:(_j,key,name,bytes)=>put(`${key}-${name}`,bytes)});
  const descriptor={operation:{id:f.input.operationId,priorCandidateId:f.input.baseCandidateId,version:f.input.version,buildVersion:f.input.buildVersion},sources:{private:{commit:f.input.sourceRevision}}};
  await assert.rejects(adapter.input({descriptor,prior:{}}),/capacity-and-stage-producer-required/);assert.equal(calls,0);
  const prior={route:{route:'frontend',serviceInputsSha256:f.input.serviceInputsSha256},sign:{frontendId:f.input.frontendId,...f.input.assets},capacity:{kind:'nova-delivery-frontend-capacity',operationId:f.input.operationId,capacityQualified:true,frontendStage:{kind:'nova-protected-frontend-stage',planInput:f.input}}};
  const input=await adapter.input({descriptor,prior}),context={descriptor,prior,input,intent:{input,key:randomUUID(),inputSha256:'7'.repeat(64)},journal:{directory:root}};
  await adapter.validate(context);const result=await adapter.execute(context);await adapter.verify(result,context);assert.equal(calls,1);assert.equal(result.output.planSha256,result.output.workerPlan.sha256);
  assert.equal(result.output.effectDispatchQualified,false);prior.capacity.frontendStage.planInput.processIdentity=randomUUID();assert.throws(()=>adapter.validate(context),/input-changed/);
});
