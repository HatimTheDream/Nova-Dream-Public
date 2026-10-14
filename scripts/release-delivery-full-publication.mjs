/** Fixed full-release asset/feed children. Each uncertain child is observed,
 * never replayed. The original delivery retains its deadlines and identity. */
import { readFileSync,existsSync } from 'node:fs';
import { join,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { readEvidenceFile,readReleaseInputFile,sha256 } from './release-plan.mjs';
import { verifyFullPremaintenance,verifyFullCompletion,collectFullOnlineCapacity,fullHostOptionsSchema } from './release-delivery-full-host.mjs';
import { buildFullCoordinatorDescriptor } from './release-delivery-install.mjs';
import { validateJournalDirectory } from './release-coordinate.mjs';
import {verifyRuntimeArtifact,runtimeTransition} from './release-runtime-artifact.mjs';
import { advanceFullPrestage,verifyFullProtectedAssets } from './release-delivery-full-prestage.mjs';

const need=(v,r)=>{if(!v)throw Error(r);};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const encoded=v=>Buffer.from(canonical(v)+'\n');
const helperNames=['release-delivery-full-publication.py','release-full-publication-primitives.py','release-full-feed-publication.py','release-frontend-github-primitives.py','release-delivery-ci.py','release-ci-primitives.py'];
const rolesFor=signed=>['app','bundle','dependencies','manifest',...(signed.runtime?['runtime']:[])];
const suffix={app:'app.tgz',bundle:'operator-bundle.json',dependencies:'app-dependencies.tgz',manifest:'stable.json',runtime:'runtime.tgz'};
export const fullPublicationHelpers=()=>Object.fromEntries(helperNames.map(n=>[n,sha256(readFileSync(new URL(n,import.meta.url)))]));
const output=(state,reason,c,value=null,receipt=null)=>({state,reason,externalId:c.descriptor.operation.id,output:value,receipt});
// This existing arbitration authority belongs to the configured target. Keep
// it across sibling operations; a new empty directory cannot reconcile history.
export function fullPublicationLedgerDirectory(path){
 const checked=validateJournalDirectory(path,{create:false});
 need(checked===path,'full-publication-ledger-canonical-path-required');return checked;
}
const save=(c,store,n,v)=>store(c.journal,c.intent.key,n,encoded(v));
function retained(c,n){const path=join(c.journal.directory,'delivery-evidence',c.intent.key+'-'+n);if(!existsSync(path))return null;const raw=readReleaseInputFile(path);return{value:JSON.parse(raw),ref:{path,sha256:sha256(raw)}};}

export function fullPublicationInput({descriptor,prior,tools,releaseIds,options}){
 need(prior.route?.route==='full'&&prior.sign?.route==='full'&&prior.recovery?.kind==='nova-delivery-full-rehearsal','full-rehearsal-before-publication-required');
 fullHostOptionsSchema.parse(options.host);need(options.signing.previousFeed!=='initial','existing-full-feed-predecessor-required');
 need(same(prior.sign.bundle,prior.package.bundle)&&same(prior.sign.dependencies,prior.package.dependencies),'full-published-package-changed');
 need(same(prior.sign.runtime??null,prior.package.runtime??null),'full-published-runtime-changed');
 return{format:1,operationId:descriptor.operation.id,version:descriptor.operation.version,buildVersion:descriptor.operation.buildVersion,
  sourceCommits:Object.fromEntries(['private','public'].map(s=>[s,descriptor.sources[s].commit])),priorCandidateId:descriptor.operation.priorCandidateId,
  trustedPublicKeySha256:descriptor.operation.trustedPublicKeySha256,signed:prior.sign,
  applicationArchive:prior.artifacts.repositories.private.archive,tools,releaseIds,helperHashes:fullPublicationHelpers(),
  sources:descriptor.sources,previousFeed:options.signing.previousFeed,capacity:prior.capacity,recovery:prior.recovery,host:options.host,
  ledgerDirectory:fullPublicationLedgerDirectory(options.publicationLedgerDirectory)};
}
export function verifyFullPublicationInput(input,descriptor,now=Date.now()){
 need(input.operationId===descriptor.operation.id&&input.version===descriptor.operation.version&&input.buildVersion===descriptor.operation.buildVersion
  &&input.priorCandidateId===descriptor.operation.priorCandidateId&&input.trustedPublicKeySha256===descriptor.operation.trustedPublicKeySha256
  &&same(input.sources,descriptor.sources)&&same(input.sourceCommits,descriptor.operation.sourceCommits),'full-publication-operation-changed');
 need(same(input.helperHashes,fullPublicationHelpers()),'full-publication-helper-changed');
 fullPublicationLedgerDirectory(input.ledgerDirectory);
 for(const side of ['private','public'])need(input.sourceCommits[side]===descriptor.sources[side].commit&&Number.isSafeInteger(input.releaseIds[side])&&input.releaseIds[side]>0,'full-publication-source-release-changed');
 for(const name of ['node','python','git'])readEvidenceFile(input.tools[name],{maximum:128*1024**2});
 readEvidenceFile(input.previousFeed,{maximum:256*1024});verifyFullPremaintenance(input,descriptor,now);verifyFullCompletion(input.recovery.completion,input.recovery.values);
 const refs={app:input.applicationArchive,bundle:input.signed.bundle,dependencies:input.signed.dependencies.archive,manifest:input.signed.signedFeed};
 if(input.signed.runtime){
  need(descriptor.operation.priorAgentVersion==='2026.9.6'&&descriptor.operation.agentVersion==='2026.9.8','full-runtime-publication-transition-changed');
  runtimeTransition(input.signed.runtime,input.signed.release);refs.runtime=input.signed.runtime.archive;
 }else need(!input.signed.release?.runtimeBundle,'full-runtime-publication-unbound');
 return rolesFor(input.signed).map(role=>({role,name:'nova-'+input.version+'-'+suffix[role],...refs[role],bytes:role==='runtime'?input.signed.runtime.description.archiveBytes:readEvidenceFile(refs[role],{maximum:128*1024**2}).length}));
}
export function verifyFullPublishedAsset(value,spec,c){
 need(value?.operationId===c.descriptor.operation.id&&value.key===c.intent.key&&value.inputSha256===c.intent.inputSha256&&value.role===spec.role
  &&value.asset?.name===spec.name&&value.asset.bytes===spec.bytes&&value.asset.sha256===spec.sha256&&value.asset.authenticatedDownloadVerified===true
  &&Number.isSafeInteger(value.asset.id)&&value.asset.id>0,'full-published-asset-changed');
 const local=relative(join(c.journal.directory,'full-publication-'+c.intent.key+'-'+spec.role),value.asset.localPath).replaceAll('\\','/');
 need(new RegExp('^(first|observe-[a-f0-9-]{36})/0-readback/'+spec.name.replaceAll('.','\\.')+'$').test(local),'full-asset-readback-path-changed');
 const ref={path:value.asset.localPath,sha256:spec.sha256};
 if(spec.role==='runtime')verifyRuntimeArtifact(ref,spec.bytes);else readEvidenceFile(ref,{maximum:128*1024**2});
}
/** The final coordinator accepts exactly this paired publication receipt. */
export function pairedFullPublicationReceipt(input,repositories,readback){
 need(repositories.length===2&&readback.publicFeedReadVerified===true&&readback.publicFeedSha256===input.signed.signedFeed.sha256&&readback.sequence===input.signed.sequence,'full-public-feed-readback-required');
 for(const [i,side]of ['private','public'].entries()){
  const r=repositories[i],name='Nova-Dream'+(side==='public'?'-Public':'');
  need(r.repository===name&&r.sourceCommit===input.sourceCommits[side]&&r.feedParentCommit===input.sourceCommits[side]
   &&/^[a-f0-9]{40}$/.test(r.feedCommit)&&r.feedCommit!==r.feedParentCommit&&r.pushed===true&&r.unrelatedIndexPreserved===true
   &&r.changedOnly===(side==='private'?'edition3/updates/stable.json':'updates/stable.json')
   &&r.feedSha256===input.signed.signedFeed.sha256&&r.sequence===input.signed.sequence,'full-paired-feed-publication-changed');
 }
 return{format:1,repositories,publicFeedReadVerified:true,publicFeedSha256:readback.publicFeedSha256,sequence:readback.sequence,applicationInstalled:false};
}
export function createFullPublicationAdapter({tools,releaseIds,options,transport,base,command,storeReceipt,run,clock=Date.now}){
 const expected=c=>fullPublicationInput({...c,tools,releaseIds,options});
 const validate=c=>{need(same(c.input,expected(c)),'full-publication-input-changed');return verifyFullPublicationInput(c.input,c.descriptor,clock());};
 const python=async(c,name,mode,request,requestName)=>{
  const ref=save(c,storeReceipt,requestName,request);readEvidenceFile(tools.python,{maximum:128*1024**2});
  need(same(request.helperHashes,fullPublicationHelpers()),'full-publication-execution-helper-changed');
  need(request.ledgerDirectory===options.publicationLedgerDirectory,'full-publication-ledger-authority-changed');fullPublicationLedgerDirectory(request.ledgerDirectory);
  let response;try{response=JSON.parse(await command(tools.python.path,['-B',fileURLToPath(new URL(name,import.meta.url)),mode,'--request',ref.path,'--request-sha256',ref.sha256],{maximum:1024**2,timeoutMs:600000,acceptJsonFailure:true,gitExecPath:tools.gitExecPath}));}
  catch(error){const diagnostic={name:String(error.name),message:String(error.message).slice(0,1000),request:ref,originalOutcomeUncertain:true};return output('uncertain','full-original-publication-response-unavailable',c,{diagnostic:save(c,storeReceipt,'full-publication-diagnostic-'+sha256(encoded(diagnostic))+'.json',diagnostic)});}
  need(['completed','uncertain','failed'].includes(response?.state),'full-publication-child-response-invalid');return response;
 };
 const fresh=async c=>{need(typeof c.beforeNewEffect==='function','full-publication-fresh-prerequisites-required');await c.beforeNewEffect();verifyFullPublicationInput(c.intent.input,c.descriptor,clock());};
 const advance=async c=>{
  const input=c.intent.input,specs=verifyFullPublicationInput(input,c.descriptor,clock()),done=retained(c,'full-publication.json');
  if(done){const value=output('completed','full-paired-publication-completed',c,done.value,done.ref);await verifyResult(value,c,specs);return value;}
  const common=Object.fromEntries(['format','operationId','version','buildVersion','sourceCommits','priorCandidateId','trustedPublicKeySha256','signed','applicationArchive','tools','releaseIds','helperHashes'].map(n=>[n,input[n]]));
  Object.assign(common,{key:c.intent.key,inputSha256:c.intent.inputSha256,ledgerDirectory:input.ledgerDirectory});
  let assetsRecord=retained(c,'full-assets.json');
  if(!assetsRecord){
   const assets=[];
   for(const spec of specs){
    const outputDirectory=join(c.journal.directory,'full-publication-'+c.intent.key+'-'+spec.role),mode=existsSync(join(outputDirectory,'dispatch.json'))?'observe':'execute';
    // A durable reservation is made before Python can begin; absence of the
    // child dispatch after a lost call never authorizes a second execution.
    const dispatchName='full-asset-'+spec.role+'-dispatch.json',reserved=retained(c,dispatchName);
    const action=reserved?'observe':mode;if(!reserved){await fresh(c);save(c,storeReceipt,dispatchName,{format:1,operationId:input.operationId,key:c.intent.key,role:spec.role,outputDirectory,automaticReplayPermitted:false});}
    const value=await python(c,'release-delivery-full-publication.py',action,{...common,spec,outputDirectory},'full-asset-'+spec.role+'-request.json');
    if(value.state!=='completed')return output(value.state,value.reason,c,value.output,value.receipt);
    need(value.externalId===releaseIds.private+':'+c.intent.key,'full-asset-external-id-changed');verifyFullPublishedAsset(value.output,spec,c);assets.push(value.output);
   }
   const value={kind:'nova-delivery-full-assets',operationId:input.operationId,key:c.intent.key,inputSha256:c.intent.inputSha256,assets};assetsRecord={value,ref:save(c,storeReceipt,'full-assets.json',value)};
  }
  need(assetsRecord.value.kind==='nova-delivery-full-assets'&&assetsRecord.value.operationId===input.operationId&&assetsRecord.value.key===c.intent.key&&assetsRecord.value.inputSha256===c.intent.inputSha256&&assetsRecord.value.assets.length===specs.length,'full-original-assets-aggregate-changed');
  specs.forEach((spec,i)=>verifyFullPublishedAsset(assetsRecord.value.assets[i],spec,c));
  const staged=await advanceFullPrestage(c,{assets:assetsRecord.value.assets,transport,options:options.host,tools,command,storeReceipt,clock});
  if(staged.state!=='completed')return output(staged.state,staged.reason??'full-original-protected-staging-unsettled',c,staged.output??null,staged.receipt??null);
  const protectedStage={receipt:staged.receipt,output:staged.output};
  verifyFullProtectedAssets(protectedStage,{operationId:input.operationId,publicationKey:c.intent.key,bundle:input.signed.bundle,dependencies:input.signed.dependencies,runtime:input.signed.runtime});
  const repositories=[];
  for(const side of ['private','public']){
   let committed=null;
   for(const phase of ['commit','push']){
    const label='full-feed-'+side+'-'+phase,retainedResult=retained(c,label+'-result.json');
    if(retainedResult){committed=retainedResult.value;continue;}
    const outputDirectory=join(c.journal.directory,'full-feed-'+c.intent.key+'-'+side+'-'+phase),reserved=retained(c,label+'-dispatch.json'),action=reserved?'observe':'execute';
    if(!reserved){await fresh(c);save(c,storeReceipt,label+'-dispatch.json',{format:1,operationId:input.operationId,key:c.intent.key,side,phase,outputDirectory,automaticReplayPermitted:false});}
    const request={...common,sources:input.sources,previousFeed:input.previousFeed,assetsReceipt:assetsRecord.ref,side,phase,commit:phase==='push'?committed:null,outputDirectory};
    const value=await python(c,'release-full-feed-publication.py',action,request,label+'-request.json');
    if(value.state!=='completed')return output(value.state,value.reason,c,value.output,value.receipt);
    need(value.externalId===('Nova-Dream'+(side==='public'?'-Public':''))+':'+c.intent.key+':'+phase,'full-feed-child-identity-changed');
    need(same(JSON.parse(readEvidenceFile(value.receipt)),value.output),'full-feed-child-receipt-changed');committed=value.output;save(c,storeReceipt,label+'-result.json',committed);
   }repositories.push(committed);
  }
  const readback=await python(c,'release-full-feed-publication.py','readback',common,'full-feed-readback-request.json');
  if(readback.state!=='completed')return output(readback.state,readback.reason,c,readback.output,readback.receipt);
  const paired=pairedFullPublicationReceipt(input,repositories,readback.output),pairedReceipt=save(c,storeReceipt,'full-paired-feed-publication.json',paired);
  const capacity=await collectFullOnlineCapacity(c,{transport,options:options.host,storeReceipt,run,clock});
  if(capacity.state!=='completed')return output('uncertain','full-fresh-capacity-observation-required',c,capacity.output??{diagnostic:capacity.diagnostic});
  const evidence={receipt:pairedReceipt,feed:input.signed.signedFeed,publicKey:input.signed.publicKey};
  const coordinatorContext={...c,prior:{...c.prior,recovery:{...c.prior.recovery,evidence:capacity.recoveryEvidence}}};
  const coordinatorDescriptor=buildFullCoordinatorDescriptor(coordinatorContext,{capacityEvidence:capacity.evidence,evidence},{transport,base,storeReceipt,clock});
  const value={kind:'nova-delivery-full-publication',operationId:input.operationId,key:c.intent.key,inputSha256:c.intent.inputSha256,releaseIds,
   assets:assetsRecord.value.assets,protectedStage,evidence,capacityEvidence:capacity.evidence,recoveryEvidence:capacity.recoveryEvidence,coordinatorDescriptor,applicationInstalled:false,savedReplyAccepted:false,browserAccepted:false};
  return output('completed','full-paired-publication-completed',c,value,save(c,storeReceipt,'full-publication.json',value));
 };
 const verifyResult=async(value,c,specs)=>{
  if(value.state!=='completed')return;const o=value.output;
  need(value.externalId===c.descriptor.operation.id&&same(JSON.parse(readEvidenceFile(value.receipt)),o)&&o.kind==='nova-delivery-full-publication'
   &&o.operationId===c.descriptor.operation.id&&o.key===c.intent.key&&o.inputSha256===c.intent.inputSha256&&same(o.releaseIds,releaseIds)
   &&o.applicationInstalled===false&&o.savedReplyAccepted===false&&o.browserAccepted===false&&o.assets.length===specs.length,'full-publication-result-changed');
  specs.forEach((spec,i)=>verifyFullPublishedAsset(o.assets[i],spec,c));
  verifyFullProtectedAssets(o.protectedStage,{operationId:o.operationId,publicationKey:c.intent.key,bundle:c.intent.input.signed.bundle,dependencies:c.intent.input.signed.dependencies,runtime:c.intent.input.signed.runtime});
  const r=JSON.parse(readEvidenceFile(o.evidence.receipt));need(same(pairedFullPublicationReceipt(c.intent.input,r.repositories,r),r),'full-publication-paired-proof-changed');
  need(same(o.evidence.feed,c.intent.input.signed.signedFeed)&&same(o.evidence.publicKey,c.intent.input.signed.publicKey),'full-published-feed-ref-changed');
  readEvidenceFile(o.capacityEvidence.observation);
  // Current installation admission is re-evaluated by its original coordinator;
  // retained publication never relabels old capacity as a fresh measurement.
  need(o.coordinatorDescriptor?.input?.operation?.id===c.descriptor.operation.id&&same(o.coordinatorDescriptor.input.evidence.publication,o.evidence)
   &&same(o.coordinatorDescriptor.input.evidence.capacity,o.capacityEvidence),'full-publication-coordinator-changed');
 };
 return{input:async c=>expected(c),validate,execute:advance,observe:advance,verify:async(v,c)=>verifyResult(v,c,verifyFullPublicationInput(c.intent.input,c.descriptor,clock()))};
}
