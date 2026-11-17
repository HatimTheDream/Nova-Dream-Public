import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from '../support/release-publication-grant-fixture.mjs';
import {postinstallReadinessFixture,postinstallAcceptanceFixture} from '../support/postinstall-browser-fixture.mjs';
import {verifyPostinstallBrowserRecovery} from '../scripts/release-delivery-postinstall-browser.mjs';
import {sha256} from '../scripts/release-plan.mjs';
import {postinstallRequestSchema,postinstallCoverageSchema,postinstallCoverage,POSTINSTALL_SCOPE,POSTINSTALL_GAPS,postinstallSnapshot,postinstallAuthoritySchema,verifyPostinstallAuthority,verifyPostinstallAdmission,reconcilePostinstallBrowser} from '../scripts/release-delivery-postinstall-recovery.mjs';
import {deliveryProfileSchema} from '../scripts/release-delivery-initialize.mjs';
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const doc=r=>JSON.parse(readFileSync(r.path));
const coverage={acceptanceScope:POSTINSTALL_SCOPE,originalTransitionCoverage:'unverified',transitionCoverageGaps:[...POSTINSTALL_GAPS]};
function setup(t,{acceptance=false}={}){
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
 const sourceBytes=readFileSync(new URL('../scripts/release-delivery-postinstall-recovery.mjs',import.meta.url)),rows=[{name:'release-delivery-postinstall-recovery.mjs',sha256:sha256(sourceBytes)}];for(const side of ['private','public'])save('current-'+side+'/'+(side==='private'?'edition3/':'')+'scripts/release-delivery-postinstall-recovery.mjs',sourceBytes);
 const ci=s=>({requestedAttempt:1,run:{id:10,run_attempt:1,repository:{full_name:s.repository},head_sha:s.commit,head_branch:s.branch,event:'push',path:'.github/workflows/operator-continuation-quality.yml',name:'Operator continuation quality',status:'completed',conclusion:'success'},jobs:{total_count:1,jobs:[{id:11,run_id:10,head_sha:s.commit,name:'quality',status:'completed',conclusion:'success',steps:['Run npm run quality','Verify Linux update recovery'].map(name=>({name,status:'completed',conclusion:'success'}))}]}});
 const operator={adapterIdentity:sha256(canonical(rows)),sources:operatorSources,sourceFiles:rows,ci:Object.fromEntries(['private','public'].map(side=>[side,save('current-ci-'+side+'.json',ci(operatorSources[side]))]))};
 const request={format:1,kind:'nova-postinstall-browser-recovery-request',operationId:id,historical:f.request.historical,operatorSources,ciRuns:{private:10,public:10},sessionId:randomUUID(),durationMs:600000,capacity:{diskReserveBytes:2147483648,workingAllowanceBytes:536870912},owner,failure};
 const options={now:at,assertAbsent:()=>{}};
 const snapshot=()=>postinstallSnapshot(journal,id,request,options);
 const planValue={format:1,kind:'nova-postinstall-browser-recovery-plan',operationId:id,request,snapshot:snapshot(),operator,browserReadiness:save('readonly-browser.json',acceptance?postinstallReadinessFixture(browserInput,{sessionId:request.sessionId,now:at,requestSha256:sha256(canonical(request)),capacity:request.capacity}):{syntheticReadOnlyEdge:true}),plannedAtMs:at,readOnly:true,hostEffects:false,journalWrites:false};
 const plan=save('plan.json',planValue),review=save('review.json',{kind:'nova-postinstall-browser-plan-review',status:'passed',independentReview:true,plan,operationId:id,operatorAdapterIdentity:operator.adapterIdentity});
 const intentRef=save('execution-intent.json',{kind:'nova-postinstall-browser-execution-intent',operationId:id,plan,review,sessionId:request.sessionId,browserOnly:true,automaticReplayPermitted:false,issuedAtMs:at,expiresAtMs:at+60000});
 const admitted={...request,admission:{plan,review,intent:intentRef}},requestRef=save('admitted-request.json',admitted);
 const authority=()=>postinstallAuthoritySchema.parse({format:1,kind:'nova-postinstall-browser-observation-authority',operationId:id,sessionId:request.sessionId,startedAtMs:at,deadlineAtMs:at+request.durationMs,request:requestRef,plan,browserReadiness:planValue.browserReadiness,browserKey:br.key,browserInputSha256:br.inputSha256,snapshot:snapshot(),operator,...coverage,automaticRenewal:false,installationPermitted:false,assistantDispatchPermitted:false});
 return {...f,at,previous,request,admitted,requestRef,operator,planValue,authority,snapshot,coordinator};
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
 assert.deepEqual(seen,[proof]);assert.equal(result.complete,false);assert.deepEqual(postinstallCoverage(result),coverage);assert.equal(f.journal.deliveryPostinstallRecovery(f.id).proof.deadlineAtMs,proof.deadlineAtMs);
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
