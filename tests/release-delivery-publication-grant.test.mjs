import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {ReleaseJournal} from '../scripts/release-coordinate.mjs';
import {sha256,assessTimeline} from '../scripts/release-plan.mjs';
import {PREWRITE_PREREQUISITES} from '../scripts/release-delivery-disposition.mjs';
import {deliveryAdapterIdentity,deliveryAdapterSourceFiles} from '../scripts/release-delivery-adapters.mjs';
import {browserBinding} from '../scripts/release-delivery-browser.mjs';
import {verifyContinuationGrant,verifyContinuationStorageAuthority,verifyCompletedOriginalStorage,originalOwnerObservationArguments,verifyPublicationStorageAdmission} from '../scripts/release-delivery-continuation.mjs';
import {PUBLICATION_PACKAGE_SUBSTEPS,PUBLICATION_CONTINUATION_PREREQUISITES,publicationContinuationSnapshot,publicationContinuationRequestSchema,verifyPublicationContinuationAdmission} from '../scripts/release-delivery-continuation.mjs';
import {stepDelivery} from '../scripts/release-deliver.mjs';
import {fullHostFixture} from '../support/full-host-fixture.mjs';
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const app=fileURLToPath(new URL('..',import.meta.url)),source=readFileSync(new URL('../scripts/release-coordinate.mjs',import.meta.url),'utf8');
const baseSchema=source.match(/this\.db\.exec\(`(PRAGMA journal_mode=WAL;[\s\S]+?PRAGMA user_version=1; COMMIT;)`\);/)[1].replace('${APPLICATION_ID}',String(0x4e56524c));
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'nova-continuation-')),journal=Object.create(ReleaseJournal.prototype);journal.db=new DatabaseSync(':memory:');journal.readOnly=false;journal.directory=join(dir,'journal');mkdirSync(journal.directory);journal.db.exec(baseSchema);
 t.after(()=>{journal.close();rmSync(dir,{recursive:true,force:true});});
 const save=(name,value)=>{const path=join(dir,name);mkdirSync(dirname(path),{recursive:true});const raw=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)+'\n');writeFileSync(path,raw,{mode:0o600});return {path,sha256:sha256(raw)};};
 const host=fullHostFixture(),now=1700000000000,id=host.key,oldRoot=join(dir,'historical'),node=save('node.bin',Buffer.from('synthetic executable'));
 const oldEntry=save('historical/scripts/release-deliver.mjs',Buffer.from('// synthetic original entry'));
 const oldAdapter=save('historical/scripts/release-delivery-adapters.mjs',Buffer.from('// synthetic original adapter'));
 const oldRows=[{name:'release-delivery-adapters.mjs',sha256:oldAdapter.sha256},{name:'release-deliver.mjs',sha256:oldEntry.sha256}];
 const original={id:randomUUID(),step:'total',issuedAtMs:now,remainingMs:[1000,2000],confidence:'low',basis:'Synthetic original estimate.',reason:'Original estimate.',nextCheckpointAtMs:now+300000};
 const operation={...host.descriptor.operation,stage:'draft',candidateId:null,publicCandidateId:null,version:'8.1.0',buildVersion:'1.0.801',sourceCommits:{private:'a'.repeat(40),public:'b'.repeat(40)},bundleSha256:null,trustedPublicKeySha256:sha256('key'),helperHashes:null};
 const d={format:1,operation,sources:{private:{root:join(dir,'original-private'),repository:'HatimTheDream/Nova-Dream',commit:'a'.repeat(40),baseCommit:'c'.repeat(40),branch:'main'},public:{root:join(dir,'original-public'),repository:'HatimTheDream/Nova-Dream-Public',commit:'b'.repeat(40),baseCommit:'d'.repeat(40),branch:'main'}},
  target:save('target.json',{artifactTools:{node},full:{host:host.options},transport:{synthetic:true},bases:{private:{candidateId:operation.priorCandidateId,manifest:save('base-manifest.json',{version:'8.0.0',buildVersion:'1.0.800'})}},browserTools:{format:1,mode:'remote',node,executable:node,playwright:node,baseUrl:'http://127.0.0.1:4383',timeoutMs:300000,suite:'tasks-search-escape',user:'nova',directoryRoot:'/opt/browser-tests'}}),targetIdentity:sha256('target'),adapterIdentity:sha256(canonical(oldRows)),timeline:{startedAtMs:now,original,revisions:[],reviews:[],lastCheckpointAtMs:now},observationBudgetMs:60000};
 journal.initializeDelivery(d,now);
 for(const phase of PUBLICATION_CONTINUATION_PREREQUISITES){const {intent}=journal.reserveDeliveryPhase(id,phase,{phase},now+1);if(phase==='package')for(const child of PUBLICATION_PACKAGE_SUBSTEPS){const s=journal.reserveDeliveryPhase(id,child,{parentKey:intent.key,parentInputSha256:intent.inputSha256},now+1).intent;journal.recordDeliveryObservation(id,child,{key:s.key,state:'completed',reason:'synthetic-verified',externalId:s.key,receipt:null,output:{synthetic:true}},now+1);}
 journal.recordDeliveryObservation(id,phase,{key:intent.key,state:'completed',reason:'synthetic-verified',externalId:null,receipt:null,output:phase==='route'?{route:'full',targetCandidateId:sha256('candidate')}:phase==='sign'?{candidateId:sha256('candidate'),priorCandidateId:operation.priorCandidateId}:{phase}},now+1);}
 const reserved=journal.reserveDeliveryPhase(id,'publication',{phase:'publication',candidateCommit:d.sources.private.commit},now+2);
 journal.recordDeliveryObservation(id,'publication',{key:reserved.intent.key,state:'gap',reason:'browser-original-response-unavailable',externalId:null,receipt:null,output:null},now+3);
 const at=now+120000,originalRequest=save('owner/request.json',{format:1,operationId:id,node,deliveryEntry:oldEntry,releaseInput:save('original-start.json',{profile:save('original-profile.json',{synthetic:true})}),storageBudget:save('budget.json',{allocations:[{id:'candidate',bytes:100}]})});
 const oldRequest=JSON.parse(readFileSync(originalRequest.path));
 const process=(pid,parentPid)=>({pid,parentPid,created:'/Date('+now+')/',executable:node.path,commandLineSha256:sha256('process'+pid)});
 const launcher=save('owner/waiting.json',{format:1,kind:'verified-waiting-release-launcher',dispatchAuthority:false,operationId:id,mode:'resume',cwd:oldRoot,node,entry:oldEntry,start:oldRequest.releaseInput,budget:oldRequest.storageBudget,runner:save('runner.bin',Buffer.from('synthetic runner')),config:save('config.json',{}),owner:process(100,1),worker:process(101,100)});
 const o='owner/observations/observation-0001/';
 const attempt={launcher,intent:save(o+'intent.json',{request:originalRequest,sameReleaseOperation:true,argv:[node.path,oldEntry.path,'resume',journal.directory,id]}),exit:save(o+'exit.json',{finishedAtMilliseconds:at-1,returnCode:2}),
  childResult:save(o+'default-child-result.json',{automaticNewOperationPermitted:false,logBoundExceeded:false,originalChildClosed:true,returnCode:2}),stdout:save(o+'stdout.json',{...journal.deliveryStatus(id,at)})};
 const operatorSources={private:{root:basename(app)==='edition3'?dirname(app):join(dir,'current-private'),repository:'HatimTheDream/Nova-Dream',branch:'operator/publication-continuation-r1',commit:'e'.repeat(40)},public:{root:basename(app)==='edition3'?join(dir,'current-public'):app,repository:'HatimTheDream/Nova-Dream-Public',branch:'operator/publication-continuation-r1',commit:'f'.repeat(40)}};
 // The authority always references the private operator entry, including in the standalone public layout.
 if(basename(app)!=='edition3')save('current-private/edition3/scripts/release-deliver.mjs',readFileSync(new URL('../scripts/release-deliver.mjs',import.meta.url)));
 const request={format:1,kind:'nova-expired-publication-request',operationId:id,historical:{root:oldRoot,manifest:save('original-graph.json',{format:1,adapterIdentity:d.adapterIdentity,sourceFiles:[oldAdapter,oldEntry]})},owner:{request:originalRequest,attempts:[attempt]},operatorSources,ciRuns:{private:10,public:20},durationMs:60000,publication:{key:reserved.intent.key,inputSha256:reserved.intent.inputSha256,observationSha256:sha256(canonical(journal.deliveryPhase(id,'publication').current))},browser:{predecessor:save('browser-original.json',{synthetic:true}),status:save('browser-closed.json',{synthetic:true}),successorSessionId:randomUUID()}};

 const target=JSON.parse(readFileSync(d.target.path)),binding=browserBinding({descriptor:d,prior:{route:journal.deliveryPhase(id,'route').current.output,sign:journal.deliveryPhase(id,'sign').current.output}},target.browserTools,target.transport);
 request.browser.predecessor=save('journal/browser-session/original.json',{binding,startedAtMs:now-300000,deadlineAtMs:now});
 request.browser.status=save('browser-closed.json',{state:'observed',operationId:id,originalSha256:request.browser.predecessor.sha256,observedAtMs:now+1000,files:{failed:{operationId:id,reason:'browser-original-deadline-exhausted',atMs:now+1},closed:{operationId:id,browserClosed:true,tunnelClosed:true,atMs:now+2},acceptance:null},unitState:'ActiveState=inactive\nMainPID=0\n',ownedPids:[]});
 return {dir,journal,id,now,at,d,save,request,attempt,host,operation};
}
const snapshot=f=>publicationContinuationSnapshot(f.journal,f.id,f.at,{request:f.request,assertAbsent:()=>{}});
function admission(f,override=null){
 const s=snapshot(f),operator=override??{adapterIdentity:sha256('operator'),sources:f.request.operatorSources,sourceFiles:[{name:'synthetic',sha256:sha256('source')}],ci:{private:f.save('ci-private.json',{}),public:f.save('ci-public.json',{})}};
 const requestRef=f.save('planned-request.json',f.request),plan=f.save('plan.json',{format:1,kind:'nova-publication-continuation-plan',operationId:f.id,request:requestRef,snapshot:s,operator,hostFacts:f.save('synthetic-plan-host.json',{}),prestagePlan:f.save('prestage-plan.json',{synthetic:true}),plannedAtMs:f.at,readOnly:true,hostEffects:false,journalWrites:false});
 const review=f.save('review.json',{format:1,kind:'nova-publication-continuation-plan-review',plan,operatorAdapterIdentity:operator.adapterIdentity,status:'passed',independentReview:true});
 const intent=f.save('grant-intent.json',{format:1,kind:'nova-publication-continuation-grant-intent',operationId:f.id,action:f.request.successor?'grant-original-publication-storage-successor':'grant-original-publication-continuation',request:requestRef,plan,review,notBeforeMs:f.at,notAfterMs:f.at+300000,automaticRenewal:false});
 return {request:{...f.request,admission:{plan,review,intent}},operator,snapshot:s};
}
test('publication snapshot retains ten completed phases and a genuine closed gap without relabeling the old result expired',t=>{
 const f=fixture(t),before=f.journal.loadDelivery(f.id),s=snapshot(f);
 assert.equal(s.prerequisites.length,10);assert.deepEqual(s.prerequisites.map(p=>p.phase),PUBLICATION_CONTINUATION_PREREQUISITES);
 assert.deepEqual(s.publication,f.request.publication);assert.equal(s.originalCreatedAtMs,f.now);assert.equal(s.originalBudgetMs,60000);
 assert.deepEqual(f.journal.loadDelivery(f.id),before);assert.equal(JSON.parse(readFileSync(f.attempt.stdout.path)).observationBudgetExpired,undefined);
 assert.equal(f.journal.deliveryOperatorContinuation(f.id),null);
});
test('unexpired authority, live owner, and unclassified child refuse publication continuation',t=>{
 const f=fixture(t);
 assert.throws(()=>publicationContinuationSnapshot(f.journal,f.id,f.now+60000,{request:f.request,assertAbsent:()=>{}}),/budget-not-expired/);
 assert.throws(()=>publicationContinuationSnapshot(f.journal,f.id,f.at,{request:f.request,assertAbsent:()=>{throw Error('still live');}}),/still live/);
 mkdirSync(join(f.dir,'owner/observations/observation-0002'));
 assert.throws(()=>snapshot(f),/unclassified/);
});
test('changed reserved publication or any downstream phase cannot be adopted',t=>{
 for(const field of ['key','inputSha256','observationSha256']){const f=fixture(t);f.request.publication[field]=field==='key'?randomUUID():sha256('different');assert.throws(()=>snapshot(f),/reservation-changed/);}
 const f=fixture(t);f.journal.db.prepare('INSERT INTO delivery_phases VALUES(?,?,?,?,?,?)').run(f.id,'installation',randomUUID(),'{}',sha256('{}'),f.at);
 assert.throws(()=>snapshot(f),/downstream-reservation/);
});
test('failed completed-prerequisite validation and changed original owner outcome refuse',t=>{
 const f=fixture(t);f.journal.recordDeliveryRevalidation(f.id,'recovery',{state:'failed',reason:'changed-retained-rehearsal'},f.at);
 assert.throws(()=>snapshot(f),/prerequisites-not-complete/);
 const g=fixture(t);g.attempt.childResult=g.save('owner/observations/observation-0001/default-child-result.json',{automaticNewOperationPermitted:false,logBoundExceeded:false,originalChildClosed:false,returnCode:2});
 assert.throws(()=>snapshot(g),/owner-not-closed/);
});
test('publication schema permits only its generic operator branch and preserves the prepackage boundary',t=>{
 const f=fixture(t);assert.deepEqual(publicationContinuationRequestSchema.parse(f.request),f.request);
 const bad=structuredClone(f.request);bad.operatorSources.private.branch='codex/operator-continuation-31';assert.throws(()=>publicationContinuationRequestSchema.parse(bad));
});
test('grant requires the exact actual plan, independent review and separate finite intent',t=>{
 const f=fixture(t),a=admission(f);assert.equal(verifyPublicationContinuationAdmission(a.request,a.operator,a.snapshot,f.at).kind,'nova-publication-continuation-plan');
 for(const mutate of [x=>x.request.durationMs++,x=>x.operator.adapterIdentity=sha256('changed'),x=>x.snapshot.originalBudgetMs++,x=>x.request.browser.successorSessionId=randomUUID()]){
  const bad=structuredClone(a);mutate(bad);assert.throws(()=>verifyPublicationContinuationAdmission(bad.request,bad.operator,bad.snapshot,f.at));
 }
 assert.throws(()=>verifyPublicationContinuationAdmission(a.request,a.operator,a.snapshot,f.at+300000),/separate-intent/);
 assert.throws(()=>verifyPublicationContinuationAdmission(a.request,a.operator,a.snapshot,f.at+900001),/plan-stale/);
 const bad=structuredClone(a),review=JSON.parse(readFileSync(bad.request.admission.review.path));review.independentReview=false;bad.request.admission.review=f.save('bad-review.json',review);
 assert.throws(()=>verifyPublicationContinuationAdmission(bad.request,bad.operator,bad.snapshot,f.at),/plan-review/);
});
test('a changed history prefix invalidates an otherwise matching planned snapshot',t=>{
 const f=fixture(t),a=admission(f);
 f.journal.checkpointDelivery(f.id,{...f.d.timeline,lastCheckpointAtMs:f.at+1},f.at+1);f.at++;
 assert.throws(()=>verifyPublicationContinuationAdmission(a.request,a.operator,snapshot(f),f.at+1),/plan-binding/);
});

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
test('actual journal commits one immutable publication grant, preserves all original keys and refuses renewal',t=>{
 const f=fixture(t),g=grantFixture(f),before=f.journal.loadDelivery(f.id),keys=[...PUBLICATION_CONTINUATION_PREREQUISITES,'publication'].map(p=>f.journal.deliveryPhase(f.id,p).key),saved=g.grant();
 assert.deepEqual(g.grant(),saved);assert.deepEqual(f.journal.loadDelivery(f.id),before);assert.deepEqual([...PUBLICATION_CONTINUATION_PREREQUISITES,'publication'].map(p=>f.journal.deliveryPhase(f.id,p).key),keys);
 assert.throws(()=>f.journal.recordOperatorContinuation(f.id,{...g.proof,expiresAtMs:g.proof.expiresAtMs+1},f.at),/already-granted/);
 assert.throws(()=>f.journal.db.prepare('DELETE FROM delivery_operator_continuations WHERE operation_id=?').run(f.id),/immutable/);
 verifyContinuationGrant(f.journal,f.id,{now:g.proof.expiresAtMs+1});assert.throws(()=>verifyContinuationGrant(f.journal,f.id,{now:g.proof.expiresAtMs,effect:true}),/window-expired/);
});
test('actual grant transaction refuses a concurrent downstream reservation without writing authority',t=>{
 const f=fixture(t),g=grantFixture(f);f.journal.db.prepare('INSERT INTO delivery_phases VALUES(?,?,?,?,?,?)').run(f.id,'installation',randomUUID(),'{}',sha256('{}'),f.at);
 assert.throws(()=>g.grant(),/downstream-reservation/);assert.equal(f.journal.deliveryOperatorContinuation(f.id),null);
});

test('all seven completed package child identities are retained; a failed child refuses',t=>{
 const f=fixture(t),s=snapshot(f),parent=f.journal.deliveryPhase(f.id,'package');
 assert.deepEqual(s.packageSubsteps.map(p=>p.phase),PUBLICATION_PACKAGE_SUBSTEPS);assert(s.packageSubsteps.every(p=>p.parentKey===parent.key&&p.parentInputSha256===parent.inputSha256));
 f.journal.recordDeliveryRevalidation(f.id,'package/pair',{state:'failed',reason:'changed-pair-proof'},f.at);
 assert.throws(()=>snapshot(f),/package-substeps-changed/);
});

async function storageAdmissionFixture(f){
 const g=grantFixture(f),saved=g.grant(),authority=await verifyContinuationStorageAuthority({journal:f.journal,operationId:f.id,now:f.at});
 assert.equal(authority.continuationStarted,false);
 assert(readFileSync(authority.operatorEntry.path).equals(readFileSync(new URL('../scripts/release-deliver.mjs',import.meta.url))));
 const originalDispatch=f.save('owner/release-dispatch.json',{synthetic:true}),dispatch=f.save('owner/continuations/'+saved.sha256+'/admission-0001/release-dispatch.json',{
  format:1,grantSha256:saved.sha256,request:f.request.owner.request,originalDispatch,automaticNewOperationPermitted:false,startedAtMilliseconds:f.at,
  storageResult:{state:'ready',historical:false,observationExpiresAtMilliseconds:f.at+120000}});
 const session=f.save('owner/session-observation-0002.json',{format:1,kind:'nova-storage-default-session',mode:'resume',operationId:f.id,
  request:f.request.owner.request,dispatch:originalDispatch,continuationDispatch:dispatch,operatorContinuation:authority,issuedAtMilliseconds:f.at,
  descriptor:f.save('storage-descriptor.json',f.d),sourceGraph:f.save('storage-graph.json',{format:1,adapterIdentity:g.proof.operator.adapterIdentity})});
 return{g,saved,authority,admission:{format:1,kind:'nova-publication-continuation-storage-admission',operationId:f.id,grantSha256:saved.sha256,dispatch,session,verifiedAtMs:f.at}};
}
test('publication storage admission records one native event only after genuine first-session binding and survives a crash before phase progress',async t=>{
 const f=fixture(t),x=await storageAdmissionFixture(f),phase=f.journal.deliveryPhase(f.id,'publication');
 assert.equal(f.journal.deliveryPublicationContinuationAdmission(f.id),null);
 const result=f.journal.recordPublicationContinuationAdmission(f.id,x.admission,f.at);
 assert.deepEqual(f.journal.recordPublicationContinuationAdmission(f.id,x.admission,f.at+1),result);
 assert.deepEqual(f.journal.deliveryPhase(f.id,'publication'),phase);
 const next=await verifyContinuationStorageAuthority({journal:f.journal,operationId:f.id,now:f.at+1});assert.equal(next.continuationStarted,true);
 assert.deepEqual({...next,continuationStarted:false},x.authority);
 const swapped={...x.admission,session:f.save('owner/session-observation-0003.json',JSON.parse(readFileSync(x.admission.session.path)))};
 assert.throws(()=>f.journal.recordPublicationContinuationAdmission(f.id,swapped,f.at+1),/already-recorded/);
 assert.throws(()=>f.journal.db.prepare("DELETE FROM delivery_events WHERE operation_id=? AND kind='publication-continuation-storage-admitted'").run(f.id),/immutable/);
});
test('publication storage admission rejects wrong grant, stale dispatch and a session already claiming started',async t=>{
 for(const change of ['grant','stale','started']){
  const f=fixture(t),x=await storageAdmissionFixture(f),a=structuredClone(x.admission);
  if(change==='grant')a.grantSha256=sha256('other grant');
  if(change==='stale'){const d=JSON.parse(readFileSync(a.dispatch.path));d.storageResult.observationExpiresAtMilliseconds=f.at-1;a.dispatch=f.save('owner/continuations/'+x.saved.sha256+'/admission-0001/release-dispatch.json',d);const s=JSON.parse(readFileSync(a.session.path));s.continuationDispatch=a.dispatch;a.session=f.save('owner/session-observation-0002.json',s);}
  if(change==='started'){const s=JSON.parse(readFileSync(a.session.path));s.operatorContinuation.continuationStarted=true;a.session=f.save('owner/session-observation-0002.json',s);}
  assert.throws(()=>f.journal.recordPublicationContinuationAdmission(f.id,a,a.verifiedAtMs));
  assert.equal(f.journal.deliveryPublicationContinuationAdmission(f.id),null);
 }
});
test('publication storage admission read-only access cannot append an event or infer admission from a saved session',async t=>{
 const f=fixture(t),x=await storageAdmissionFixture(f);
 assert.equal((await verifyContinuationStorageAuthority({journal:f.journal,operationId:f.id,now:f.at})).continuationStarted,false);
 f.journal.readOnly=true;assert.equal(f.journal.deliveryPublicationContinuationAdmission(f.id),null);
 assert.throws(()=>f.journal.recordPublicationContinuationAdmission(f.id,x.admission,f.at),/readonly-journal/);
 f.journal.readOnly=false;assert.equal(f.journal.deliveryPublicationContinuationAdmission(f.id),null);
});

test('publication storage admission detects duplicated event and changed retained receipt bytes',async t=>{
 const f=fixture(t),x=await storageAdmissionFixture(f);f.journal.recordPublicationContinuationAdmission(f.id,x.admission,f.at);
 const row=f.journal.db.prepare("SELECT * FROM delivery_events WHERE operation_id=? AND kind='publication-continuation-storage-admitted'").get(f.id);
 f.journal.db.prepare('INSERT INTO delivery_events(operation_id,at_ms,kind,payload_json,payload_hash) VALUES(?,?,?,?,?)').run(f.id,row.at_ms,row.kind,row.payload_json,row.payload_hash);
 assert.throws(()=>f.journal.deliveryPublicationContinuationAdmission(f.id),/duplicate/);
 const g=fixture(t),y=await storageAdmissionFixture(g);g.journal.recordPublicationContinuationAdmission(g.id,y.admission,g.at);
 writeFileSync(y.admission.dispatch.path,'{}');assert.throws(()=>g.journal.deliveryPublicationContinuationAdmission(g.id),/evidence-hash-changed/);
});


function completedStorageFixture(f,previous){
 const save=f.save,parentId='a1111111-1111-4111-8111-111111111111',childId='5656c24f-0cc8-5606-a624-11a1351738bc',generationId='10145439-e729-52d7-a6d1-6720cefe84b1';
 const prefix='owner/continuations/'+previous.sha256+'/admission-0002/before-delivery',directory=join(f.dir,prefix),batchDirectory=join(directory,'batch-001');mkdirSync(batchDirectory,{recursive:true});
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
function successorFixture(t){
 const f=fixture(t),original=grantFixture(f),previous=original.grant(),storage=completedStorageFixture(f,previous),save=f.save;
 const request={...f.request,operatorSources:Object.fromEntries(Object.entries(f.request.operatorSources).map(([k,v])=>[k,{...v,branch:'operator/publication-storage-successor-r1'}])),
  successor:{predecessorGrantSha256:previous.sha256,completedOriginalStorage:storage.marker,reason:'Original reserved storage completed after the first finite window.'}};
 const next={...f,request,at:previous.proof.expiresAtMs+1,save:(name,value)=>save('successor/'+name,value)},g=grantFixture(next);
 return {f,next,original,previous,storage,proof:g.proof,grant:()=>f.journal.recordPublicationStorageSuccessor(f.id,g.proof,next.at,{assertAbsent:()=>{}})};
}
test('one explicit storage successor is append-only and preserves original proof, clock, scope and all passed keys',t=>{
 const x=successorFixture(t),before=x.f.journal.loadDelivery(x.f.id),oldRow=x.f.journal.db.prepare('SELECT * FROM delivery_operator_continuations').get(),keys=x.proof.prerequisites.map(p=>p.key),saved=x.grant();
 assert.deepEqual(x.f.journal.loadDelivery(x.f.id),before);assert.deepEqual(x.f.journal.db.prepare('SELECT * FROM delivery_operator_continuations').get(),oldRow);
 assert.deepEqual(x.f.journal.deliveryOriginalOperatorContinuation(x.f.id),x.previous);assert.deepEqual(x.grant(),saved);assert.notEqual(saved.sha256,x.previous.sha256);
 assert.deepEqual(saved.proof.prerequisites.map(p=>p.key),keys);assert.equal(saved.proof.originalCreatedAtMs,x.original.proof.originalCreatedAtMs);assert.equal(saved.proof.originalBudgetMs,x.original.proof.originalBudgetMs);
 assert.deepEqual(saved.proof.browser,x.original.proof.browser);assert.equal(saved.proof.automaticRenewal,false);
 assert.throws(()=>x.f.journal.recordOperatorContinuation(x.f.id,x.proof,x.next.at),/explicit-record/);
 assert.throws(()=>x.f.journal.recordPublicationStorageSuccessor(x.f.id,{...x.proof,expiresAtMs:x.proof.expiresAtMs+1},x.next.at),/already-granted/);
 assert.throws(()=>x.f.journal.db.prepare("DELETE FROM delivery_events WHERE kind='publication-storage-successor-granted'").run(),/immutable/);
 assert.throws(()=>x.f.journal.db.prepare("UPDATE delivery_events SET at_ms=at_ms+1 WHERE kind='publication-storage-successor-granted'").run(),/immutable/);
});
test('successor authority derives exactly one completed-storage marker and expires new effects normally',async t=>{
 const x=successorFixture(t);x.grant();const authority=await verifyContinuationStorageAuthority({journal:x.f.journal,operationId:x.f.id,now:x.next.at});
 assert.equal(Object.keys(authority).length,11);assert.deepEqual(authority.completedOriginalStorage,x.storage.marker);assert.equal(authority.continuationStarted,false);
 verifyContinuationGrant(x.f.journal,x.f.id,{now:x.next.at,effect:true,assertAbsent:()=>{}});
 assert.throws(()=>verifyContinuationGrant(x.f.journal,x.f.id,{now:x.proof.expiresAtMs,effect:true,assertAbsent:()=>{}}),/window-expired/);
 assert.doesNotThrow(()=>verifyContinuationGrant(x.f.journal,x.f.id,{now:x.proof.expiresAtMs+1,effect:false}));
});
test('successor requires a distinct explicit intent action and unchanged original scope',t=>{
 const x=successorFixture(t),bad={...x.next.request,browser:{...x.next.request.browser,successorSessionId:randomUUID()}};
 assert.throws(()=>publicationContinuationSnapshot(x.f.journal,x.f.id,x.next.at,{request:bad,assertAbsent:()=>{}}),/original-scope/);
 const request=JSON.parse(readFileSync(x.proof.request.path)),intent=JSON.parse(readFileSync(request.admission.intent.path));intent.action='grant-original-publication-continuation';
 request.admission.intent=x.f.save('wrong-successor-intent.json',intent);
 assert.throws(()=>verifyPublicationContinuationAdmission(request,x.proof.operator,snapshot(x.next),x.next.at),/separate-intent/);
});
test('unexpired predecessor, a competing installation, and a second successor refuse before granting',t=>{
 const x=successorFixture(t);
 assert.throws(()=>publicationContinuationSnapshot(x.f.journal,x.f.id,x.previous.proof.expiresAtMs-1,{request:x.next.request,assertAbsent:()=>{}}),/recovery-time|not-expired/);
 x.f.journal.db.prepare('INSERT INTO delivery_phases VALUES(?,?,?,?,?,?)').run(x.f.id,'installation',randomUUID(),'{}',sha256('{}'),x.next.at);
 assert.throws(()=>x.grant(),/downstream-reservation/);assert.deepEqual(x.f.journal.deliveryOperatorContinuation(x.f.id),x.previous);
});
test('successor refuses a predecessor native admission or an existing later batch',async t=>{
 const f=fixture(t),admitted=await storageAdmissionFixture(f);f.journal.recordPublicationContinuationAdmission(f.id,admitted.admission,f.at);
 const storage=completedStorageFixture(f,admitted.saved),request={...f.request,operatorSources:Object.fromEntries(Object.entries(f.request.operatorSources).map(([k,v])=>[k,{...v,branch:'operator/publication-storage-successor-r1'}])),successor:{predecessorGrantSha256:admitted.saved.sha256,completedOriginalStorage:storage.marker,reason:'Must refuse already admitted predecessor.'}};
 assert.throws(()=>publicationContinuationSnapshot(f.journal,f.id,admitted.saved.proof.expiresAtMs+1,{request,assertAbsent:()=>{}}),/already-admitted/);
 const x=successorFixture(t);mkdirSync(join(x.storage.directory,'batch-002'));
 assert.throws(()=>x.grant(),/original-admission-already-used/);
});
test('successor requires genuine completion, protected cleanup, original lineage and independent outcome',t=>{
 for(const field of ['state','protectedRolesVerified','operationId']){
  const x=successorFixture(t),result=JSON.parse(readFileSync(x.storage.result.path));result.storage[field]=field==='state'?'cleanup-insufficient':field==='protectedRolesVerified'?false:randomUUID();
  const marker={...x.storage.marker,result:x.f.save('tampered-'+field+'.json',result)};
  assert.throws(()=>verifyCompletedOriginalStorage(x.f.journal,x.f.id,marker,{predecessor:x.previous,now:x.next.at}),/native-completion|independent-outcome/);
 }
 const x=successorFixture(t),review=JSON.parse(readFileSync(x.storage.review.path));review.independentReview=false;
 assert.throws(()=>verifyCompletedOriginalStorage(x.f.journal,x.f.id,{...x.storage.marker,review:x.f.save('not-independent.json',review)},{predecessor:x.previous,now:x.next.at}),/independent-outcome/);
});
test('legacy authority stays exactly ten fields and no implicit successor is issued by observation',async t=>{
 const f=fixture(t),g=grantFixture(f),old=g.grant(),authority=await verifyContinuationStorageAuthority({journal:f.journal,operationId:f.id,now:g.proof.expiresAtMs+1});
 assert.equal(Object.keys(authority).length,10);assert.equal(authority.newEffectsAllowed,false);assert.equal(authority.completedOriginalStorage,undefined);
 assert.deepEqual(f.journal.deliveryOperatorContinuation(f.id),old);assert.equal(f.journal.db.prepare("SELECT count(*) AS n FROM delivery_events WHERE kind='publication-storage-successor-granted'").get().n,0);
});

test('Windows owner observation uses the identical readable bounded query and rejects noninteger process ids',()=>{
 const argv=originalOwnerObservationArguments(1234);
 assert.deepEqual(argv.slice(0,3),['-NoProfile','-NonInteractive','-Command']);assert.equal(argv.length,4);
 assert.match(argv[3],/Get-CimInstance Win32_Process -Filter 'ProcessId = 1234'/);assert.match(argv[3],/CreationDate/);
 assert(!argv.includes('-EncodedCommand'));assert(!argv[3].includes('Stop-Process'));
 for(const pid of [0,-1,1.5,'1234;bad'])assert.throws(()=>originalOwnerObservationArguments(pid),/process-id-invalid/);
});

test('readable Windows owner query observes the current process without elevation', {skip:process.platform!=='win32'},()=>{
 const raw=execFileSync(join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),originalOwnerObservationArguments(process.pid),{encoding:'utf8',timeout:15000,maxBuffer:65536,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const observed=JSON.parse(raw);assert.equal(observed.pid,process.pid);assert.match(observed.created,/^\/Date\([0-9]+\)\/$/);
});

test('successor native admission requires the exact marker on both session and readonly dispatch',async t=>{
 const x=successorFixture(t),saved=x.grant(),authority=await verifyContinuationStorageAuthority({journal:x.f.journal,operationId:x.f.id,now:x.next.at});
 const make=(n,change={})=>{
  const prefix='owner/continuations/'+saved.sha256+'/admission-'+String(n).padStart(4,'0'),storageInput=x.f.save(prefix+'/before-delivery/input.json',{synthetic:true});
  const readonly=x.f.save(prefix+'/readonly.json',{kind:'private-storage-preflight',state:'ready',cleanupPerformed:false,assessment:{fits:true,releaseAdmission:false}});
  const result={state:'ready',historical:false,result:readonly,cleanupPerformed:false,scope:'fresh-capacity-admission-check-only',observationExpiresAtMilliseconds:x.next.at+120000};
  const originalDispatch=x.f.save('owner/release-dispatch.json',{synthetic:true});
  const dispatchValue={format:1,grantSha256:saved.sha256,request:x.f.request.owner.request,originalDispatch,automaticNewOperationPermitted:false,startedAtMilliseconds:x.next.at,
   completedOriginalStorage:x.storage.marker,storageInput,storageMaintenanceInput:storageInput,storageMaintenanceResult:result,storageResult:result,...change.dispatch};
  const dispatch=x.f.save(prefix+'/release-dispatch.json',dispatchValue),session=x.f.save('owner/session-observation-'+String(n+10).padStart(4,'0')+'.json',{
   format:1,kind:'nova-storage-default-session',mode:'resume',operationId:x.f.id,request:x.f.request.owner.request,dispatch:originalDispatch,continuationDispatch:dispatch,
   operatorContinuation:{...authority,...change.authority},issuedAtMilliseconds:x.next.at,descriptor:x.f.save('successor-storage-descriptor.json',x.f.d),sourceGraph:x.f.save('successor-storage-graph.json',{format:1,adapterIdentity:x.proof.operator.adapterIdentity})});
  return {format:1,kind:'nova-publication-continuation-storage-admission',operationId:x.f.id,grantSha256:saved.sha256,dispatch,session,verifiedAtMs:x.next.at};
 };
 assert.throws(()=>verifyPublicationStorageAdmission(x.f.journal,x.f.id,make(1,{authority:{completedOriginalStorage:undefined}})),/readonly-admission/);
 assert.throws(()=>verifyPublicationStorageAdmission(x.f.journal,x.f.id,make(2,{dispatch:{completedOriginalStorage:undefined}})),/readonly-admission/);
 assert.throws(()=>verifyPublicationStorageAdmission(x.f.journal,x.f.id,make(3,{dispatch:{storageMaintenanceResult:{cleanupPerformed:true}}})),/readonly-admission/);
 // These owners are synthetic: never probe unrelated runner processes with their fixture PIDs.
 let ownerProbeCode='EPERM';
 const ownerProbe=t.mock.method(process,'kill',(pid,signal)=>{
  assert([100,101].includes(pid));assert.equal(signal,0);
  throw Object.assign(new Error('Synthetic owner observation'),{code:ownerProbeCode});
 });
 try{
  const good=make(4);
  assert.throws(()=>x.f.journal.recordPublicationContinuationAdmission(x.f.id,good,x.next.at),/owner-closure-unavailable/);
  assert.equal(x.f.journal.deliveryPublicationContinuationAdmission(x.f.id),null);
  ownerProbeCode='ESRCH';
  x.f.journal.recordPublicationContinuationAdmission(x.f.id,good,x.next.at);
  assert.deepEqual(ownerProbe.mock.calls.map(call=>call.arguments),[[100,0],[100,0],[101,0]]);
  assert.equal((await verifyContinuationStorageAuthority({journal:x.f.journal,operationId:x.f.id,now:x.next.at+1})).continuationStarted,true);
 }finally{ownerProbe.mock.restore();}
});
