import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseOperatorCommand,operatorMaintenanceRequest} from '../scripts/operator-maintenance.mjs';

test('operator CLI accepts only bounded fixed-protocol commands, never endpoints or proof paths',()=>{
  const id='11111111-1111-4111-8111-111111111111',epoch='22222222-2222-4222-8222-222222222222',candidate='a'.repeat(64);
  assert.deepEqual(parseOperatorCommand(['enter',id,candidate,epoch]),{action:'enter',body:{leaseId:id,candidateId:candidate,workspaceEpoch:epoch}});
  assert.deepEqual(parseOperatorCommand(['phase',id,'checking']),{action:'phase',body:{leaseId:id,phase:'checking'}});
  assert.deepEqual(parseOperatorCommand(['status']),{action:'status',body:{}});
  for(const input of [['status','--socket=/tmp/other.sock'],['release',id,'/private/proof'],['enter',id,candidate,'invented'],['phase',id,'released'],['release','../../other'],['exec','shell'],['enter',id,'latest',epoch]])assert.throws(()=>parseOperatorCommand(input),/Usage/);
});
test('operator client rejects unprivileged and non-Linux callers before any connection',{skip:process.platform==='linux'&&process.getuid?.()===0},async()=>{
  await assert.rejects(operatorMaintenanceRequest(['status']),/provisioned Linux root/);
});
