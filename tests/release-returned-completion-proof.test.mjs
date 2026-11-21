import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256} from '../scripts/release-plan.mjs';
import {buildReturnedCompletionProgram,returnedRosterSchema,verifyReturnedCompletion} from '../scripts/release-returned-completion-proof.mjs';
import {fullHostFixture} from '../support/full-host-fixture.mjs';

function roster() {
  const rows = {};
  for (const n of [1,2,3]) {
    const roles = ['capacity','started','fork-observed','process','ready','capture-before'];
    if (n < 3) roles.push('closed','capture-closed','capture-writer');
    for (const role of roles) {
      const name = `startup-${n}-${role}.json`;
      rows[name] = {bytes:role === 'capture-before' || role === 'capture-closed' ? 90000 : 512,sha256:sha256(name)};
    }
  }
  return rows;
}

test('the returned roster admits only its five larger capture metadata records',()=>{
  const rows=roster();
  assert.deepEqual(returnedRosterSchema.parse(rows),rows);
  for (const change of [
    r=>{r['startup-1-capture-before.json'].bytes=131073;}, r=>{r['startup-1-capture-writer.json'].bytes=65537;},
    r=>{r['startup-1-ready.json'].bytes=true;}, r=>{r['startup-3-closed.json']=r['startup-1-closed.json'];},
    r=>{r['../startup-3-ready.json']=r['startup-3-ready.json'];},r=>{delete r['startup-1-capture-before.json'];},
    r=>{r['startup-1-ready.json'].path='/tmp/alternate';}, r=>{r['startup-1-ready.json'].sha256='x'.repeat(64);},
    r=>{for(const row of Object.values(r)) row.bytes=65536;},
  ]) {
    const invalid=structuredClone(rows);change(invalid);
    assert.throws(()=>buildReturnedCompletionProgram({},invalid));
  }
});

test('normal completed proof requires the independently retained roster and all three accepted capacity hashes',()=>{
  const rows=roster(),{values,completed}=fullHostFixture();
  const refs=[1,2,3].map(attempt=>({attempt,receiptSha256:rows[`startup-${attempt}-capacity.json`].sha256}));
  const detail=JSON.parse(Buffer.from(completed.evidenceRawBase64,'base64'));
  detail.startupCapacityBudgets=refs;
  const evidence=Buffer.from(JSON.stringify(detail));
  completed.actualStartupCapacityReceiptRefs=refs;
  completed.relatedStartupReceiptHashes=Object.fromEntries(Object.entries(rows).map(([k,v])=>[k,v.sha256]));
  completed.evidenceRawBase64=evidence.toString('base64');
  completed.rehearsalEvidenceSha256=completed.completedProof.proof.evidenceSha256=sha256(evidence);
  const acceptance=Buffer.from(JSON.stringify(completed.completedProof.proof));
  completed.proofRawBase64=acceptance.toString('base64');
  completed.operator.proofSha256=completed.socketStatus.lease.proofSha256=completed.completedProof.proofSha256=sha256(acceptance);
  assert.deepEqual(verifyReturnedCompletion(completed,values,rows).detailRaw,evidence);
  const swapped=structuredClone(rows);
  swapped['startup-1-capture-closed.json'].sha256=rows['startup-2-capture-closed.json'].sha256;
  assert.throws(()=>verifyReturnedCompletion(completed,values,swapped),/receipt-hash-changed/);
  const otherBudget=structuredClone(completed);
  otherBudget.actualStartupCapacityReceiptRefs[1].receiptSha256=refs[0].receiptSha256;
  assert.throws(()=>verifyReturnedCompletion(otherBudget,values,rows),/capacity-commitment/);
  assert.throws(()=>verifyReturnedCompletion({...completed,socketStatus:{held:true}},values,rows),/original-return/);
});
