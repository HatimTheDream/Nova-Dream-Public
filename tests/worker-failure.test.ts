import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readNativeWorkerObservation } from '../packages/domain/worker.js';

const base={runId:'fixture-run',status:'error',endedAt:123};
test('native failures retain only a finite category, with quota taking precedence over transport rate limiting',()=>{
  for(const [error,reason] of [
    ["429 rate limit exceeded: You've reached your Codex subscription usage limit. Secret=private-sentinel",'usage_limit'],
    ['insufficient_quota: private-sentinel','usage_limit'],
    ['429 Too many requests: private-sentinel','rate_limit'],
    ['authentication_error: invalid_api_key private-sentinel','authentication'],
    ['refresh token expired: private-sentinel','authentication'],
  ]) {
    const value=readNativeWorkerObservation({...base,error});
    assert.equal(value.failureReason,reason); assert.equal('error' in value,false);
    assert.equal(JSON.stringify(value).includes('private-sentinel'),false);
  }
  for(const error of ['Unknown runtime failure',{message:'insufficient_quota'},'x'.repeat(100001)])assert.equal(readNativeWorkerObservation({...base,error}).failureReason,undefined);
});
test('successful replies and unsettled errors cannot claim a provider failure or carry an injected category',()=>{
  for(const patch of [{status:'ok',terminalReply:{disposition:'visible',text:'insufficient_quota'}},{status:'pending'},{status:'timeout'},{pendingError:true},{yielded:true},{endedAt:undefined}]) {
    const value=readNativeWorkerObservation({...base,...patch,error:'insufficient_quota',failureReason:'authentication'});
    assert.equal('failureReason' in value,false); assert.equal('error' in value,false);
  }
  assert.equal(readNativeWorkerObservation({...base,failureReason:'usage_limit',terminalReply:{disposition:'visible',text:'subscription usage limit'}}).failureReason,undefined);
});
