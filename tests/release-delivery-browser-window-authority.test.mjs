import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {successorFixture,grantFixture} from '../support/release-publication-grant-fixture.mjs';
import {sha256} from '../scripts/release-plan.mjs';
import {deliveryAdapterSourceFiles,deliveryAdapterIdentity,createDeliveryRegistry} from '../scripts/release-delivery-adapters.mjs';
import {publicationContinuationSnapshot,verifyContinuationGrant,verifyContinuationStorageAuthority,reconcileExpiredPublication} from '../scripts/release-delivery-continuation.mjs';
import {configuredBrowserWindowRecoveryStorageReadiness,verifyStorageSession} from '../scripts/release-storage-default.mjs';
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const doc=r=>JSON.parse(readFileSync(r.path));
const app=fileURLToPath(new URL('..',import.meta.url));
const sourceRef=path=>({path,sha256:sha256(readFileSync(path))});
function targetFactory({old,save,dir,node}){
 const base={...old.bases.private,directory:dir};
 return {...old,format:1,transport:save('transport.json',{format:1,hostAlias:'fixture',sshConfig:node}),bases:{private:base,public:base},
 artifactTools:{git:node,node,python:node,ciNodeSha256:node.sha256,nodeToolchain:{nodeVersion:'22.23.2',platform:process.platform==='win32'?'win32':'linux',arch:'x64'}},
 full:{...old.full,bundleUrl:'https://example.invalid/bundle',dependenciesUrl:'https://example.invalid/dependencies',publicationLedgerDirectory:dir,
 feed:{channel:'stable',sequence:1,createdAt:'2023-01-01T00:00:00.000Z',expiresAt:'2030-01-01T00:00:00.000Z'},signing:{privateKeyPath:join(dir,'key'),publicKey:node,previousFeed:'initial'}}};
}
function browserBoundary(f){
 const target=doc(f.d.target),options=target.browserTools,modes=[];
 let lost=false;
 const run=async(_config,program)=>{
  const p=JSON.parse(Buffer.from(program.match(/base64\.b64decode\('([^']+)'\)/)[1],'base64').toString());modes.push(p.mode);
  if(p.mode==='start'&&lost)throw Error('synthetic-lost-launch-response');
  const original=p.original,id=f.id,digest=sha256(Buffer.from(canonical(original)+'\n'));
  const plan={format:1,kind:'nova-remote-browser-plan',operationId:id,sessionId:original.binding.sessionId,directory:options.directoryRoot+'/'+original.binding.sessionId,unit:'nova-browser-'+original.binding.sessionId,
   originalSha256:digest,node:options.node,executable:options.executable,playwrightSha256:options.playwright.sha256,memoryMaxBytes:1073741824,hostReserveBytes:2147483648};
  const response=['readiness','plan'].includes(p.mode)?{state:p.mode==='readiness'?'ready':'planned',plan,planSha256:sha256(canonical(plan)),existingOperation:false,sessionAbsent:true,hostWrites:false,memoryAdmission:{availableBytes:4*1024**3,requiredBytes:3*1024**3}}:
   {state:'observed',operationId:id,originalSha256:digest,observedAtMs:f.at,unitState:'ActiveState=active\nMainPID=123\n',ownedPids:[123],files:{heartbeat:{operationId:id,originalSha256:digest,browserAlive:true,transport:'remote-direct',atMs:f.at,pid:123},prepared:{bindingSha256:sha256(canonical(original.binding)),epoch:original.binding.epoch,document:{candidateId:original.binding.priorCandidateId},startedAtMs:f.at},failed:null,closed:null}};
  return {exitCode:0,stdout:JSON.stringify(response)};
 };
 return {run,modes,loseLaunch:()=>{lost=true;}};
}
function configFixture(f,authority){
 const roots=[join(f.request.operatorSources.private.root,'edition3'),f.request.operatorSources.public.root],graph={format:1,adapterIdentity:deliveryAdapterIdentity(),sourceFiles:deliveryAdapterSourceFiles().map(n=>sourceRef(resolve(app,'scripts',n)))};
 for(const root of roots){mkdirSync(join(root,'scripts'),{recursive:true});for(const name of ['release-deliver.mjs','release-coordinate.mjs','release-storage-default.mjs','release-delivery-adapters.mjs'])if(resolve(root)!==resolve(app))copyFileSync(join(app,'scripts',name),join(root,'scripts',name));}
 const runner=f.save('runtime/runner.py',Buffer.from('# synthetic runner')),identity=f.save('runtime/default_identity.mjs',Buffer.from('// synthetic identity'));
 const files=Object.fromEntries([...graph.sourceFiles,runner,identity,...roots.flatMap(root=>['release-deliver.mjs','release-coordinate.mjs','release-storage-default.mjs','release-delivery-adapters.mjs'].map(n=>sourceRef(join(root,'scripts',n))))].map(r=>[r.path,r.sha256]));
 const sourceReview=f.save('runtime/source-review.json',{format:1,kind:'nova-storage-default-source-review',status:'passed',independentReview:true,reviewer:'synthetic-test-only',files});
 const storageReview=f.save('runtime/storage-review.json',{format:1,kind:'independent-storage-source-review',status:'passed',independentReview:true,reviewer:'synthetic-test-only',files:{[runner.path]:runner.sha256}});
 mkdirSync(f.d.sources.public.root,{recursive:true});
 const originalConfig=f.save('runtime/original-config.json',{format:1,kind:'nova-storage-default',applicationRoots:[join(f.d.sources.private.root,'edition3'),f.d.sources.public.root],storageReview:doc(f.request.owner.request).independentSourceReview});
 const config={format:1,kind:'nova-storage-default',python:doc(f.request.owner.request).node,runner,sourceReview,storageReview,operationsRoot:join(f.dir,'storage-operations'),applicationRoots:roots,
  operatorContinuation:{operationId:f.id,journalDirectory:f.journal.directory,originalRequest:f.request.owner.request,originalConfig}};
 return {config,configRef:f.save('runtime/config.json',config),graphRef:f.save('runtime/graph.json',graph),authority};
}
function capacity(f,configRef,at,label){
 const original=doc(f.request.owner.request),input=f.save(label+'/input.json',{format:1,operationId:randomUUID(),profile:doc(original.releaseInput).profile,budget:original.storageBudget,phase:'before-allocation',configuration:configRef,originalDeadline:new Date(at+300000).toISOString()});
 const inventory=f.save(label+'/inventory.json',{readOnly:true,observedAtMilliseconds:at,sourceEvidence:{profile:doc(original.releaseInput).profile,configuration:configRef}});
 const result=f.save(label+'/result.json',{format:1,kind:'private-storage-preflight',operationId:doc(input).operationId,state:'ready',cleanupPerformed:false,phase:'before-allocation',originalDeadline:doc(input).originalDeadline,inventory,
  assessment:{format:1,kind:'storage-lifecycle-budget-result',phase:'before-allocation',fits:true,allocationBudgetAdmissionOnly:true,releaseAdmission:false,stoppedAndPostStartChecksStillRequired:true,observationExpiresAtMilliseconds:at+120000,filesystems:[{availableBytes:10000,requiredFreeBytes:1100,deficitBytes:0,allocations:doc(original.storageBudget).allocations}]}});
 return {input,result,checked:{state:'ready',historical:false,result,cleanupPerformed:false,scope:'fresh-capacity-admission-check-only',observationExpiresAtMilliseconds:at+120000}};
}
async function recoveryFixture(t,{fileJournal=false}={}){
 const x=successorFixture(t,{browserTimeoutMs:1800000,durationMs:2400000,targetFactory,fileJournal}),{f}=x,previous=x.grant();
 const authority=await verifyContinuationStorageAuthority({journal:f.journal,operationId:f.id,now:x.next.at}),cfg=configFixture(f,authority),at=x.next.at+10;
 const original=doc(f.request.owner.request),owner='storage-operations/release-'+f.id,oldCap=capacity(f,cfg.configRef,at-10,owner+'/original-capacity'),oldDispatch=f.save(owner+'/release-dispatch.json',{format:1,request:f.request.owner.request,automaticNewOperationPermitted:false,storageInput:oldCap.input,storageResult:oldCap.checked,startedAtMilliseconds:at-10}),cap=capacity(f,cfg.configRef,at,owner+'/continuations/'+previous.sha256+'/admission-0001/before-delivery');
 const dispatch=f.save(owner+'/continuations/'+previous.sha256+'/admission-0001/release-dispatch.json',{format:1,grantSha256:previous.sha256,request:f.request.owner.request,originalDispatch:oldDispatch,automaticNewOperationPermitted:false,startedAtMilliseconds:at,
  completedOriginalStorage:x.storage.marker,storageInput:cap.input,storageMaintenanceInput:cap.input,storageMaintenanceResult:cap.checked,storageResult:cap.checked});
 const session=f.save(owner+'/session-observation-0002.json',{format:1,kind:'nova-storage-default-session',mode:'resume',operationId:f.id,request:f.request.owner.request,dispatch:oldDispatch,continuationDispatch:dispatch,
  operatorContinuation:authority,issuedAtMilliseconds:at,descriptor:f.save('request-'+f.id+'/descriptor.json',f.d),sourceGraph:cfg.graphRef,adapterIdentity:authority.operatorAdapterIdentity,config:cfg.configRef,sourceReview:cfg.config.sourceReview,storageReview:cfg.config.storageReview});
 // Only synthetic owner identities reach this fixture; no system process is probed.
 t.mock.method(process,'kill',()=>{throw Object.assign(Error('synthetic-closed-owner'),{code:'ESRCH'});});
 const admitted=f.journal.recordPublicationContinuationAdmission(f.id,{format:1,kind:'nova-publication-continuation-storage-admission',operationId:f.id,grantSha256:previous.sha256,dispatch,session,verifiedAtMs:at},at);
 const launch=doc(f.attempt.launcher),launcher=f.save(owner+'/successor-waiting.json',{...launch,cwd:join(previous.proof.operator.sources.private.root,'edition3'),entry:authority.operatorEntry,config:cfg.configRef,runner:cfg.config.runner});
 const prefix=owner+'/observations/observation-0002/',attempt={launcher,intent:f.save(prefix+'intent.json',{request:f.request.owner.request,sameReleaseOperation:true,argv:[original.node.path,authority.operatorEntry.path,'resume',f.journal.directory,f.id]}),
  exit:f.save(prefix+'exit.json',{returnCode:1,finishedAtMilliseconds:at+1}),childResult:f.save(prefix+'default-child-result.json',{originalChildClosed:true,returnCode:1,logBoundExceeded:false,automaticNewOperationPermitted:false}),
  stdout:f.save(prefix+'stdout.json',{kind:'nova-release-delivery-error',reason:'synthetic-readonly-startup-observation-failure',automaticReplayPermitted:false})};
 const request={...f.request,owner:{...f.request.owner,attempts:[...f.request.owner.attempts,attempt]},durationMs:2400000,operatorSources:Object.fromEntries(Object.entries(f.request.operatorSources).map(([side,s])=>[side,{...s,branch:'operator/browser-window-recovery-r1'}])),
  browserWindowRecovery:{predecessorGrantSha256:previous.sha256,storageAdmission:{eventId:admitted.eventId,sha256:admitted.sha256,session,dispatch},reason:'Explicit recovery of closed pre-browser startup observation.'}};
 const save=(name,value)=>f.save('recovery/'+name,value),next={...f,at:previous.proof.expiresAtMs+1,request,save},g=grantFixture(next),currentRequest=doc(g.proof.request),boundary=browserBoundary(next),registry=createDeliveryRegistry({clock:()=>next.at,run:boundary.run});
 const context={journal:f.journal,descriptor:f.d,prior:Object.fromEntries(g.proof.prerequisites.map(p=>[p.phase,f.journal.deliveryPhase(f.id,p.phase).current.output])),intent:f.journal.deliveryPhase(f.id,'publication'),request:currentRequest};context.input=context.intent.input;
 g.proof.browserWindowReadiness=await registry.browserWindowRecoveryReadiness(context);
 const fresh=capacity(f,cfg.configRef,next.at,'recovery/fresh-capacity');
 g.proof.storageWindowReadiness=save('storage-readiness.json',{format:1,kind:'nova-browser-window-recovery-storage-readiness',operationId:f.id,reconciliationRequest:g.proof.request,config:cfg.configRef,
  sourceReview:cfg.config.sourceReview,storageReview:cfg.config.storageReview,entry:authority.operatorEntry,runner:cfg.config.runner,sourceGraph:cfg.graphRef,predecessor:request.browserWindowRecovery,capacity:{input:fresh.input,result:fresh.result},observedAtMs:next.at,expiresAtMs:next.at+120000,readOnly:true,storageAdmissionCreated:false});
 g.proof.browserReservation={sessionId:request.browser.successorSessionId,startedAtMs:next.at,deadlineAtMs:next.at+1800000};
 const reconciliationSession=f.save(owner+'/reconciliations/reconciliation-0001/session.json',{format:1,kind:'nova-storage-publication-reconciliation-session',operationId:f.id,config:cfg.configRef,request:f.request.owner.request,reconciliationRequest:g.proof.request,
 sourceReview:cfg.config.sourceReview,storageReview:cfg.config.storageReview,sourceGraph:cfg.graphRef,browserWindowRecoveryReadiness:g.proof.storageWindowReadiness});
 return {...x,next,previous,admitted,cfg,g,context,registry,boundary,reconciliationSession,grant:()=>f.journal.recordBrowserWindowRecovery(f.id,g.proof,next.at,{assertAbsent:()=>{}})};
}

test('expired admitted predecessor grants one atomic browser reservation and configured preparation reconnects after lost launch response',async t=>{
 const x=await recoveryFixture(t,{fileJournal:true}),{f,g,next}=x,oldRows=f.journal.db.prepare('SELECT * FROM delivery_events ORDER BY id').all(),oldOriginal=f.journal.deliveryOriginalOperatorContinuation(f.id);
 const readiness=configuredBrowserWindowRecoveryStorageReadiness({journal:f.journal,operationId:f.id,requestRef:g.proof.request,request:doc(g.proof.request),operator:g.proof.operator,now:next.at,env:{NOVA_RELEASE_STORAGE_CONFIG:x.cfg.configRef.path,NOVA_RELEASE_STORAGE_SESSION:x.reconciliationSession.path}});
 assert.deepEqual(readiness,g.proof.storageWindowReadiness);
 const saved=x.grant();assert.deepEqual(x.grant(),saved);assert.deepEqual(f.journal.deliveryOriginalOperatorContinuation(f.id),oldOriginal);assert.deepEqual(f.journal.deliveryStorageSuccessorContinuation(f.id),x.previous);
 assert.deepEqual(f.journal.db.prepare('SELECT * FROM delivery_events WHERE id<=? ORDER BY id').all(oldRows.at(-1).id),oldRows);
 assert.deepEqual(saved.proof.browserReservation,{sessionId:next.request.browser.successorSessionId,startedAtMs:next.at,deadlineAtMs:next.at+1800000});
 const authority=await verifyContinuationStorageAuthority({journal:f.journal,operationId:f.id,now:next.at,effect:true});assert.equal(authority.continuationStarted,true);assert.deepEqual(authority.historicalStorageAdmission,x.admitted);
 const original=doc(f.request.owner.request),start=doc(original.releaseInput),descriptor=sourceRef(join(f.dir,'request-'+f.id,'descriptor.json')),directory=join(f.dir,'request-'+f.id),owner='storage-operations/release-'+f.id;
 const initialization=f.save('request-'+f.id+'/initialization.json',{format:1,kind:'nova-delivery-initialization',input:start,profile:start.profile,inputSha256:sha256(canonical(start)+'\n'),directory,journalDirectory:f.journal.directory,descriptor:{reference:descriptor,value:f.d},target:{reference:f.d.target,value:doc(f.d.target)},adapterIdentity:f.d.adapterIdentity});
 const argv=[original.node.path,authority.operatorEntry.path,'resume',f.journal.directory,f.id],observationIntent=f.save(owner+'/observations/observation-0003/intent.json',{request:f.request.owner.request,argv,sameReleaseOperation:true}),sourceGraph=f.save(owner+'/source-graph-observation-0003.json',doc(x.cfg.graphRef));
 const session=f.save(owner+'/session-observation-0003.json',{format:1,kind:'nova-storage-default-session',mode:'resume',operationId:f.id,config:x.cfg.configRef,sourceReview:x.cfg.config.sourceReview,storageReview:x.cfg.config.storageReview,request:f.request.owner.request,dispatch:doc(x.admitted.admission.session).dispatch,observationIntent,sourceGraph,initialization,descriptor,issuedAtMilliseconds:next.at,operatorContinuation:authority,continuationDispatch:x.admitted.admission.dispatch,argv,adapterIdentity:authority.operatorAdapterIdentity});
 const permit=await verifyStorageSession(['resume',f.journal.directory,f.id],authority.operatorEntry.path,{env:{NOVA_RELEASE_STORAGE_CONFIG:x.cfg.configRef.path,NOVA_RELEASE_STORAGE_SESSION:session.path},now:next.at,clock:()=>next.at,executable:original.node.path});assert.equal(permit.operationId,f.id);

 x.boundary.loseLaunch();await assert.rejects(x.registry.prepareBrowserWindowRecovery(x.context),/lost-launch-response/);
 const path=join(f.journal.directory,'browser-session','successor-'+next.request.browser.successorSessionId,'original.json'),bytes=readFileSync(path),reservation=JSON.parse(bytes);
 assert.equal(reservation.startedAtMs,next.at);assert.equal(reservation.deadlineAtMs,next.at+1800000);
 const starts=x.boundary.modes.filter(x=>x==='start').length;
 const observed=await reconcileExpiredPublication(f.journal,f.id,g.proof.request,{clock:()=>next.at+1000,assertAbsent:()=>{},registry:x.registry});
 assert.deepEqual(observed,saved);assert.equal(x.boundary.modes.filter(x=>x==='start').length,starts);assert.deepEqual(readFileSync(path),bytes);
 assert.equal(f.journal.db.prepare("SELECT count(*) AS n FROM delivery_events WHERE kind='publication-browser-window-recovery-granted'").get().n,1);
 assert.equal(f.journal.db.prepare("SELECT count(*) AS n FROM delivery_events WHERE kind='publication-continuation-storage-admitted'").get().n,1);
});

test('recovery rejects changed admission lineage, owner closure, any downstream reservation and prior browser materialization',async t=>{
 for(const name of ['grant','admission','dispatch','owner','installation','browser'])await t.test(name,async t=>{
  const x=await recoveryFixture(t),r=structuredClone(x.next.request);
  if(name==='grant')r.browserWindowRecovery.predecessorGrantSha256=sha256('wrong');
  if(name==='admission')r.browserWindowRecovery.storageAdmission.sha256=sha256('wrong');
  if(name==='dispatch')r.browserWindowRecovery.storageAdmission.dispatch=x.f.save('wrong-dispatch.json',{});
  if(name==='owner'){const a=r.owner.attempts.at(-1);a.childResult=x.f.save('changed-closure.json',{...doc(a.childResult),originalChildClosed:false});}
  if(name==='installation')x.f.journal.db.prepare('INSERT INTO delivery_phases VALUES(?,?,?,?,?,?)').run(x.f.id,'installation',randomUUID(),'{}',sha256('{}'),x.next.at);
  if(name==='browser'){const dir=join(x.f.journal.directory,'browser-session','successor-'+r.browser.successorSessionId);mkdirSync(dir);writeFileSync(join(dir,'original.json'),'{}');}
  assert.throws(()=>publicationContinuationSnapshot(x.f.journal,x.f.id,x.next.at,{request:r,assertAbsent:()=>{}}));assert.equal(x.f.journal.deliveryOperatorContinuation(x.f.id).sha256,x.previous.sha256);
 });
});

test('recovery cannot refresh its reservation or reuse stale readiness, CI, source or capacity',async t=>{
 for(const name of ['reservation','capacity','source','ci','stale'])await t.test(name,async t=>{
  const x=await recoveryFixture(t),p=structuredClone(x.g.proof);
  if(name==='reservation')p.browserReservation.startedAtMs++;
  if(name==='capacity'){const ready=doc(p.storageWindowReadiness),proof=doc(ready.capacity.result);proof.assessment.filesystems[0].availableBytes=0;ready.capacity.result=x.f.save('bad-capacity.json',proof);p.storageWindowReadiness=x.f.save('bad-readiness.json',ready);}
  if(name==='source'){const ready=doc(p.storageWindowReadiness);ready.entry=x.f.save('wrong-entry.mjs',Buffer.from('// changed'));p.storageWindowReadiness=x.f.save('bad-readiness.json',ready);}
  if(name==='ci'){const ci=doc(p.operator.ci.private);ci.run.head_sha='1'.repeat(40);p.operator.ci.private=x.f.save('wrong-ci.json',ci);}
  if(name==='stale'){const ready=doc(p.storageWindowReadiness);ready.expiresAtMs=x.next.at;p.storageWindowReadiness=x.f.save('stale-readiness.json',ready);}
  assert.throws(()=>x.f.journal.recordBrowserWindowRecovery(x.f.id,p,x.next.at,{assertAbsent:()=>{}}));assert.equal(x.f.journal.deliveryOperatorContinuation(x.f.id).sha256,x.previous.sha256);
 });
 const x=await recoveryFixture(t),saved=x.grant();assert.throws(()=>x.f.journal.recordBrowserWindowRecovery(x.f.id,{...saved.proof,expiresAtMs:saved.proof.expiresAtMs+1},x.next.at),/already-granted/);
 assert.throws(()=>verifyContinuationGrant(x.f.journal,x.f.id,{now:saved.proof.expiresAtMs,effect:true,assertAbsent:()=>{}}),/window-expired/);
 await assert.rejects(reconcileExpiredPublication(x.f.journal,x.f.id,saved.proof.request,{clock:()=>saved.proof.expiresAtMs,assertAbsent:()=>{},registry:x.registry}),/window-expired/);
 assert.equal(existsSync(join(x.f.journal.directory,'browser-session','successor-'+x.next.request.browser.successorSessionId,'original.json')),false);
});

