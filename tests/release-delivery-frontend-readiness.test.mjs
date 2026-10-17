import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frontendReadinessBinding,frontendReadinessIdentity,buildFrontendReadinessProgram,verifyFrontendReadinessPlan,ensureFrontendReadiness } from '../scripts/release-delivery-frontend-readiness.mjs';
import { sha256 } from '../scripts/release-plan.mjs';
const enc=v=>Buffer.from(JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x)+'\n');
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'nova-readiness-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'delivery-evidence'));
 const put=(name,raw)=>{const path=join(root,name);if(existsSync(path))assert.deepEqual(readFileSync(path),raw);else writeFileSync(path,raw,{flag:'wx'});return {path,sha256:sha256(raw)};};
 const binding={operationId:randomUUID(),runId:randomUUID(),baseCandidateId:'a'.repeat(64),serviceInputsSha256:'b'.repeat(64),workspaceEpoch:randomUUID(),baseVersion:'2.7.5',worker:{path:'/fixed/frontend.py',sha256:'c'.repeat(64)},config:{path:'/etc/nova-update/frontend.json',sha256:'d'.repeat(64)}};
 const context={journal:{directory:root},intent:{key:binding.runId},beforeNewEffect:async()=>{}};
 const ssh=put('ssh.conf',Buffer.from('Host fixture\n HostName example.invalid\n')),transport=put('transport.json',enc({format:1,sshConfig:ssh,hostAlias:'fixture'}));
 const base={candidateId:binding.baseCandidateId,serviceInputsSha256:binding.serviceInputsSha256};
 const ready={format:1,kind:'frontend-readiness-plan',operationId:binding.operationId,runId:binding.runId,binding,sourceSha256:frontendReadinessIdentity(),readOnly:true,ready:true,retirementRequired:false,health:{base,epoch:binding.workspaceEpoch,frontend:{id:base.candidateId,source:'bundled'}}};
 const selector=Buffer.from('retained signed selector');
 const plan={format:1,kind:'frontend-retirement-plan',operationId:randomUUID(),blockedDeliveryOperationId:binding.operationId,binding,readOnly:true,retirementRequired:true,
   sources:{worker:binding.worker,config:binding.config,adapterSha256:frontendReadinessIdentity()},health:{base,epoch:binding.workspaceEpoch,frontend:{source:'bundled',blocked:true}},
   observedAtMilliseconds:Date.now(),validForMilliseconds:120000,workerTimeoutSeconds:120,realHeartbeatWaitMaximumSeconds:35,originalSelectorBase64:selector.toString('base64'),proof:{selectorSha256:sha256(selector)}};
 return {root,binding,ready,plan,context,packet:binding,transport,storeReceipt:(_j,key,name,raw)=>put('delivery-evidence/'+key+'-'+name,raw)};
}
function data(program){return JSON.parse(Buffer.from(program.match(/b64decode\('([^']+)'/)[1],'base64'));}
test('readiness transport binds fixed reviewed source and rejects foreign modes',t=>{
 const f=fixture(t);assert.deepEqual(frontendReadinessBinding({...f.binding,ignored:'never passed'}),f.binding);
 const wire=data(buildFrontendReadinessProgram({mode:'readiness-plan',binding:f.binding}));assert.equal(sha256(Buffer.from(wire.sourceBase64,'base64')),frontendReadinessIdentity());
 assert.throws(()=>buildFrontendReadinessProgram({mode:'delete'}));verifyFrontendReadinessPlan(f.ready,f.binding);verifyFrontendReadinessPlan(f.plan,f.binding);
 for(const change of [v=>v.binding={...v.binding,operationId:randomUUID()},v=>v.sources.adapterSha256='f'.repeat(64),v=>v.proof.selectorSha256='f'.repeat(64),v=>v.realHeartbeatWaitMaximumSeconds=300]){const p=structuredClone(f.plan);change(p);assert.throws(()=>verifyFrontendReadinessPlan(p,f.binding));}
});
test('ready selection does not dispatch retirement or request effect prerequisites',async t=>{
 const f=fixture(t),modes=[];f.context.beforeNewEffect=()=>assert.fail('No effect allowed');
 const run=async(_target,program)=>{modes.push(data(program).value.mode);return {exitCode:0,stdout:JSON.stringify(f.ready)};};
 const result=await ensureFrontendReadiness({...f,run});assert.equal(result.state,'completed');assert.deepEqual(modes,['readiness-plan']);
 await ensureFrontendReadiness({...f,run});assert.deepEqual(modes,['readiness-plan']);
});
test('lost retirement response only observes original operation and preserves exact dispatch',async t=>{
 const f=fixture(t),modes=[];let checks=0;f.context.beforeNewEffect=async()=>{checks++;};
 const run=async(_target,program)=>{
   const v=data(program).value;modes.push(v.mode);
   if(v.mode==='readiness-plan')return {exitCode:0,stdout:JSON.stringify(f.plan)};
   assert.equal(checks,1);const path=join(f.root,'delivery-evidence',f.binding.runId+'-frontend-readiness-dispatch.json');assert.ok(existsSync(path));
   assert.deepEqual(JSON.parse(readFileSync(path)),v.intent);
   if(v.mode==='readiness-execute')return {uncertain:true,stdout:'original reply lost'};
   return {exitCode:0,stdout:JSON.stringify({format:1,kind:'frontend-retirement-record',operationId:f.plan.operationId,plan:f.plan,phase:'completed',planSha256:sha256(enc(f.plan)),intentSha256:sha256(enc(v.intent)),adapterSha256:frontendReadinessIdentity()})};
 };
 assert.equal((await ensureFrontendReadiness({...f,run})).state,'uncertain');assert.equal((await ensureFrontendReadiness({...f,run})).state,'completed');
 assert.deepEqual(modes,['readiness-plan','readiness-execute','readiness-observe']);assert.equal(checks,1);
});
test('acknowledged retirement refusal remains failed and never issues a second execute',async t=>{
 const f=fixture(t),modes=[];
 const run=async(_target,program)=>{const v=data(program).value;modes.push(v.mode);if(v.mode==='readiness-plan')return {exitCode:0,stdout:JSON.stringify(f.plan)};
   return {exitCode:0,stdout:JSON.stringify({format:1,kind:'frontend-retirement-record',operationId:f.plan.operationId,plan:f.plan,phase:'refused',planSha256:sha256(enc(f.plan)),intentSha256:sha256(enc(v.intent)),adapterSha256:frontendReadinessIdentity()})};};
 assert.equal((await ensureFrontendReadiness({...f,run})).state,'failed');assert.equal((await ensureFrontendReadiness({...f,run})).state,'failed');assert.equal(modes.filter(m=>m==='readiness-execute').length,1);
});

test('expired read-only retirement plan fails before effect instead of refreshing its clock',async t=>{
 const f=fixture(t);f.plan.observedAtMilliseconds=Date.now()-120001;const modes=[];
 const run=async(_target,program)=>{const v=data(program).value;modes.push(v.mode);assert.equal(v.mode,'readiness-plan');return {exitCode:0,stdout:JSON.stringify(f.plan)};};
 const first=await ensureFrontendReadiness({...f,run});assert.equal(first.state,'failed');assert.equal(first.reason,'frontend-readiness-plan-expired-before-dispatch');
 const second=await ensureFrontendReadiness({...f,run});assert.equal(second.state,'failed');assert.deepEqual(modes,['readiness-plan']);
 assert.equal(existsSync(join(f.root,'delivery-evidence',f.binding.runId+'-frontend-readiness-dispatch.json')),false);
});
