import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { coordinatorFixture, now } from '../support/full-coordinator-fixture.mjs';
import { buildFullCoordinatorDescriptor } from '../scripts/release-delivery-full-coordinator.mjs';
import { createFullInstallationAdmission } from '../scripts/release-delivery-install-admission.mjs';
import { createCoordinatorInstallationAdapter } from '../scripts/release-delivery-install.mjs';
import { describeInstallAdapter } from '../scripts/release-adapters.mjs';
import { ReleaseJournal } from '../scripts/release-coordinate.mjs';
import { planRelease, sha256 } from '../scripts/release-plan.mjs';
const schema=readFileSync(new URL('../scripts/release-coordinate.mjs',import.meta.url),'utf8').match(/this\.db\.exec\(`(PRAGMA journal_mode=WAL;[\s\S]+?PRAGMA user_version=1; COMMIT;)`\);/)[1].replace('${APPLICATION_ID}',String(0x4e56524c));
async function fixture(t,{totalMs=1200000}={}) {
  const cleanup=[],f=await coordinatorFixture({after:fn=>cleanup.push(fn)});
  const journal=Object.create(ReleaseJournal.prototype);journal.directory=f.root;journal.readOnly=false;journal.db=new DatabaseSync(join(f.root,'admission.sqlite'));journal.db.exec(schema);
  t.after(()=>{journal.close();for(const fn of cleanup)fn();});
  f.timeline.original.remainingMs=[600000,totalMs];
  const published=buildFullCoordinatorDescriptor(f.context,f.verified,f.options);
  const descriptor={format:1,...f.descriptor,target:f.put({fixtureOnly:true}),adapterIdentity:sha256('fixture-registry'),timeline:f.timeline,
    sources:Object.fromEntries(Object.entries(f.descriptor.sources).map(([side,s])=>[side,{...s,root:'/fixture/'+side,baseCommit:(side==='private'?'c':'d').repeat(40),branch:'main'}]))};
  journal.initializeDelivery(descriptor,now);
  const prior={...f.prior,publication:{coordinatorDescriptor:published,syntheticPublication:true}},row=journal.reserveDeliveryPhase(descriptor.operation.id,'publication',{syntheticOnly:true},now).intent;
  journal.recordDeliveryObservation(descriptor.operation.id,'publication',{key:row.key,state:'completed',reason:'synthetic-publication-complete',externalId:null,receipt:null,output:prior.publication},now);
  let at=now+400000,collections=0;
  const context={descriptor,prior,journal,input:{coordinatorDescriptor:published}};
  const collectCapacity=async c=>{collections++;assert.equal(c.intent.key,row.key);assert.equal(journal.deliveryPhase(descriptor.operation.id,'installation'),null);
    const observation={...JSON.parse(readFileSync(f.verified.capacityEvidence.observation.path)),observedAtMilliseconds:at};
    return {state:'completed',evidence:{observation:f.put(observation)}};};
  const admission=createFullInstallationAdmission({collectCapacity,storeReceipt:f.options.storeReceipt,clock:()=>at});
  return {...f,journal,descriptor,prior,published,row,context,admission,collectCapacity,clock:()=>at,setTime:v=>at=v,collections:()=>collections,
    reserve:input=>({...context,input,intent:journal.reserveDeliveryPhase(descriptor.operation.id,'installation',input,at).intent})};
}

test('stale publication capacity is refreshed before new installation reservation without changing publication',async t=>{
  const f=await fixture(t),prior=f.journal.deliveryPhase(f.descriptor.operation.id,'publication');
  assert.notEqual(planRelease(f.published.input,{nowMs:f.clock()}).phases.find(p=>p.id==='capacity').state,'passed');
  const input=await f.admission.prepare(f.context);
  assert.equal(f.journal.intent(f.descriptor.operation.id),null);assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id,'installation'),null);
  assert.equal(f.journal.db.prepare('SELECT count(*) n FROM operations').get().n,0);
  assert.equal(planRelease(input.coordinatorDescriptor.input,{nowMs:f.clock()}).phases.find(p=>p.id==='capacity').state,'passed');
  assert.deepEqual(f.journal.deliveryPhase(f.descriptor.operation.id,'publication'),prior);
  assert.deepEqual(input.coordinatorDescriptor.input.operation,f.published.input.operation);assert.deepEqual(input.coordinatorDescriptor.input.timeline.original,f.timeline.original);
  const context=f.reserve(input);assert.deepEqual(await f.admission.apply(context),{observeOnly:false});
  const original=f.journal.reserveInstall(f.descriptor.operation.id,f.clock()).intent,checkpoint=f.journal.load(f.descriptor.operation.id).checkpoint;
  f.setTime(f.clock()+700000);assert.deepEqual(await f.admission.apply(context),{observeOnly:true});
  assert.equal(f.collections(),1);assert.equal(f.journal.intent(f.descriptor.operation.id).idempotencyKey,original.idempotencyKey);
  assert.equal(f.journal.load(f.descriptor.operation.id).checkpoint.id,checkpoint.id);
});

test('lost read-only preparation can be repeated while original unknown install is never renewed',async t=>{
  const f=await fixture(t),input=await f.admission.prepare(f.context);await f.admission.prepare(f.context);
  assert.equal(f.collections(),2);assert.equal(f.journal.intent(f.descriptor.operation.id),null);
  const ctx=f.reserve(input),bridge=createCoordinatorInstallationAdapter({admission:f.admission,clock:f.clock,resume:async()=>{
    const r=f.journal.reserveInstall(f.descriptor.operation.id,f.clock());return {operationId:f.descriptor.operation.id,intent:r.intent};}});
  const first=await bridge.execute(ctx),original=f.journal.intent(f.descriptor.operation.id);
  assert.equal(first.state,'uncertain');f.setTime(f.clock()+400000);
  const second=await bridge.observe(ctx);assert.equal(second.state,'uncertain');assert.equal(f.collections(),2);
  assert.equal(f.journal.intent(f.descriptor.operation.id).idempotencyKey,original.idempotencyKey);
  assert.equal(f.journal.db.prepare('SELECT count(*) n FROM intents').get().n,1);
});

test('pre-existing original coordinator intent observes its captured checkpoint without capacity collection',async t=>{
  const f=await fixture(t);f.setTime(now);
  const described=describeInstallAdapter({...f.published.adapter,operation:f.published.input.operation,input:f.published.input});
  f.journal.attachDeliveryCoordinator(f.descriptor.operation.id,f.published,described,now);
  const original=f.journal.reserveInstall(f.descriptor.operation.id,now).intent;f.setTime(now+400000);
  const input=await f.admission.prepare(f.context),record=JSON.parse(readFileSync(input.admission.path));
  assert.equal(record.mode,'original-request-observation');assert.equal(f.collections(),0);assert.equal(record.originalRequest.key,original.idempotencyKey);
  const ctx=f.reserve(input);assert.deepEqual(await f.admission.apply(ctx),{observeOnly:true});
  assert.equal(f.journal.intent(f.descriptor.operation.id).checkpointId,original.checkpointId);
});

test('expired admission, corrupted evidence and changed target cannot start an original install',async t=>{
  for(const scenario of ['expired','corrupt','changed-target','failed-capacity'])await t.test(scenario,async t=>{
    const f=await fixture(t);
    if(scenario==='failed-capacity'){
      const admission=createFullInstallationAdmission({collectCapacity:async()=>({state:'uncertain'}),storeReceipt:f.options.storeReceipt,clock:f.clock});
      await assert.rejects(admission.prepare(f.context),/fresh-capacity-unavailable/);
      assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id,'installation'),null);return;
    }
    const input=await f.admission.prepare(f.context),ctx=f.reserve(input);
    if(scenario==='expired')f.setTime(f.clock()+300001);
    if(scenario==='corrupt')writeFileSync(input.admission.path,'{}');
    if(scenario==='changed-target')ctx.descriptor={...ctx.descriptor,targetIdentity:sha256('other')};
    await assert.rejects(f.admission.apply(ctx));assert.equal(f.journal.intent(f.descriptor.operation.id),null);
  });
});

test('previously initialized coordinator gets a fresh checkpoint without changing original operation',async t=>{
  const f=await fixture(t);f.setTime(now);
  const described=describeInstallAdapter({...f.published.adapter,operation:f.published.input.operation,input:f.published.input});
  f.journal.attachDeliveryCoordinator(f.descriptor.operation.id,f.published,described,now);const old=f.journal.load(f.descriptor.operation.id);
  f.setTime(now+400000);const input=await f.admission.prepare(f.context),ctx=f.reserve(input);await f.admission.apply(ctx);
  const current=f.journal.load(f.descriptor.operation.id);assert.equal(current.operation.descriptor_hash,old.operation.descriptor_hash);
  assert.ok(current.checkpoint.id>old.checkpoint.id);assert.deepEqual(current.input.timeline.original,old.input.timeline.original);
  assert.equal(f.journal.intent(f.descriptor.operation.id),null);
});

test('fresh recovery observation reuses the exact completed proof after a long interruption',async t=>{
  const f=await fixture(t,{totalMs:7200000});f.setTime(now+4000000);
  const original=f.published.input.evidence.recovery;
  await assert.rejects(f.admission.prepare(f.context),/fresh-prerequisites-unverified/);
  const freshRecovery={...original,observation:f.put({...JSON.parse(readFileSync(original.observation.path)),observedAtMilliseconds:f.clock()})};
  const admission=createFullInstallationAdmission({collectCapacity:async c=>({...await f.collectCapacity(c),recoveryEvidence:freshRecovery}),storeReceipt:f.options.storeReceipt,clock:f.clock});
  const input=await admission.prepare(f.context);
  assert.deepEqual(input.coordinatorDescriptor.input.evidence.recovery.proof,original.proof);
  assert.deepEqual(input.coordinatorDescriptor.input.evidence.recovery.review,original.review);
  assert.deepEqual(input.coordinatorDescriptor.input.evidence.recovery.observation,freshRecovery.observation);
  assert.deepEqual(f.published.input.evidence.recovery,original);assert.equal(f.journal.intent(f.descriptor.operation.id),null);
  const wrong=createFullInstallationAdmission({collectCapacity:async c=>({...await f.collectCapacity(c),recoveryEvidence:{...freshRecovery,proof:f.put({differentProof:true})}}),storeReceipt:f.options.storeReceipt,clock:f.clock});
  await assert.rejects(wrong.prepare(f.context),/original-rehearsal-proof-changed/);
});
