/** Synthetic retained publication fixtures; no host evidence or external effects. */
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {ReleaseJournal,validateJournalDirectory} from '../scripts/release-coordinate.mjs';
import {sha256} from '../scripts/release-plan.mjs';
import {deliveryAdapterIdentity,deliveryAdapterSourceFiles} from '../scripts/release-delivery-adapters.mjs';
import {browserBinding} from '../scripts/release-delivery-browser.mjs';
import {PUBLICATION_PACKAGE_SUBSTEPS,PUBLICATION_CONTINUATION_PREREQUISITES,publicationContinuationSnapshot} from '../scripts/release-delivery-continuation.mjs';
import {fullHostIdentity} from '../scripts/release-delivery-full-host.mjs';
import {fullHostFixture} from './full-host-fixture.mjs';
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const app=fileURLToPath(new URL('..',import.meta.url)),source=readFileSync(new URL('../scripts/release-coordinate.mjs',import.meta.url),'utf8');
const baseSchema=source.match(/this\.db\.exec\(`(PRAGMA journal_mode=WAL;[\s\S]+?PRAGMA user_version=1; COMMIT;)`\);/)[1].replace('${APPLICATION_ID}',String(0x4e56524c));
function fixture(t,{browserTimeoutMs=300000,durationMs=60000,targetFactory=null,fileJournal=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'nova-continuation-')),journal=fileJournal?new ReleaseJournal(join(dir,'journal-b1111111-1111-4111-8111-111111111111'),{create:true}):Object.create(ReleaseJournal.prototype);if(!fileJournal){journal.db=new DatabaseSync(':memory:');journal.readOnly=false;journal.directory=join(dir,'journal-b1111111-1111-4111-8111-111111111111');mkdirSync(journal.directory);journal.db.exec(baseSchema);}
 t.after(()=>{journal.close();rmSync(dir,{recursive:true,force:true});});
 const save=(name,value)=>{const path=join(dir,name);mkdirSync(dirname(path),{recursive:true});const raw=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)+'\n');writeFileSync(path,raw,{mode:0o600});return {path,sha256:sha256(raw)};};
 const host=fullHostFixture(),now=1700000000000,id='b1111111-1111-4111-8111-111111111111',oldRoot=join(dir,'original-private/edition3'),node=save('node.bin',Buffer.from('synthetic executable'));
 host.facts.review.leaseId=fullHostIdentity(id,'lease');
 const oldEntry=save('original-private/edition3/scripts/release-deliver.mjs',Buffer.from('// synthetic original entry'));
 const oldAdapter=save('original-private/edition3/scripts/release-delivery-adapters.mjs',Buffer.from('// synthetic original adapter'));
 const oldRows=[{name:'release-delivery-adapters.mjs',sha256:oldAdapter.sha256},{name:'release-deliver.mjs',sha256:oldEntry.sha256}];
 const original={id:randomUUID(),step:'total',issuedAtMs:now,remainingMs:[1000,2000],confidence:'low',basis:'Synthetic original estimate.',reason:'Original estimate.',nextCheckpointAtMs:now+300000};
 const operation={...host.descriptor.operation,id,stage:'draft',candidateId:null,publicCandidateId:null,version:'8.1.0',buildVersion:'1.0.801',sourceCommits:{private:'a'.repeat(40),public:'b'.repeat(40)},bundleSha256:null,trustedPublicKeySha256:sha256('key'),helperHashes:null};
 const d={format:1,operation,sources:{private:{root:join(dir,'original-private'),repository:'HatimTheDream/Nova-Dream',commit:'a'.repeat(40),baseCommit:'c'.repeat(40),branch:'main'},public:{root:join(dir,'original-public'),repository:'HatimTheDream/Nova-Dream-Public',commit:'b'.repeat(40),baseCommit:'d'.repeat(40),branch:'main'}},
  target:save('target.json',{artifactTools:{node},full:{host:host.options},transport:{synthetic:true},bases:{private:{candidateId:operation.priorCandidateId,manifest:save('base-manifest.json',{version:'8.0.0',buildVersion:'1.0.800'})}},browserCapability:'available',browserTools:{format:1,mode:'remote',node,executable:node,playwright:node,baseUrl:'http://127.0.0.1:4383',timeoutMs:browserTimeoutMs,suite:'tasks-search-escape',user:'nova',directoryRoot:'/opt/browser-tests'}}),targetIdentity:sha256('target'),adapterIdentity:sha256(canonical(oldRows)),timeline:{startedAtMs:now,original,revisions:[],reviews:[],lastCheckpointAtMs:now},observationBudgetMs:60000};
 if(targetFactory){const old=JSON.parse(readFileSync(d.target.path));d.target=save('target.json',targetFactory({old,save,dir,node,host,operation}));}
 journal.initializeDelivery(d,now);
 for(const phase of PUBLICATION_CONTINUATION_PREREQUISITES){const {intent}=journal.reserveDeliveryPhase(id,phase,{phase},now+1);if(phase==='package')for(const child of PUBLICATION_PACKAGE_SUBSTEPS){const s=journal.reserveDeliveryPhase(id,child,{parentKey:intent.key,parentInputSha256:intent.inputSha256},now+1).intent;journal.recordDeliveryObservation(id,child,{key:s.key,state:'completed',reason:'synthetic-verified',externalId:s.key,receipt:null,output:{synthetic:true}},now+1);}
 journal.recordDeliveryObservation(id,phase,{key:intent.key,state:'completed',reason:'synthetic-verified',externalId:null,receipt:null,output:phase==='route'?{route:'full',targetCandidateId:sha256('candidate')}:phase==='sign'?{candidateId:sha256('candidate'),priorCandidateId:operation.priorCandidateId}:{phase}},now+1);}
 const reserved=journal.reserveDeliveryPhase(id,'publication',{phase:'publication',candidateCommit:d.sources.private.commit},now+2);
 journal.recordDeliveryObservation(id,'publication',{key:reserved.intent.key,state:'gap',reason:'browser-original-response-unavailable',externalId:null,receipt:null,output:null},now+3);
 const at=now+120000,originalRequest=save('storage-operations/release-b1111111-1111-4111-8111-111111111111/request.json',{format:1,operationId:id,node,deliveryEntry:oldEntry,independentSourceReview:save('fixture-original-storage-review.json',{synthetic:true}),releaseInput:save('original-start.json',{operationId:id,outputRoot:dir,sourceCommits:operation.sourceCommits,timeline:d.timeline,observationBudgetMs:d.observationBudgetMs,profile:save('original-profile.json',{target:d.target,sources:d.sources})}),storageBudget:save('budget.json',{reserveBytes:1000,allocations:[{id:'candidate',bytes:100}]})});
 const oldRequest=JSON.parse(readFileSync(originalRequest.path));
 const process=(pid,parentPid)=>({pid,parentPid,created:'/Date('+now+')/',executable:node.path,commandLineSha256:sha256('process'+pid)});
 const launcher=save('storage-operations/release-b1111111-1111-4111-8111-111111111111/waiting.json',{format:1,kind:'verified-waiting-release-launcher',dispatchAuthority:false,operationId:id,mode:'resume',cwd:oldRoot,node,entry:oldEntry,start:oldRequest.releaseInput,budget:oldRequest.storageBudget,runner:save('runner.bin',Buffer.from('synthetic runner')),config:save('config.json',{}),owner:process(100,1),worker:process(101,100)});
 const o='storage-operations/release-b1111111-1111-4111-8111-111111111111/observations/observation-0001/';
 const attempt={launcher,intent:save(o+'intent.json',{request:originalRequest,sameReleaseOperation:true,argv:[node.path,oldEntry.path,'resume',journal.directory,id]}),exit:save(o+'exit.json',{finishedAtMilliseconds:at-1,returnCode:2}),
  childResult:save(o+'default-child-result.json',{automaticNewOperationPermitted:false,logBoundExceeded:false,originalChildClosed:true,returnCode:2}),stdout:save(o+'stdout.json',{...journal.deliveryStatus(id,at)})};
 const operatorSources={private:{root:basename(app)==='edition3'?dirname(app):join(dir,'current-private'),repository:'HatimTheDream/Nova-Dream',branch:'operator/publication-continuation-r1',commit:'e'.repeat(40)},public:{root:basename(app)==='edition3'?join(dir,'current-public'):app,repository:'HatimTheDream/Nova-Dream-Public',branch:'operator/publication-continuation-r1',commit:'f'.repeat(40)}};
 // The authority always references the private operator entry, including in the standalone public layout.
 if(basename(app)!=='edition3')save('current-private/edition3/scripts/release-deliver.mjs',readFileSync(new URL('../scripts/release-deliver.mjs',import.meta.url)));
 const request={format:1,kind:'nova-expired-publication-request',operationId:id,historical:{root:oldRoot,manifest:save('original-graph.json',{format:1,adapterIdentity:d.adapterIdentity,sourceFiles:[oldAdapter,oldEntry]})},owner:{request:originalRequest,attempts:[attempt]},operatorSources,ciRuns:{private:10,public:20},durationMs,publication:{key:reserved.intent.key,inputSha256:reserved.intent.inputSha256,observationSha256:sha256(canonical(journal.deliveryPhase(id,'publication').current))},browser:{predecessor:save('browser-original.json',{synthetic:true}),status:save('browser-closed.json',{synthetic:true}),successorSessionId:randomUUID()}};

 const target=JSON.parse(readFileSync(d.target.path)),binding=browserBinding({descriptor:d,prior:{route:journal.deliveryPhase(id,'route').current.output,sign:journal.deliveryPhase(id,'sign').current.output}},target.browserTools,target.transport);
 if(fileJournal)validateJournalDirectory(join(journal.directory,'browser-session'),{create:true});
 request.browser.predecessor=save('journal-b1111111-1111-4111-8111-111111111111/browser-session/original.json',{binding,startedAtMs:now-browserTimeoutMs,deadlineAtMs:now});
 request.browser.status=save('browser-closed.json',{state:'observed',operationId:id,originalSha256:request.browser.predecessor.sha256,observedAtMs:now+1000,files:{failed:{operationId:id,reason:'browser-original-deadline-exhausted',atMs:now+1},closed:{operationId:id,browserClosed:true,tunnelClosed:true,atMs:now+2},acceptance:null},unitState:'ActiveState=inactive\nMainPID=0\n',ownedPids:[]});
 return {dir,journal,id,now,at,d,save,request,attempt,host,operation};
}
const snapshot=f=>publicationContinuationSnapshot(f.journal,f.id,f.at,{request:f.request,assertAbsent:()=>{}});
function admission(f,override=null){
 const s=snapshot(f),operator=override??{adapterIdentity:sha256('operator'),sources:f.request.operatorSources,sourceFiles:[{name:'synthetic',sha256:sha256('source')}],ci:{private:f.save('ci-private.json',{}),public:f.save('ci-public.json',{})}};
 const requestRef=f.save('planned-request.json',f.request),plan=f.save('plan.json',{format:1,kind:'nova-publication-continuation-plan',operationId:f.id,request:requestRef,snapshot:s,operator,hostFacts:f.save('synthetic-plan-host.json',{}),prestagePlan:f.save('prestage-plan.json',{synthetic:true}),plannedAtMs:f.at,readOnly:true,hostEffects:false,journalWrites:false});
 const review=f.save('review.json',{format:1,kind:'nova-publication-continuation-plan-review',plan,operatorAdapterIdentity:operator.adapterIdentity,status:'passed',independentReview:true});
 const intent=f.save('grant-intent.json',{format:1,kind:'nova-publication-continuation-grant-intent',operationId:f.id,action:f.request.browserWindowRecovery?'grant-original-publication-browser-window-recovery':f.request.successor?'grant-original-publication-storage-successor':'grant-original-publication-continuation',request:requestRef,plan,review,notBeforeMs:f.at,notAfterMs:f.at+300000,automaticRenewal:false});
 return {request:{...f.request,admission:{plan,review,intent}},operator,snapshot:s};
}
function grantFixture(f){
 const {host,operation,at,save}=f,operatorSources=f.request.operatorSources;
 const ci=s=>({requestedAttempt:1,run:{id:10,run_attempt:1,repository:{full_name:s.repository},head_sha:s.commit,head_branch:s.branch,event:'push',path:'.github/workflows/operator-continuation-quality.yml',name:'Operator continuation quality',status:'completed',conclusion:'success'},jobs:{total_count:1,jobs:[{id:11,run_id:10,run_attempt:1,head_sha:s.commit,name:'quality',status:'completed',conclusion:'success',steps:['Run npm run quality','Verify Linux update recovery'].map(name=>({name,status:'completed',conclusion:'success'}))}]}});
 host.facts.observedAtMilliseconds=at;
 const hostSpec={format:2,sourceCommit:'a'.repeat(40),helperDirectory:host.options.helperDirectory,helperHashes:host.facts.review.helperHashes,hostConfiguration:host.options.hostConfiguration.path,hostConfigurationSha256:host.options.hostConfiguration.sha256,startupGuardFile:null,workspaceEpoch:operation.workspaceEpoch,leaseId:host.facts.review.leaseId,acceptedInstallation:host.options.acceptedInstallation,base:host.facts.base};
 const bytes=Buffer.from(JSON.stringify(host.facts)),hostRef=save('host.json',{spec:hostSpec,facts:host.facts,stdoutRawBase64:bytes.toString('base64'),stdoutSha256:sha256(bytes),hostWrites:false});

 const operator={adapterIdentity:deliveryAdapterIdentity(),sources:operatorSources,sourceFiles:deliveryAdapterSourceFiles().map(name=>({name,sha256:sha256(readFileSync(new URL('../scripts/'+name,import.meta.url)))})),ci:{private:save('ci-private.json',ci(operatorSources.private)),public:save('ci-public.json',{...ci(operatorSources.public),run:{...ci(operatorSources.public).run,id:20},jobs:{total_count:1,jobs:[{...ci(operatorSources.public).jobs.jobs[0],run_id:20}]}})}};
 const a=admission(f,operator),proof={format:1,kind:'nova-expired-publication-continuation',operationId:f.id,...a.snapshot,request:save('grant-request.json',a.request),admission:a.request.admission,prestageVerification:save('prestage-reverification.json',{synthetic:true}),operator,hostFacts:hostRef,issuedAtMs:at,expiresAtMs:at+f.request.durationMs,automaticRenewal:false,originalHistoryPreserved:true};
 return {proof,grant:()=>f.journal.recordOperatorContinuation(f.id,proof,at,{assertAbsent:()=>{}})};
}
function completedStorageFixture(f,previous){
 const save=f.save,parentId='a1111111-1111-4111-8111-111111111111',childId='5656c24f-0cc8-5606-a624-11a1351738bc',generationId='10145439-e729-52d7-a6d1-6720cefe84b1';
 const prefix='storage-operations/release-b1111111-1111-4111-8111-111111111111/continuations/'+previous.sha256+'/admission-0002/before-delivery',directory=join(f.dir,prefix),batchDirectory=join(directory,'batch-001');mkdirSync(batchDirectory,{recursive:true});
 const original=JSON.parse(readFileSync(f.request.owner.request.path)),deadline=new Date(previous.proof.expiresAtMs).toISOString(),configuration=save('storage-config.json',{synthetic:true});
 const parent={format:1,operationId:parentId,phase:'before-allocation',originalDeadline:deadline,profile:JSON.parse(readFileSync(original.releaseInput.path)).profile,budget:original.storageBudget,configuration};
 const originalInput=save(prefix+'/input.json',parent),batchInput=save(prefix+'/batch-001-input.json',{...parent,operationId:childId});
 const observer=save('observer.py',Buffer.from('# synthetic readonly observer')),launcher=JSON.parse(readFileSync(f.attempt.launcher.path));
 const observerInput=save('observer-input.json',{originalRoots:{owner:launcher.owner,worker:launcher.worker}});
 const closure=save('locked-owner.json',{kind:'exact-original-caller-closure-observation',status:'passed',closed:true,readOnly:true,releaseAdmission:false,releaseOperationId:f.id,stopOrKillCalls:0,remoteHostCalls:0,censusPasses:2,
  snapshots:[0,1].map(()=>({closed:true,descendantCandidates:[],identityConflicts:[],taskProcessConflicts:[]})),source:observer,input:observerInput,waitingLauncher:f.attempt.launcher,sources:{caller:observer}});
 const fixed={releaseOperationId:f.id,grantSha256:previous.sha256,journalDirectory:f.journal.directory,storageInput:originalInput,batchInput,request:f.request.owner.request,configuration,directory,batchDirectory,generationOperationId:generationId,originalDeadline:deadline,ownerObserver:observer,ownerObserverInput:observerInput};
 const planSource=save('storage-adapter.py',Buffer.from('# synthetic qualified single batch adapter'));
 const plan=save('storage-recovery-plan.json',{source:planSource,kind:'original-storage-recovery-plan',releaseOperationId:f.id,maximumBatches:1,releaseDispatchPermitted:false,automaticRetry:false,fixedContext:save('fixed-storage.json',fixed),originalInput,batchInput,originalRequest:f.request.owner.request,configuration,directory,batchDirectory,storageOperationId:parentId,generationOperationId:generationId,originalDeadline:deadline});
 const planReview=save('storage-plan-review.json',{status:'passed',independentReview:true,plan,source:planSource}),intent=save('storage-intent.json',{plan,review:planReview,automaticRetry:false});
 const inventory=save(prefix+'/batch-001/inventory.json',{readOnly:true,observedAtMilliseconds:previous.proof.expiresAtMs,sourceEvidence:{profile:parent.profile,configuration}});
 const finalPreflight=save(prefix+'/batch-001/after-cleanup.json',{format:1,kind:'private-storage-preflight',state:'ready',phase:'before-allocation',originalDeadline:deadline,inventory,
  assessment:{format:1,kind:'storage-lifecycle-budget-result',phase:'before-allocation',fits:true,allocationBudgetAdmissionOnly:true,releaseAdmission:false,stoppedAndPostStartChecksStillRequired:true,observationExpiresAtMilliseconds:previous.proof.expiresAtMs+120000,
  filesystems:[{availableBytes:1000,requiredFreeBytes:100,deficitBytes:0,allocations:[{id:'candidate',bytes:100}]}]}});
 const cleanup=save(prefix+'/batch-001/cleanup-closed.json',{cleanupComplete:true,protectedRolesVerified:true,originalWorkerClosed:true,originalDeadline:deadline,observedFreeIncreaseBytes:100});
 const storage={format:1,kind:'private-storage-maintenance-result',state:'ready',operationId:childId,originalDeadline:deadline,cleanupPerformed:true,protectedRolesVerified:true,releaseAdmission:false,reclaimedBytes:100,cleanup,finalPreflight,observationExpiresAtMilliseconds:previous.proof.expiresAtMs+120000};
 storage.result=save(prefix+'/batch-001/complete.json',{...storage});
 const result=save('storage-recovery-result.json',{format:1,kind:'original-storage-recovery-result',recordedAt:new Date(previous.proof.expiresAtMs+1).toISOString(),state:'ready',storage,plan,review:planReview,intent,releaseDispatched:false,deploymentLockReleased:true,originalDeadline:deadline});
 const review=save('storage-outcome-review.json',{kind:'independent-original-storage-recovery-outcome-review',status:'passed',independentReview:true,recoveryResult:result,nativeCompletion:storage.result,batchInput,lockedOwnerClosure:closure,originalDeadline:deadline,releaseDispatched:false,noSuccessorBatch:true,completedOriginalStorageVerified:true,noReleaseAdmission:true,originalBatchOnly:true});
 return {marker:{result,review},directory,batchDirectory,storage,plan,review,result};
}
function successorFixture(t,options){
 const f=fixture(t,options),original=grantFixture(f),previous=original.grant(),storage=completedStorageFixture(f,previous),save=f.save;
 const request={...f.request,operatorSources:Object.fromEntries(Object.entries(f.request.operatorSources).map(([k,v])=>[k,{...v,branch:'operator/publication-storage-successor-r1'}])),
  successor:{predecessorGrantSha256:previous.sha256,completedOriginalStorage:storage.marker,reason:'Original reserved storage completed after the first finite window.'}};
 const next={...f,request,at:previous.proof.expiresAtMs+1,save:(name,value)=>save('successor/'+name,value)},g=grantFixture(next);
 return {f,next,original,previous,storage,proof:g.proof,grant:()=>f.journal.recordPublicationStorageSuccessor(f.id,g.proof,next.at,{assertAbsent:()=>{}})};
}

export {fixture, snapshot, admission, grantFixture, completedStorageFixture, successorFixture};
