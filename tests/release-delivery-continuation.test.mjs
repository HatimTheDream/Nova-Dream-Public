import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {ReleaseJournal} from '../scripts/release-coordinate.mjs';
import {sha256,assessTimeline} from '../scripts/release-plan.mjs';
import {PREWRITE_PREREQUISITES} from '../scripts/release-delivery-disposition.mjs';
import {deliveryAdapterIdentity,deliveryAdapterSourceFiles} from '../scripts/release-delivery-adapters.mjs';
import {continuationSnapshot,verifyContinuationTimeline,verifyContinuationGrant,verifyContinuationStorageAuthority,verifyOperatorCi,assertDeliveryOperator} from '../scripts/release-delivery-continuation.mjs';
import {stepDelivery} from '../scripts/release-deliver.mjs';
import {normalizedDeliveryDescriptor} from '../scripts/release-delivery-journal.mjs';
import {acceptedDependencyBasis,correctedDependencyTarget,correctionGrantKind,correctionRequestKind,correctionBranch,correctionForPhase,graphRefusal} from '../scripts/release-delivery-dependency-correction.mjs';
import {fullHostFixture} from '../support/full-host-fixture.mjs';
import {dependencyCorrectionFixture} from '../support/dependency-correction-fixture.mjs';
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const app=fileURLToPath(new URL('..',import.meta.url)),source=readFileSync(new URL('../scripts/release-coordinate.mjs',import.meta.url),'utf8');
const baseSchema=source.match(/this\.db\.exec\(`(PRAGMA journal_mode=WAL;[\s\S]+?PRAGMA user_version=1; COMMIT;)`\);/)[1].replace('${APPLICATION_ID}',String(0x4e56524c));
function fixture(t,{correction=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'nova-continuation-')),journal=Object.create(ReleaseJournal.prototype);journal.db=new DatabaseSync(':memory:');journal.readOnly=false;journal.directory=join(dir,'journal');mkdirSync(journal.directory);journal.db.exec(baseSchema);
 t.after(()=>{journal.close();rmSync(dir,{recursive:true,force:true});});
 const save=(name,value)=>{const path=join(dir,name);mkdirSync(dirname(path),{recursive:true});const raw=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)+'\n');writeFileSync(path,raw,{mode:0o600});return {path,sha256:sha256(raw)};};
 const host=fullHostFixture(),now=1700000000000,id=host.key,oldRoot=join(dir,'historical'),node=save('node.bin',Buffer.from('synthetic executable'));
 const oldEntry=save('historical/scripts/release-deliver.mjs',Buffer.from('// synthetic original entry'));
 const oldAdapter=save('historical/scripts/release-delivery-adapters.mjs',Buffer.from('// synthetic original adapter'));
 const oldRows=[{name:'release-delivery-adapters.mjs',sha256:oldAdapter.sha256},{name:'release-deliver.mjs',sha256:oldEntry.sha256}];
 const original={id:randomUUID(),step:'total',issuedAtMs:now,remainingMs:[1000,2000],confidence:'low',basis:'Synthetic original estimate.',reason:'Original estimate.',nextCheckpointAtMs:now+300000};
 const operation={...host.descriptor.operation,stage:'draft',candidateId:null,publicCandidateId:null,version:'8.1.0',buildVersion:'1.0.801',sourceCommits:{private:'a'.repeat(40),public:'b'.repeat(40)},bundleSha256:null,trustedPublicKeySha256:sha256('key'),helperHashes:null};
 const native=correction?dependencyCorrectionFixture(save,dir,host.options,operation):null;
 const d={format:1,operation,sources:{private:{root:join(dir,'original-private'),repository:'HatimTheDream/Nova-Dream',commit:'a'.repeat(40),baseCommit:'c'.repeat(40),branch:'main'},public:{root:join(dir,'original-public'),repository:'HatimTheDream/Nova-Dream-Public',commit:'b'.repeat(40),baseCommit:'d'.repeat(40),branch:'main'}},
  target:save('target.json',{artifactTools:{node},full:{host:host.options,...(native?{dependencyTransport:native.transport}:{})}}),targetIdentity:sha256('target'),adapterIdentity:sha256(canonical(oldRows)),timeline:{startedAtMs:now,original,revisions:[],reviews:[],lastCheckpointAtMs:now},observationBudgetMs:60000};
 journal.initializeDelivery(d,now);
 for(const phase of PREWRITE_PREREQUISITES){const {intent}=journal.reserveDeliveryPhase(id,phase,{phase},now+1);journal.recordDeliveryObservation(id,phase,{key:intent.key,state:'completed',reason:'synthetic-verified',externalId:null,receipt:null,output:native?.prior[phase]??(phase==='route'?{route:'full'}:{phase})},now+1);}
 const at=now+(correction?30000:120000),originalRequest=save('owner/request.json',{format:1,operationId:id,node,deliveryEntry:oldEntry,releaseInput:save('original-start.json',{synthetic:true}),storageBudget:save('budget.json',{synthetic:true})});
 const oldRequest=JSON.parse(readFileSync(originalRequest.path));
 const process=(pid,parentPid)=>({pid,parentPid,created:'/Date('+now+')/',executable:node.path,commandLineSha256:sha256('process'+pid)});
 const launcher=save('owner/waiting.json',{format:1,kind:'verified-waiting-release-launcher',dispatchAuthority:false,operationId:id,mode:'resume',cwd:oldRoot,node,entry:oldEntry,start:oldRequest.releaseInput,budget:oldRequest.storageBudget,runner:save('runner.bin',Buffer.from('synthetic runner')),config:save('config.json',{}),owner:process(100,1),worker:process(101,100)});
 const o='owner/observations/observation-0001/';
 const attempt={launcher,intent:save(o+'intent.json',{request:originalRequest,sameReleaseOperation:true,argv:[node.path,oldEntry.path,'resume',journal.directory,id]}),exit:save(o+'exit.json',{finishedAtMilliseconds:at-1,returnCode:2}),
  childResult:save(o+'default-child-result.json',{automaticNewOperationPermitted:false,logBoundExceeded:false,originalChildClosed:true,returnCode:2}),stdout:save(o+'stdout.json',{...journal.deliveryStatus(id,at),observationBudgetExpired:true})};
 const operatorSources={private:{root:basename(app)==='edition3'?dirname(app):join(dir,'current-private'),repository:'HatimTheDream/Nova-Dream',branch:'codex/operator-continuation-31',commit:'e'.repeat(40)},public:{root:basename(app)==='edition3'?join(dir,'current-public'):app,repository:'HatimTheDream/Nova-Dream-Public',branch:'codex/operator-continuation-31',commit:'f'.repeat(40)}};
 // Public CI has no private checkout; materialize only its referenced synthetic entry.
 save('current-private/edition3/scripts/release-deliver.mjs',readFileSync(new URL('../scripts/release-deliver.mjs',import.meta.url)));
 const request={format:1,kind:'nova-expired-prepackage-request',operationId:id,historical:{root:oldRoot,manifest:save('original-graph.json',{format:1,adapterIdentity:d.adapterIdentity,sourceFiles:[oldAdapter,oldEntry]})},owner:{request:originalRequest,attempts:[attempt]},operatorSources,ciRuns:{private:10,public:20},durationMs:60000};
 if(correction){
  const packet=(ref,patch)=>save(relative(dir,ref.path),{...JSON.parse(readFileSync(ref.path)),...patch});
  request.kind=correctionRequestKind;delete request.durationMs;
  for(const side of Object.values(operatorSources))side.branch=correctionBranch;
  request.correction=native.correction;
  attempt.launcher=packet(launcher,{mode:'start'});
  const descriptorFile=join(resolve(journal.directory,'..'),'request-'+id,'descriptor.json');
  attempt.intent=packet(attempt.intent,{argv:[node.path,oldEntry.path,'start',journal.directory,descriptorFile]});
  attempt.exit=packet(attempt.exit,{returnCode:1});attempt.childResult=packet(attempt.childResult,{returnCode:1});
  attempt.stdout=save(relative(dir,attempt.stdout.path),{kind:'nova-release-delivery-error',reason:graphRefusal,automaticReplayPermitted:false});
 }
 const requestRef=save('continuation-request.json',request);
 const ci=s=>({requestedAttempt:1,run:{id:10,run_attempt:1,repository:{full_name:s.repository},head_sha:s.commit,head_branch:s.branch,event:'push',path:'.github/workflows/operator-continuation-quality.yml',name:'Operator continuation quality',status:'completed',conclusion:'success'},jobs:{total_count:1,jobs:[{id:11,run_id:10,run_attempt:1,head_sha:s.commit,name:'quality',status:'completed',conclusion:'success',steps:['Run npm run quality','Verify Linux update recovery'].map(name=>({name,status:'completed',conclusion:'success'}))}]}});
 host.facts.observedAtMilliseconds=at;
 const hostSpec={format:2,sourceCommit:'a'.repeat(40),helperDirectory:host.options.helperDirectory,helperHashes:host.facts.review.helperHashes,hostConfiguration:host.options.hostConfiguration.path,hostConfigurationSha256:host.options.hostConfiguration.sha256,startupGuardFile:null,workspaceEpoch:operation.workspaceEpoch,leaseId:host.facts.review.leaseId,acceptedInstallation:host.options.acceptedInstallation,base:host.facts.base};
 const bytes=Buffer.from(JSON.stringify(host.facts)),hostRef=save('host.json',{spec:hostSpec,facts:host.facts,stdoutRawBase64:bytes.toString('base64'),stdoutSha256:sha256(bytes),hostWrites:false});
 const snapshot=continuationSnapshot(journal,id,at,{request,assertAbsent:()=>{}});
 const proof={format:1,kind:'nova-expired-prepackage-continuation',operationId:id,...snapshot,request:requestRef,operator:{adapterIdentity:deliveryAdapterIdentity(),sources:operatorSources,
  sourceFiles:deliveryAdapterSourceFiles().map(name=>({name,sha256:sha256(readFileSync(new URL('../scripts/'+name,import.meta.url)))})),ci:{private:save('ci-private.json',ci(operatorSources.private)),public:save('ci-public.json',{...ci(operatorSources.public),run:{...ci(operatorSources.public).run,id:20},jobs:{total_count:1,jobs:[{...ci(operatorSources.public).jobs.jobs[0],run_id:20}]}})}},hostFacts:hostRef,issuedAtMs:at,expiresAtMs:at+60000,automaticRenewal:false,originalHistoryPreserved:true};
 if(correction)Object.assign(proof,{kind:correctionGrantKind,correction:request.correction,expiresAtMs:now+d.observationBudgetMs});
 const grant=()=>journal.recordOperatorContinuation(id,proof,at,{assertAbsent:()=>{}});
 return {dir,journal,id,now,at,d,save,request,proof,grant,attempt,native};
}
test('typed pre-reservation dependency correction keeps all six observations, genuine event id and first deadline',async t=>{
 const f=fixture(t,{correction:true}),phases=()=>PREWRITE_PREREQUISITES.map(n=>f.journal.deliveryPhase(f.id,n)),original=phases();
 const g=f.grant();assert.deepEqual(phases(),original);assert.deepEqual(f.grant(),g);
 assert.equal(Number.isSafeInteger(g.eventId)&&g.eventId>0,true);
 const event=f.journal.db.prepare('SELECT kind,payload_json FROM delivery_events WHERE id=?').get(g.eventId);
 assert.equal(event.kind,'prepackage-dependency-input-corrected');assert.equal(JSON.parse(event.payload_json).originalBudgetExpired,false);
 assert.deepEqual(correctionForPhase(f.journal,f.id),f.request.correction);
 const authority=await verifyContinuationStorageAuthority({journal:f.journal,operationId:f.id,now:f.at});
 assert.equal(authority.expiresAtMs,f.now+f.d.observationBudgetMs);
 assert.throws(()=>verifyContinuationGrant(f.journal,f.id,{now:authority.expiresAtMs,effect:true}),/window-expired/);
});
test('correction rejects later reservations, different native error, extended clock, and additional original attempts',t=>{
 for(const cause of ['package','error','expired','extended','extra']){
  const f=fixture(t,{correction:true});
  if(cause==='package')f.journal.reserveDeliveryPhase(f.id,'package',{role:'fixture'},f.now+2);
  if(cause==='expired'){assert.throws(()=>continuationSnapshot(f.journal,f.id,f.now+f.d.observationBudgetMs,{request:f.request}),/original-budget-expired/);continue;}
  if(cause==='extended')f.proof.expiresAtMs++;
  if(cause==='extra')f.request.owner.attempts.push(f.attempt);
  if(cause==='error')f.attempt.stdout=f.save(relative(f.dir,f.attempt.stdout.path),{kind:'nova-release-delivery-error',reason:'different-error',automaticReplayPermitted:false});
  if(['extra','error'].includes(cause))f.proof.request=f.save(relative(f.dir,f.proof.request.path),f.request);
  assert.throws(()=>f.grant());assert.equal(f.journal.deliveryOperatorContinuation(f.id),null);
 }
});
test('storage binding uses the same original target and source path normalization as delivery startup',t=>{
 const f=fixture(t),inputFile=join(f.dir,'start','descriptor.json'),raw=structuredClone(f.d);
 raw.target.path='../target.json';raw.sources.private.root='../original-private';raw.sources.public.root='../original-public';
 const normalized=normalizedDeliveryDescriptor(raw,inputFile);
 assert.deepEqual(normalized,f.d);assert.equal(raw.target.path,'../target.json');
});
test('the envelope can only project the accepted pack onto the unchanged candidate and verified route',t=>{
 const f=fixture(t,{correction:true}),n=f.native,target=JSON.parse(readFileSync(f.d.target.path));
 const actual=correctedDependencyTarget(target,f.d,n.prior,n.correction);
 assert.deepEqual(actual.full.dependencyTransport.nativeInput,n.correction.correctedNativeInput);
 assert.deepEqual({...actual,full:{...actual.full,dependencyTransport:{...actual.full.dependencyTransport,nativeInput:n.correction.originalNativeInput}}},target);
 for(const change of [
  value=>{value.acceptedCandidate=sha256('another candidate');},
  value=>{value.targetLock=value.targetPackage;},
  value=>{value.acceptedInstaller=value.acceptedBundle;},
  value=>{value.nativeReceipt=n.transport.qualifiedDependencies.execution;},
  value=>{value.transition.toVersion='999.0.0';},
  value=>{value.additionalAuthority=true;},
 ]){
  const value=structuredClone(n.native);change(value);
  const proposal={...n.correction,correctedNativeInput:f.save('different-native-input',value)};
  assert.throws(()=>correctedDependencyTarget(target,f.d,n.prior,proposal));
 }
});
test('a prepackage grant cannot select the alternate browser route for another release',t=>{
 const f=fixture(t,{correction:true});
 const request={...f.request,browserWindowPolicy:{kind:'one-prior-then-two-targets',priorCandidateId:f.d.operation.priorCandidateId,targetCandidateId:sha256('other')}};
 assert.throws(()=>continuationSnapshot(f.journal,f.id,f.at,{request,assertAbsent:()=>{}}),/browser-retained-window-policy-target-changed/);
});
test('next profile carries the successful installed native pack and validated package identity',t=>{
 const f=fixture(t,{correction:true}),n=f.native,old=n.old,transport={...n.transport,qualifiedDependencies:old.refs};
 const accepted={pair:transport.selectedPair,result:transport.selectedInstaller,bundle:transport.selectedBundle};
 const candidate=f.d.operation.priorCandidateId,base={candidateId:candidate,directory:dirname(old.packageRef.path)};
 const sign={candidateId:candidate,bundle:accepted.bundle,dependencies:{...old.refs,description:old.description,qualification:old.refs.execution,newNativeDependenciesQualified:true,unchangedNativeDependencies:false}};
 const args={transport,accepted,sign,base,packageRef:old.packageRef,lockRef:old.lockRef};
 const basis=acceptedDependencyBasis(args);assert.deepEqual(basis.oldArchive,old.refs.archive);assert.deepEqual(basis.nativeReceipt,sign.dependencies.execution);
 assert.equal(basis.transition.fromVersion,n.acceptedBinding.targets.private.version);
 assert.throws(()=>acceptedDependencyBasis({...args,sign:{...sign,dependencies:{...sign.dependencies,execution:n.transport.qualifiedDependencies.execution}}}),/accepted-native-pack-changed/);
});
test('one append-only grant preserves descriptor, all six keys and original budget; duplicate cannot renew',t=>{
 const f=fixture(t),before=f.journal.loadDelivery(f.id),keys=PREWRITE_PREREQUISITES.map(n=>f.journal.deliveryPhase(f.id,n).key),g=f.grant();
 assert.deepEqual(f.journal.loadDelivery(f.id),before);assert.deepEqual(PREWRITE_PREREQUISITES.map(n=>f.journal.deliveryPhase(f.id,n).key),keys);
 assert.deepEqual(f.grant(),g);assert.throws(()=>f.journal.recordOperatorContinuation(f.id,{...f.proof,expiresAtMs:f.proof.expiresAtMs+1},f.at),/already-granted/);
 assert.throws(()=>f.journal.db.prepare('DELETE FROM delivery_operator_continuations WHERE operation_id=?').run(f.id),/immutable/);
 assert.throws(()=>f.journal.db.prepare('UPDATE delivery_operator_continuations SET at_ms=? WHERE operation_id=?').run(f.at+1,f.id),/immutable/);
});
test('grant recording rechecks a competing package reservation inside the transaction',t=>{
 const f=fixture(t);f.journal.db.prepare('INSERT INTO delivery_phases VALUES(?,?,?,?,?,?)').run(f.id,'package',randomUUID(),'{}',sha256('{}'),f.at);
 assert.throws(()=>f.grant(),/downstream-reservation/);assert.equal(f.journal.deliveryOperatorContinuation(f.id),null);
});
test('unknown observation directory and live original owner are refused',t=>{
 const f=fixture(t);mkdirSync(join(f.dir,'owner/observations/observation-0002'));
 assert.throws(()=>continuationSnapshot(f.journal,f.id,f.at,{request:f.request,assertAbsent:()=>{}}),/unclassified/);
 assert.throws(()=>continuationSnapshot(f.journal,f.id,f.at,{request:f.request,assertAbsent:()=>{throw Error('live original');}}),/live original/);
});
test('current authority preserves candidate commits, accepts later truthful checkpoint, and expires only new effects',async t=>{
 const f=fixture(t);f.grant();assert.equal(verifyContinuationGrant(f.journal,f.id,{now:f.at,effect:true}).proof.originalBudgetMs,60000);
 const timeline={...f.d.timeline,lastCheckpointAtMs:f.at+1};
 f.journal.checkpointDelivery(f.id,timeline,f.at+1);
 verifyContinuationGrant(f.journal,f.id,{now:f.at+2,effect:true});
 assert.throws(()=>verifyContinuationGrant(f.journal,f.id,{now:f.proof.expiresAtMs,effect:true}),/window-expired/);
 verifyContinuationGrant(f.journal,f.id,{now:f.proof.expiresAtMs+1});
 const authority=await verifyContinuationStorageAuthority({journal:f.journal,operationId:f.id,now:f.at});
 assert.equal(authority.newEffectsAllowed,true);assert.equal(authority.continuationStarted,false);
 assert.deepEqual(f.journal.loadDelivery(f.id).descriptor.operation.sourceCommits,f.d.operation.sourceCommits);
});
test('expired grant observes an original parent, denies next outer phase and every new child effect',async t=>{
 const f=fixture(t);f.grant();const reserved=f.journal.reserveDeliveryPhase(f.id,'package',{phase:'package'},f.at+1);let observed=0,executed=0;
 const registry={identity:async()=>deliveryAdapterIdentity(),targetIdentity:async()=>f.d.targetIdentity,adapter:phase=>({input:async()=>({phase}),validate:async()=>{},verify:async()=>{},
  execute:async()=>{executed++;throw Error('unexpected execute');},observe:async c=>{observed++;await assert.rejects(c.beforeNewEffect(),/window-expired/);return {state:'completed',reason:'original-completed',externalId:null,receipt:null,output:{phase}};}})};
 const result=await stepDelivery(f.journal,f.id,registry,{clock:()=>f.proof.expiresAtMs+1});
 assert.equal(observed,1);assert.equal(executed,0);assert.equal(f.journal.deliveryPhase(f.id,'package').key,reserved.intent.key);assert.equal(result.acceptanceGap,'operator-continuation-window-expired');
 assert.equal(f.journal.deliveryPhase(f.id,'sign'),null);
});
test('two re-entry calls share one reserved key; changed current graph and source identity refuse',async t=>{
 const f=fixture(t);f.grant();const a=f.journal.reserveDeliveryPhase(f.id,'package',{phase:'package'},f.at+1),b=f.journal.reserveDeliveryPhase(f.id,'package',{phase:'package'},f.at+2);
 assert.equal(a.newlyReserved,true);assert.equal(b.newlyReserved,false);assert.equal(a.intent.key,b.intent.key);
 await assert.rejects(assertDeliveryOperator(f.journal,f.id,{identity:async()=>sha256('unknown current controller')},{clock:()=>f.at}),/adapter-changed/);
});
test('operator CI refuses wrong head, branch, workflow, repository, failed or missing canonical steps',()=>{
 const s={repository:'HatimTheDream/Nova-Dream',commit:'a'.repeat(40),branch:'codex/operator-continuation-31'};
 const v={requestedAttempt:1,run:{id:1,run_attempt:1,head_sha:s.commit,head_branch:s.branch,event:'push',path:'.github/workflows/operator-continuation-quality.yml',name:'Operator continuation quality',repository:{full_name:s.repository},status:'completed',conclusion:'success'},jobs:{total_count:1,jobs:[{id:2,run_id:1,run_attempt:1,head_sha:s.commit,name:'quality',status:'completed',conclusion:'success',steps:['Run npm run quality','Verify Linux update recovery'].map(name=>({name,status:'completed',conclusion:'success'}))}]}};
 assert.equal(verifyOperatorCi(v,s),v);const documented=structuredClone(v);delete documented.jobs.jobs[0].run_attempt;assert.equal(verifyOperatorCi(documented,s),documented);
 for(const change of [x=>x.run.head_sha='b'.repeat(40),x=>x.run.head_branch='main',x=>x.requestedAttempt=2,x=>x.jobs.jobs[0].run_attempt=2,x=>x.run.event='pull_request',x=>x.run.repository.full_name='Other/Repo',x=>x.jobs.jobs[0].steps.pop(),x=>x.jobs.jobs[0].steps[0].conclusion='failure']){const bad=structuredClone(v);change(bad);assert.throws(()=>verifyOperatorCi(bad,s));}
});

 test('tampered original graph, CI and host proof cannot become a grant',t=>{
 for(const role of ['graph','ci','host']){
  const f=fixture(t),bad=structuredClone(f.proof);
  if(role==='graph'){writeFileSync(f.request.historical.manifest.path,'{}');}
  if(role==='ci'){const v=JSON.parse(readFileSync(bad.operator.ci.private.path));v.run.head_sha='0'.repeat(40);bad.operator.ci.private=f.save('bad-ci.json',v);}
  if(role==='host'){const v=JSON.parse(readFileSync(bad.hostFacts.path));v.facts.operatorStatus.held=true;const raw=Buffer.from(JSON.stringify(v.facts));v.stdoutRawBase64=raw.toString('base64');v.stdoutSha256=sha256(raw);bad.hostFacts=f.save('bad-host.json',v);}
  assert.throws(()=>f.journal.recordOperatorContinuation(f.id,bad,f.at,{assertAbsent:()=>{}}));assert.equal(f.journal.deliveryOperatorContinuation(f.id),null);
 }
 });

test('post-grant deadline misses still stop new effects and repeated evidence cannot clear the second miss',t=>{
 const f=fixture(t);f.grant();let timeline=structuredClone(f.d.timeline);
 const originalEvidence=sha256('baseline correction');
 const checkpoint=at=>{timeline.lastCheckpointAtMs=at;f.journal.checkpointDelivery(f.id,timeline,at);};
 const forecast=(at,end)=>({...timeline.original,id:randomUUID(),issuedAtMs:at,remainingMs:[1,end-at],nextCheckpointAtMs:end+10});
 timeline.reviews.push({deadlineId:timeline.original.id,reviewedAtMs:f.at+1,action:'change-approach',reason:'Original reviewed correction.',evidenceSha256:originalEvidence});
 // This forecast predates the grant but its deadline is later and remains guarded.
 const first=forecast(f.at-1,f.at+4);timeline.revisions.push(first);checkpoint(f.at+1);
 verifyContinuationGrant(f.journal,f.id,{now:f.at+2,effect:true});
 assert.throws(()=>f.journal.reserveDeliveryPhase(f.id,'package',{phase:'package'},f.at+5),/later-overrun-review/);
 timeline.reviews.push({deadlineId:first.id,reviewedAtMs:f.at+6,action:'continue-observing',reason:'First later miss reviewed.',evidenceSha256:sha256('first review')});checkpoint(f.at+6);
 verifyContinuationGrant(f.journal,f.id,{now:f.at+6,effect:true});
 const second=forecast(f.at+7,f.at+10);timeline.revisions.push(second);checkpoint(f.at+7);
 timeline.reviews.push({deadlineId:second.id,reviewedAtMs:f.at+11,action:'change-approach',reason:'Old evidence must not qualify again.',evidenceSha256:originalEvidence});checkpoint(f.at+11);
 assert.throws(()=>verifyContinuationGrant(f.journal,f.id,{now:f.at+11,effect:true}),/later-change-approach/);
 verifyContinuationGrant(f.journal,f.id,{now:f.at+11});
 const third=forecast(f.at+12,f.at+14);timeline.revisions.push(third);checkpoint(f.at+12);
 timeline.reviews.push({deadlineId:third.id,reviewedAtMs:f.at+15,action:'change-approach',reason:'New causal correction with distinct evidence.',evidenceSha256:sha256('new correction')});checkpoint(f.at+15);
 verifyContinuationGrant(f.journal,f.id,{now:f.at+15,effect:true});
 assert.equal(f.journal.loadDelivery(f.id).descriptor.timeline.startedAtMs,f.now);
});

test('late review attached only to an old deadline cannot waive two new misses',()=>{
 const e=(id,issuedAtMs)=>({id,step:'total',issuedAtMs,remainingMs:[1,2],confidence:'low',basis:'Synthetic timing.',reason:'Synthetic estimate.',nextCheckpointAtMs:issuedAtMs+10});
 const original=e(randomUUID(),1),a=e(randomUUID(),20),b=e(randomUUID(),30),review=(deadlineId,evidence,action)=>({deadlineId,reviewedAtMs:50,action,reason:'Synthetic review.',evidenceSha256:sha256(evidence)});
 const timeline={startedAtMs:1,original,revisions:[a,b],reviews:[review(a.id,'a','continue-observing'),review(b.id,'b','continue-observing'),review(original.id,'new-but-wrong-deadline','change-approach')],lastCheckpointAtMs:50};
 const eta=assessTimeline(timeline,{nowMs:50});assert.deepEqual(eta.suspendNewAttemptsFor,[]);
 const j={deliveryTimeline:()=>({timeline,eta}),deliveryPhase:()=>null};
 assert.throws(()=>verifyContinuationTimeline(j,'synthetic',10,50),/later-change-approach/);
});
