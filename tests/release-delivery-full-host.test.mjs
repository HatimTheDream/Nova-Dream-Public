import test from 'node:test';
import assert from 'node:assert/strict';
import {fullHostIdentity,fullHostOptionsSchema,fullFactsSpec,verifyFullFacts,verifyFullCompletion,verifyFullPremaintenance,collectFullOnlineCapacity,createFullCapacityAdapter,buildFullHostProgram,FULL_HELPERS} from '../scripts/release-delivery-full-host.mjs';
import {fullHostFixture} from '../support/full-host-fixture.mjs';
const copy=v=>structuredClone(v);
const {facts,values,completed,key,options,descriptor}=fullHostFixture();
test('original phase gives stable distinct lease and worker identities',()=>{
  assert.equal(fullHostIdentity(key,'lease'),fullHostIdentity(key,'lease'));assert.notEqual(fullHostIdentity(key,'lease'),fullHostIdentity(key,'plan'));
  assert.notEqual(fullHostIdentity(key,'execute'),fullHostIdentity('1a4ddd43-464a-4285-90d4-f2b626fc3046','execute'));
  assert.throws(()=>fullHostIdentity(key,'new-attempt'));assert.throws(()=>fullHostIdentity('arbitrary','lease'));
});
test('host authority is strict and new runtime or helper qualification cannot be asserted',()=>{
  assert.deepEqual(fullHostOptionsSchema.parse(options),options);
  assert.throws(()=>fullHostOptionsSchema.parse({...options,stageParent:'/tmp'}));
  assert.throws(()=>fullHostOptionsSchema.parse({...options,hostConfiguration:{...options.hostConfiguration,path:'/etc/nova-update/../other'}}));
  assert.throws(()=>fullHostOptionsSchema.parse({...options,rehearsalPassed:true}));
  assert.throws(()=>fullFactsSpec({...descriptor,operation:{...descriptor.operation,agentVersion:'2026.10.1'}},options,key),/unsupported-runtime-transition/);
  assert.throws(()=>fullFactsSpec({...descriptor,operation:{...descriptor.operation,changeClass:'updater'}},options,key),/recovery-qualification/);
});
test('runtime sources or prior-runtime rehearsal cannot admit target startup or dispatch host work',async()=>{
  const changed={...descriptor,operation:{...descriptor.operation,priorAgentVersion:'2026.9.6'}};
  const runtime={qualification:{passed:true,actualSettledQualification:true},syntheticNative:{passed:true}};
  const gap=/actual-settled-runtime-qualification-producer-required/;
  assert.throws(()=>fullFactsSpec(changed,options,key),gap);
  const signed={route:'full',priorCandidateId:changed.operation.priorCandidateId,candidateId:'b'.repeat(64),runtime};
  changed.operation.candidateId=signed.candidateId;
  assert.throws(()=>verifyFullPremaintenance({signed,capacity:{targetCandidateId:signed.candidateId}},changed),gap);
  let effects=0;const run=async()=>{effects++;throw Error('No host calls permitted');};
  const context={descriptor:changed,prior:{sign:signed,route:{route:'full'},recovery:{kind:'nova-delivery-full-rehearsal',completion:completed,values}}};
  await assert.rejects(collectFullOnlineCapacity(context,{options,run}),gap);
  await assert.rejects(createFullCapacityAdapter({options,run}).input(context),gap);
  assert.equal(effects,0);
});
test('historical closed lease remains distinct from actual accepted running base',()=>{
  const spec=fullFactsSpec(descriptor,options,key),v=copy(facts);v.base=spec.base;v.review.leaseId=spec.leaseId;
  v.health={status:'ready',candidateId:spec.base.candidateId,version:spec.base.priorVersion};v.accessContext={workspaceEpoch:spec.workspaceEpoch};
  assert.equal(verifyFullFacts(v,spec,v.observedAtMilliseconds).candidateId,spec.base.candidateId);
  assert.throws(()=>verifyFullFacts(v,spec,v.observedAtMilliseconds+900001),/expired/);
  const bad=copy(v);bad.protectedHashes[options.acceptedInstallation.path]='0'.repeat(64);assert.throws(()=>verifyFullFacts(bad,spec,v.observedAtMilliseconds),/binding/);
  const held=copy(v);held.operatorStatus.held=true;assert.throws(()=>verifyFullFacts(held,spec,v.observedAtMilliseconds),/idle/);
});
test('synthetic completed rehearsal validates only with its exact original bindings',()=>{
  const verified=verifyFullCompletion(completed,values);assert.ok(verified.proofRaw.length>0);assert.deepEqual(JSON.parse(verified.proofRaw),completed.completedProof.proof);
});
test('completed receipt cannot change lease, helper, native return, or finite worker profile',()=>{
  for(const change of [v=>v.unit.TimeoutStartUSec='infinity',v=>v.unit.Restart='on-failure',v=>v.operator.id=key,
    v=>v.completedProof.originalReturned=false,v=>v.helperHashes['install.py']='0'.repeat(64),v=>v.socketStatus.held=true]){
    const bad=copy(completed);change(bad);assert.throws(()=>verifyFullCompletion(bad,values));
  }
  assert.throws(()=>verifyFullCompletion(completed,{...values,executionUnit:'different.service'}));
});
test('changed raw saved-work proof and unsupported programs fail closed',()=>{
  const bad=copy(completed);bad.proofRawBase64=Buffer.from('{}').toString('base64');assert.throws(()=>verifyFullCompletion(bad,values),/raw-proof/);
  assert.throws(()=>buildFullHostProgram('arbitrary.py',{}),/fixed-program/);
  const program=buildFullHostProgram('collect-facts.py',fullFactsSpec(descriptor,options,key));
  assert.ok(program.includes('hashlib.sha256(s).hexdigest()'));assert.ok(program.includes('signal.alarm(110)'));
  assert.ok(program.indexOf('hashlib.sha256(s).hexdigest()')<program.indexOf('exec(compile'));
  assert.equal(Object.keys(FULL_HELPERS).length,7);
});
