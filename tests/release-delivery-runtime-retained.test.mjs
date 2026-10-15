import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync,mkdirSync,existsSync} from 'node:fs';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {ReleaseJournal} from '../scripts/release-coordinate.mjs';
import {sha256} from '../scripts/release-plan.mjs';
import {createDependencyPairProducer} from '../scripts/release-delivery-dependencies.mjs';
import {createRuntimeRetainedCollector,verifyRuntimeRetainedProjection,assertRuntimeQualifiedCandidate,runtimeRetainedRequest,buildRuntimeRetainedProgram,verifyRuntimeQualificationReference} from '../scripts/release-delivery-runtime-retained.mjs';
import {createMaintainedDependencyTransport,dependencyTransportSchema} from '../scripts/release-delivery-dependency-transport.mjs';
import {verifyCandidate} from '../scripts/candidate.mjs';
import {runtimeCommandFixture} from '../support/runtime-command-fixture.mjs';
import {fullHostFixture} from '../support/full-host-fixture.mjs';
import {fullFactsSpec,FULL_HELPERS,collectFullOnlineCapacity} from '../scripts/release-delivery-full-host.mjs';
import {createDeliveryRegistry} from '../scripts/release-delivery-adapters.mjs';
import {withVerificationPass,verificationEffect} from '../scripts/release-verification-pass.mjs';
const copy=v=>structuredClone(v);

test('runtime verification scope distinguishes original journal directories',async t=>{
 const f=runtimeCommandFixture(t),transport=createMaintainedDependencyTransport({options:f.transportOptions,base:f.selected,
  runtimeCollector:async()=>f.proof,run:async()=>{throw Error('No command permitted');}});
 const context={descriptor:f.descriptor,intent:{...f.intent,input:f.input},journal:f.journal},open=fs.openSync;let reads=0;
 fs.openSync=function(path,...args){if(path===f.transportOptions.selectedBundle.path)reads++;return open.call(this,path,...args);};syncBuiltinESMExports();
 try{
  await withVerificationPass(context,async c=>{
   await transport.validate(c);await transport.validate(c);assert.equal(reads,2);
   const other={...c,journal:{directory:join(f.root,'different-original-journal')}};
   await transport.validate(other);assert.equal(reads,4);
   await transport.validate(other);assert.equal(reads,4);
  });
  assert.equal(f.calls.length,0);
 }finally{fs.openSync=open;syncBuiltinESMExports();}
});

test('runtime verification scope binds retained proof and rehashes after an effect and resume',async t=>{
 const f=runtimeCommandFixture(t),transport=createMaintainedDependencyTransport({options:f.transportOptions,base:f.selected,
  runtimeCollector:async()=>f.proof,run:async()=>{throw Error('No command permitted');}});
 const context={descriptor:f.descriptor,input:f.input},open=fs.openSync;let reads=0;
 fs.openSync=function(path,...args){if(path===f.transportOptions.selectedBundle.path)reads++;return open.call(this,path,...args);};syncBuiltinESMExports();
 try{
  await withVerificationPass(context,async c=>{
   for(let i=0;i<35;i++)await transport.validate(c);assert.equal(reads,2);
   const name='dist/service/apps/service/main.js',original=f.proof.qualifiedServiceArtifacts[name];
   f.proof.qualifiedServiceArtifacts[name]='0'.repeat(64);
   await assert.rejects(transport.validate(c),/runtime-qualified-original-service-changed/);f.proof.qualifiedServiceArtifacts[name]=original;
   await verificationEffect(c,()=>fs.writeFileSync(f.transportOptions.runtime.archive.path,'corrupt runtime'));
   await assert.rejects(transport.validate(c),/artifact|hash|changed/);
  });
  await assert.rejects(withVerificationPass(context,c=>transport.validate(c)),/artifact|hash|changed/);
  assert.equal(f.calls.length,0);
 }finally{fs.openSync=open;syncBuiltinESMExports();}
});

test('actual-proof request is strict and fixed collector never accepts a local passed receipt',t=>{
 const f=runtimeCommandFixture(t),request=runtimeRetainedRequest(f.runtimeOptions);
 assert.deepEqual(verifyRuntimeRetainedProjection(f.proof,request),f.proof);
 assert.throws(()=>runtimeRetainedRequest({...f.runtimeOptions,passed:true}));
 assert.throws(()=>runtimeRetainedRequest({...f.runtimeOptions,producer:{...f.runtimeOptions.producer,sha256:'0'.repeat(64)}}));
 const program=buildRuntimeRetainedProgram(request);assert.match(program,/signal.alarm\(110\)/);assert.ok(program.indexOf('hashlib.sha256')<program.indexOf('exec(compile'));
 for(const mutate of [v=>v.actualSettledQualification=false,v=>v.productionAdmission=true,v=>v.scenarios.pop(),v=>delete v.references.restorationCompleted,v=>v.request.parent.sha256='0'.repeat(64)]){
  const v=copy(f.proof);mutate(v);assert.throws(()=>verifyRuntimeRetainedProjection(v,request));
 }
});
test('read-only collection strips observation time without renewing original proof identity',async t=>{
 const f=runtimeCommandFixture(t),ssh=f.put(join(f.root,'ssh-config'),Buffer.from('# synthetic')),transport=f.put(join(f.root,'transport.json'),{format:1,sshConfig:ssh,hostAlias:'fixture'});let calls=0,now=1234567890000;
 const run=async(_target,program)=>{calls++;assert.match(program,/fixed_runtime_retained_consumer/);return{exitCode:0,stdout:JSON.stringify({ok:true,value:{...f.proof,observedAtMilliseconds:now}})};};
 const collect=createRuntimeRetainedCollector({transport,options:f.runtimeOptions,run,clock:()=>now});
 const a=await collect();now+=120000;assert.deepEqual(await collect(),a);assert.equal(calls,2);assert.equal(a.observedAtMilliseconds,undefined);
 await assert.rejects(createRuntimeRetainedCollector({transport,options:f.runtimeOptions,run:async()=>({uncertain:true,stdout:''}),clock:()=>now})(),/observation-unavailable/);
});
test('separate selected prior, accepted native anchor and target compiled service are mandatory',t=>{
 const f=runtimeCommandFixture(t),candidates=Object.fromEntries(Object.entries(f.artifacts).map(([k,v])=>[k,verifyCandidate(v.directory)]));
 const input={operation:f.descriptor.operation,prior:f.priorCandidate,nativeAnchor:f.qualified,candidates,runtime:f.runtime,helpers:f.proof.helpers};
 assert.doesNotThrow(()=>assertRuntimeQualifiedCandidate(f.proof,input));
 assert.throws(()=>assertRuntimeQualifiedCandidate(f.proof,{...input,prior:f.qualified}),/prior-and-native-anchor/);
 const changed={...candidates.private,bytes:new Map(candidates.private.bytes)};changed.bytes.set('dist/service/apps/service/main.js',Buffer.from('unqualified'));
 assert.throws(()=>assertRuntimeQualifiedCandidate(f.proof,{...input,candidates:{...candidates,private:changed}}),/changed-startup/);
});
test('version3 source admission reuses native anchor but cannot fabricate settled evidence',async t=>{
 const f=runtimeCommandFixture(t);assert.equal(dependencyTransportSchema.parse(f.transportOptions).format,3);let collected=0;
 const factory=collector=>createMaintainedDependencyTransport({options:f.transportOptions,base:f.selected,run:async()=>{throw Error('No command');},runtimeCollector:collector});
 await assert.rejects(factory(null).validate({descriptor:f.descriptor,input:f.input}),/actual-settled/);
 const transport=factory(async()=>{collected++;return f.proof;});await transport.validate({descriptor:f.descriptor,input:f.input});await transport.validate({descriptor:f.descriptor,input:f.input});
 assert.equal(collected,1);assert.equal(f.calls.length,0);
 const altered=copy(f.proof);altered.runtime.archiveSha256='0'.repeat(64);
 await assert.rejects(factory(async()=>altered).validate({descriptor:f.descriptor,input:f.input}),/artifact-or-helper/);
});
test('persisted runtime proof binds signed successor, real prior, native anchor and original sources',t=>{
 const f=runtimeCommandFixture(t),runtime={...f.transportOptions.runtime,description:f.runtime,qualification:f.put(join(f.root,'qualified-proof.json'),f.proof),qualificationBinding:{candidateId:f.artifacts.private.candidateId,priorCandidateId:f.selected.candidateId,nativeAnchorCandidateId:f.nativeAnchor.candidateId,sourceCommits:f.descriptor.operation.sourceCommits}};
 assert.doesNotThrow(()=>verifyRuntimeQualificationReference(runtime,f.descriptor.operation,f.proof.helpers));
 for(const mutate of [v=>v.qualificationBinding.priorCandidateId='0'.repeat(64),v=>v.qualificationBinding.nativeAnchorCandidateId='0'.repeat(64),v=>v.description.toVersion='2026.9.9']){
  const v=copy(runtime);mutate(v);assert.throws(()=>verifyRuntimeQualificationReference(v,f.descriptor.operation,f.proof.helpers));
 }
});
test('full host admits the distinct runtime proof while capacity remains an online projection',async t=>{
 const f=runtimeCommandFixture(t),h=fullHostFixture();f.proof.helpers={...FULL_HELPERS};
 const runtime={...f.transportOptions.runtime,description:f.runtime,qualification:f.put(join(f.root,'qualified-host-proof.json'),f.proof),qualificationBinding:{candidateId:f.artifacts.private.candidateId,priorCandidateId:f.selected.candidateId,nativeAnchorCandidateId:f.nativeAnchor.candidateId,sourceCommits:f.descriptor.operation.sourceCommits}};
 const spec=fullFactsSpec(f.descriptor,h.options,h.key,runtime);assert.equal(spec.base.agentVersion,'2026.9.6');assert.equal(spec.base.candidateId,f.selected.candidateId);
 assert.throws(()=>fullFactsSpec(f.descriptor,h.options,h.key),/actual-settled/);
 const now=1700000000000;h.completed.observedAtMilliseconds=now;h.values.stateDirectory='/var/lib/nova-update';
 const metadata=f.put(join(f.root,'package-capacity.json'),{archiveBytes:10,expandedBytes:100,fileCount:3});
 const ssh=f.put(join(f.root,'ssh-config'),Buffer.from('# synthetic')),transport=f.put(join(f.root,'transport.json'),{format:1,sshConfig:ssh,hostAlias:'fixture'});
 const capacity={freeBytes:8*1024**3,candidateBytes:1000,snapshotCopyBytes:100,independentRestoreBytes:100,startupGrowthAllowanceBytes:200,nativeMigrationBytes:10,managedCompanionBytes:20,metadataOverheadBytes:30,reserveBytes:1536*1024**2,allowanceBytes:256*1024**2,metadataOverheadMeasured:true,snapshotDeltaMeasured:true,lifecycle:'online'};
 capacity.requiredFreeBytes=['candidateBytes','snapshotCopyBytes','independentRestoreBytes','startupGrowthAllowanceBytes','nativeMigrationBytes','managedCompanionBytes','metadataOverheadBytes','reserveBytes','allowanceBytes'].reduce((n,k)=>n+capacity[k],0);
 let calls=0,changedProjection=false;
 const run=async(_transport,program)=>{
  calls++;const data=JSON.parse(Buffer.from(program.match(/base64.b64decode\('([^']+)'/)[1],'base64')).data;
  assert.deepEqual(data.runtime,f.runtime);assert.equal(data.spec.base.agentVersion,'2026.9.6');
  return{exitCode:0,stdout:JSON.stringify({format:2,kind:'measured-full-online-capacity',readOnly:true,hostEffects:false,observedAtMilliseconds:now,
   workspaceEpoch:f.descriptor.operation.workspaceEpoch,health:{status:'ready',candidateId:f.selected.candidateId},runtime:{agentVersion:'2026.9.6'},sourceCommit:f.descriptor.sources.private.commit,helperHashes:FULL_HELPERS,
   originalClosedEvidence:data.recoveryEvidence,expectedReclaimBytes:0,dependencyReuseCreditBytes:0,authoritativeStoppedAdmission:false,stoppedAndPostStartChecksStillRequired:true,capacity,
   runtimeProjection:{kind:'conservative-runtime-online-projection',fromVersion:'2026.9.6',toVersion:'2026.9.8',archiveSha256:f.runtime.archiveSha256,runtimeReuseCreditBytes:0,actualTargetStartupQualified:false,runtimeAdmission:changedProjection,runtimeArchiveBytes:34,runtimeExpansionBytes:100,nativeMigrationBytes:10,managedCompanionBytes:20}})};
 };
 const context={journal:f.journal,intent:{key:h.key},descriptor:f.descriptor,prior:{sign:{runtime,dependencies:{description:{}},release:{bundle:{bytes:100},agentVersion:'2026.9.8',runtimeBundle:{bytes:17,sha256:f.runtime.archiveSha256}}},
  artifacts:{repositories:{private:{metadata}}},recovery:{kind:'nova-delivery-full-rehearsal',completion:h.completed,values:h.values,leaseId:h.values.leaseId,evidence:{}}}};
 const args={transport,options:h.options,run,clock:()=>now,storeReceipt:(_j,key,name,bytes)=>f.put(join(f.root,key+'-'+name),bytes)};
 assert.equal((await collectFullOnlineCapacity(context,args)).state,'completed');assert.equal(calls,1);
 changedProjection=true;await assert.rejects(collectFullOnlineCapacity(context,args),/projection-incomplete/);
});
test('main registry collects actual runtime proof before any source or package effect',async t=>{
 const f=runtimeCommandFixture(t),ssh=f.put(join(f.root,'ssh-config'),Buffer.from('# synthetic')),transport=f.put(join(f.root,'transport.json'),{format:1,sshConfig:ssh,hostAlias:'fixture'});
 const target={format:1,transport,bases:{private:f.selected,public:f.selected},browserCapability:'unavailable',full:{publicationLedgerDirectory:join(f.root,'publication-ledger'),bundleUrl:'https://example.invalid/bundle.json',dependenciesUrl:'https://example.invalid/dependencies.tgz',runtimeUrl:'https://example.invalid/runtime.tgz',dependencyTransport:f.transportOptions,
  feed:{channel:'stable',sequence:1,createdAt:'2026-10-14T18:00:00Z',expiresAt:'2026-10-15T18:00:00Z'},signing:{privateKeyPath:join(f.root,'unused-key'),publicKey:ssh,previousFeed:'initial'}}};
 const descriptor={...f.descriptor,target:f.put(join(f.root,'runtime-target.json'),target)},prior={route:f.route,artifacts:{repositories:f.artifacts}},now=Date.now();let calls=0,bad=false;
 const run=async()=>{calls++;return{exitCode:0,stdout:JSON.stringify({ok:true,value:{...f.proof,actualSettledQualification:!bad,observedAtMilliseconds:now}})};};
 const registry=createDeliveryRegistry({command:async()=>{throw Error('No command permitted');},run,clock:()=>now});
 const gaps=await registry.preflight(descriptor);assert.deepEqual(gaps,['source-toolchain-not-configured','artifact-toolchain-not-configured']);assert.equal(calls,1);
 const adapter=registry.adapter('package',descriptor,prior),input=await adapter.input({descriptor,prior});await adapter.validate({descriptor,input});assert.equal(calls,2);
 assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id,'package/dependency-stage'),null);
 bad=true;await assert.rejects(registry.preflight(descriptor),/projection-required/);
 const unsupported={...descriptor,operation:{...descriptor.operation,priorAgentVersion:'2026.9.2',agentVersion:'2026.9.6'}};
 assert.ok((await registry.preflight(unsupported)).includes('authenticated-runtime-producer-unavailable'));assert.equal(calls,3);
});
test('runtime resume observes the reserved original stage and rejects replacement proof identity',async t=>{
 const f=runtimeCommandFixture(t),journal=Object.create(ReleaseJournal.prototype);journal.directory=join(f.root,'runtime-journal');mkdirSync(journal.directory);journal.readOnly=false;
 journal.db=new DatabaseSync(join(journal.directory,'journal.sqlite'));try{
 const schema=readFileSync(new URL('../scripts/release-coordinate.mjs',import.meta.url),'utf8').match(/this\.db\.exec\(`(PRAGMA journal_mode=WAL;[\s\S]+?PRAGMA user_version=1; COMMIT;)`\);/)[1].replace('${APPLICATION_ID}',String(0x4e56524c));journal.db.exec(schema);
 const now=Date.now();journal.initializeDelivery(f.descriptor,now);
 const intent=journal.reserveDeliveryPhase(f.descriptor.operation.id,'package',{...f.input,options:{}},now).intent,context={journal,descriptor:f.descriptor,intent,beforeNewEffect:async()=>{throw Error('Original stage must not acquire a fresh effect');}};
 let commands=0;const factory=proof=>createMaintainedDependencyTransport({options:f.transportOptions,base:f.selected,run:async()=>{commands++;throw Error('No command permitted');},runtimeCollector:async()=>proof});
 const transport=factory(f.proof);await transport.validate(context);
 const payload=await transport.steps['dependency-stage'].input({...context,priorSubsteps:{}}),old=journal.reserveDeliveryPhase(f.descriptor.operation.id,'package/dependency-stage',{parentKey:intent.key,parentInputSha256:intent.inputSha256,priorResultsSha256:sha256('{}'),payload},now).intent;
 const result=await createDependencyPairProducer({maintained:transport}).observe(context);
 assert.equal(result.state,'uncertain');assert.equal(commands,0);assert.equal(existsSync(join(journal.directory,'dependency-'+intent.key)),false);
 assert.equal(journal.deliveryPhase(f.descriptor.operation.id,'package/dependency-stage').key,old.key);
 const different=copy(f.proof);different.qualificationOperationId='3d47456c-df00-4317-9513-91ae98ff323c';
 await assert.rejects(createDependencyPairProducer({maintained:factory(different)}).observe(context),/substep-input-changed/);assert.equal(commands,0);
 }finally{journal.close();}
});
