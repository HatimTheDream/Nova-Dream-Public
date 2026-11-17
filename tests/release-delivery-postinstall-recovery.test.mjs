import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from '../support/release-publication-grant-fixture.mjs';
import {postinstallReadinessFixture,postinstallAcceptanceFixture} from '../support/postinstall-browser-fixture.mjs';
import {verifyPostinstallBrowserRecovery} from '../scripts/release-delivery-postinstall-browser.mjs';
import {sha256} from '../scripts/release-plan.mjs';
import {postinstallRequestSchema,postinstallCorrectionSnapshot,verifyPostinstallCorrectionEvidence,currentPostinstallRecovery,postinstallCoverageSchema,postinstallCoverage,POSTINSTALL_SCOPE,POSTINSTALL_GAPS,postinstallSnapshot,postinstallAuthoritySchema,verifyPostinstallAuthority,verifyPostinstallAdmission,reconcilePostinstallBrowser} from '../scripts/release-delivery-postinstall-recovery.mjs';
import {deliveryProfileSchema,persistSuccessorProfile} from '../scripts/release-delivery-initialize.mjs';
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const doc=r=>JSON.parse(readFileSync(r.path));
const coverage={acceptanceScope:POSTINSTALL_SCOPE,originalTransitionCoverage:'unverified',transitionCoverageGaps:[...POSTINSTALL_GAPS]};
function setup(t,{acceptance=false,historicalSource=false}={}){
 const f=fixture(t,{fileJournal:true}),{journal,id,save,now}=f,at=now+1800001;
 const record=(phase,output,externalId=null)=>{const row=journal.deliveryPhase(id,phase)??journal.reserveDeliveryPhase(id,phase,{phase},now+4).intent;journal.recordDeliveryObservation(id,phase,{key:row.key,state:'completed',reason:'synthetic-completed-producer',externalId,receipt:save(phase+'-receipt.json',output),output},now+4);return journal.deliveryPhase(id,phase);};
 record('publication',{kind:'synthetic-publication'});const job=randomUUID();record('installation',{kind:'synthetic-installed',jobId:job},job);
 const ar=journal.reserveDeliveryPhase(id,'assistant',{phase:'assistant'},now+4).intent;
 const assistant={kind:'nova-delivery-saved-assistant-reply',key:ar.key,operationId:id,savedReplyAccepted:true,browserUiVerified:false,replySha256:sha256('one saved reply'),savedMessageId:randomUUID(),...(acceptance?{conversationId:randomUUID(),nativeId:randomUUID()}: {})};record('assistant',assistant,id);
 const coordinator={state:'completed',externalJobId:job,idempotencyKey:randomUUID()};t.mock.method(journal,'intent',()=>coordinator);
 const sessionId=randomUUID(),binding={operationId:id,sessionId,route:'full',epoch:f.operation.workspaceEpoch,priorCandidateId:f.operation.priorCandidateId};
 const bd='old-browser',original=save(bd+'/original.json',{binding,startedAtMs:now,deadlineAtMs:now+1800000}),prepared=save(bd+'/prepared.json',{bindingSha256:sha256(canonical(binding)),startedAtMs:now,document:{candidateId:f.operation.priorCandidateId},...(acceptance?{draft:'Synthetic task-owned retained draft for exact recovery proof.'}:{})});
 const browserInput={format:1,operationId:id,installed:{operationId:id,route:'full',...(acceptance?{installedHealth:{candidateId:sha256('installed candidate'),epoch:f.operation.workspaceEpoch,frontend:{id:sha256('bundled frontend'),source:'bundled',version:'8.1.0',buildVersion:'1.0.801'}}}:{})},assistant,original,prepared};const br=journal.reserveDeliveryPhase(id,'browser',browserInput,now+6).intent;
 journal.recordDeliveryObservation(id,'browser',{key:br.key,state:'gap',reason:'browser-dom-or-transport-check-failed',externalId:id,receipt:null,output:null},now+7);
 const previous={sha256:sha256('original-publication-authority'),proof:{operator:{adapterIdentity:sha256('original-operator')},browserWindowRecovery:{historical:true},browserReservation:{sessionId,startedAtMs:now,deadlineAtMs:now+1800000}}};t.mock.method(journal,'deliveryOperatorContinuation',()=>previous);
 const failure={failed:save(bd+'/failed.json',{operationId:id,reason:'browser-dom-or-transport-check-failed',atMs:now+10}),closed:save(bd+'/closed.json',{operationId:id,browserClosed:true,tunnelClosed:true,atMs:now+11}),memory:save(bd+'/memory-browser-closed.json',{operationId:id,atMs:now+11,events:'oom 5\noom_kill 1\n'})};
 const oldRequest=f.request.owner.request,node=doc(f.d.target).artifactTools.node,entry=save('old-controller.mjs',Buffer.from('// original operator'));
 const root='postinstall-owners',dir=root+'/observations/observation-0004',argv=[node.path,entry.path,'resume',journal.directory,id];
 const intent=save(dir+'/intent.json',{request:oldRequest,sameReleaseOperation:true,argv});
 const session=save(root+'/session-observation-0004.json',{kind:'nova-storage-default-session',operationId:id,mode:'resume',argv,request:oldRequest,observationIntent:intent,issuedAtMilliseconds:now+8,descriptor:save('owner-descriptor.json',f.d),adapterIdentity:previous.proof.operator.adapterIdentity,config:doc(f.attempt.launcher).config,operatorContinuation:{grantSha256:previous.sha256,operatorEntry:entry,browserReservation:previous.proof.browserReservation}});
 const priorLauncher=doc(f.attempt.launcher),launcher=save(root+'/waiting.json',{...priorLauncher,entry});
 const owner={session,launcher,intent,exit:save(dir+'/exit.json',{returnCode:2,finishedAtMilliseconds:now+20}),childResult:save(dir+'/default-child-result.json',{returnCode:2,originalChildClosed:true,automaticNewOperationPermitted:false,logBoundExceeded:false}),stdout:save(dir+'/stdout.json',journal.deliveryStatus(id,now+20))};
 const operatorSources=Object.fromEntries(['private','public'].map(side=>[side,{root:join(f.dir,'current-'+side),repository:side==='private'?'HatimTheDream/Nova-Dream':'HatimTheDream/Nova-Dream-Public',branch:'operator/browser-postinstall-recovery-r1',commit:(side==='private'?'c':'d').repeat(40)}]));
 const sourceBytes=historicalSource?Buffer.from('// preserved historical operator source; never executed'):readFileSync(new URL('../scripts/release-delivery-postinstall-recovery.mjs',import.meta.url)),rows=[{name:'release-delivery-postinstall-recovery.mjs',sha256:sha256(sourceBytes)}];for(const side of ['private','public'])save('current-'+side+'/'+(side==='private'?'edition3/':'')+'scripts/release-delivery-postinstall-recovery.mjs',sourceBytes);
 const ci=s=>({requestedAttempt:1,run:{id:10,run_attempt:1,repository:{full_name:s.repository},head_sha:s.commit,head_branch:s.branch,event:'push',path:'.github/workflows/operator-continuation-quality.yml',name:'Operator continuation quality',status:'completed',conclusion:'success'},jobs:{total_count:1,jobs:[{id:11,run_id:10,head_sha:s.commit,name:'quality',status:'completed',conclusion:'success',steps:['Run npm run quality','Verify Linux update recovery'].map(name=>({name,status:'completed',conclusion:'success'}))}]}});
 const operator={adapterIdentity:sha256(canonical(rows)),sources:operatorSources,sourceFiles:rows,ci:Object.fromEntries(['private','public'].map(side=>[side,save('current-ci-'+side+'.json',ci(operatorSources[side]))]))};
 const request={format:1,kind:'nova-postinstall-browser-recovery-request',operationId:id,historical:f.request.historical,operatorSources,ciRuns:{private:10,public:10},sessionId:randomUUID(),durationMs:600000,capacity:{diskReserveBytes:2147483648,workingAllowanceBytes:536870912},owner,failure};
 const options={now:at,assertAbsent:()=>{}};
 const snapshot=()=>postinstallSnapshot(journal,id,request,options);
 const planValue={format:1,kind:'nova-postinstall-browser-recovery-plan',operationId:id,request,snapshot:snapshot(),operator,browserReadiness:save('readonly-browser.json',acceptance?postinstallReadinessFixture(browserInput,{sessionId:request.sessionId,now:at,requestSha256:sha256(canonical(request)),capacity:request.capacity}):{syntheticReadOnlyEdge:true}),plannedAtMs:at-(historicalSource?1000:0),readOnly:true,hostEffects:false,journalWrites:false};
 const plan=save('plan.json',planValue),review=save('review.json',{kind:'nova-postinstall-browser-plan-review',status:'passed',independentReview:true,plan,operationId:id,operatorAdapterIdentity:operator.adapterIdentity});
 const intentRef=save('execution-intent.json',{kind:'nova-postinstall-browser-execution-intent',operationId:id,plan,review,sessionId:request.sessionId,browserOnly:true,automaticReplayPermitted:false,issuedAtMs:at-(historicalSource?999:0),expiresAtMs:at+60000});
 const admitted={...request,admission:{plan,review,intent:intentRef}},requestRef=save('admitted-request.json',admitted);
 const authority=()=>postinstallAuthoritySchema.parse({format:1,kind:'nova-postinstall-browser-observation-authority',operationId:id,sessionId:request.sessionId,startedAtMs:at,deadlineAtMs:at+request.durationMs,request:requestRef,plan,browserReadiness:planValue.browserReadiness,browserKey:br.key,browserInputSha256:br.inputSha256,snapshot:snapshot(),operator,...coverage,automaticRenewal:false,installationPermitted:false,assistantDispatchPermitted:false});
 return {...f,at,previous,request,admitted,requestRef,operator,planValue,authority,snapshot,coordinator,ci};
}
test('actual native reservation is atomic, immutable, separate from old grant and idempotent',t=>{
 const f=setup(t),before=f.journal.deliveryPhase(f.id,'browser'),proof=f.authority(),oldGrant=structuredClone(f.previous),stored=f.journal.recordPostinstallRecovery(f.id,proof,f.at,{assertAbsent:()=>{}});
 assert.deepEqual(stored.proof,proof);assert.deepEqual(f.journal.deliveryOperatorContinuation(f.id),oldGrant);assert.deepEqual(f.journal.deliveryPhase(f.id,'browser'),before);
 assert.deepEqual(f.journal.recordPostinstallRecovery(f.id,proof,f.at+1),stored);
 assert.throws(()=>f.journal.recordPostinstallRecovery(f.id,{...proof,deadlineAtMs:proof.deadlineAtMs+1},f.at+2),/second-or-conflicting/);
 assert.throws(()=>f.journal.db.prepare('UPDATE delivery_postinstall_recoveries SET at_ms=? WHERE operation_id=?').run(f.at+1,f.id),/immutable-postinstall/);
 assert.deepEqual(postinstallCoverage(f.journal.deliveryStatus(f.id,f.at+1)),coverage);
 assert.equal(f.journal.deliveryStatus(f.id,f.at+1).complete,false);
});
test('authority allows only its finite browser interval and authenticates source/CI/history',t=>{
 const f=setup(t),proof=f.authority();f.journal.recordPostinstallRecovery(f.id,proof,f.at,{assertAbsent:()=>{}});
 assert.equal(verifyPostinstallAuthority(f.journal,f.id,{now:f.at,effect:true}).sha256,sha256(canonical(proof)));
 assert.throws(()=>verifyPostinstallAuthority(f.journal,f.id,{now:proof.deadlineAtMs,effect:true}),/authority-expired/);
 assert.doesNotThrow(()=>verifyPostinstallAuthority(f.journal,f.id,{now:proof.deadlineAtMs}));
 f.save('current-private/edition3/scripts/release-delivery-postinstall-recovery.mjs',Buffer.from('changed source'));
 assert.throws(()=>verifyPostinstallAuthority(f.journal,f.id,{now:f.at,effect:true}));
});
test('snapshot rejects wrong owner, missing OOM, live owner and changed saved reply',t=>{
 const f=setup(t);assert.doesNotThrow(f.snapshot);
 assert.throws(()=>postinstallSnapshot(f.journal,f.id,f.request,{now:f.at,assertAbsent:()=>{throw Error('owner-still-live')}}),/owner-still-live/);
 const changed=structuredClone(f.request);changed.failure.memory=f.save('different-memory.json',{operationId:f.id,events:'oom_kill 0\n'});assert.throws(()=>postinstallSnapshot(f.journal,f.id,changed,{now:f.at,assertAbsent:()=>{}}),/failure-path/);
 f.save('old-browser/memory-browser-closed.json',{operationId:f.id,events:'oom_kill 0\n'});assert.throws(f.snapshot);
});
test('separate plan and finite execution intent bind all native state and exact reviewed source',t=>{
 const f=setup(t);assert.doesNotThrow(()=>verifyPostinstallAdmission(f.admitted,f.planValue,f.snapshot(),f.operator,f.at));
 for(const [key,value]of [['browserKey',randomUUID()],['historySha256',sha256('changed history')],['prerequisitesSha256',sha256('changed saved reply')]])assert.throws(()=>verifyPostinstallAdmission(f.admitted,f.planValue,{...f.snapshot(),[key]:value},f.operator,f.at),/plan-binding/);
 assert.throws(()=>verifyPostinstallAdmission(f.admitted,f.planValue,f.snapshot(),f.operator,f.at+60000),/finite-execution/);
 assert.throws(()=>verifyPostinstallAdmission(f.request,f.planValue,f.snapshot(),f.operator,f.at),/separate-execution/);
});
test('crash after native reservation reuses fixed authority and never invokes preparation or producer registry',async t=>{
 const f=setup(t),proof=f.authority();f.journal.recordPostinstallRecovery(f.id,proof,f.at,{assertAbsent:()=>{}});
 const seen=[];const browserApi={planPostinstallBrowserRecovery(){throw Error('must-not-plan-again');},async observePostinstallBrowserRecovery(c){seen.push(c.authority);c.beforeNewEffect();return {state:'gap',reason:'synthetic-lost-browser-response',externalId:f.id,receipt:null,output:null};}};
 const result=await reconcilePostinstallBrowser(f.journal,f.id,f.requestRef,{clock:()=>f.at+1,browserApi,qualify(){throw Error('must-not-reissue');}});
 assert.deepEqual(seen,[proof]);assert.deepEqual(result.successor,{gap:'postinstall-browser-acceptance-pending'});assert.equal(result.complete,false);assert.deepEqual(postinstallCoverage(result),coverage);assert.equal(f.journal.deliveryPostinstallRecovery(f.id).proof.deadlineAtMs,proof.deadlineAtMs);
 const changed=f.save('conflicting-request.json',{...f.admitted,sessionId:randomUUID()});await assert.rejects(()=>reconcilePostinstallBrowser(f.journal,f.id,changed,{clock:()=>f.at+2,browserApi}),/second-or-conflicting/);
});
test('coverage is mandatory and unknown, missing or suppressed transition gaps are rejected',()=>{
 assert.deepEqual(postinstallCoverage(coverage),coverage);
 for(const v of [{...coverage,acceptanceScope:'ordinary'},{...coverage,transitionCoverageGaps:[]},{...coverage,originalTransitionCoverage:'passed'}])assert.equal(postinstallCoverageSchema.safeParse(v).success,false);
 assert.throws(()=>postinstallCoverage({kind:'nova-postinstall-browser-recovery-acceptance'}),/coverage-required/);
 assert.equal(postinstallRequestSchema.safeParse({kind:'nova-postinstall-browser-recovery-request'}).success,false);
});

test('configured native policy adopts real validated scoped proof under original browser key without install or reply replay',async t=>{
 const f=setup(t,{acceptance:true}),browserBefore=f.journal.deliveryPhase(f.id,'browser'),oldGrant=structuredClone(f.previous),oldOriginal=readFileSync(browserBefore.input.original.path),oldFailure=readFileSync(f.request.failure.failed.path);
 const beforePhases=Object.fromEntries(['installation','assistant'].map(name=>[name,f.journal.deliveryPhase(f.id,name)]));
 let observedNow=f.at,observations=0,readinessChecks=0;
 const browserApi={
  async verifyPostinstallBrowserRecoveryPlan(reference,context){readinessChecks++;assert.deepEqual(reference,f.planValue.browserReadiness);assert.deepEqual(context.browserInput,browserBefore.input);return reference;},
  async observePostinstallBrowserRecovery(context){observations++;context.beforeNewEffect();assert.deepEqual(context.browserInput,browserBefore.input);assert.equal(context.authority.browserKey,browserBefore.key);
   const output=postinstallAcceptanceFixture(f.save,context.browserInput,context.authority,context.authorityRef);
   // Genuine production proof validator, including durable ordered checks,
   // fixed native authority, saved reply, request fence, resources and closure.
   verifyPostinstallBrowserRecovery(output,context.browserInput);observedNow=f.at+1200;
   return {state:'completed',reason:'current-installed-browser-crash-recovery-verified',externalId:f.id,output,receipt:f.save('accepted-scoped-browser.json',output)};
  },
 };
 const result=await reconcilePostinstallBrowser(f.journal,f.id,f.requestRef,{clock:()=>observedNow,assertAbsent:()=>{},qualify:async()=>structuredClone(f.operator),browserApi});
 assert.equal(readinessChecks,1);assert.equal(observations,1);assert.equal(result.complete,true);assert.deepEqual(postinstallCoverage(result),coverage);
 const accepted=f.journal.deliveryPhase(f.id,'browser');assert.equal(accepted.key,browserBefore.key);assert.equal(accepted.inputSha256,browserBefore.inputSha256);assert.deepEqual(accepted.input,browserBefore.input);assert.equal(accepted.externalId,f.id);
 assert.deepEqual(f.journal.deliveryOperatorContinuation(f.id),oldGrant);assert.deepEqual(readFileSync(browserBefore.input.original.path),oldOriginal);assert.deepEqual(readFileSync(f.request.failure.failed.path),oldFailure);
 for(const [name,before]of Object.entries(beforePhases))assert.deepEqual(f.journal.deliveryPhase(f.id,name),before);
 const rows=f.journal.db.prepare("SELECT observation_json FROM delivery_observations WHERE operation_id=? AND phase='browser' ORDER BY id").all(f.id).map(row=>JSON.parse(row.observation_json));assert.equal(rows.length,2);assert.equal(rows[0].state,'gap');assert.equal(rows[1].state,'completed');
 // Synthetic historical package/initialization is deliberately insufficient
 // for accepted-profile export; native acceptance cannot fabricate closeout.
 assert.equal(typeof result.successor.gap,'string');assert.equal(result.successor.profile,undefined);
 const authority=f.journal.deliveryPostinstallRecovery(f.id),events=f.journal.db.prepare('SELECT COUNT(*) AS n FROM delivery_events WHERE operation_id=?').get(f.id).n;
 observedNow+=100;const again=await reconcilePostinstallBrowser(f.journal,f.id,f.requestRef,{clock:()=>observedNow,browserApi});assert.equal(again.complete,true);assert.equal(observations,1);assert.deepEqual(f.journal.deliveryPostinstallRecovery(f.id),authority);assert.equal(f.journal.db.prepare('SELECT COUNT(*) AS n FROM delivery_events WHERE operation_id=?').get(f.id).n,events);
 const r=f.d.target,profile={format:1,target:r,targetIdentity:f.d.targetIdentity,sources:Object.fromEntries(Object.entries(f.d.sources).map(([side,s])=>[side,{root:s.root,repository:s.repository,branch:'main'}])),accepted:{identity:r,result:r,pair:r,bundle:r},qualificationEvidence:[],previousDelivery:{operationId:f.id,descriptorSha256:sha256('descriptor'),assistantReceipt:beforePhases.assistant.current.receipt,publicationReceipt:f.journal.deliveryPhase(f.id,'publication').current.receipt,sourceCandidates:{private:r,public:r},browserAccepted:true,browserInput:f.save('accepted-browser-input.json',accepted.input),browserReceipt:accepted.current.receipt,...coverage}};
 assert.deepEqual(postinstallCoverage(deliveryProfileSchema.parse(profile).previousDelivery),coverage);
 for(const change of [{transitionCoverageGaps:[]},{originalTransitionCoverage:'passed'},{acceptanceScope:'ordinary-full-browser'}])assert.equal(deliveryProfileSchema.safeParse({...profile,previousDelivery:{...profile.previousDelivery,...change}}).success,false);
 const missing={...profile.previousDelivery};delete missing.transitionCoverageGaps;assert.equal(deliveryProfileSchema.safeParse({...profile,previousDelivery:missing}).success,false);
});

test('execution intent expiry during fresh readiness refuses issuance and atomic direct recording',async t=>{
 const f=setup(t),before=f.journal.deliveryPhase(f.id,'browser');let now=f.at,dispatches=0;
 const browserApi={async verifyPostinstallBrowserRecoveryPlan(reference){now=f.at+60000;return reference;},async observePostinstallBrowserRecovery(){dispatches++;throw Error('expired-intent-must-not-dispatch');}};
 await assert.rejects(()=>reconcilePostinstallBrowser(f.journal,f.id,f.requestRef,{clock:()=>now,assertAbsent:()=>{},qualify:async()=>structuredClone(f.operator),browserApi}),/postinstall-finite-execution-intent-required/);
 assert.equal(dispatches,0);assert.equal(f.journal.deliveryPostinstallRecovery(f.id),null);assert.deepEqual(f.journal.deliveryPhase(f.id,'browser'),before);
 assert.throws(()=>f.journal.recordPostinstallRecovery(f.id,f.authority(),f.at+60000,{assertAbsent:()=>{}}),/postinstall-finite-execution-intent-required/);
 assert.equal(f.journal.deliveryPostinstallRecovery(f.id),null);
 assert.equal(f.journal.db.prepare("SELECT COUNT(*) AS n FROM delivery_events WHERE operation_id=? AND kind='postinstall-browser-observation-reserved'").get(f.id).n,0);
});

const mailPolicy={mailActivityPolicy:'blocked',mailFunctionalityCoverage:'unverified'};
function correctionSetup(t){
 const f=setup(t,{acceptance:true,historicalSource:true}),{journal,id,save}=f,old=f.authority();journal.recordPostinstallRecovery(id,old,f.at,{assertAbsent:()=>{}});
 const at=old.deadlineAtMs+1,oldRef=save('old-authority.json',old),input=journal.deliveryPhase(id,'browser').input;
 const status={state:'observed',operationId:id,sessionId:old.sessionId,files:{failed:{operationId:id,reason:'browser-recovery-connected-mail-not-admitted',atMs:f.at+100,completedChecks:[],diagnostics:{pageAvailable:false},fence:null},closed:{operationId:id,sessionId:old.sessionId,atMs:f.at+200,browserClosed:true},'profile-copy':{source:doc(old.browserReadiness).profile,sourceUnchanged:true},'memory-closed':{atMs:f.at+201,events:'oom_kill 0\n'}},checks:[],unitState:'ActiveState=inactive\nMainPID=0\n',ownedPids:[],originalProfileUnchanged:null,hostWrites:false};
 const transport=(value,when,name)=>save(name,{mode:'status',observedAtMs:when,programSha256:sha256('synthetic current readonly status transport'),exitCode:0,stdout:JSON.stringify(value),stderr:'',diagnosticsTruncated:false});
 const failure=transport(status,f.at+300,'predecessor-failure-transport.json');journal.recordDeliveryObservation(id,'browser',{key:old.browserKey,state:'gap',reason:status.files.failed.reason,externalId:id,receipt:failure,output:null},f.at+300);
 const dir='correction-owners/reconciliation-0001',priorLauncher=doc(f.request.owner.launcher),node=doc(f.d.target).artifactTools.node;
 const entry=save('current-private/edition3/scripts/release-deliver.mjs',Buffer.from('// historical entry'));const sourceReview=save('old-default-review.json',{synthetic:true}),storageReview=save('old-storage-review.json',{synthetic:true});
 const config=save('old-config.json',{postinstallBrowserRecovery:true,sourceReview,storageReview,operatorContinuation:{originalRequest:doc(f.request.owner.session).request}}),runner=save('old-runner.py',Buffer.from('# historical runner'));
 const argv=[node.path,entry.path,'reconcile-browser-recovery',journal.directory,id,old.request.path];
 const intent=save(dir+'/intent.json',{argv,request:doc(f.request.owner.session).request,reconciliationRequest:old.request,sameReleaseOperation:true});
 const launcher=save(dir+'/waiting-launcher.json',{...priorLauncher,dispatchAuthority:false,mode:'reconcile-browser-recovery',entry,cwd:join(f.operator.sources.private.root,'edition3'),config,node,runner,reconciliationRequest:old.request});
 const session=save(dir+'/session.json',{kind:'nova-storage-postinstall-browser-reconciliation-session',mode:'reconcile-browser-recovery',operationId:id,argv,reconciliationRequest:old.request,waitingLauncher:launcher,request:doc(f.request.owner.session).request,config,sourceReview,storageReview,sourceGraph:save('old-source-graph.json',{adapterIdentity:old.operator.adapterIdentity}),adapterIdentity:old.operator.adapterIdentity,descriptor:save('old-descriptor.json',f.d),issuedAtMilliseconds:f.at-500,runnerPid:priorLauncher.worker.pid});
 const owners=[{session,launcher,intent,exit:save(dir+'/exit.json',{returnCode:2,finishedAtMilliseconds:f.at+500}),childResult:save(dir+'/default-child-result.json',{returnCode:2,originalChildClosed:true,automaticNewOperationPermitted:false,logBoundExceeded:false}),stdout:save(dir+'/stdout.json',{kind:'nova-release-delivery',operationId:id,complete:false,postinstallAuthority:oldRef,phases:[{phase:'browser',key:old.browserKey,state:'gap'}]})}];
 const sources=Object.fromEntries(['private','public'].map(side=>[side,{...f.operator.sources[side],root:join(f.dir,'correction-'+side),commit:(side==='private'?'e':'f').repeat(40)}]));
 const bytes=readFileSync(new URL('../scripts/release-delivery-postinstall-recovery.mjs',import.meta.url)),rows=[{name:'release-delivery-postinstall-recovery.mjs',sha256:sha256(bytes)}];
 for(const side of ['private','public'])save('correction-'+side+'/'+(side==='private'?'edition3/':'')+'scripts/release-delivery-postinstall-recovery.mjs',bytes);
 const operator={adapterIdentity:sha256(canonical(rows)),sources,sourceFiles:rows,ci:Object.fromEntries(['private','public'].map(side=>{const c=f.ci(sources[side]);c.run.id=20;c.jobs.jobs[0].run_id=20;return[side,save('correction-ci-'+side+'.json',c)];}))};
 const request={...f.request,operatorSources:sources,ciRuns:{private:20,public:20},sessionId:randomUUID(),correction:{kind:'nova-postinstall-connected-mail-correction',predecessorAuthority:oldRef,failure,owners,...mailPolicy}};
 const snapshot=()=>postinstallCorrectionSnapshot(journal,id,request,{now:at,assertAbsent:()=>{}});
 const readiness=save('correction-readiness.json',postinstallReadinessFixture(input,{sessionId:request.sessionId,now:at,requestSha256:sha256(canonical(request)),capacity:request.capacity,mailPolicy}));
 const statusRef=save('fresh-status.json',status),transportReceipt=transport(status,at,'fresh-transport.json');
 const planValue={format:1,kind:'nova-postinstall-browser-recovery-plan',operationId:id,request,snapshot:snapshot(),operator,browserReadiness:readiness,predecessorStatus:{status:statusRef,transport:transportReceipt},plannedAtMs:at,readOnly:true,hostEffects:false,journalWrites:false};
 const plan=save('correction-plan.json',planValue),review=save('correction-review.json',{kind:'nova-postinstall-browser-plan-review',status:'passed',independentReview:true,plan,operationId:id,operatorAdapterIdentity:operator.adapterIdentity});
 const intentRef=save('correction-intent.json',{kind:'nova-postinstall-browser-execution-intent',operationId:id,plan,review,sessionId:request.sessionId,browserOnly:true,automaticReplayPermitted:false,issuedAtMs:at,expiresAtMs:at+60000});
 const admitted={...request,admission:{plan,review,intent:intentRef}},requestRef=save('correction-request.json',admitted);
 const proof={...old,sessionId:request.sessionId,startedAtMs:at,deadlineAtMs:at+request.durationMs,request:requestRef,plan,browserReadiness:readiness,snapshot:snapshot(),operator,...mailPolicy};
 const record={format:1,kind:'nova-postinstall-connected-mail-correction-record',operationId:id,predecessorSha256:journal.deliveryPostinstallRecovery(id).sha256,predecessorAuthority:oldRef,predecessorStatus:statusRef,predecessorTransport:transportReceipt,proof};
 return {...f,at,old,oldRef,input,status,transport,statusRef,transportReceipt,request,admitted,requestRef,readiness,operator,planValue,proof,record,snapshot};
}
test('one correction preserves original authority, historical source, phase keys and pre-issuance owner chronology',t=>{
 const f=correctionSetup(t),before=f.journal.deliveryPostinstallRecovery(f.id),browser=f.journal.deliveryPhase(f.id,'browser');
 const stored=f.journal.recordPostinstallCorrection(f.id,f.record,f.at,{assertAbsent:()=>{}});
 assert.deepEqual(f.journal.deliveryPostinstallRecovery(f.id),before);assert.deepEqual(f.journal.deliveryPhase(f.id,'browser'),browser);
 assert.deepEqual(currentPostinstallRecovery(f.journal,f.id),stored);assert.doesNotThrow(()=>verifyPostinstallAuthority(f.journal,f.id,{now:f.at,effect:true}));
 assert.deepEqual(f.journal.recordPostinstallCorrection(f.id,f.record,f.at+1),stored);
 assert.throws(()=>f.journal.recordPostinstallCorrection(f.id,{...f.record,proof:{...f.proof,sessionId:randomUUID()}},f.at+1),/conflicting-correction/);
 assert.throws(()=>f.journal.db.prepare('DELETE FROM delivery_postinstall_corrections WHERE operation_id=?').run(f.id),/immutable-postinstall-correction/);
 assert.deepEqual(postinstallCoverage(f.journal.deliveryStatus(f.id,f.at)),{...coverage,...mailPolicy});
 f.save('current-private/edition3/scripts/release-delivery-postinstall-recovery.mjs',Buffer.from('changed historical bytes'));assert.throws(()=>verifyPostinstallAuthority(f.journal,f.id,{now:f.at,effect:true}));
});
test('correction refuses wrong cause, page reached, checks completed, uncertain closure, owner and changed source profile',t=>{
 const f=correctionSetup(t);assert.doesNotThrow(f.snapshot);
 assert.throws(()=>postinstallCorrectionSnapshot(f.journal,f.id,f.request,{now:f.at,assertAbsent:()=>{throw Error('live-owner')}}),/live-owner/);
 assert.throws(()=>postinstallCorrectionSnapshot(f.journal,f.id,f.request,{now:f.old.deadlineAtMs-1,assertAbsent:()=>{}}),/window-not-closed/);
 for(const mutate of [s=>s.files.failed.reason='another-failure',s=>s.files.failed.diagnostics.pageAvailable=true,s=>s.files.failed.completedChecks=['one'],s=>s.ownedPids=[1],s=>s.unitState='ActiveState=active\nMainPID=1\n']){
  const status=structuredClone(f.status);mutate(status);const statusRef=f.save('bad-status.json',status),transport=f.transport(status,f.at,'bad-transport.json');
  assert.throws(()=>verifyPostinstallCorrectionEvidence(f.journal,f.id,f.request,statusRef,transport,f.readiness,f.at),/terminal-prepage/);
 }
 const changed={...doc(f.readiness),profile:{...doc(f.readiness).profile,inventorySha256:sha256('changed profile')}};
 assert.throws(()=>verifyPostinstallCorrectionEvidence(f.journal,f.id,f.request,f.statusRef,f.transportReceipt,f.save('changed-profile-readiness.json',changed),f.at),/original-profile-changed/);
 const wrong={...f.request,correction:{...f.request.correction,predecessorAuthority:f.save('wrong-authority.json',{...f.old,sessionId:randomUUID()})}};
 assert.throws(()=>postinstallCorrectionSnapshot(f.journal,f.id,wrong,{now:f.at,assertAbsent:()=>{}}),/predecessor-changed/);
});
test('correction checks expiry again after fresh predecessor status and leaves no reservation or launch',async t=>{
 const f=correctionSetup(t);let now=f.at,launches=0;
 const api={async verifyPostinstallBrowserRecoveryPlan(){return f.readiness;},async observePostinstallRecoveryPredecessor(){now=f.at+60000;return {status:f.status,statusRef:f.statusRef,transportReceipt:f.transportReceipt};},async observePostinstallBrowserRecovery(){launches++;throw Error('must-not-launch');}};
 await assert.rejects(()=>reconcilePostinstallBrowser(f.journal,f.id,f.requestRef,{clock:()=>now,assertAbsent:()=>{},qualify:async()=>structuredClone(f.operator),browserApi:api}),/finite-execution-intent/);
 assert.equal(f.journal.deliveryPostinstallCorrection(f.id),null);assert.equal(launches,0);
});
test('configured correction joins real acceptance validator, retains failure and reconnects without reissuing',async t=>{
 const f=correctionSetup(t),original=f.journal.deliveryPostinstallRecovery(f.id),before=f.journal.deliveryPhase(f.id,'browser');let calls=0,now=f.at;
 const api={async verifyPostinstallBrowserRecoveryPlan(){return f.readiness;},async observePostinstallRecoveryPredecessor(){return {status:f.status,statusRef:f.statusRef,transportReceipt:f.transportReceipt};},async observePostinstallBrowserRecovery(c){calls++;c.beforeNewEffect();const output=postinstallAcceptanceFixture(f.save,c.browserInput,c.authority,c.authorityRef);verifyPostinstallBrowserRecovery(output,c.browserInput);now=f.at+1200;return {state:'completed',reason:'current-installed-browser-crash-recovery-verified',externalId:f.id,output,receipt:f.save('correction-accepted.json',output)};}};
 const result=await reconcilePostinstallBrowser(f.journal,f.id,f.requestRef,{clock:()=>now,assertAbsent:()=>{},qualify:async()=>structuredClone(f.operator),browserApi:api});
 assert.equal(result.complete,true);assert.equal(result.mailFunctionalityCoverage,'unverified');assert.equal(calls,1);assert.deepEqual(f.journal.deliveryPostinstallRecovery(f.id),original);
 const browser=f.journal.deliveryPhase(f.id,'browser');assert.equal(browser.key,before.key);assert.deepEqual(browser.input,before.input);
 const rows=f.journal.db.prepare("SELECT observation_json FROM delivery_observations WHERE operation_id=? AND phase='browser' ORDER BY id").all(f.id).map(r=>JSON.parse(r.observation_json));assert.equal(rows.length,3);assert.equal(rows[1].reason,'browser-recovery-connected-mail-not-admitted');assert.equal(rows[2].state,'completed');
 await reconcilePostinstallBrowser(f.journal,f.id,f.requestRef,{clock:()=>now+1,browserApi:api});assert.equal(calls,1);
 await assert.rejects(()=>reconcilePostinstallBrowser(f.journal,f.id,f.old.request,{clock:()=>now+1,browserApi:api}),/predecessor-retired/);
});

test('correction export write tail preserves prior pending provenance and profiles without filename collisions',t=>{
 const f=correctionSetup(t),r=f.d.target,dir=join(f.dir,'retained-pending-export');
 const originalFiles=['accepted-operator-postinstall-recovery.json','successor-profile.json','successor-target.json','accepted-source-private.json','accepted-source-public.json'].map(name=>f.save('retained-pending-export/'+name,{historical:name,predecessor:f.oldRef}));
 const originalBytes=originalFiles.map(r=>readFileSync(r.path));
 const profile={format:1,target:r,targetIdentity:f.d.targetIdentity,sources:Object.fromEntries(Object.entries(f.d.sources).map(([side,s])=>[side,{root:s.root,repository:s.repository,branch:'main'}])),accepted:{identity:r,result:r,pair:r,bundle:r},qualificationEvidence:[],previousDelivery:{operationId:f.id,descriptorSha256:sha256('descriptor'),assistantReceipt:f.journal.deliveryPhase(f.id,'assistant').current.receipt,publicationReceipt:f.journal.deliveryPhase(f.id,'publication').current.receipt,sourceCandidates:{private:r,public:r},browserAccepted:true,browserInput:r,browserReceipt:r,...coverage,...mailPolicy}};
 const postinstall={proof:f.proof,correction:f.record,sha256:sha256(canonical(f.record)),recordedAtMs:f.at};
 assert.throws(()=>persistSuccessorProfile(dir,profile,postinstall,{browserAccepted:false,...coverage,...mailPolicy}),/correction-export-requires-accepted-browser/);
 assert.throws(()=>persistSuccessorProfile(dir,{...profile,previousDelivery:{...profile.previousDelivery,acceptanceScope:undefined}},postinstall,{browserAccepted:true,...mailPolicy}),/correction-export-requires-accepted-browser/);
 const output=persistSuccessorProfile(dir,profile,postinstall,{browserAccepted:true,...coverage,...mailPolicy});
 assert.equal(output.path,join(dir,'successor-profile-browser-mail-excluded-accepted.json'));
 const written=doc(output);assert.equal(written.operatorProvenance.path,join(dir,'accepted-operator-postinstall-correction.json'));assert.deepEqual(doc(written.operatorProvenance),postinstall);assert.deepEqual(postinstallCoverage(written.previousDelivery),{...coverage,...mailPolicy});
 originalFiles.forEach((r,i)=>assert.deepEqual(readFileSync(r.path),originalBytes[i]));
 assert.deepEqual(persistSuccessorProfile(dir,profile,postinstall,{browserAccepted:true,...coverage,...mailPolicy}),output);
 assert.throws(()=>persistSuccessorProfile(dir,{...profile,targetIdentity:sha256('changed target')},postinstall,{browserAccepted:true,...coverage,...mailPolicy}),/changed/);
 originalFiles.forEach((r,i)=>assert.deepEqual(readFileSync(r.path),originalBytes[i]));
});

test('correction effect verification authenticates retained failure and closure bytes after reservation',t=>{
 const f=correctionSetup(t);f.journal.recordPostinstallCorrection(f.id,f.record,f.at,{assertAbsent:()=>{}});
 for(const reference of [f.request.correction.failure,f.request.correction.owners[0].exit,f.record.predecessorStatus,f.record.predecessorTransport]){
  const bytes=readFileSync(reference.path);writeFileSync(reference.path,'{}');
  assert.throws(()=>verifyPostinstallAuthority(f.journal,f.id,{now:f.at+1,effect:true}));writeFileSync(reference.path,bytes);
 }
 assert.doesNotThrow(()=>verifyPostinstallAuthority(f.journal,f.id,{now:f.at+1,effect:true}));
});
