/** Fixed private-asset prestaging. Every transfer/copy has one durable child;
 * a lost response is reconciled against that child's exact host paths. */
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual as same} from 'node:util';
import {readEvidenceFile,readReleaseInputFile,sha256} from './release-plan.mjs';
import {FULL_HELPERS,verifyFullCompletion,fullHostOptionsSchema} from './release-delivery-full-host.mjs';
import {verifyRuntimeArtifact,runtimeTransition} from './release-runtime-artifact.mjs';
import {awaitObservationTime} from './release-observation-clock.mjs';

const need=(v,r)=>{if(!v)throw Error(r);};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const encoded=v=>Buffer.from(canonical(v)+'\n');
const names=['release-delivery-full-prestage.py','release-full-publication-primitives.py','full-host-primitives/asset-stage.py','full-host-primitives/install-facts.py'];
export const fullPrestageHelpers=()=>Object.fromEntries(names.map(n=>[n,sha256(readFileSync(new URL(n,import.meta.url)))]));
const save=(c,store,n,v)=>store(c.journal,c.intent.key,n,encoded(v));
function retained(c,n){const path=join(c.journal.directory,'delivery-evidence',c.intent.key+'-'+n);if(!existsSync(path))return null;const raw=readReleaseInputFile(path);return{value:JSON.parse(raw),ref:{path,sha256:sha256(raw)}};}
export function unwrapFullPrestage(value){
 need(value&&typeof value.stdoutRawBase64==='string','full-prestage-actual-response-required');
 const raw=Buffer.from(value.stdoutRawBase64,'base64');
 need(raw.length<=131072&&raw.toString('base64')===value.stdoutRawBase64&&sha256(raw)===value.stdoutSha256&&same(JSON.parse(raw),value.remoteResult),'full-prestage-raw-response-changed');
 return value.remoteResult;
}
/** Share the five-second genuine-clock catch-up policy with full-host
 * observations while preserving the original five-minute freshness limit. */
export async function awaitFullPrestageFactsTime(observedAtMilliseconds,options={}){
 const reasons={
  'observation-timestamp-invalid':'full-prestage-facts-timestamp-invalid',
  'observation-clock-offset-exceeded':'full-prestage-facts-clock-offset-exceeds-5s',
  'observation-monotonic-clock-invalid':'full-prestage-facts-monotonic-clock-invalid',
  'observation-local-clock-moved-backward':'full-prestage-local-clock-moved-backward',
  'observation-clock-wait-budget-expired':'full-prestage-facts-clock-wait-budget-expired',
  'observation-expired':'full-prestage-current-facts-expired',
  'observation-local-clock-did-not-catch-up':'full-prestage-local-clock-did-not-catch-up',
  'observation-clock-wait-interrupted':'full-prestage-facts-clock-wait-interrupted',
  'observation-clock-did-not-progress':'full-prestage-facts-clock-did-not-progress',
 };
 try{return{...await awaitObservationTime(observedAtMilliseconds,{...options,maximumWaitMilliseconds:5000,maximumAgeMilliseconds:300000,maximumSamples:128}),kind:'full-prestage-facts-clock-observation'};}
 catch(error){error.message=reasons[error.message]??error.message;if(error.clockObservation)error.clockObservation.kind='full-prestage-facts-clock-observation';throw error;}
}
export function fullPrestageBinding(c,options,facts,assets){
 fullHostOptionsSchema.parse(options);const op=c.descriptor.operation,s=c.prior.sign,r=c.prior.recovery;
 verifyFullCompletion(r.completion,r.values);
 need(facts?.format===1&&facts.kind==='current-install-prestage-facts'&&facts.readOnly===true&&facts.hostWrites===false
  &&facts.hostConfiguration.path===options.hostConfiguration.path&&facts.hostConfiguration.sha256===options.hostConfiguration.sha256
  &&facts.result.path===options.acceptedInstallation.path&&facts.result.sha256===options.acceptedInstallation.sha256
  &&facts.currentJob.id===options.priorJobId&&facts.currentJob.state==='completed'&&facts.currentJob.hold===false
  &&facts.currentJob.candidateId===op.priorCandidateId&&facts.controller.holdFor===null
  &&facts.controller.job?.id===options.priorJobId&&facts.controller.job.state==='completed','full-prestage-current-installation-changed');
 need(facts.resultValue.candidateId===op.priorCandidateId&&facts.resultValue.jobId===options.priorJobId&&facts.resultValue.outcome==='completed'
  &&['savedWorkVerified','accountsVerified','healthVerified','recoveryVerified'].every(k=>facts.resultValue[k]===true),'full-prestage-prior-result-incomplete');
 need(r.values.candidateId===op.priorCandidateId&&r.values.workspaceEpoch===op.workspaceEpoch,'full-prestage-rehearsal-base-changed');
 const runtime=s.runtime??null;if(runtime){need(op.priorAgentVersion==='2026.9.6'&&op.agentVersion==='2026.9.8','full-prestage-runtime-transition-changed');runtimeTransition(runtime,s.release);}
 else need(!s.release.runtimeBundle&&op.priorAgentVersion===op.agentVersion,'full-prestage-runtime-missing');
 const roles=['bundle','dependencies',...(runtime?['runtime']:[])];
 const rows=Object.fromEntries(roles.map(role=>{const a=assets.filter(a=>a.role===role);need(a.length===1,'full-prestage-asset-role-ambiguous');return[role,a[0]];}));
 const specs=[['bundle','bundle.json',s.bundle,s.release.bundle.bytes],['dependencies','app-dependencies.tgz',s.dependencies.archive,s.dependencies.description.archiveBytes],...(runtime?[['runtime','runtime.tgz',runtime.archive,runtime.description.archiveBytes]]:[])];
 const files={};for(const [role,name,ref,size]of specs){
  const row=rows[role];need(row.operationId===op.id&&row.key===c.intent.key&&row.inputSha256===c.intent.inputSha256&&row.asset.authenticatedDownloadVerified===true&&row.asset.sha256===ref.sha256&&row.asset.bytes===size,'full-prestage-authenticated-asset-required');
  files[name]={path:row.asset.localPath,sha256:ref.sha256};
  if(role==='runtime')verifyRuntimeArtifact(files[name],size);else need(readEvidenceFile(files[name],{maximum:128*1024**2}).length===size,'full-prestage-asset-bytes-changed');
 }
 const metadata=JSON.parse(readEvidenceFile(c.prior.artifacts.repositories.private.metadata)),completed=r.completion;
 const binding={BUNDLE:s.bundle.sha256,BUNDLE_BYTES:s.release.bundle.bytes,TARGET:s.candidateId,PRIOR:op.priorCandidateId,PRIOR_VERSION:options.priorVersion,
  EPOCH:op.workspaceEpoch,JOB:options.priorJobId,LEASE:r.leaseId,PROOF:r.evidence.proof.sha256,INCOMING:'/var/tmp/nova-full-delivery-private-assets-'+c.intent.key,NONCE:c.intent.key,
  SPECS:Object.fromEntries(specs.map(([_role,name,ref,size])=>[name,[size,ref.sha256]])),CURRENT_FACTS:facts,
  ...(runtime?{RUNTIME:runtime.description,PRIOR_AGENT_VERSION:op.priorAgentVersion}:{}),
  CAPACITY:{application:Object.fromEntries(['archiveBytes','expandedBytes','fileCount'].map(k=>[k,metadata[k]])),dependencyDescription:s.dependencies.description,
   helperHashes:Object.fromEntries(['recovery.py','install.py','app_dependencies.py'].map(n=>[n,FULL_HELPERS[n]])),helperRoot:r.values.stage,
   runnerSha256:c.prior.capacity.facts.protectedHashes['/etc/nova-update/runner.json'],rehearsal:{completedEvidenceSha256:completed.rehearsalEvidenceSha256,
    snapshotManifestSha256:completed.completedProof.snapshotManifestSha256,finalPhaseSha256:completed.completedProof.finalPhaseSha256,unitName:completed.unitName}},
  EXCLUDED:options.excludedIdentities,acceptedInstallation:options.acceptedInstallation,hostConfiguration:options.hostConfiguration,STAGE_PLAN:null,STAGE_INTENT:null,STAGE_PLAN_RAW_BASE64:null};
 need(typeof binding.CAPACITY.helperRoot==='string'&&/^[a-f0-9]{64}$/.test(binding.CAPACITY.runnerSha256),'full-prestage-qualified-capacity-inputs-required');
 return{binding,files};
}
const expectedFiles=b=>Object.fromEntries(Object.entries(b.SPECS).map(([k,v])=>[k,{bytes:v[0],sha256:v[1]}]));
export function bindFullPrestagePlan(binding,wrapped){
 const p=unwrapFullPrestage(wrapped);
 need(p.format===1&&p.kind==='exact-full-private-prestage-plan'&&p.readOnly===true&&p.automaticReplayPermitted===false
  &&p.bundleSha256===binding.BUNDLE&&p.candidateId===binding.TARGET&&p.priorCandidateId===binding.PRIOR&&p.rehearsalLeaseId===binding.LEASE&&p.rehearsalProofSha256===binding.PROOF
  &&p.incoming===binding.INCOMING&&p.destination==='/var/lib/nova-update/staging/'+binding.BUNDLE&&same(p.files,expectedFiles(binding))
  &&same(p.currentJob,binding.CURRENT_FACTS.currentJob)&&same(p.currentResult,binding.CURRENT_FACTS.result),'full-prestage-exact-plan-changed');
 verifyPrestageCapacity(p.capacity,0,binding);
 return{...binding,STAGE_PLAN:p,STAGE_PLAN_RAW_BASE64:wrapped.stdoutRawBase64,STAGE_INTENT:{format:1,kind:'execute-exact-full-private-prestage',planSha256:wrapped.stdoutSha256,bundleSha256:binding.BUNDLE,nonce:binding.NONCE,automaticReplayPermitted:false}};
}
function verifyPrestageCapacity(v,paid,b){
 need(v?.phase==='prestop-artifact-and-candidate-staging'&&v.operatingFloorBytes===1879048192&&v.futureReclaimCreditBytes===0&&v.dependencyReuseCreditBytes===0
  &&v.closedRecoveryCapacityAdmitted===false&&v.maintainedInstallerCapacityStillRequired===true&&v.archiveRoles===Object.keys(b.SPECS).length&&v.freeBytes>=v.requiredFreeBytes
  &&v.paidRoles.length===paid*Object.keys(b.SPECS).length&&same(v.completedRehearsal,b.CAPACITY.rehearsal),'full-prestage-capacity-scope-changed');
 if(b.RUNTIME)need(v.runtimeExpansionBytes>=b.RUNTIME.expandedBytes+b.RUNTIME.fileCount*4096,'full-prestage-runtime-allocation-missing');
}
function verifyPrepared(v,b){
 need(v?.inputPrepared===true&&v.bundleSha256===b.BUNDLE&&v.dependenciesSha256===b.SPECS['app-dependencies.tgz'][1]&&v.jobId===b.JOB
  &&v.completedResultSha256===b.CURRENT_FACTS.result.sha256&&v.proofSha256===b.PROOF&&v.incoming===b.INCOMING&&v.destination==='/var/lib/nova-update/staging/'+b.BUNDLE
  &&v.automaticRetry===false&&Number.isSafeInteger(v.transferUid)&&v.transferUid>0&&/^[a-f0-9]{64}$/.test(v.preparedReceiptSha256),'full-prestage-original-preparation-changed');
 for(const [name,owner]of [['destinationIdentity',0],['incomingIdentity',v.transferUid]])need(v[name]?.mode===448&&v[name].uid===owner&&Number.isSafeInteger(v[name].device)&&Number.isSafeInteger(v[name].inode),'full-prestage-directory-identity-changed');
 need(b.RUNTIME?v.runtimeSha256===b.SPECS['runtime.tgz'][1]:!Object.hasOwn(v,'runtimeSha256'),'full-prestage-prepared-runtime-changed');
}
export function verifyFullPrestageResult(v,b,prepared){
 const r=v.stageVerified===true?v.reconciliation:v;
 need(r?.verified===true&&r.bundleSha256===b.BUNDLE&&r.stagingIdentity===b.BUNDLE&&r.dependenciesSha256===b.SPECS['app-dependencies.tgz'][1]
  &&r.jobId===b.JOB&&r.priorCompletedJobId===b.JOB&&r.completedResultSha256===b.CURRENT_FACTS.result.sha256&&r.proofSha256===b.PROOF
  &&r.incoming===b.INCOMING&&r.destination===prepared.destination&&r.transferUid===prepared.transferUid&&r.automaticRetry===false
  &&r.preparedReceiptSha256===prepared.preparedReceiptSha256&&same(r.destinationIdentityBeforeCopy,prepared.destinationIdentity)
  &&same(r.files,expectedFiles(b))&&r.bundleBytes===b.SPECS['bundle.json'][0]&&r.dependenciesBytes===b.SPECS['app-dependencies.tgz'][0]
  &&r.applicationActivated===false&&r.installDispatched===false,'full-prestage-original-stage-proof-changed');
 need(b.RUNTIME?r.runtimeSha256===b.SPECS['runtime.tgz'][1]:!Object.hasOwn(r,'runtimeSha256'),'full-prestage-staged-runtime-changed');
 verifyPrestageCapacity(r.capacity,2,b);return r;
}
export function verifyFullProtectedAssets(value,{operationId,publicationKey,bundle,dependencies,runtime=null}){
 need(value?.receipt&&same(JSON.parse(readEvidenceFile(value.receipt)),value.output),'full-protected-assets-receipt-changed');
 const o=value.output,input=JSON.parse(readEvidenceFile(o.input));
 need(o.kind==='nova-delivery-full-protected-assets'&&o.operationId===operationId&&o.key===publicationKey&&o.applicationActivated===false&&o.installDispatched===false
  &&input.operationId===operationId&&input.key===publicationKey&&input.inputSha256===o.inputSha256&&same(input.helperHashes,fullPrestageHelpers())
  &&input.binding.BUNDLE===bundle.sha256&&input.binding.SPECS['app-dependencies.tgz'][1]===dependencies.archive.sha256,'full-protected-assets-original-binding-changed');
 need(runtime?same(input.binding.RUNTIME,runtime.description)&&same(input.binding.SPECS['runtime.tgz'],[runtime.description.archiveBytes,runtime.archive.sha256])
  :!Object.hasOwn(input.binding,'RUNTIME')&&!Object.hasOwn(input.binding.SPECS,'runtime.tgz'),'full-protected-runtime-binding-changed');
 const facts=unwrapFullPrestage(JSON.parse(readEvidenceFile(input.actualFacts))),plan=JSON.parse(readEvidenceFile(input.actualPlan));
 need(same(facts,input.binding.CURRENT_FACTS)&&same(bindFullPrestagePlan({...input.binding,STAGE_PLAN:null,STAGE_INTENT:null,STAGE_PLAN_RAW_BASE64:null},plan),input.binding),'full-protected-assets-original-plan-changed');
 for(const [name,ref]of Object.entries(input.files)){
  need(ref.sha256===input.binding.SPECS[name][1],'full-protected-assets-source-changed');
  if(name==='runtime.tgz')verifyRuntimeArtifact(ref,input.binding.SPECS[name][0]);else need(readEvidenceFile(ref,{maximum:128*1024**2}).length===input.binding.SPECS[name][0],'full-protected-assets-source-changed');
 }
 verifyPrepared(o.prepared,input.binding);return verifyFullPrestageResult(o.stage,input.binding,o.prepared);
}
export async function advanceFullPrestage(c,{assets,transport,options,tools,command,storeReceipt,clock=Date.now,monotonic,wait}){
 const hashes=fullPrestageHelpers(),original=retained(c,'full-prestage-input.json');
 const target=JSON.parse(readEvidenceFile(transport));readEvidenceFile(target.sshConfig,{maximum:65536});
 const common={format:1,operationId:c.descriptor.operation.id,key:c.intent.key,inputSha256:c.intent.inputSha256,transport:target,
  outputDirectory:join(c.journal.directory,'full-prestage-'+c.intent.key),helperHashes:hashes};
 const call=async(mode,binding,files)=>{
  const request={...common,binding,files},ref=save(c,storeReceipt,'full-prestage-'+mode+'-request-'+sha256(encoded(request))+'.json',request);
  readEvidenceFile(tools.python,{maximum:128*1024**2});need(same(hashes,fullPrestageHelpers()),'full-prestage-source-changed');readEvidenceFile(target.sshConfig,{maximum:65536});
  try{const value=JSON.parse(await command(tools.python.path,['-B',fileURLToPath(new URL('release-delivery-full-prestage.py',import.meta.url)),mode,'--request',ref.path,'--request-sha256',ref.sha256],{maximum:1024**2,timeoutMs:380000,acceptJsonFailure:true}));
   need(['completed','uncertain'].includes(value?.state)&& (value.state!=='completed'||value.externalId===common.operationId),'full-prestage-child-identity-changed');return value;}
  catch(error){return{state:'uncertain',reason:'original-full-prestage-response-unavailable',output:{diagnostic:save(c,storeReceipt,'full-prestage-diagnostic-'+sha256(encoded({mode,ref,message:String(error.message)}))+'.json',{mode,request:ref,message:String(error.message).slice(0,1000),automaticReplayPermitted:false})}};}
 };
 let input=original?.value;
 if(!input){
  const factsResult=await call('facts',null,{});if(factsResult.state!=='completed')return factsResult;const facts=unwrapFullPrestage(factsResult.output);
  try{await awaitFullPrestageFactsTime(facts.observedAtMilliseconds,{clock,monotonic,wait});}
  catch(error){
   const actualFacts=save(c,storeReceipt,'full-prestage-clock-facts-'+factsResult.output.stdoutSha256+'.json',factsResult.output);
   const diagnostic={format:1,operationId:common.operationId,key:common.key,inputSha256:common.inputSha256,actualFacts,
    reason:error.message,clockObservation:error.clockObservation,planStarted:false,hostEffectStarted:false,automaticReplayPermitted:false};
   return{state:'failed',externalId:common.operationId,reason:error.message,output:{diagnostic:save(c,storeReceipt,'full-prestage-clock-diagnostic-'+sha256(encoded(diagnostic))+'.json',diagnostic)}};
  }
  const initial=fullPrestageBinding(c,options,facts,assets),planned=await call('plan',initial.binding,initial.files);if(planned.state!=='completed')return planned;
  input={format:1,operationId:common.operationId,key:common.key,inputSha256:common.inputSha256,helperHashes:hashes,transport,binding:bindFullPrestagePlan(initial.binding,planned.output),files:initial.files,
   actualFacts:save(c,storeReceipt,'full-prestage-facts.json',factsResult.output),actualPlan:save(c,storeReceipt,'full-prestage-plan.json',planned.output)};
  save(c,storeReceipt,'full-prestage-input.json',input);
 }
 need(input.operationId===common.operationId&&input.key===common.key&&input.inputSha256===common.inputSha256&&same(input.helperHashes,hashes)&&same(input.transport,transport),'full-prestage-original-input-changed');
 const recomputed=fullPrestageBinding(c,options,unwrapFullPrestage(JSON.parse(readEvidenceFile(input.actualFacts))),assets);
 need(same(input.files,recomputed.files)&&same(input.binding,bindFullPrestagePlan(recomputed.binding,JSON.parse(readEvidenceFile(input.actualPlan)))),'full-prestage-retained-plan-changed');
 const b=input.binding,files=input.files,done=retained(c,'full-prestage-result.json');
 if(done){verifyFullPrestageResult(done.value.stage,b,done.value.prepared);return{state:'completed',output:done.value,receipt:done.ref};}
 const effect=async(mode,observe,verify)=>{
  const name='full-prestage-'+mode,previous=retained(c,name+'-result.json');if(previous){verify(previous.value);return{state:'completed',output:previous.value};}
  const reserved=retained(c,name+'-dispatch.json');
  if(!reserved){need(typeof c.beforeNewEffect==='function','full-prestage-fresh-gates-required');await c.beforeNewEffect();save(c,storeReceipt,name+'-dispatch.json',{format:1,operationId:common.operationId,key:common.key,inputSha256:common.inputSha256,mode,input:retained(c,'full-prestage-input.json').ref,automaticReplayPermitted:false});}
  const value=await call(reserved?observe:mode,b,files);if(value.state!=='completed')return value;
  const actual=value.output.remoteResult===undefined?value.output:unwrapFullPrestage(value.output);
  try{verify(actual);}catch(error){return{state:'uncertain',reason:'original-full-prestage-child-not-proved',output:{mode,actual:save(c,storeReceipt,name+'-unsettled-'+sha256(encoded(actual))+'.json',actual),reason:String(error.message)}};}
  save(c,storeReceipt,name+'-result.json',actual);return{state:'completed',output:actual};
 };
 const preparation=await effect('prepare-input','transfer-observe',v=>verifyPrepared(v,b));if(preparation.state!=='completed')return preparation;
 for(const [mode,name]of [['upload-bundle','bundle.json'],['upload-dependencies','app-dependencies.tgz'],...(b.RUNTIME?[['upload-runtime','runtime.tgz']]:[])]){
  const transferred=await effect(mode,'transfer-observe',v=>{
   if(v.readOnly===true){verifyPrepared(v,b);need(v.preparedReceiptSha256===preparation.output.preparedReceiptSha256&&v.transfers?.[name]?.complete===true&&v.transfers[name].bytes===b.SPECS[name][0]&&v.transfers[name].sha256===b.SPECS[name][1],'full-prestage-original-upload-not-complete');}
   else need(v.transferred===true&&v.name===name&&v.bytes===b.SPECS[name][0]&&v.sha256===b.SPECS[name][1]&&v.incoming===b.INCOMING&&v.authenticatedSourcePreserved===true,'full-prestage-upload-result-changed');
  });if(transferred.state!=='completed')return transferred;
 }
 const staged=await effect('stage','observe',v=>verifyFullPrestageResult(v,b,preparation.output));if(staged.state!=='completed')return staged;
 const value={format:1,kind:'nova-delivery-full-protected-assets',operationId:common.operationId,key:common.key,inputSha256:common.inputSha256,
  input:retained(c,'full-prestage-input.json').ref,prepared:preparation.output,stage:staged.output,applicationActivated:false,installDispatched:false};
 return{state:'completed',output:value,receipt:save(c,storeReceipt,'full-prestage-result.json',value)};
}
