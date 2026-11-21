import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fullHostFixture} from '../support/full-host-fixture.mjs';
import {sha256} from '../scripts/release-plan.mjs';
import {RETAINED_BINDINGS_STARTUP_HELPERS} from '../scripts/release-delivery-startup-retained.mjs';
import {buildReturnedCompletionPlanProgram, buildReturnedCompletionProgram,
  returnedRosterSchema, verifyReturnedCompletion} from '../scripts/release-same-schema-returned-proof.mjs';

function roster() {
  const result = {};
  for (const attempt of [1,2,3]) {
    const roles = ['capacity','fork-observed','process','ready','started'];
    if (attempt < 3) roles.push('closed');
    for (const role of roles) {
      const name = 'startup-'+attempt+'-'+role+'.json';
      result[name] = {bytes:32,sha256:sha256(name)};
    }
  }
  return result;
}

test('the 17 native receipt slots have exact names, individual limits and an aggregate limit', () => {
  const rows = roster();
  assert.deepEqual(returnedRosterSchema.parse(rows),rows);
  for (const edit of [r=>delete r['startup-2-closed.json'],r=>{r['startup-3-closed.json']=r['startup-1-closed.json'];},
    r=>{r['startup-1-capture-before.json']=r['startup-1-ready.json'];},r=>{r['startup-1-ready.json'].bytes=65537;},
    r=>{r['startup-1-process.json'].extra=true;},r=>{for (const v of Object.values(r)) v.bytes=65536;}]) {
    const bad = structuredClone(rows);
    edit(bad);
    assert.equal(returnedRosterSchema.safeParse(bad).success,false);
  }
});

test('the fixed collector embeds the bounded native implementation and the exact reviewed roster', () => {
  const values = {stageResult:{helperHashes:RETAINED_BINDINGS_STARTUP_HELPERS}};
  const rows = roster();
  for (const [expected, program] of [[null,buildReturnedCompletionPlanProgram(values)],[rows,buildReturnedCompletionProgram(values,rows)]]) {
    const transport = JSON.parse(Buffer.from(program.match(/p=json.loads\(base64.b64decode\('([A-Za-z0-9+/=]+)'/)[1],'base64'));
    const source = Buffer.from(transport.source,'base64');
    assert.equal(sha256(source),transport.sha256);
    assert.deepEqual(transport.expected,expected);
    assert.match(source.toString(),/rows=ordinary_return_roster\(output,V,detail,EXPECTED_ROSTER\)/);
    assert.doesNotMatch(source.toString(),/rows=returned_roster\(output,V,detail\)/);
  }
  assert.throws(()=>buildReturnedCompletionPlanProgram({stageResult:{helperHashes:{}}}),/helper-family/);
});

function normalized(detailChanges={}) {
  const rows = roster(), {values,completed} = fullHostFixture();
  values.stageResult={helperHashes:RETAINED_BINDINGS_STARTUP_HELPERS};
  completed.helperHashes = structuredClone(RETAINED_BINDINGS_STARTUP_HELPERS);
  completed.relatedStartupReceiptHashes=Object.fromEntries(Object.entries(rows).map(([name,row])=>[name,row.sha256]));
  const budgets=[1,2,3].map(attempt=>({attempt,receiptSha256:rows['startup-'+attempt+'-capacity.json'].sha256}));
  completed.actualStartupCapacityReceiptRefs=budgets;
  const detail={...JSON.parse(Buffer.from(completed.evidenceRawBase64,'base64')),startupCapacityBudgets:budgets,...detailChanges};
  const detailRaw=Buffer.from(JSON.stringify(detail));
  completed.evidenceRawBase64=detailRaw.toString('base64');
  completed.rehearsalEvidenceSha256=sha256(detailRaw);
  completed.completedProof.proof.evidenceSha256=sha256(detailRaw);
  const proofRaw=Buffer.from(JSON.stringify(completed.completedProof.proof));
  completed.proofRawBase64=proofRaw.toString('base64');
  completed.completedProof.proofSha256=sha256(proofRaw);
  completed.operator.proofSha256=sha256(proofRaw);
  completed.socketStatus.lease=structuredClone(completed.operator);
  return {rows,values,completed};
}

test('accepts settled native capacity and rejects mixed capture evidence, changed bindings, and extra hashes', () => {
  const {rows,values,completed}=normalized();
  assert.ok(verifyReturnedCompletion(completed,values,rows).proofRaw.length);
  for(const edit of [c=>{c.relatedStartupReceiptHashes.extra=sha256('extra');},
    c=>{c.actualStartupCapacityReceiptRefs[1].attempt=3;},c=>{c.completedProof.originalReturned=false;}]) {
    const bad=structuredClone(completed);
    edit(bad);
    assert.throws(()=>verifyReturnedCompletion(bad,values,rows));
  }
  const altered=structuredClone(rows);
  altered['startup-2-fork-observed.json'].sha256=sha256('changed');
  assert.throws(()=>verifyReturnedCompletion(completed,values,altered));
  const mixed=normalized({nativeCaptureSourceSha256:sha256('migration proof')});
  assert.throws(()=>verifyReturnedCompletion(mixed.completed,mixed.values,mixed.rows),/same-schema-returned-evidence-changed/);
});
