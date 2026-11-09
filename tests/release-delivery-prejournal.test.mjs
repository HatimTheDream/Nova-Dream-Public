import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,rmdirSync,symlinkSync,unlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {ReleaseJournal,validateJournalDirectory} from '../scripts/release-coordinate.mjs';
import {verifyStorageSession} from '../scripts/release-storage-default.mjs';
import {ensureDeliverySchema} from '../scripts/release-delivery-journal.mjs';
import {sha256} from '../scripts/release-plan.mjs';
import {deliveryAdapterIdentity,deliveryAdapterSourceFiles} from '../scripts/release-delivery-adapters.mjs';
import {preJournalOriginal,preJournalRequestSchema,verifyPreJournalProof,verifyReservedPreJournalFailure,verifyContinuationGrant,
 verifyContinuationStorageAuthority,verifyPreJournalStorageAuthority,operatorObservationDeadline,assertDeliveryOperator} from '../scripts/release-delivery-continuation.mjs';
import {stepDelivery} from '../scripts/release-deliver.mjs';
import {fullHostFixture} from '../support/full-host-fixture.mjs';

const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const app=fileURLToPath(new URL('..',import.meta.url));
const baseSchema=readFileSync(new URL('../scripts/release-coordinate.mjs',import.meta.url),'utf8')
 .match(/this\.db\.exec\(`(PRAGMA journal_mode=WAL;[\s\S]+?PRAGMA user_version=1; COMMIT;)`\);/)[1].replace('${APPLICATION_ID}',String(0x4e56524c));
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'nova-prejournal-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const save=(name,value)=>{const path=join(dir,name);mkdirSync(dirname(path),{recursive:true});const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)+'\n');writeFileSync(path,bytes,{mode:0o600});return{path,sha256:sha256(bytes)};};
 const now=1700000000000,id=randomUUID(),owner='operations/release-'+id,root=join(dir,owner),outputRoot=join(dir,'output'),j=join(outputRoot,'journal-'+id);mkdirSync(j,{recursive:true,mode:0o700});
 const node={path:process.execPath,sha256:sha256(readFileSync(process.execPath))},oldRoot=join(dir,'old-private/edition3'),entry=save('old-private/edition3/scripts/release-deliver.mjs',Buffer.from('// original entry')),
  adapter=save('old-private/edition3/scripts/release-delivery-adapters.mjs',Buffer.from('// original adapter')),validator=save('old-private/edition3/scripts/release-coordinate.mjs',Buffer.from('// original validator'));
 const oldRows=[adapter,entry,validator].map(r=>({name:basename(r.path),sha256:r.sha256})),host=fullHostFixture();
 const target=save('target.json',{artifactTools:{node}}),profile=save('profile.json',{target,sources:{private:{root:dirname(oldRoot)},public:{root:join(dir,'old-public')}}}),budget=save('budget.json',{format:1,reserveBytes:100,allocations:[]});mkdirSync(join(dir,'old-public'));
 const original={id:randomUUID(),step:'total',issuedAtMs:now,remainingMs:[1000,2000],confidence:'low',basis:'Synthetic original estimate.',reason:'Original estimate.',nextCheckpointAtMs:now+300000};
 const start={format:1,operationId:id,profile,outputRoot,sourceCommits:{private:'a'.repeat(40),public:'b'.repeat(40)},timeline:{startedAtMs:now,original,revisions:[],reviews:[],lastCheckpointAtMs:now},observationBudgetMs:10800000};
 const startRef=save('start.json',start);
 const d={format:1,operation:{...host.descriptor.operation,id,stage:'draft',candidateId:null,publicCandidateId:null,version:'8.1.0',buildVersion:'1.0.801',sourceCommits:start.sourceCommits,bundleSha256:null,trustedPublicKeySha256:sha256('key'),helperHashes:null},
  sources:{private:{root:join(dir,'old-private'),repository:'HatimTheDream/Nova-Dream',commit:'a'.repeat(40),baseCommit:'c'.repeat(40),branch:'main'},public:{root:join(dir,'old-public'),repository:'HatimTheDream/Nova-Dream-Public',commit:'b'.repeat(40),baseCommit:'d'.repeat(40),branch:'main'}},
  target,targetIdentity:sha256('target'),adapterIdentity:sha256(canonical(oldRows)),timeline:start.timeline,observationBudgetMs:start.observationBudgetMs};
 const descriptor=save('output/request-'+id+'/descriptor.json',d),initialization=save('output/request-'+id+'/initialization.json',{format:1,kind:'nova-delivery-initialization',input:start,inputSha256:sha256(canonical(start)+'\n'),directory:join(outputRoot,'request-'+id),adapterIdentity:d.adapterIdentity,profile,journalDirectory:j,descriptor:{reference:descriptor,value:d},target:{reference:target,value:JSON.parse(readFileSync(target.path))}});
 const originalGraph=save('graph.json',{format:1,adapterIdentity:d.adapterIdentity,sourceFiles:[adapter,entry,validator]}),sourceReview=save('source-review.json',{}),storageReview=save('storage-review.json',{}),config=save('config.json',{sourceReview,storageReview,applicationRoots:[oldRoot,join(dir,'old-public')]});
 const request=save(owner+'/request.json',{format:1,operationId:id,node,deliveryEntry:entry,releaseInput:startRef,storageBudget:budget,independentSourceReview:storageReview});
 const configuration=save('storage-configuration.json',{}),storage=save(owner+'/before-delivery/input.json',{profile,budget,configuration,phase:'before-allocation',originalDeadline:new Date(now+5000).toISOString()});
 const capacity=(name,at)=>{const inventory=save(owner+'/'+name+'/inventory.json',{sourceEvidence:{profile,configuration},readOnly:true,observedAtMilliseconds:at});return save(owner+'/'+name+'/preflight.json',{format:1,kind:'private-storage-preflight',state:'ready',phase:'before-allocation',originalDeadline:new Date(now+5000).toISOString(),inventory,assessment:{format:1,kind:'storage-lifecycle-budget-result',phase:'before-allocation',fits:true,observationExpiresAtMilliseconds:at+120000,allocationBudgetAdmissionOnly:true,releaseAdmission:false,stoppedAndPostStartChecksStillRequired:true,filesystems:[{availableBytes:1000,requiredFreeBytes:100,deficitBytes:0,allocations:[]}]}});};
 const oldCapacity=capacity('before-delivery',now);
 const maintenance={kind:'private-storage-batch-maintenance-result',state:'ready',cleanupPerformed:true,protectedRolesVerified:true,releaseAdmission:false};
 const completion=save(owner+'/before-delivery/complete.json',maintenance);
 const dispatch=save(owner+'/release-dispatch.json',{format:1,request,automaticNewOperationPermitted:false,storageInput:storage,storageMaintenanceResult:{...maintenance,result:completion},storageResult:{state:'ready',historical:false,cleanupPerformed:false,result:oldCapacity,observationExpiresAtMilliseconds:now+120000},startedAtMilliseconds:now});
 const argv=[node.path,entry.path,'start',j,descriptor.path],o=owner+'/observations/observation-0001/';
 const observation={intent:save(o+'intent.json',{request,sameReleaseOperation:true,argv}),exit:save(o+'exit.json',{returnCode:1,finishedAtMilliseconds:now+10000}),childResult:save(o+'default-child-result.json',{returnCode:1,originalChildClosed:true,logBoundExceeded:false,automaticNewOperationPermitted:false}),stdout:save(o+'stdout.json',{kind:'nova-release-delivery-error',reason:'storage-start-already-dispatched-use-resume',automaticReplayPermitted:false}),stderr:save(o+'stderr.log',Buffer.from(''))};
 const session=save(owner+'/session-observation-0001.json',{kind:'nova-storage-default-session',mode:'start',operationId:id,request,dispatch,initialization,descriptor,argv,config,sourceReview,storageReview,sourceGraph:originalGraph,adapterIdentity:d.adapterIdentity});
 const directoryPreparation=save('directory-preparation.json',{kind:'original-empty-journal-directory-preparation',originalInitialization:initialization,source:validator,journalDirectory:j,absentBefore:true,protected:true,emptyAfter:true,databaseCreated:false,newOperationCreated:false,hostEffects:false});
 const processIdentity=(pid,parentPid)=>({pid,parentPid,created:'/Date('+now+')/',executable:node.path,commandLineSha256:sha256('process'+pid)});
 const launcher=save(owner+'/waiting.json',{kind:'verified-waiting-release-launcher',dispatchAuthority:false,operationId:id,start:startRef,budget,entry,node,runner:save('runner.bin',Buffer.from('synthetic')),config,owner:processIdentity(2147483646,1),worker:processIdentity(2147483647,2147483646)});
 const operatorSources={private:{root:basename(app)==='edition3'?dirname(app):join(dir,'current-private'),repository:'HatimTheDream/Nova-Dream',branch:'operator/prejournal-c494-r1',commit:'e'.repeat(40)},public:{root:basename(app)==='edition3'?join(dir,'current-public'):app,repository:'HatimTheDream/Nova-Dream-Public',branch:'operator/prejournal-c494-r1',commit:'f'.repeat(40)}};
 if(basename(app)!=='edition3')save('current-private/edition3/scripts/release-deliver.mjs',readFileSync(new URL('../scripts/release-deliver.mjs',import.meta.url)));
 const r={format:1,kind:'nova-pre-journal-dispatch-request',operationId:id,historical:{root:oldRoot,manifest:originalGraph},original:{request,initialization,descriptor,dispatch,session,directoryPreparation,launcher,observation},operatorSources,ciRuns:{private:10,public:20},outputDirectory:join(dir,'authority'),durationMs:60000,reason:'closed-storage-start-rejected-before-journal',automaticRenewal:false};
 const ci=(s,runId)=>({requestedAttempt:1,run:{id:runId,run_attempt:1,repository:{full_name:s.repository},head_sha:s.commit,head_branch:s.branch,event:'push',path:'.github/workflows/operator-continuation-quality.yml',name:'Operator continuation quality',status:'completed',conclusion:'success'},jobs:{total_count:1,jobs:[{id:runId+1,run_id:runId,head_sha:s.commit,name:'quality',status:'completed',conclusion:'success',steps:['Run npm run quality','Verify Linux update recovery'].map(name=>({name,status:'completed',conclusion:'success'}))}]}});
 const at=now+120000,proof={format:1,kind:'nova-pre-journal-dispatch-reconciliation',operationId:id,...preJournalOriginal(r,{assertAbsent:()=>{}}).binding,request:save('request.json',r),operator:{adapterIdentity:deliveryAdapterIdentity(),sources:operatorSources,sourceFiles:deliveryAdapterSourceFiles().map(name=>({name,sha256:sha256(readFileSync(new URL('../scripts/'+name,import.meta.url)))})),ci:{private:save('ci-private.json',ci(operatorSources.private,10)),public:save('ci-public.json',ci(operatorSources.public,20))}},issuedAtMs:at,expiresAtMs:at+60000,automaticRenewal:false,originalHistoryPreserved:true};
 const journal=Object.create(ReleaseJournal.prototype);journal.db=new DatabaseSync(':memory:');journal.readOnly=false;journal.directory=j;journal.db.exec(baseSchema);t.after(()=>journal.close());
 return{dir,save,id,now,at,d,r,proof,journal,j,owner,capacity,storage,node};
}


function reservedFixture(t){
 const f=fixture(t),oldProof=f.save('authority/prejournal-authority.json',f.proof),root=join(f.dir,f.owner),
  previousApp=join(f.r.operatorSources.private.root,'edition3'),entry=join(previousApp,'scripts/release-deliver.mjs');
 const graph={format:1,adapterIdentity:f.proof.operator.adapterIdentity,sourceFiles:f.proof.operator.sourceFiles.map(s=>{
  const path=resolve(previousApp,'scripts',s.name);
  if(!existsSync(path)){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,readFileSync(new URL('../scripts/'+s.name,import.meta.url)));}
  return {path,sha256:s.sha256};
 })};
 const runner=f.save('reserved-runtime/runner.py',Buffer.from('# inert reviewed ordering fixture')),bootstrap=f.save('reserved-runtime/continuation_authority.mjs',Buffer.from('// inert')),
  retry=f.save('reserved-runtime/authority_retry.mjs',Buffer.from('// inert'));
 const files=Object.fromEntries([...graph.sourceFiles,runner,bootstrap,retry].map(r=>[r.path,r.sha256]));
 const sourceReview=f.save('reserved-review.json',{kind:'nova-storage-default-source-review',status:'passed',independentReview:true,files}),
  storageReview=f.save('reserved-storage-review.json',{kind:'independent-storage-source-review',status:'passed',independentReview:true,files:{}});
 const config=f.save('reserved-config.json',{kind:'nova-storage-default',runner,sourceReview,storageReview,
  applicationRoots:[previousApp,f.r.operatorSources.public.root],operatorContinuation:{operationId:f.id,journalDirectory:f.j,originalRequest:f.r.original.request,preJournalProof:oldProof}});
 const originalLauncher=JSON.parse(readFileSync(f.r.original.launcher.path));
 const launcher=f.save(f.owner+'/reserved-waiting.json',{...originalLauncher,mode:'resume',config,runner,entry:{path:entry,sha256:sha256(readFileSync(entry))}});
 const argv=[f.node.path,entry,'start',f.j,f.r.original.descriptor.path],grantHash=sha256(canonical(f.proof));
 const admission=f.save(f.owner+'/continuations/'+grantHash+'/admission-0001/release-dispatch.json',{
  request:f.r.original.request,originalDispatch:f.r.original.dispatch,grantSha256:grantHash,automaticNewOperationPermitted:false,startedAtMilliseconds:f.at+1});
 const observationIntent=f.save(f.owner+'/observations/observation-0002/intent.json',{request:f.r.original.request,argv,sameReleaseOperation:true}),
  sourceGraph=f.save(f.owner+'/source-graph-observation-0002.json',graph),prefix=f.owner+'/authority-observations/check-fixture/';
 const authorityIntent=f.save(prefix+'intent.json',{argv:[f.node.path,bootstrap.path,entry,files[join(previousApp,'scripts/release-delivery-continuation.mjs')],
  files[join(previousApp,'scripts/release-coordinate.mjs')],f.j,f.id,oldProof.path,oldProof.sha256],bootstrap,retryHelper:retry,config,
  originalRequest:f.r.original.request,totalTimeoutSeconds:60,readOnly:true});
 const stdout=f.save(prefix+'stdout.log',Buffer.alloc(0)),stderr=f.save(prefix+'stderr.log',Buffer.from(
  "Error: spawnSync C:\\windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe EPERM\nat protectDirectory (fixed)\nat validateJournalDirectory (fixed)\nat verifyPreJournalStorageAuthority (fixed)\nerrno: -4048, code: 'EPERM', pid: 0, status: null\n"));
 const output=r=>({reference:r,totalBytes:readFileSync(r.path).length,complete:true,wholeSha256:r.sha256});
 const result=f.save(prefix+'result.json',{returnCode:1,failure:null,elapsedSeconds:0.4,outputs:{stdout:output(stdout),stderr:output(stderr)},readOnly:true,releaseEffectRetry:false});
 const disposition={format:1,kind:'nova-prejournal-no-child-disposition',operationId:f.id,previousProof:oldProof,admission,observationIntent,sourceGraph,launcher,
  authority:{intent:authorityIntent,result,stdout,stderr},review:{status:'passed',independentReview:true,reviewedAt:new Date(f.at+120000).toISOString(),
   sourceOrdering:'session-and-logs-before-native-spawn',originalWrapperClosed:true,nativeChildDispatched:false,noJournalCreated:true,automaticReplayPermitted:false}};
 const request={...f.r,reason:'reserved-attempt-confirmed-before-native-dispatch',reservedFailure:f.save('no-child-disposition.json',disposition),
  outputDirectory:join(f.dir,'successor-authority')};
 return {...f,root,request,disposition};
}

test('explicit no-child disposition permits a distinct successor while expired proof and history stay unchanged',t=>{
 const f=reservedFixture(t),original=readFileSync(f.disposition.previousProof.path),late=f.proof.expiresAtMs+120000;
 assert.throws(()=>verifyPreJournalProof(f.proof,{now:late,requireEmpty:true}),/window-expired/);
 assert.deepEqual(verifyReservedPreJournalFailure(f.request,{assertAbsent:()=>{}}),f.disposition);
 preJournalOriginal(f.request,{exclusiveHistory:true,assertAbsent:()=>{}});
 const successor={...f.proof,request:f.save('successor-request.json',f.request),issuedAtMs:late,expiresAtMs:late+60000};
 verifyPreJournalProof(successor,{now:late+1,requireEmpty:true,assertAbsent:()=>{}});
 f.journal.initializeReconciledDelivery(f.d,successor,late+1);
 assert.equal(f.journal.loadDelivery(f.id).created_at,late+1);
 assert.deepEqual(readFileSync(f.disposition.previousProof.path),original);
 assert.deepEqual(f.journal.loadDelivery(f.id).descriptor.timeline,f.d.timeline);
});

test('reserved recovery refuses session, child logs, unknown attempts, nonempty journal and live owner',t=>{
 const f=reservedFixture(t),check=()=>preJournalOriginal(f.request,{exclusiveHistory:true,assertAbsent:()=>{}});
 for(const path of [join(f.root,'session-observation-0002.json'),...['stdout.json','stderr.log','exit.json','default-child-result.json'].map(n=>join(f.root,'observations/observation-0002',n))]){
  writeFileSync(path,'x');assert.throws(check,/child-dispatch-uncertain/);unlinkSync(path);
 }
 writeFileSync(join(f.j,'release.sqlite'),'x');assert.throws(check,/empty-uninitialized/);unlinkSync(join(f.j,'release.sqlite'));
 mkdirSync(join(f.root,'observations/observation-0003'));assert.throws(check,/unclassified/);rmdirSync(join(f.root,'observations/observation-0003'));
 assert.throws(()=>verifyReservedPreJournalFailure(f.request,{assertAbsent:()=>{throw Error('live owner');}}),/live owner/);
});

test('reserved recovery refuses changed failure evidence, mismatched grant and recursive renewals',t=>{
 const f=reservedFixture(t);
 for(const change of [d=>d.operationId=randomUUID(),d=>d.review.nativeChildDispatched=true,d=>d.review.independentReview=false,
  d=>d.admission=d.observationIntent,d=>d.authority.stderr=d.authority.stdout]){
  const d=structuredClone(f.disposition);change(d);
  const r={...f.request,reservedFailure:f.save('bad-disposition.json',d)};
  assert.throws(()=>verifyReservedPreJournalFailure(r,{assertAbsent:()=>{}}));
 }
 const recursive={...f.proof,request:f.save('recursive-request.json',f.request)};
 const d={...f.disposition,previousProof:f.save('recursive-proof.json',recursive)};
 assert.throws(()=>verifyReservedPreJournalFailure({...f.request,reservedFailure:f.save('recursive-disposition.json',d)},{assertAbsent:()=>{}}),/predecessor/);
 assert.throws(()=>preJournalRequestSchema.parse({...f.request,reservedFailure:undefined}),/explicit-reserved/);
});

test('closed pre-journal failure initializes once, then ordinary effects use the unchanged native three-hour horizon',async t=>{
 const f=fixture(t),first=f.at+1000;
 assert.equal(preJournalOriginal(f.r,{assertAbsent:()=>{},exclusiveHistory:true}).journalDirectory,f.j);
 f.journal.initializeReconciledDelivery(f.d,f.proof,first);
 const original=f.journal.loadDelivery(f.id),grant=f.journal.deliveryOperatorContinuation(f.id);
 assert.equal(original.created_at,first);assert.deepEqual(original.descriptor,f.d);assert.deepEqual(grant.proof,f.proof);
 // A later observation does not rewrite the original failure or invalidate the grant.
 mkdirSync(join(f.dir,f.owner,'observations/observation-0002'));
 writeFileSync(join(f.j,'release.sqlite'),Buffer.from('fixture marks a native initialized directory'));
 assert.throws(()=>verifyPreJournalProof(f.proof,{now:first,requireEmpty:true}),/empty-uninitialized/);
 const later=f.proof.expiresAtMs+1000;
 verifyContinuationGrant(f.journal,f.id,{now:later,effect:true});
 const authority=await verifyContinuationStorageAuthority({journal:f.journal,operationId:f.id,now:later});
 assert.equal(authority.continuationStarted,true);assert.equal(authority.expiresAtMs,first+10800000);assert.equal(authority.newEffectsAllowed,true);
 assert.equal(operatorObservationDeadline(f.journal,f.id),first+10800000);
 await assertDeliveryOperator(f.journal,f.id,{identity:async()=>deliveryAdapterIdentity()},{clock:()=>later,effect:true});
 const status=await stepDelivery(f.journal,f.id,{identity:async()=>deliveryAdapterIdentity(),targetIdentity:async()=>f.d.targetIdentity,
  preflight:async()=>[],capabilityGaps:async()=>[],phasePreflight:async()=>[],adapter:()=>({input:async()=>({synthetic:true}),validate:async()=>{},verify:async()=>{},execute:async()=>({state:'running',externalId:null,reason:'fixture-running',receipt:null,output:null})})},{clock:()=>later});
 assert.equal(status.acceptanceGap,null);assert.equal(f.journal.deliveryPhase(f.id,'private-source').state,'running');
 f.journal.initializeReconciledDelivery(f.d,f.proof,later);assert.equal(f.journal.loadDelivery(f.id).created_at,first);
 assert.throws(()=>f.journal.initializeReconciledDelivery(f.d,{...f.proof,expiresAtMs:f.proof.expiresAtMs+1},later));
 verifyContinuationGrant(f.journal,f.id,{now:first+10800000});
 assert.throws(()=>verifyContinuationGrant(f.journal,f.id,{now:first+10800000,effect:true}),/window-expired/);
});

test('initialization transaction rollback retains no delivery or authority; exact completed commit cannot be renewed',t=>{
 const f=fixture(t);ensureDeliverySchema(f.journal);
 const original=f.journal.transaction.bind(f.journal);let injected=true;
 f.journal.transaction=fn=>original(()=>{const value=fn();if(injected){injected=false;throw Error('synthetic-before-commit');}return value;});
 assert.throws(()=>f.journal.initializeReconciledDelivery(f.d,f.proof,f.at+1),/synthetic-before-commit/);
 assert.equal(f.journal.deliveryOperatorContinuation(f.id),null);
 f.journal.transaction=original;f.journal.initializeReconciledDelivery(f.d,f.proof,f.at+2);
 assert.equal(f.journal.loadDelivery(f.id).created_at,f.at+2);
 assert.throws(()=>f.journal.db.prepare('DELETE FROM delivery_operator_continuations WHERE operation_id=?').run(f.id),/immutable/);
});

test('shared authority independently rejects a cross-operation or cross-journal proof',async t=>{
 const f=fixture(t),proofReference=f.save('authority/prejournal-authority.json',f.proof);
 await assert.rejects(verifyPreJournalStorageAuthority({proofReference,operationId:randomUUID(),now:f.at+1}),/requested-operation/);
 await assert.rejects(verifyPreJournalStorageAuthority({proofReference,journalDirectory:join(f.dir,'other-journal'),now:f.at+1}),/requested-operation/);
});

test('real shared session guard accepts only the fresh companion admission and never reuses the expired dispatch',async t=>{
 const f=fixture(t),current=f.at+1,roots=[join(f.r.operatorSources.private.root,'edition3'),f.r.operatorSources.public.root];
 const refs=[];
 for(const root of roots)for(const name of ['release-deliver.mjs','release-coordinate.mjs','release-storage-default.mjs','release-delivery-adapters.mjs']){
  const path=join(root,'scripts',name);if(resolve(root)!==resolve(app)){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,readFileSync(new URL('../scripts/'+name,import.meta.url)));}
  refs.push({path,sha256:sha256(readFileSync(path))});
 }
 const runner=f.save('current-runner/runner.py',Buffer.from('# synthetic inert runner')),identity=f.save('current-runner/default_identity.mjs',Buffer.from('// synthetic identity')),helper=f.save('current-storage.py',Buffer.from('# synthetic storage'));
 const sourceReview=f.save('current-source-review.json',{format:1,kind:'nova-storage-default-source-review',status:'passed',independentReview:true,files:Object.fromEntries([...refs,runner,identity].map(r=>[r.path,r.sha256]))});
 const storageReview=f.save('current-storage-review.json',{format:1,kind:'independent-storage-source-review',status:'passed',independentReview:true,files:{[helper.path]:helper.sha256}});
 const proofReference=f.save('authority/prejournal-authority.json',f.proof),oldLauncher=JSON.parse(readFileSync(f.r.original.launcher.path));
 const config={format:1,kind:'nova-storage-default',python:f.node,runner,sourceReview,storageReview,operationsRoot:join(f.dir,'operations'),applicationRoots:roots,
  operatorContinuation:{operationId:f.id,journalDirectory:f.j,originalConfig:oldLauncher.config,originalRequest:f.r.original.request,preJournalProof:proofReference}};
 const configRef=f.save('current-config.json',config),entry=join(roots[0],'scripts/release-deliver.mjs');
 // Exercise the actual maintained Windows ACL validator on this empty test directory only.
 rmdirSync(f.j);validateJournalDirectory(f.j,{create:true});
 const authority=await verifyPreJournalStorageAuthority({proofReference,entry,operationId:f.id,journalDirectory:f.j,now:current});
 const fresh=f.capacity('fresh-capacity',f.at),admission=f.save(f.owner+'/continuations/'+authority.grantSha256+'/admission-0001/release-dispatch.json',{
  format:1,request:f.r.original.request,originalDispatch:f.r.original.dispatch,grantSha256:authority.grantSha256,automaticNewOperationPermitted:false,
  storageInput:f.storage,storageResult:{state:'ready',historical:false,cleanupPerformed:false,result:fresh,observationExpiresAtMilliseconds:f.at+120000},startedAtMilliseconds:current});
 const args=['start',f.j,f.r.original.descriptor.path],argv=[process.execPath,entry,...args];
 const intent=f.save(f.owner+'/observations/observation-0002/intent.json',{request:f.r.original.request,sameReleaseOperation:true,argv});
 const graph=f.save(f.owner+'/source-graph-observation-0002.json',{format:1,adapterIdentity:deliveryAdapterIdentity(),sourceFiles:deliveryAdapterSourceFiles().map(name=>{const path=fileURLToPath(new URL('../scripts/'+name,import.meta.url));return{path,sha256:sha256(readFileSync(path))};})});
 const session={format:1,kind:'nova-storage-default-session',config:configRef,request:f.r.original.request,dispatch:f.r.original.dispatch,initialization:f.r.original.initialization,
  descriptor:f.r.original.descriptor,sourceGraph:graph,observationIntent:intent,adapterIdentity:deliveryAdapterIdentity(),argv,operationId:f.id,mode:'start',sourceReview,storageReview,
  issuedAtMilliseconds:current,operatorContinuation:authority,continuationDispatch:admission};
 const sessionRef=f.save(f.owner+'/session-observation-0002.json',session),env={NOVA_RELEASE_STORAGE_CONFIG:configRef.path,NOVA_RELEASE_STORAGE_SESSION:sessionRef.path};
 assert.deepEqual((await verifyStorageSession(args,entry,{env,clock:()=>current})).preJournalProof,proofReference);
 // Refusal is at the fresh companion, even though original pre-maintenance history is authentic.
 await assert.rejects(verifyStorageSession(args,entry,{env,clock:()=>f.at+120001}),/window-expired|first-admission-expired/);
 const changed=JSON.parse(readFileSync(admission.path));changed.storageResult.result=JSON.parse(readFileSync(f.r.original.dispatch.path)).storageResult.result;
 session.continuationDispatch=f.save(f.owner+'/continuations/'+authority.grantSha256+'/admission-0001/release-dispatch.json',changed);
 f.save(f.owner+'/session-observation-0002.json',session);
 await assert.rejects(verifyStorageSession(args,entry,{env,clock:()=>current}),/capacity-proof-changed/);
});

test('initial authority refuses changed identity, failed ownership and nonempty journal',t=>{
 const f=fixture(t);assert.throws(()=>preJournalOriginal(f.r,{assertAbsent:()=>{throw Error('owner alive');}}),/owner alive/);
 for(const change of [r=>r.operationId=randomUUID(),r=>r.original.descriptor=r.original.session,r=>r.original.dispatch=r.original.session,r=>r.operatorSources.private.branch='main']){
  const r=structuredClone(f.r);change(r);assert.throws(()=>preJournalOriginal(r,{assertAbsent:()=>{}}));
 }
 for(const name of ['release.sqlite','release.sqlite-wal','release.sqlite-shm','other']){writeFileSync(join(f.j,name),'x');assert.throws(()=>preJournalOriginal(f.r,{assertAbsent:()=>{}}),/empty-uninitialized/);unlinkSync(join(f.j,name));}
 mkdirSync(join(f.dir,f.owner,'observations/observation-0002'));assert.throws(()=>preJournalOriginal(f.r,{assertAbsent:()=>{},exclusiveHistory:true}),/unclassified/);
});

test('expired admission, CI mismatch, changed descriptor and symlink directory are refused',t=>{
 const f=fixture(t);assert.throws(()=>verifyPreJournalProof(f.proof,{now:f.proof.expiresAtMs,requireEmpty:true}),/window-expired/);
 const bad=structuredClone(f.proof);bad.descriptorSha256='0'.repeat(64);assert.throws(()=>f.journal.initializeReconciledDelivery(f.d,bad,f.at+1),/context-changed/);
 const ci=JSON.parse(readFileSync(bad.operator.ci.private.path));ci.run.head_sha='0'.repeat(40);bad.operator.ci.private=f.save('bad-ci.json',ci);assert.throws(()=>verifyPreJournalProof(bad));
 assert.throws(()=>preJournalRequestSchema.parse({...f.r,automaticRenewal:true}));
 if(process.platform!=='win32'){rmSync(f.j,{recursive:true});const redirected=join(f.dir,'redirected');mkdirSync(redirected);symlinkSync(redirected,f.j,'dir');assert.throws(()=>preJournalOriginal(f.r,{assertAbsent:()=>{}}),/canonical-directory/);}
});
