import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256} from '../scripts/release-plan.mjs';
import {bindFullPrestagePlan,unwrapFullPrestage,verifyFullPrestageResult,fullPrestageHelpers,advanceFullPrestage,verifyFullProtectedAssets} from '../scripts/release-delivery-full-prestage.mjs';
import {fullHostFixture} from '../support/full-host-fixture.mjs';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const h=c=>c.repeat(64),key='e70e77aa-6494-49ce-b2a7-7359cd1e73f7';
const b={BUNDLE:h('a'),TARGET:h('b'),PRIOR:h('c'),JOB:key,LEASE:key,PROOF:h('d'),NONCE:key,INCOMING:'/var/tmp/nova-full-delivery-private-assets-'+key,
 SPECS:{'bundle.json':[12,h('a')],'app-dependencies.tgz':[24,h('e')]},CURRENT_FACTS:{currentJob:{id:key},result:{path:'/protected/result.json',sha256:h('f')}},CAPACITY:{rehearsal:{unitName:'original.service'}}};
const files=Object.fromEntries(Object.entries(b.SPECS).map(([k,v])=>[k,{bytes:v[0],sha256:v[1]}]));
const capacity=paid=>({phase:'prestop-artifact-and-candidate-staging',operatingFloorBytes:1879048192,futureReclaimCreditBytes:0,dependencyReuseCreditBytes:0,
 closedRecoveryCapacityAdmitted:false,maintainedInstallerCapacityStillRequired:true,archiveRoles:2,freeBytes:3000000000,requiredFreeBytes:2000000000,paidRoles:Array.from({length:paid*2},()=>({})),completedRehearsal:b.CAPACITY.rehearsal});
const plan={format:1,kind:'exact-full-private-prestage-plan',readOnly:true,automaticReplayPermitted:false,bundleSha256:b.BUNDLE,candidateId:b.TARGET,
 priorCandidateId:b.PRIOR,rehearsalLeaseId:b.LEASE,rehearsalProofSha256:b.PROOF,incoming:b.INCOMING,destination:'/var/lib/nova-update/staging/'+b.BUNDLE,
 files,currentJob:b.CURRENT_FACTS.currentJob,currentResult:b.CURRENT_FACTS.result,capacity:capacity(0)};
const wrap=v=>{const raw=Buffer.from(JSON.stringify(v,null,2)+'\n');return{remoteResult:v,stdoutRawBase64:raw.toString('base64'),stdoutSha256:sha256(raw),stderrSha256:sha256(Buffer.alloc(0))};};
test('separate staging intent binds actual returned plan bytes rather than reconstructed JSON',()=>{
 const actual=wrap(plan),bound=bindFullPrestagePlan(b,actual);assert.equal(bound.STAGE_INTENT.planSha256,actual.stdoutSha256);assert.equal(bound.STAGE_PLAN_RAW_BASE64,actual.stdoutRawBase64);
 assert.throws(()=>unwrapFullPrestage({...actual,stdoutRawBase64:Buffer.from(JSON.stringify(plan)).toString('base64')}),/raw-response/);
 assert.throws(()=>unwrapFullPrestage({...actual,remoteResult:{...plan,candidateId:h('0')}}),/raw-response/);
 for(const change of [p=>p.candidateId=h('0'),p=>p.incoming+='/other',p=>p.currentJob.id='other',p=>p.capacity.futureReclaimCreditBytes=1,p=>p.capacity.closedRecoveryCapacityAdmitted=true]){
  const changed=structuredClone(plan);change(changed);assert.throws(()=>bindFullPrestagePlan(b,wrap(changed)));
 }
});
test('copy observation must retain exact original preparation, identities, files and capacity scope',()=>{
 const prepared={destination:plan.destination,transferUid:1000,preparedReceiptSha256:h('1'),destinationIdentity:{device:1,inode:3}};
 const result={verified:true,bundleSha256:b.BUNDLE,stagingIdentity:b.BUNDLE,dependenciesSha256:b.SPECS['app-dependencies.tgz'][1],jobId:b.JOB,priorCompletedJobId:b.JOB,
  completedResultSha256:b.CURRENT_FACTS.result.sha256,proofSha256:b.PROOF,incoming:b.INCOMING,destination:prepared.destination,transferUid:1000,automaticRetry:false,
  preparedReceiptSha256:prepared.preparedReceiptSha256,destinationIdentityBeforeCopy:prepared.destinationIdentity,files,bundleBytes:12,dependenciesBytes:24,
  applicationActivated:false,installDispatched:false,capacity:capacity(2)};
 assert.deepEqual(verifyFullPrestageResult({stageVerified:true,reconciliation:result},b,prepared),result);
 for(const change of [v=>v.preparedReceiptSha256=h('2'),v=>v.destinationIdentityBeforeCopy.inode=4,v=>v.files['bundle.json'].sha256=h('2'),v=>v.installDispatched=true,v=>v.capacity.paidRoles.pop()]){
  const changed=structuredClone(result);change(changed);assert.throws(()=>verifyFullPrestageResult(changed,b,prepared));
 }
});
test('fixed prestage closure includes root authority and read-only install facts',()=>{
 const helpers=fullPrestageHelpers();assert.equal(Object.keys(helpers).length,4);for(const h of Object.values(helpers))assert.match(h,/^[a-f0-9]{64}$/);
});
for(const runtimeEnabled of [false,true])test('lost original '+(runtimeEnabled?'runtime upload and ':'')+'copy response resumes by observation without duplicate effects',async t=>{
 const f=fullHostFixture(),root=mkdtempSync(join(tmpdir(),'nova-full-prestage-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(n,b)=>{const path=join(root,n);writeFileSync(path,b);return{path,sha256:sha256(Buffer.from(b))};};
 const bundle=put('bundle','synthetic bundle'),archive=put('archive','synthetic dependencies'),metadata=put('metadata',JSON.stringify({archiveBytes:100,expandedBytes:200,fileCount:3}));
 const transport=put('transport',JSON.stringify({format:1,hostAlias:'synthetic',sshConfig:put('config','Host synthetic\n')})),python=put('python','synthetic interpreter');
 const proof=put('proof',Buffer.from(f.completed.proofRawBase64,'base64'));f.values.stage=f.options.stageParent+'/rehearsal-'+f.values.leaseId;f.completed.completedProof.finalPhaseSha256=h('7');
 const c={descriptor:f.descriptor,journal:{directory:root},intent:{key:f.key,inputSha256:h('8')},beforeNewEffect:async()=>{},prior:{
  sign:{candidateId:h('9'),bundle,release:{bundle:{bytes:16}},dependencies:{archive,description:{archiveBytes:22,expandedBytes:500,fileCount:10}}},
  artifacts:{repositories:{private:{metadata}}},capacity:{facts:{protectedHashes:{'/etc/nova-update/runner.json':h('6')}}},
  recovery:{kind:'nova-delivery-full-rehearsal',leaseId:f.values.leaseId,values:f.values,completion:f.completed,evidence:{proof}}}};
 const assets=[['bundle',bundle,16],['dependencies',archive,22]].map(([role,ref,bytes])=>({role,operationId:f.descriptor.operation.id,key:f.key,inputSha256:h('8'),asset:{authenticatedDownloadVerified:true,sha256:ref.sha256,bytes,localPath:ref.path}}));
 if(runtimeEnabled){
  const runtimeArchive=put('runtime','synthetic runtime'),description={format:1,fromVersion:'2026.9.6',toVersion:'2026.9.8',nodeVersion:'24.21.0',companion:{pluginVersion:'2026.9.8',codexVersion:'0.158.0'},archiveBytes:17,archiveSha256:runtimeArchive.sha256,expandedBytes:2000,fileCount:12};
  c.descriptor.operation.priorAgentVersion='2026.9.6';c.descriptor.operation.agentVersion='2026.9.8';
  c.prior.sign.runtime={archive:runtimeArchive,description};c.prior.sign.release.agentVersion='2026.9.8';c.prior.sign.release.runtimeBundle={bytes:17,sha256:runtimeArchive.sha256};
  assets.push({role:'runtime',operationId:f.descriptor.operation.id,key:f.key,inputSha256:h('8'),asset:{authenticatedDownloadVerified:true,sha256:runtimeArchive.sha256,bytes:17,localPath:runtimeArchive.path}});
 }
 const facts={format:1,kind:'current-install-prestage-facts',readOnly:true,hostWrites:false,observedAtMilliseconds:1000,
  hostConfiguration:f.options.hostConfiguration,result:f.options.acceptedInstallation,currentJob:{id:f.options.priorJobId,state:'completed',hold:false,candidateId:f.descriptor.operation.priorCandidateId},
  controller:{holdFor:null,job:{id:f.options.priorJobId,state:'completed'}},resultValue:{candidateId:f.descriptor.operation.priorCandidateId,jobId:f.options.priorJobId,outcome:'completed',savedWorkVerified:true,accountsVerified:true,recoveryVerified:true,healthVerified:true}};
 const storeReceipt=(_j,k,n,raw)=>{const path=join(root,'delivery-evidence',k+'-'+n);mkdirSync(join(root,'delivery-evidence'),{recursive:true});if(existsSync(path))assert.deepEqual(readFileSync(path),raw);else writeFileSync(path,raw);return{path,sha256:sha256(raw)};};
 let prepared,staged,runtimeUploaded=false;const calls=[];const command=async(_binary,args)=>{
  const mode=args[2],request=JSON.parse(readFileSync(args[4]));calls.push(mode);const b=request.binding;let out;
  const cap=paid=>({...capacity(paid),archiveRoles:Object.keys(b.SPECS).length,paidRoles:Array.from({length:paid*Object.keys(b.SPECS).length},()=>({})),...(b.RUNTIME?{runtimeExpansionBytes:2000+12*4096}:{}),completedRehearsal:b.CAPACITY.rehearsal});
  if(mode==='facts')out=facts;
  else if(mode==='plan')out={...plan,bundleSha256:b.BUNDLE,candidateId:b.TARGET,priorCandidateId:b.PRIOR,rehearsalLeaseId:b.LEASE,rehearsalProofSha256:b.PROOF,incoming:b.INCOMING,destination:'/var/lib/nova-update/staging/'+b.BUNDLE,files:Object.fromEntries(Object.entries(b.SPECS).map(([n,[bytes,sha256]])=>[n,{bytes,sha256}])),currentJob:facts.currentJob,currentResult:facts.result,capacity:cap(0)};
  else if(mode==='prepare-input')out=prepared={format:1,inputPrepared:true,bundleSha256:b.BUNDLE,dependenciesSha256:b.SPECS['app-dependencies.tgz'][1],...(b.RUNTIME?{runtimeSha256:b.SPECS['runtime.tgz'][1]}:{}),jobId:b.JOB,completedResultSha256:facts.result.sha256,proofSha256:b.PROOF,incoming:b.INCOMING,destination:'/var/lib/nova-update/staging/'+b.BUNDLE,automaticRetry:false,transferUid:1000,preparedReceiptSha256:h('5'),destinationIdentity:{mode:448,uid:0,device:1,inode:2},incomingIdentity:{mode:448,uid:1000,device:1,inode:3}};
  else if(mode.startsWith('upload-')){const name={'upload-bundle':'bundle.json','upload-dependencies':'app-dependencies.tgz','upload-runtime':'runtime.tgz'}[mode];out={transferred:true,name,bytes:b.SPECS[name][0],sha256:b.SPECS[name][1],incoming:b.INCOMING,authenticatedSourcePreserved:true};
   if(mode==='upload-runtime'){assert.equal(runtimeUploaded,false);runtimeUploaded=true;throw Error('lost original runtime upload');}
   return JSON.stringify({state:'completed',externalId:f.key,output:out});}
  else if(mode==='transfer-observe'){assert.equal(runtimeUploaded,true);out={...prepared,readOnly:true,transfers:{'runtime.tgz':{complete:true,bytes:17,sha256:b.SPECS['runtime.tgz'][1]}}};}
  else if(mode==='stage'){
   staged={...prepared,verified:true,stagingIdentity:b.BUNDLE,priorCompletedJobId:b.JOB,bundleBytes:16,dependenciesBytes:22,destinationIdentityBeforeCopy:prepared.destinationIdentity,
    files:Object.fromEntries(Object.entries(b.SPECS).map(([n,[bytes,sha256]])=>[n,{bytes,sha256}])),applicationActivated:false,installDispatched:false,capacity:cap(2)};
   throw Error('response lost after original completed copy');
  }else if(mode==='observe')out={stageVerified:true,reconciliation:staged};else throw Error('Unexpected '+mode);
  return JSON.stringify({state:'completed',externalId:f.key,output:wrap(out)});
 };
 const options={assets,transport,options:f.options,tools:{python},command,storeReceipt,clock:()=>1000};
 assert.equal((await advanceFullPrestage(c,options)).state,'uncertain');
 if(runtimeEnabled){const count=calls.length;assert.equal((await advanceFullPrestage(c,options)).state,'uncertain');assert.deepEqual(calls.slice(count),['transfer-observe','stage']);}
 const count=calls.length,result=await advanceFullPrestage(c,options);assert.equal(result.state,'completed');assert.deepEqual(calls.slice(count),['observe']);
 assert.equal(calls.filter(x=>x==='stage').length,1);assert.equal(calls.filter(x=>x==='prepare-input').length,1);
 verifyFullProtectedAssets(result,{operationId:f.key,publicationKey:f.key,bundle,dependencies:c.prior.sign.dependencies,runtime:c.prior.sign.runtime});
 if(runtimeEnabled){
  assert.equal(calls.filter(x=>x==='upload-runtime').length,1);
  assert.throws(()=>verifyFullProtectedAssets(result,{operationId:f.key,publicationKey:f.key,bundle,dependencies:c.prior.sign.dependencies}),/runtime-binding/);
 }
 const count2=calls.length;assert.equal((await advanceFullPrestage(c,options)).state,'completed');assert.equal(calls.length,count2);
});
