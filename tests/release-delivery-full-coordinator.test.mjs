import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFullCoordinatorDescriptor } from '../scripts/release-delivery-full-coordinator.mjs';
import { planRelease, sha256 } from '../scripts/release-plan.mjs';
import { coordinatorFixture as fixture, now } from '../support/full-coordinator-fixture.mjs';

test('full coordinator is derived from exact qualified outputs and original timeline',async t=>{
  const f=await fixture(t),result=buildFullCoordinatorDescriptor(f.context,f.verified,f.options);
  assert.equal(result.input.operation.stage,'frozen');assert.equal(result.input.operation.id,f.descriptor.operation.id);
  assert.equal(result.input.operation.candidateId,f.prior.package.candidateId);assert.equal(result.input.operation.bundleSha256,f.prior.package.bundle.sha256);
  assert.deepEqual(result.input.timeline,f.timeline);assert.deepEqual(result.input.evidence.capacity,f.verified.capacityEvidence);
  assert.equal(planRelease(result.input,{nowMs:now}).phases.filter(p=>p.state==='passed').length,6);
  const spec=JSON.parse(readFileSync(result.adapter.installSpec.path));assert.equal(spec.priorVersion,'2.3.0');assert.equal(spec.version,'2.4.0');
  assert.equal(spec.rehearsalProofSha256,f.prior.recovery.evidence.proof.sha256);assert.equal(spec.idempotencyKey,undefined);
});

test('failed publication readback and changed authenticated helper stop coordinator preparation',async t=>{
  const f=await fixture(t),bad=structuredClone(f.verified);
  bad.evidence.receipt=f.put({...JSON.parse(readFileSync(bad.evidence.receipt.path)),publicFeedReadVerified:false});
  assert.throws(()=>buildFullCoordinatorDescriptor(f.context,bad,f.options),/preparation-not-qualified/);
  f.artifacts.public.sourceHashes['deploy/update-runner/operator_rehearsal.py'].sha256=sha256('changed');
  assert.throws(()=>buildFullCoordinatorDescriptor(f.context,f.verified,f.options),/authenticated-helper-changed/);
});

test('an expired original estimate cannot be replaced by coordinator preparation',async t=>{
  const f=await fixture(t);
  assert.throws(()=>buildFullCoordinatorDescriptor(f.context,f.verified,{...f.options,clock:()=>now+2001}),/overrun-review-required/);
  assert.equal(f.timeline.original.issuedAtMs,now);assert.deepEqual(f.timeline.original.remainingMs,[1000,2000]);
});
