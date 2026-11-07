import test from 'node:test';
import assert from 'node:assert/strict';
import {join,dirname} from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import {sha256,qualifyApplicationPackage,planRelease} from '../scripts/release-plan.mjs';
import {buildFullCoordinatorDescriptor} from '../scripts/release-delivery-full-coordinator.mjs';
import {coordinatorFixture,now as coordinatorNow} from '../support/full-coordinator-fixture.mjs';
import {startupCommandFixture,HOME_CAPTURE_ROLES} from '../support/startup-command-fixture.mjs';
import {startupRetainedRequest,verifyStartupRetainedProjection,assertStartupQualifiedCandidate,QUALIFIED_STARTUP_SOURCES} from '../scripts/release-delivery-startup-retained.mjs';
import {createMaintainedDependencyTransport,dependencyTransportSchema,DEPENDENCY_PARSER_SHA} from '../scripts/release-delivery-dependency-transport.mjs';
import {createDependencyPairProducer} from '../scripts/release-delivery-dependencies.mjs';
import {createFullBundleAdapter} from '../scripts/release-delivery-full.mjs';
import {DEPENDENCY_PACK_PROBE_SHA} from '../scripts/release-delivery-qualified-dependencies.mjs';

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

async function pairLifecycle(t,schemaMigration=false,qualifiedDependencies=false){
  const f=startupCommandFixture(t,{schemaMigration,newDependencyGraph:qualifiedDependencies,...(schemaMigration?{sources:QUALIFIED_STARTUP_SOURCES}:{})}),commands=[];
  if(qualifiedDependencies){
    const binding=f.proof.qualificationBinding,archive=f.put(join(f.root,'qualified-dependencies.tgz'),Buffer.from('synthetic freshly qualified different Linux graph'));
    const description={format:1,archiveBytes:readFileSync(archive.path).length,archiveSha256:archive.sha256,expandedBytes:100,fileCount:3,packageLockSha256:binding.targets.private.packageLockSha256,dependencyGraphSha256:sha256('different installed fixture2 graph'),platform:'linux',arch:'x64',nodeVersion:'22.23.2',nodeAbi:127};
    const metadata=f.put(join(f.root,'qualified-dependencies.metadata.json'),description);
    binding.applicationDependencies=description;binding.dependencyGraphSha256=description.dependencyGraphSha256;
    binding.runtime.node='/runtime/node';binding.runtime.nodeSha256=sha256('synthetic application Node22');
    const execution=f.put(join(f.root,'qualified-dependencies.execution.json'),{format:1,kind:'qualified-application-dependency-pack',producerSha256:DEPENDENCY_PARSER_SHA,
      node:{path:binding.runtime.node,sha256:binding.runtime.nodeSha256,platform:'linux',arch:'x64',nodeVersion:'22.23.2',nodeAbi:127},
      source:{packageSha256:binding.targets.private.packageSha256,packageLockSha256:description.packageLockSha256,dependencyGraphSha256:description.dependencyGraphSha256,inventoryBeforeSha256:sha256('closed source'),inventoryAfterSha256:sha256('closed source')},
      archive:{sha256:archive.sha256,bytes:description.archiveBytes},metadataSha256:metadata.sha256,description,execution:{probeSha256:DEPENDENCY_PACK_PROBE_SHA,identity:{platform:'linux',arch:'x64',nodeVersion:'22.23.2',nodeAbi:127},exitCode:0},
      ...Object.fromEntries(['planRef','intentRef','closureRef'].map(n=>[n,{path:'/synthetic/'+n+'.json',sha256:sha256(n),bytes:1}]))});
    f.transportOptions={...f.transportOptions,format:6,mode:'qualified-application-dependency-successor',qualifiedDependencies:{archive,metadata,execution}};
  }
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
  const canonicalInput=structuredClone(f.intent.input);
  for(const artifact of Object.values(canonicalInput.artifacts)) delete artifact.manifest;
  assert.equal(await transport.validate({descriptor:f.descriptor,input:canonicalInput}),schemaMigration?60:55);
  assert.equal(commands.length,0);
  const completed=await producer.execute(f.context);
  assert.equal(completed.state,'completed',JSON.stringify({completed,executionErrors}));
  assert.deepEqual(commands.map(x=>JSON.parse(readFileSync(x.argv[2])).phase),qualifiedDependencies?[]:['plan','execute']);
  const output=completed.output,proofRef=output.startupQualification.projection;
  assert.deepEqual(JSON.parse(readFileSync(proofRef.path)),f.proof);
  assert.deepEqual(output.startupQualification.binding,f.proof.qualificationBinding);
  const pair=JSON.parse(readFileSync(join(output.directory,'reviewed-pair.json'))),preparation=JSON.parse(readFileSync(output.preparation.path));
  assert.notDeepEqual(pair.startupBarrier.prior,pair.startupBarrier.target);
  assert.equal(Object.hasOwn(pair,'startupQualification'),schemaMigration);
  if(schemaMigration){
    assert.deepEqual(pair.applicationTransition,f.proof.qualificationBinding.applicationTransition);
    assert.deepEqual(pair.startupQualification,{projection:{path:'startup-qualification.json',sha256:proofRef.sha256},binding:output.startupQualification.binding});
    assert.deepEqual(readFileSync(join(output.directory,'startup-qualification.json')),readFileSync(proofRef.path));
  }
  assert.deepEqual(preparation.startupQualification,output.startupQualification);
  assert.equal(preparation.newTargetStartupClaimed,false);
  assert.equal(preparation.freshFullRehearsalStillRequired,true);
  const rows=Object.keys(transport.steps).map(name=>{const row=f.journal.deliveryPhase(f.descriptor.operation.id,'package/'+name);return[row.phase,row.key,row.createdAtMs];});
  const reloaded=createDependencyPairProducer({maintained:fresh()});
  assert.deepEqual(await reloaded.inspect(f.context),completed);
  await reloaded.verify(completed,f.context);
  assert.deepEqual(Object.keys(transport.steps).map(name=>{const row=f.journal.deliveryPhase(f.descriptor.operation.id,'package/'+name);return[row.phase,row.key,row.createdAtMs];}),rows);
  assert.equal(commands.length,qualifiedDependencies?0:2);
  if(schemaMigration){
    const options={bundleUrl:'https://example.invalid/migration.json',dependenciesUrl:'https://example.invalid/dependencies.tgz'};
    const full=createFullBundleAdapter({options,pairProducer:{execute:async()=>completed,inspect:async()=>completed,verify:async()=>reloaded.verify(completed,f.context)}});
    const context={...f.context,intent:{...f.intent,input:{...f.intent.input,options}}};
    const packaged=await full.execute(context);assert.equal(packaged.state,'completed');
    assert.deepEqual(await full.observe(context),packaged);
    const envelope=JSON.parse(readFileSync(packaged.output.bundle.path));
    assert.equal(envelope.files.length,14);assert.equal(envelope.files.filter(x=>x.name==='startup-qualification.json').length,1);
    assert.equal(commands.length,qualifiedDependencies?0:2);
    if(qualifiedDependencies){
      const seed={...f,prior:{route:f.route,artifacts:{repositories:f.artifacts}}};
      const coordinated=await coordinatorFixture(t,{seed,packaged});
      const result=buildFullCoordinatorDescriptor(coordinated.context,coordinated.verified,coordinated.options);
      assert.equal(Object.keys(result.input.operation.helperHashes).length,11);
      assert.equal(planRelease(result.input,{nowMs:coordinatorNow}).phases.filter(p=>p.state==='passed').length,6);
      const spec=JSON.parse(readFileSync(result.adapter.installSpec.path));
      assert.equal(spec.schemaVersion,60);assert.equal(spec.applicationQualification.priorSchemaVersion,55);
      assert.equal(spec.applicationQualification.projectionSha256,proofRef.sha256);
      const entries=new Map(envelope.files.map(row=>[row.name,Buffer.from(row.data,'base64')]));
      const actualPair=JSON.parse(entries.get('reviewed-pair.json'));
      assert.equal(spec.applicationQualification.reviewedPairSha256,sha256(entries.get('reviewed-pair.json')));
      assert.equal(qualifyApplicationPackage(actualPair,entries,result.input.operation).length,11);
      for(const mutate of [p=>p.heldBootstrapVerified=false,p=>p.workerClosed=false,
        p=>p.qualificationBinding.sourceCommits.public='c'.repeat(40),p=>p.qualificationBinding.workspaceEpoch='11111111-1111-4111-8111-111111111111',
        p=>p.qualificationBinding.targets.public.candidateId='0'.repeat(64),p=>p.qualificationBinding.helpers['hosted_retained_catalog.py']='0'.repeat(64),
        p=>p.qualificationBinding.applicationDependencies.archiveSha256='0'.repeat(64),p=>p.qualificationBinding.applicationTransition.toSchemaVersion=61]){
        const changedProof=structuredClone(f.proof);mutate(changedProof);
        const proofBytes=Buffer.from(JSON.stringify(changedProof)+'\n'),changedPair=structuredClone(actualPair),changedEntries=new Map(entries);
        changedPair.startupQualification={projection:{path:'startup-qualification.json',sha256:sha256(proofBytes)},binding:changedProof.qualificationBinding};
        changedEntries.set('startup-qualification.json',proofBytes);changedEntries.set('reviewed-pair.json',Buffer.from(JSON.stringify(changedPair)));
        assert.throws(()=>qualifyApplicationPackage(changedPair,changedEntries,result.input.operation));
      }
      for(const name of ['startup-qualification.json','hosted-retained-catalog.mjs']){
        const missing=new Map(entries);missing.delete(name);assert.throws(()=>qualifyApplicationPackage(actualPair,missing,result.input.operation));
      }
      const changedHelper=new Map(entries);changedHelper.set('hosted-retained-catalog.mjs',Buffer.from('different helper'));
      assert.throws(()=>qualifyApplicationPackage(actualPair,changedHelper,result.input.operation),/helper-bytes-changed/);
      const unqualified={...actualPair};delete unqualified.applicationTransition;delete unqualified.startupQualification;
      assert.throws(()=>qualifyApplicationPackage(unqualified,entries,result.input.operation));
    }
  }
  writeFileSync(proofRef.path,JSON.stringify({...f.proof,heldBootstrapVerified:false})+'\n');
  await assert.rejects(reloaded.inspect(f.context));
  assert.equal(commands.length,qualifiedDependencies?0:2);
}
test('format5 stages, qualifies, pairs and reloads the same proof without replay; persisted drift refuses',t=>pairLifecycle(t));
test('schema55-to60 pair and full package carry the exact actual startup projection and remain observation-only on resume',t=>pairLifecycle(t,true));

test('format6 qualifies a different application dependency graph and packages it without replaying native execution',t=>pairLifecycle(t,true,true));

test('only the explicit schema55-to60 actual startup proof admits migration; unqualified same-schema60 refuses',async t=>{
  const f=startupCommandFixture(t,{schemaMigration:true});
  assert.doesNotThrow(()=>assertStartupQualifiedCandidate(f.proof,f.assertion,f.sources));
  for(const change of [v=>delete v.qualificationBinding.applicationTransition,
    v=>v.qualificationBinding.applicationTransition.fromSchemaVersion=54,
    v=>v.qualificationBinding.applicationTransition.toSchemaVersion=61,
    v=>v.qualificationBinding.applicationTransition.apiVersion=2,
    v=>v.qualificationBinding.applicationTransition.toAgentVersion='2026.10.0',
    v=>v.independentOriginalRestored=false,v=>v.scenarios.pop()]){
    const proof=structuredClone(f.proof);change(proof);
    assert.throws(()=>assertStartupQualifiedCandidate(proof,f.assertion,f.sources));
  }
  const transport=createMaintainedDependencyTransport({options:f.transportOptions,base:f.base,run:async()=>{throw Error('No command allowed');},startupCollector:async()=>f.proof,startupSources:f.sources});
  await transport.validate({descriptor:f.descriptor,input:f.intent.input});
  assert.equal(f.calls.length,0);
  const same=startupCommandFixture(t,{sameSchema60:true});
  assert.throws(()=>assertStartupQualifiedCandidate(same.proof,same.assertion,same.sources),/same-schema60-producer-unavailable/);
  const stale=structuredClone(same.proof);stale.qualificationBinding.applicationTransition=f.proof.qualificationBinding.applicationTransition;
  assert.throws(()=>assertStartupQualifiedCandidate(stale,same.assertion,same.sources),/unexpected-startup|startup-qualified-artifact-closure/);
});

const historicalSources = {
  'qualified-startup.py':'0a45ca346ec848ec8b17a0f1dcab43314ae344b12b5f8a0144f518d05144f3f5',
  'qualified-parent.py':'9ed15c8a2f6899376a2dbe577a4b559fc03c62e0e780332d01ba68c3d7d731b2',
  'produce-startup-inputs.py':'8538ccf1be387997037dde375a06d564871ef5200884449ebcbd2edad33a72ec',
  'contracts.py':'473e6f57a6a8536cb3f926e480ef60bf07fbe48df73c63c328c240dcde08ddc7',
};
const replicaProfiles = {
  current:QUALIFIED_STARTUP_SOURCES,
  source25:{'qualified-startup.py':'9a30fd20d3a8321d763abba55dfc9ba55818d27984b1aa0337f3a17c0607554b',
    'qualified-parent.py':'11bd0945c69845cd66a5f3dd6024328b4630011bbd5a0640690a18584686d722',
    'produce-startup-inputs.py':'1aedbc3c70393663c2929d3a7a908f443c43d1d6775e166a6b8b61f9d59b2b81',
    'contracts.py':'ce05132d19826e2dde754dce5e69a9f48a1d64e3f2dbe32ab97e5b31d99bcb31'},
  previous:historicalSources,
  historical:{...historicalSources,'qualified-startup.py':'3c433ce80cf48a2988f2fac3818429174b1bcedbdc78bbcc01bee75e3a9479af','contracts.py':'68b6f47f8a5a321f3415a043b152bc99114c56dcea515eae0c54e58be1d35642'},
};
for(const [profile,sources] of Object.entries(replicaProfiles)){
  test('the '+profile+' replica qualification rejects omitted device and stale queue-cutoff evidence',t=>{
    const fixture=startupCommandFixture(t,{sources,schemaMigration:true});
    verifyStartupRetainedProjection(fixture.proof,fixture.proof.request,fixture.sources);
    for(const change of [s=>delete s[0].replicaConfigObservation,
      s=>{s[1].replicaConfigObservation.queueExpiry.authenticatedStartSeconds=s[1].startedAtSeconds;},
      s=>{s[0].replicaConfigObservation.observations[0].changedFields=['uid'];},
      s=>{s[2].replicaConfigObservation.observations[0].mode='same-filesystem-original-equality';}]){
      const copy=structuredClone(fixture.proof);change(copy.scenarios);
      assert.throws(()=>verifyStartupRetainedProjection(copy,copy.request,fixture.sources));
    }
  });
}

test('the incident capture source requires original staged bytes and authenticated restart and restore evidence',t=>{
  const fixture=startupCommandFixture(t,{schemaMigration:true,sources:QUALIFIED_STARTUP_SOURCES});
  const verify=p=>verifyStartupRetainedProjection(p,fixture.proof.request,fixture.sources);
  verify(fixture.proof);
  for(const change of [
    p=>delete p.baselineLineage,
    p=>delete p.scenarios[0].captureRetirement,
    p=>p.scenarios[1].captureRetirement.roles=[],
    p=>p.scenarios[1].captureRetirement.roles[0].proofSha256='f'.repeat(64),
    p=>p.scenarios[1].captureRetirement.roles[0].firstWindow=[200,250],
    p=>p.scenarios[2].captureRetirement.roles[0].headerSha256='e'.repeat(64),
    p=>p.scenarios[2].captureRetirement.roles[0].physicalOwner=p.scenarios[0].captureRetirement.roles[0].physicalOwner,
  ]){
    const proof=structuredClone(fixture.proof);change(proof);assert.throws(()=>verify(proof));
  }
});

test('new lifecycle profile accepts only bound role reaping and preserves old retirement profile',t=>{
  const fixture=startupCommandFixture(t,{schemaMigration:true,sources:QUALIFIED_STARTUP_SOURCES});
  const verify=p=>verifyStartupRetainedProjection(p,p.request,fixture.sources);
  const reaped=structuredClone(fixture.proof);
  const role=reaped.scenarios[1].captureRetirement.roles[0];
  Object.assign(role,{proofSha256:sha256('actual second role'),physicalOwner:null,state:'reaped',reaped:true,
    remainingNamespaces:[],remainingCount:0,remainingSha256:sha256('[]'),sourceAdmissionsSha256:'d'.repeat(64)});
  verify(reaped);
  // The previous reviewed producer keeps the same strict lifecycle evidence contract.
  const previous=structuredClone(reaped),previousSources={...fixture.sources,
    'qualified-startup.py':'7ca0aa07ead0d6d6672352a59a520cd93e42295993cd36064994bfb701cfe6eb'};
  previous.sourceHashes=previousSources;
  previous.request.producer.sha256=previousSources['qualified-startup.py'];
  const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)
    ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
  previous.requestSha256=sha256(Buffer.from(canonical(previous.request)+'\n'));
  previous.references.producer.sha256=previousSources['qualified-startup.py'];
  previous.references['source/qualified-startup.py'].sha256=previousSources['qualified-startup.py'];
  verifyStartupRetainedProjection(previous,previous.request,previousSources);
  delete previous.references.baselineManifest;
  assert.throws(()=>verifyStartupRetainedProjection(previous,previous.request,previousSources));
  for(const alter of [p=>delete p.references.baselineManifest,
    p=>p.qualificationBinding.helpers['recovery.py']='f'.repeat(64),
    p=>p.qualificationBinding.helpers['install.py']='e'.repeat(64)]){
    const value=structuredClone(reaped);alter(value);assert.throws(()=>verify(value));
  }
  const partial=structuredClone(reaped),member='admission-Alpha1';
  Object.assign(partial.scenarios[1].captureRetirement.roles[0],{physicalOwner:['2','10'],state:'partially-reaped',reaped:false,
    remainingNamespaces:[member],remainingCount:1,remainingSha256:sha256(JSON.stringify([member]))});
  verify(partial);
  for(const change of [
    r=>r.predecessorProofSha256='f'.repeat(64),r=>r.lastWindow=[100,150],r=>r.firstWindow=[200,250],
    r=>r.physicalOwner=['2','10'],r=>r.reaped=false,r=>r.state='retired',
    r=>r.remainingCount=1,r=>r.remainingSha256='f'.repeat(64),r=>r.sourceAdmissionsSha256=null,
    r=>r.remainingNamespaces=['admission-Alpha1'],r=>r.unknown=true,
  ]){
    const value=structuredClone(reaped);change(value.scenarios[1].captureRetirement.roles[0]);
    assert.throws(()=>verify(value));
  }
  const legacySources={...QUALIFIED_STARTUP_SOURCES,
    'qualified-startup.py':'bf65b3f46cdabb5272c7bc2a6824fd242b46d761255f2633887a6f9b61b3fd58',
    'contracts.py':'00459249aff53c0b02381b47ded4b232515b773f3402f503c7e8ea143f158305'};
  const legacy=startupCommandFixture(t,{schemaMigration:true,sources:legacySources});
  verifyStartupRetainedProjection(legacy.proof,legacy.proof.request,legacy.sources);
  delete legacy.proof.scenarios[1].captureRetirement;
  assert.throws(()=>verifyStartupRetainedProjection(legacy.proof,legacy.proof.request,legacy.sources));
});

