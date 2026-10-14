import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createDeliveryRegistry,deliveryTargetSchema,deliveryPhaseIntegrationGaps} from '../scripts/release-delivery-adapters.mjs';
import {dependencyFixture} from '../support/dependency-transport-fixture.mjs';
import {fullHostFixture} from '../support/full-host-fixture.mjs';

function fixture(t,options={}) {
  const f=dependencyFixture(t,{format:2,...options}),host=fullHostFixture().options,effects=[];
  const ssh=f.put(join(f.root,'registry-ssh'),Buffer.from('Host fixture\n HostName example.invalid\n'));
  const transport=f.put(join(f.root,'registry-transport.json'),{format:1,sshConfig:ssh,hostAlias:'fixture'});
  const tools={git:f.options.python,python:f.options.python,gitExecPath:f.root};
  const target={format:1,transport,sourceTools:tools,artifactTools:{...tools,node:f.options.python,
    ciNodeSha256:'a'.repeat(64),nodeToolchain:{nodeVersion:'22.23.2',platform:process.platform,arch:'x64'}},
    bases:{private:{directory:f.base.directory,candidateId:f.base.candidateId,manifest:f.base.manifest},
      public:{directory:f.publicBase.directory,candidateId:f.publicBase.candidateId,manifest:f.publicBase.manifest}},
    assistantHost:{hostConfig:host.hostConfiguration,startupReview:ssh},browserCapability:'unavailable',
    full:{bundleUrl:'https://example.invalid/bundle.json',dependenciesUrl:'https://example.invalid/dependencies.tgz',
      dependencyTransport:f.options,host,publicationLedgerDirectory:join(f.root,'external-ledger'),
      feed:{channel:'stable',sequence:2,createdAt:'2026-10-14T19:00:00Z',expiresAt:'2026-10-15T19:00:00Z'},
      signing:{privateKeyPath:join(f.root,'never-sign.pem'),publicKey:ssh,previousFeed:f.put(join(f.root,'previous.json'),{synthetic:true})}}};
  delete target.artifactTools.gitExecPath;
  const descriptor={...f.descriptor,target:f.put(join(f.root,'full-target.json'),target)};
  const prior={route:f.route,artifacts:{repositories:f.artifacts},'private-ci':{release:{id:101}},'public-ci':{release:{id:102}}};
  const registry=createDeliveryRegistry({command:async()=>{effects.push('command');assert.fail('No command permitted');},
    run:async()=>{effects.push('host');assert.fail('No host permitted');}});
  return {...f,target,descriptor,prior,registry,effects};
}

test('configured full registry resolves all maintained producers while browser stays a distinct gap',async t=>{
  const f=fixture(t);
  assert.deepEqual(await f.registry.preflight(f.descriptor),[]);
  for(const phase of ['package','sign','capacity','recovery','publication','installation','assistant']) {
    const producer=f.registry.adapter(phase,f.descriptor,f.prior);assert.ok(producer,phase);
    for(const name of ['input','validate','execute','observe','verify'])assert.equal(typeof producer[name],'function',phase+'.'+name);
  }
  assert.equal(typeof f.registry.adapter('installation',f.descriptor,f.prior).admit,'function');
  assert.deepEqual(await f.registry.phasePreflight('browser',f.descriptor,f.prior),['browser-capability-unavailable','browser-reload-producer-not-integrated']);
  assert.deepEqual(f.effects,[]);
});

test('known runtime transitions stop initial delivery before source publication',async t=>{
  const f=fixture(t);
  for(const [priorAgentVersion,agentVersion,reason]of [
    ['2026.9.8','2026.10.0','unsupported-runtime-transition'],['2026.10.0','2026.10.0','unsupported-runtime-transition'],
    ['2026.9.6','2026.9.8','actual-settled-runtime-qualification-producer-required'],
    ['2026.9.2','2026.9.6','authenticated-runtime-producer-unavailable']]) {
    const descriptor={...f.descriptor,operation:{...f.descriptor.operation,priorAgentVersion,agentVersion}};
    assert.ok((await f.registry.preflight(descriptor)).includes(reason));
  }
  assert.deepEqual(f.effects,[]);
});

test('actual source comparisons surface schema/startup/helper gaps before any package child',async t=>{
  for(const [change,reason] of [['schema','changed-schema-qualification-producer-required'],['startup','changed-startup-qualification-producer-required'],
    [undefined,'full-helper-qualification-capability-required']]) await t.test(change??'unqualified synthetic helpers',async t=>{
      const f=fixture(t,{change});
      // Calling a changed candidate presentation cannot override its bytes.
      f.descriptor.operation.changeClass='presentation';
      assert.deepEqual(await f.registry.phasePreflight('package',f.descriptor,f.prior),[reason]);
      assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id,'package/dependency-stage'),null);
      assert.deepEqual(f.effects,[]);
    });
});

test('corrupt retained candidate is a verification error rather than an unsupported capability waiver',async t=>{
  const f=fixture(t);writeFileSync(join(f.artifacts.private.applicationDirectory,'dist/client/index.html'),'tampered');
  await assert.rejects(f.registry.phasePreflight('package',f.descriptor,f.prior));assert.deepEqual(f.effects,[]);
});

test('full configuration and actual CI release locators are required before package admission',async t=>{
  const f=fixture(t);
  const absent=structuredClone(f.target);delete absent.full.host;
  assert.ok(deliveryPhaseIntegrationGaps('package',absent,f.prior).includes('full-protected-host-target-not-configured'));
  const changed=structuredClone(f.target);changed.assistantHost.hostConfig={...changed.assistantHost.hostConfig,sha256:'0'.repeat(64)};
  assert.ok(deliveryPhaseIntegrationGaps('package',changed,f.prior).includes('full-assistant-host-configuration-mismatch'));
  assert.ok(deliveryPhaseIntegrationGaps('package',f.target,{...f.prior,'public-ci':{}}).includes('verified-ci-source-releases-required'));
  assert.equal(f.registry.adapter('publication',f.descriptor,{...f.prior,'public-ci':{}}),null);
  const noLedger=structuredClone(f.target);delete noLedger.full.publicationLedgerDirectory;assert.equal(deliveryTargetSchema.safeParse(noLedger).success,false);
  const arbitrary=structuredClone(f.target);arbitrary.full.command='arbitrary';assert.equal(deliveryTargetSchema.safeParse(arbitrary).success,false);
  assert.deepEqual(f.effects,[]);
});

test('installation admission rejects an absent or unproved original publication before capacity or dispatch',async t=>{
  const f=fixture(t),adapter=f.registry.adapter('installation',f.descriptor,f.prior);
  await assert.rejects(adapter.admit({descriptor:f.descriptor,prior:f.prior,journal:{deliveryPhase:()=>null}}),/original-publication-required/);
  const key=randomUUID(),publication={key,protectedStage:null},prior={...f.prior,publication,sign:{bundle:{},dependencies:{}}};
  await assert.rejects(adapter.admit({descriptor:f.descriptor,prior,journal:{deliveryPhase:()=>({state:'completed',key,current:{output:publication}})}}),/protected-assets-receipt-changed/);
  const result=await adapter.observe({descriptor:f.descriptor,prior,journal:{intent:()=>null}});
  assert.equal(result.state,'uncertain');assert.equal(result.reason,'original-install-reservation-not-recorded');
  assert.deepEqual(f.effects,[]);
});
