import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {sha256} from '../scripts/release-plan.mjs';
import {versionMetadataOnly,dependencyTransportSchema,DEPENDENCY_SUCCESSOR_SHA} from '../scripts/release-delivery-dependency-transport.mjs';
import {createDeliveryRegistry} from '../scripts/release-delivery-adapters.mjs';
import {dependencyFixture} from '../support/dependency-transport-fixture.mjs';

test('format1 remains version-only; format2 admits only the exact release command addition',()=>{
 const p={version:'1.0.0',edition3:{buildVersion:'1.0.1'},scripts:{build:'same',postinstall:'same'},engines:{node:'22'},dependencies:{one:'1'}},l={version:'1.0.0',packages:{'':{version:'1.0.0',dependencies:{one:'1'}}}},q=structuredClone(p),m=structuredClone(l);
 q.version='1.0.1';q.edition3.buildVersion='1.0.2';m.version=m.packages[''].version='1.0.1';assert.doesNotThrow(()=>versionMetadataOnly(p,l,q,m));
 q.scripts['release:deliver']='node scripts/release-deliver.mjs';assert.throws(()=>versionMetadataOnly(p,l,q,m),/qualification-producer/);assert.doesNotThrow(()=>versionMetadataOnly(p,l,q,m,'release-deliver-script-v1'));
 for(const change of [v=>v.scripts.postinstall='changed',v=>v.scripts.preinstall='new',v=>v.scripts['prerelease:deliver']='new',v=>v.scripts.build='changed',v=>v.engines.node='24',v=>v.dependencies.one='2',v=>v.scripts['release:deliver']='node other.mjs']){const changed=structuredClone(q);change(changed);assert.throws(()=>versionMetadataOnly(p,l,changed,m,'release-deliver-script-v1'));}
 const changedLock=structuredClone(m);changedLock.packages[''].dependencies.one='2';assert.throws(()=>versionMetadataOnly(p,l,q,changedLock,'release-deliver-script-v1'));
 assert.equal(dependencyTransportSchema.safeParse({format:1,metadataPolicy:'release-deliver-script-v1'}).success,false);
 assert.equal(sha256(readFileSync(new URL('../scripts/release-dependency-metadata-successor.py',import.meta.url))),DEPENDENCY_SUCCESSOR_SHA);
});
test('synthetic selected native/source bindings admit without child reservations or commands',async t=>{
 for(const format of [1,2])await t.test('format'+format,async t=>{const f=dependencyFixture(t,{format});await f.transport.validate({descriptor:f.descriptor,input:f.intent.input});await f.transport.validate(f.context);assert.equal(f.calls.length,0);assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id,'package/dependency-stage'),null);});
});
test('runtime/schema/startup/accepted-baseline/helper changes refuse before child effects',async t=>{
 for(const change of ['runtime','schema','startup','selected-baseline','helper'])await t.test(change,async t=>{
  const f=dependencyFixture(t,{change});if(change==='runtime')f.context.descriptor.operation.agentVersion='2026.10.0';
  if(change==='helper')f.context.intent.input.artifacts.public.sourceHashes['deploy/update-runner/recovery.py'].sha256='0'.repeat(64);
  await assert.rejects(f.transport.validate(f.context));assert.equal(f.calls.length,0);assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id,'package/dependency-stage'),null);
 });
});
test('format2 requires both authenticated existing identical command sources',async t=>{
 for(const change of ['missing-binding','corrupt-file','different-public'])await t.test(change,async t=>{
  const f=dependencyFixture(t,{format:2}),artifact=f.context.intent.input.artifacts.public,ref=artifact.sourceHashes['scripts/release-deliver.mjs'];
  if(change==='missing-binding')delete artifact.sourceHashes['scripts/release-deliver.mjs'];
  else {writeFileSync(ref.path,'different command source');if(change==='different-public')ref.sha256=sha256(readFileSync(ref.path));}
  await assert.rejects(f.transport.validate(f.context),/release-command/);assert.equal(f.calls.length,0);
 });
});
test('original reserved stage remains observation-only after interruption',async t=>{
 const f=dependencyFixture(t),payload=await f.transport.steps['dependency-stage'].input({...f.context,priorSubsteps:{}});
 const old=f.journal.reserveDeliveryPhase(f.descriptor.operation.id,'package/dependency-stage',{parentKey:f.intent.key,parentInputSha256:f.intent.inputSha256,priorResultsSha256:sha256('{}'),payload},Date.now()).intent;
 const result=await f.producer.observe(f.context);assert.equal(result.state,'uncertain');assert.equal(f.calls.length,0);
 assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id,'package/dependency-stage').key,old.key);assert.equal(existsSync(join(f.root,'dependency-'+f.intent.key)),false);
});
test('main registry uses portable validated dependency sources before any transport effect',async t=>{
 const f=dependencyFixture(t,{format:2}),effects=[],command=async()=>{effects.push('command');throw Error('No command expected');},run=async()=>{effects.push('ssh');throw Error('No SSH expected');};
 const ssh=f.put(join(f.root,'ssh-config'),Buffer.from('# fixture only\n')),transport=f.put(join(f.root,'transport.json'),{format:1,sshConfig:ssh,hostAlias:'fixture'});
 const target={format:1,transport,bases:{private:{directory:f.base.directory,candidateId:f.base.candidateId,manifest:f.base.manifest},public:{directory:f.publicBase.directory,candidateId:f.publicBase.candidateId,manifest:f.publicBase.manifest}},browserCapability:'unavailable',full:{publicationLedgerDirectory:join(f.root,'publication-ledger'),bundleUrl:'https://example.invalid/bundle.json',dependenciesUrl:'https://example.invalid/dependencies.tgz',dependencyTransport:f.options,feed:{channel:'stable',sequence:1,createdAt:'2026-10-14T18:00:00Z',expiresAt:'2026-10-15T18:00:00Z'},signing:{privateKeyPath:join(f.root,'unused-key'),publicKey:ssh,previousFeed:'initial'}}};
 const descriptor={...f.descriptor,target:f.put(join(f.root,'registry-target.json'),target)},prior={route:f.route,artifacts:{repositories:f.artifacts}},registry=createDeliveryRegistry({command,run});
 const adapter=registry.adapter('package',descriptor,prior),input=await adapter.input({descriptor,prior});await adapter.validate({descriptor,input});assert.deepEqual(effects,[]);
 assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id,'package/dependency-stage'),null);
 delete target.full.dependencyTransport;const absent={...descriptor,target:f.put(join(f.root,'missing-target.json'),target)};
 assert.ok((await registry.phasePreflight('package',absent,prior)).includes('qualified-dependency-worker-transport-not-integrated'));
});
