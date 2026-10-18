import test from 'node:test';
import assert from 'node:assert/strict';
import {join,dirname} from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import {sha256} from '../scripts/release-plan.mjs';
import {startupCommandFixture,HOME_CAPTURE_ROLES} from '../support/startup-command-fixture.mjs';
import {startupRetainedRequest,verifyStartupRetainedProjection,assertStartupQualifiedCandidate,QUALIFIED_STARTUP_SOURCES} from '../scripts/release-delivery-startup-retained.mjs';
import {createMaintainedDependencyTransport,dependencyTransportSchema} from '../scripts/release-delivery-dependency-transport.mjs';
import {createDependencyPairProducer} from '../scripts/release-delivery-dependencies.mjs';

test('startup request is strict and requires independently frozen producer sources',t=>{
  const f=startupCommandFixture(t);
  assert.deepEqual(startupRetainedRequest(f.options,f.sources),f.proof.request);
  assert.throws(()=>startupRetainedRequest({...f.options,passed:true},f.sources));
  assert.throws(()=>startupRetainedRequest(f.options,{...f.sources,'qualified-parent.py':null}),/reviewed-startup/);
  assert.throws(()=>startupRetainedRequest({...f.options,producer:{...f.options.producer,sha256:'0'.repeat(64)}},f.sources),/reviewed-startup/);
  assert.throws(()=>startupRetainedRequest(f.options),/reviewed-startup/);
});

test('complete changed service candidate is admitted by exact proof, never prior byte equality',t=>{
  const f=startupCommandFixture(t);
  assert.notDeepEqual(f.candidates.private.bytes.get('dist/service/apps/service/gateway.js'),f.prior.bytes.get('dist/service/apps/service/gateway.js'));
  assert.deepEqual(verifyStartupRetainedProjection(f.proof,f.proof.request,f.sources),f.proof);
  assert.doesNotThrow(()=>assertStartupQualifiedCandidate(f.proof,f.assertion,f.sources));
  assert.equal(f.calls.length,0);
});

test('proof refuses missing held/closed/full-retention/rollback outcomes',t=>{
  const f=startupCommandFixture(t);
  for(const change of [v=>v.heldBootstrapVerified=false,v=>v.workerClosed=false,v=>v.completeMaintainedSavedAndNativeState=false,
    v=>v.independentOriginalRestored=false,v=>v.productionAdmission=true,v=>v.scenarios.pop(),
    v=>v.scenarios[1].candidateId=v.qualificationBinding.prior.candidateId,v=>delete v.references['pristine-prior-restoration/bootstrap'],
    v=>v.workerIdentity.controlGroup='/system.slice/another.service',v=>v.sourceHashes['contracts.py']='0'.repeat(64)]){
    const value=structuredClone(f.proof);change(value);assert.throws(()=>verifyStartupRetainedProjection(value,f.proof.request,f.sources));
  }
});


test('persisted qualification cannot omit or damage any coherent HOME reference',t=>{
  const f=startupCommandFixture(t);
  assert.equal(HOME_CAPTURE_ROLES.length,15);
  for(const role of HOME_CAPTURE_ROLES){
    const key='homeCapture/'+role,missing=structuredClone(f.proof),damaged=structuredClone(f.proof);
    delete missing.references[key];damaged.references[key].sha256='invalid';
    assert.throws(()=>verifyStartupRetainedProjection(missing,f.proof.request,f.sources),/original-references-incomplete/,key);
    assert.throws(()=>verifyStartupRetainedProjection(damaged,f.proof.request,f.sources),/original-references-incomplete/,key);
  }
});

test('any other compiled service byte, source, candidate, epoch, dependency or helper drift refuses',t=>{
  const f=startupCommandFixture(t);
  for(const change of [v=>v.qualificationBinding.targets.private.candidateId='0'.repeat(64),
    v=>v.qualificationBinding.sourceCommits.public='c'.repeat(40),v=>v.qualificationBinding.workspaceEpoch='11111111-1111-4111-8111-111111111111',
    v=>v.qualificationBinding.helpers['recovery.py']='0'.repeat(64),v=>v.qualificationBinding.dependencyGraphSha256='0'.repeat(64),
    v=>v.qualificationBinding.serviceArtifacts['dist/service/apps/service/assignments.js']='0'.repeat(64),
    v=>v.qualificationBinding.targets.public.ciSourceSha256='0'.repeat(64),v=>v.qualificationBinding.targets.private.archiveBytes++,
    v=>v.qualificationBinding.hostEntrypointSha256='0'.repeat(64)]){
    const proof=structuredClone(f.proof);change(proof);assert.throws(()=>assertStartupQualifiedCandidate(proof,f.assertion,f.sources));
  }
  const publicChanged={...f.candidates.public,bytes:new Map(f.candidates.public.bytes)};
  publicChanged.bytes.set('dist/service/apps/service/assignments.js',Buffer.from('unqualified public service'));
  assert.throws(()=>assertStartupQualifiedCandidate(f.proof,{...f.assertion,candidates:{...f.candidates,public:publicChanged}},f.sources),/service-changed/);
});

test('actual authenticated artifact shape needs no invented manifest reference',t=>{
  const f=startupCommandFixture(t);
  const artifacts=Object.fromEntries(Object.entries(f.artifacts).map(([s,a])=>{const {manifest,directory,...actual}=a;return[s,actual];}));
  assert.doesNotThrow(()=>assertStartupQualifiedCandidate(f.proof,{...f.assertion,artifacts},f.sources));
  writeFileSync(join(artifacts.private.frozenSourceDirectory,'scripts/host.mjs'),'corrupted host');
  assert.throws(()=>assertStartupQualifiedCandidate(f.proof,{...f.assertion,artifacts},f.sources),/host-entrypoint/);
});

test('format5 has separate proof options and refuses before any dependency stage without a collector',async t=>{
  const f=startupCommandFixture(t);
  assert.equal(dependencyTransportSchema.parse(f.transportOptions).format,5);
  assert.equal(dependencyTransportSchema.safeParse({...f.transportOptions,format:4}).success,false);
  const transport=createMaintainedDependencyTransport({options:f.transportOptions,base:f.base,run:async()=>{throw Error('No command allowed');}});
  await assert.rejects(transport.validate({descriptor:f.descriptor,input:f.intent.input}),/actual-settled-startup/);
  assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id,'package/dependency-stage'),null);
  assert.equal(f.calls.length,0);
});

test('fixed collector source is part of the adapter graph and does not launch a producer',()=>{
  const source=readFileSync(new URL('../scripts/release-startup-retained-proof.py',import.meta.url),'utf8');
  assert.doesNotMatch(source,/import subprocess|subprocess\.|exec\(|importlib/);
  assert.match(source,/worker_closed\(result\['workerIdentity'\]\)/);
  assert.equal(Object.keys(QUALIFIED_STARTUP_SOURCES).length,4);
  assert.match(sha256(source),/^[a-f0-9]{64}$/);
});

test('format5 stages, qualifies, pairs and reloads the same proof without replay; persisted drift refuses',async t=>{
  const f=startupCommandFixture(t),commands=[];
  // Only the pre-existing dependency worker boundary is synthetic. The actual
  // transport, SQLite reservations, stage, intent, pair and reload code run.
  const run=async(executable,argv)=>{
    commands.push({executable,argv});
    assert.equal(executable,f.transportOptions.python.path);
    assert.deepEqual(argv.slice(1,2),['--request']);
    const requestPath=argv[2],request=JSON.parse(readFileSync(requestPath)),ref=path=>({path,sha256:sha256(readFileSync(path))});
    assert.equal(argv[4],ref(requestPath).sha256);
    let result={passed:true,readOnly:true,hostEffects:false};
    if(request.phase==='execute'){
      const input=JSON.parse(readFileSync(request.input.path)),archive=f.put(join(request.outputDirectory,'app-dependencies.tgz'),Buffer.from('synthetic retained dependency archive'));
      const description={...JSON.parse(readFileSync(f.transportOptions.selectedPair.path)).applicationDependencies,
        archiveSha256:archive.sha256,archiveBytes:readFileSync(archive.path).length,packageLockSha256:input.targetLock.sha256};
      const metadata=f.put(join(request.outputDirectory,'app-dependencies.tgz.metadata.json'),description);
      result=f.put(join(request.outputDirectory,'result.json'),{format:3,kind:'verified-metadata-only-dependency-successor',
        metadataPolicy:f.transportOptions.metadataPolicy,passed:true,input,everyRetainedMemberIdentical:true,retainedMemberCount:1,
        retainedInventorySha256:sha256('synthetic inventory'),newNativeExecutionClaimed:false,newTargetStartupClaimed:false,
        hostEffects:false,deliveryQualification:false,freshFullRehearsalStillRequired:true,liveAcceptanceStillRequired:true,
        originalNativeQualificationReused:input.nativeReceipt,archive,metadata,description});
    }else assert.equal(request.phase,'plan');
    f.put(join(dirname(requestPath),request.phase+'-outcome.json'),{...request,kind:'maintained-local-dependency-outcome',request:ref(requestPath),
      hostEffects:false,finishedAtMs:Date.now(),state:'completed',reason:'synthetic-worker-completed',result});
    return{exitCode:0};
  };
  const fresh=()=>createMaintainedDependencyTransport({options:f.transportOptions,base:f.base,storeReceipt:f.storeReceipt,run,
    startupCollector:async()=>structuredClone(f.proof),startupSources:f.sources});
  const transport=fresh(),executionErrors=[];
  for(const [name,step]of Object.entries(transport.steps)){const execute=step.execute;step.execute=async c=>{try{return await execute(c);}catch(e){executionErrors.push({name,message:e.message});throw e;}};}
  const producer=createDependencyPairProducer({maintained:transport});
  await transport.validate({descriptor:f.descriptor,input:f.intent.input});
  assert.equal(commands.length,0);
  const completed=await producer.execute(f.context);
  assert.equal(completed.state,'completed',JSON.stringify({completed,executionErrors}));
  assert.deepEqual(commands.map(x=>JSON.parse(readFileSync(x.argv[2])).phase),['plan','execute']);
  const output=completed.output,proofRef=output.startupQualification.projection;
  assert.deepEqual(JSON.parse(readFileSync(proofRef.path)),f.proof);
  assert.deepEqual(output.startupQualification.binding,f.proof.qualificationBinding);
  const pair=JSON.parse(readFileSync(join(output.directory,'reviewed-pair.json'))),preparation=JSON.parse(readFileSync(output.preparation.path));
  assert.notDeepEqual(pair.startupBarrier.prior,pair.startupBarrier.target);
  assert.equal(Object.hasOwn(pair,'startupQualification'),false);
  assert.deepEqual(preparation.startupQualification,output.startupQualification);
  assert.equal(preparation.newTargetStartupClaimed,false);
  assert.equal(preparation.freshFullRehearsalStillRequired,true);
  const rows=Object.keys(transport.steps).map(name=>{const row=f.journal.deliveryPhase(f.descriptor.operation.id,'package/'+name);return[row.phase,row.key,row.createdAtMs];});
  const reloaded=createDependencyPairProducer({maintained:fresh()});
  assert.deepEqual(await reloaded.inspect(f.context),completed);
  await reloaded.verify(completed,f.context);
  assert.deepEqual(Object.keys(transport.steps).map(name=>{const row=f.journal.deliveryPhase(f.descriptor.operation.id,'package/'+name);return[row.phase,row.key,row.createdAtMs];}),rows);
  assert.equal(commands.length,2);
  writeFileSync(proofRef.path,JSON.stringify({...f.proof,heldBootstrapVerified:false})+'\n');
  await assert.rejects(reloaded.inspect(f.context));
  assert.equal(commands.length,2);
});
