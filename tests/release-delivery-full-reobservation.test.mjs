import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sha256,assessCapacity} from '../scripts/release-plan.mjs';
import {collectFullOnlineCapacity,FULL_HELPERS} from '../scripts/release-delivery-full-host.mjs';
import {fullHostFixture} from '../support/full-host-fixture.mjs';

test('older completed rehearsal receives a genuine new observation of the same proof, never a new execution',async t=>{
 const f=fullHostFixture(),root=mkdtempSync(join(tmpdir(),'nova-full-reobserve-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(n,bytes)=>{const path=join(root,n);writeFileSync(path,bytes);return{path,sha256:sha256(Buffer.from(bytes))};};
 const proof=put('proof',Buffer.from(f.completed.proofRawBase64,'base64')),review=put('review','synthetic reviewed rehearsal');
 f.completed.observedAtMilliseconds=1000;f.values.stateDirectory='/var/lib/nova-update';
 const recovery={kind:'nova-delivery-full-rehearsal',values:f.values,leaseId:f.values.leaseId,completion:f.completed,evidence:{proof,review,observation:put('old-observation',JSON.stringify(f.completed))}};
 const metadata=put('metadata',JSON.stringify({archiveBytes:100,expandedBytes:200,fileCount:3}));
 const transport=put('transport',JSON.stringify({format:1,hostAlias:'synthetic',sshConfig:put('ssh-config','Host synthetic\n')}));
 const now=3602000,context={descriptor:f.descriptor,journal:{directory:root},intent:{key:f.key},prior:{recovery,artifacts:{repositories:{private:{metadata}}},sign:{release:{bundle:{bytes:100}},dependencies:{description:{archiveBytes:100,expandedBytes:200,fileCount:3}}}}};
 const capacity={freeBytes:10000000000,candidateBytes:100,snapshotCopyBytes:100,independentRestoreBytes:100,startupGrowthAllowanceBytes:100,nativeMigrationBytes:0,managedCompanionBytes:0,metadataOverheadBytes:100,reserveBytes:1610612736,allowanceBytes:268435456,metadataOverheadMeasured:true,snapshotDeltaMeasured:true,lifecycle:'online'};
 capacity.requiredFreeBytes=assessCapacity(capacity).requiredFreeBytes;
 const measured={format:1,kind:'measured-full-online-capacity',readOnly:true,hostEffects:false,workspaceEpoch:f.descriptor.operation.workspaceEpoch,
  health:{status:'ready',candidateId:f.descriptor.operation.priorCandidateId},runtime:{agentVersion:f.descriptor.operation.priorAgentVersion},sourceCommit:f.descriptor.sources.private.commit,helperHashes:FULL_HELPERS,
  originalClosedEvidence:{path:'/var/lib/nova-update/operator-maintenance/'+f.values.leaseId+'/rehearsal.json',sha256:f.completed.rehearsalEvidenceSha256},expectedReclaimBytes:0,dependencyReuseCreditBytes:0,
  authoritativeStoppedAdmission:false,stoppedAndPostStartChecksStillRequired:true,observedAtMilliseconds:now,capacity};
 const calls=[],run=async(_target,program)=>{calls.push(program);return{exitCode:0,stdout:JSON.stringify(calls.length===1?{...f.completed,observedAtMilliseconds:now}:measured),stderr:''};};
 const storeReceipt=(_j,k,n,bytes)=>{mkdirSync(join(root,'delivery-evidence'),{recursive:true});return put('delivery-evidence/'+k+'-'+n,bytes);};
 const result=await collectFullOnlineCapacity(context,{transport,options:f.options,run,storeReceipt,clock:()=>now});
 assert.equal(result.state,'completed');assert.equal(calls.length,2);assert.ok(calls.every(p=>!p.includes('launch-execute-template')));
 assert.deepEqual(result.recoveryEvidence.proof,proof);assert.deepEqual(result.recoveryEvidence.review,review);
 assert.notDeepEqual(result.recoveryEvidence.observation,recovery.evidence.observation);assert.equal(JSON.parse(readFileSync(result.recoveryEvidence.observation.path)).observedAtMilliseconds,now);
 assert.equal(f.completed.observedAtMilliseconds,1000);
 const changed={...f.completed,observedAtMilliseconds:now,rehearsalEvidenceSha256:'0'.repeat(64)};
 await assert.rejects(collectFullOnlineCapacity(context,{transport,options:f.options,run:async()=>({exitCode:0,stdout:JSON.stringify(changed),stderr:''}),storeReceipt,clock:()=>now}),/raw-proof/);
});


test('actual completed-rehearsal and measured-capacity consumers retain raw2016ms-ahead responses before catch-up',async t=>{
 const f=fullHostFixture(),root=mkdtempSync(join(tmpdir(),'nova-full-reobserve-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(n,bytes)=>{const path=join(root,n);writeFileSync(path,bytes);return{path,sha256:sha256(Buffer.from(bytes))};};
 const proof=put('proof',Buffer.from(f.completed.proofRawBase64,'base64')),review=put('review','synthetic reviewed rehearsal');
 f.completed.observedAtMilliseconds=1000;f.values.stateDirectory='/var/lib/nova-update';
 const recovery={kind:'nova-delivery-full-rehearsal',values:f.values,leaseId:f.values.leaseId,completion:f.completed,evidence:{proof,review,observation:put('old-observation',JSON.stringify(f.completed))}};
 const metadata=put('metadata',JSON.stringify({archiveBytes:100,expandedBytes:200,fileCount:3}));
 const transport=put('transport',JSON.stringify({format:1,hostAlias:'synthetic',sshConfig:put('ssh-config','Host synthetic\n')}));
 let now=3602000;const context={descriptor:f.descriptor,journal:{directory:root},intent:{key:f.key},prior:{recovery,artifacts:{repositories:{private:{metadata}}},sign:{release:{bundle:{bytes:100}},dependencies:{description:{archiveBytes:100,expandedBytes:200,fileCount:3}}}}};
 const capacity={freeBytes:10000000000,candidateBytes:100,snapshotCopyBytes:100,independentRestoreBytes:100,startupGrowthAllowanceBytes:100,nativeMigrationBytes:0,managedCompanionBytes:0,metadataOverheadBytes:100,reserveBytes:1610612736,allowanceBytes:268435456,metadataOverheadMeasured:true,snapshotDeltaMeasured:true,lifecycle:'online'};
 capacity.requiredFreeBytes=assessCapacity(capacity).requiredFreeBytes;
 const measured={format:1,kind:'measured-full-online-capacity',readOnly:true,hostEffects:false,workspaceEpoch:f.descriptor.operation.workspaceEpoch,
  health:{status:'ready',candidateId:f.descriptor.operation.priorCandidateId},runtime:{agentVersion:f.descriptor.operation.priorAgentVersion},sourceCommit:f.descriptor.sources.private.commit,helperHashes:FULL_HELPERS,
  originalClosedEvidence:{path:'/var/lib/nova-update/operator-maintenance/'+f.values.leaseId+'/rehearsal.json',sha256:f.completed.rehearsalEvidenceSha256},expectedReclaimBytes:0,dependencyReuseCreditBytes:0,
  authoritativeStoppedAdmission:false,stoppedAndPostStartChecksStillRequired:true,observedAtMilliseconds:now,capacity};

 let mono=0;const calls=[],responses=[],waits=[];
 const run=async(_target,program)=>{
  calls.push(program);const value=calls.length===1?{...f.completed,observedAtMilliseconds:now+2016}:{...measured,observedAtMilliseconds:now+2016};
  const raw=JSON.stringify(value,null,2)+'\n';responses.push(raw);return{exitCode:0,stdout:raw,stderr:''};
 };
 const storeReceipt=(_j,k,n,bytes)=>{mkdirSync(join(root,'delivery-evidence'),{recursive:true});return put('delivery-evidence/'+k+'-'+n,bytes);};
 const result=await collectFullOnlineCapacity(context,{transport,options:f.options,run,storeReceipt,clock:()=>now,monotonic:()=>mono,wait:async ms=>{waits.push(ms);now+=ms;mono+=ms;}});
 assert.equal(result.state,'completed');assert.equal(calls.length,2);assert.equal(waits.reduce((a,b)=>a+b,0),4032);
 assert.equal(result.output.observedAtMilliseconds,3602000+4032);assert.equal(f.completed.observedAtMilliseconds,1000);
 const records=readdirSync(join(root,'delivery-evidence')).map(n=>JSON.parse(readFileSync(join(root,'delivery-evidence',n))));
 const raw=records.filter(v=>v.stdoutRawBase64),accepted=records.filter(v=>v.kind==='full-host-clock-accepted');
 assert.equal(raw.length,2);assert.equal(accepted.length,2);
 for(const response of responses){assert.ok(raw.some(v=>v.stdoutSha256===sha256(Buffer.from(response))&&Buffer.from(v.stdoutRawBase64,'base64').toString()===response));}
 for(const value of accepted){assert.equal(value.clockObservation.maximumWaitMilliseconds,5000);assert.equal(value.clockObservation.factsAgeMilliseconds,0);assert.equal(value.clockObservation.factsTimestampChanged,false);}
 const before=calls.length;
 await assert.rejects(collectFullOnlineCapacity(context,{transport,options:f.options,run:async()=>{calls.push('read-only-completion');return{exitCode:0,stdout:JSON.stringify({...f.completed,observedAtMilliseconds:now+5001}),stderr:''};},storeReceipt,clock:()=>now,monotonic:()=>mono,wait:async()=>{throw Error('must not wait');}}),/offset-exceeded/);
 assert.equal(calls.length,before+1,'excessive future rehearsal response stops before capacity or effect');
 const refused=readdirSync(join(root,'delivery-evidence')).filter(n=>n.includes('clock-refusal')).map(n=>JSON.parse(readFileSync(join(root,'delivery-evidence',n))));
 assert.equal(refused.length,1);assert.equal(refused[0].originalTimestampChanged,false);assert.equal(refused[0].clockObservation.observedAtMilliseconds,now+5001);
});
