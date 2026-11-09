import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {createDeliveryRegistry} from '../scripts/release-delivery-adapters.mjs';
import {startupCommandFixture} from '../support/startup-command-fixture.mjs';
import {fullHostFixture} from '../support/full-host-fixture.mjs';
import {QUALIFIED_STARTUP_SOURCES} from '../scripts/release-delivery-startup-retained.mjs';
import {fullFactsSpec} from '../scripts/release-delivery-full-host.mjs';
import {sha256} from '../scripts/release-plan.mjs';

function fixture(t,{offset=0,stalled=false,invalidIdentity=false}={}){
 const f=startupCommandFixture(t,{sources:QUALIFIED_STARTUP_SOURCES,schemaMigration:true}),h=fullHostFixture();
 let wall=1700000000000,mono=0,calls=0;const original=wall,receipts=[],waits=[];
 const ssh=f.put(join(f.root,'clock-ssh'),Buffer.from('Host synthetic\n HostName example.invalid\n'));
 const transport=f.put(join(f.root,'clock-transport.json'),{format:1,sshConfig:ssh,hostAlias:'synthetic'});
 const target={format:1,transport,browserCapability:'unavailable',full:{bundleUrl:'https://example.invalid/bundle',dependenciesUrl:'https://example.invalid/deps',publicationLedgerDirectory:join(f.root,'ledger'),
  feed:{channel:'stable',sequence:2,createdAt:'2026-10-14T19:00:00Z',expiresAt:'2026-10-15T19:00:00Z'},signing:{privateKeyPath:join(f.root,'never-sign'),publicKey:ssh,previousFeed:'initial'},host:h.options,
  dependencyTransport:{...f.transportOptions,format:6,mode:'qualified-application-dependency-successor',qualifiedDependencies:{archive:ssh,metadata:ssh,execution:ssh}}}};
 const descriptor={...h.descriptor,target:f.put(join(f.root,'clock-target.json'),target)};
 const spec=fullFactsSpec(descriptor,h.options,descriptor.operation.id,null,f.proof.qualificationBinding.applicationTransition);
 h.facts.review.helperHashes=spec.helperHashes;h.facts.observedAtMilliseconds=original+offset;
 if(invalidIdentity)h.facts.health.candidateId='0'.repeat(64);
 const raw=JSON.stringify(h.facts),registry=createDeliveryRegistry({clock:()=>wall,monotonic:()=>mono,
  wait:async ms=>{assert.equal(receipts[0].value.kind,'operator-continuation-host-response');waits.push(ms);mono+=ms;if(!stalled)wall+=ms;},
  command:async()=>assert.fail('No command permitted'),
  run:async()=>{calls++;if(calls===1)return{exitCode:0,stderr:'',stdout:JSON.stringify({ok:true,value:{...f.proof,observedAtMilliseconds:original}})};assert.equal(calls,2);return{exitCode:0,stderr:'',stdout:raw};},
  receiptStore:(journal,key,name,bytes)=>{assert.equal(journal,f.journal);assert.equal(key,descriptor.operation.id);const reference=f.put(join(f.root,name),bytes);receipts.push({reference,value:JSON.parse(bytes)});return reference;}});
 return{...f,descriptor,registry,receipts,waits,raw,original,facts:h.facts,calls:()=>calls};
}

test('actual registry waits for small future facts and preserves exact response, timestamp and clock proof',async t=>{
 const f=fixture(t,{offset:512}),value=await f.registry.continuationFacts(f.descriptor,{journal:f.journal});
 assert.equal(f.calls(),2);assert.equal(f.waits.reduce((a,b)=>a+b,0),512);
 assert.equal(value.facts.observedAtMilliseconds,f.original+512);assert.equal(value.stdoutRawBase64,Buffer.from(f.raw).toString('base64'));assert.equal(value.stdoutSha256,sha256(Buffer.from(f.raw)));
 const response=JSON.parse(readFileSync(value.responseReceipt.path)),clock=JSON.parse(readFileSync(value.clockReceipt.path));
 assert.equal(response.receivedAtMilliseconds,f.original);assert.equal(response.stdoutRawBase64,value.stdoutRawBase64);assert.equal(response.stdoutTruncated,false);
 assert.deepEqual(clock.response,value.responseReceipt);assert.equal(clock.clockObservation.admittedAtMilliseconds,f.original+512);
 assert.equal(clock.clockObservation.factsTimestampChanged,false);assert.equal(clock.clockObservation.clockAdjusted,false);assert.equal(clock.clockObservation.freshnessExtended,false);
});

test('actual registry preserves raw facts and refusal trace for stalled, excessive-future and stale observations',async t=>{
 for(const [options,reason] of [[{offset:512,stalled:true},/did-not-catch-up/],[{offset:5001},/offset-exceeded/],[{offset:-900001},/observation-expired/]])await t.test(reason.source,async t=>{
  const f=fixture(t,options);await assert.rejects(f.registry.continuationFacts(f.descriptor,{journal:f.journal}),reason);
  assert.equal(f.calls(),2);assert.equal(f.receipts.length,2);const [response,refusal]=f.receipts;
  assert.equal(response.value.stdoutRawBase64,Buffer.from(f.raw).toString('base64'));
  assert.equal(refusal.value.kind,'operator-continuation-host-clock-refused');assert.deepEqual(refusal.value.response,response.reference);
  assert.equal(refusal.value.clockObservation.observedAtMilliseconds,f.facts.observedAtMilliseconds);assert.equal(refusal.value.clockObservation.freshnessExtended,false);
 });
});

test('clock acceptance never bypasses unchanged live identity validation',async t=>{
 const f=fixture(t,{offset:50,invalidIdentity:true});await assert.rejects(f.registry.continuationFacts(f.descriptor,{journal:f.journal}),/full-host-live-identity-changed/);
 assert.equal(f.receipts.length,2);assert.equal(f.receipts[1].value.kind,'operator-continuation-host-clock-accepted');assert.equal(f.facts.observedAtMilliseconds,f.original+50);
});
