// New lifecycle adapter boundaries only; fake host, no runtime/process/provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { runHost, observeClose, guardTransports } from '../scripts/local-native-retained-host.mjs';
const modules = ['workspace-host','http','runtime','browser-network','service-drain','store'];
function fixture(t, behavior = {}) {
  const base = mkdtempSync(join(tmpdir(), 'nova-host-boundary-')), releaseRoot = join(base, 'release'), workspaceRoot = join(base, 'work');
  mkdirSync(workspaceRoot); mkdirSync(join(releaseRoot, 'dist/service/apps/service'), {recursive:true});
  for (const name of modules) writeFileSync(join(releaseRoot, 'dist/service/apps/service', name + '.js'), '// inert fixture; never imported');
  let closed = false, starts = 0, closes = 0;
  const epoch = randomUUID(), origin = 'http://127.0.0.1:4488';
  const identity = {epoch,pid:123456,url:'ws://127.0.0.1:4489',generation:'owned-fixture',startedAt:Date.now(),version:'2026.9.8'};
  const service = {origin,store:{epoch},phoneAccess:{enabled:false},gateway:{status:()=>({state:'ready'})},
    runtime:{child:{pid:identity.pid},status:()=>({state:behavior.state ?? 'running',phase:'ready'}),updateIdentity:()=>identity,
      moduleBridge:()=>({url:origin+'/workspace',token:'a'.repeat(64)}),
      browserNetwork:{address:'http://127.0.0.1:4490',server:{listening:true,address:()=>({address:'127.0.0.1',port:4490})}}},
    drainStatus:()=>({closed,closing:closes>0})};
  const host={current:service,async close(){closes++;if(behavior.pending && closes===1)throw new Error('original drain pending');closed=true;}};
  const start=async()=>{starts++;if(behavior.delay)await new Promise(r=>setTimeout(r,behavior.delay));return host;};
  const input={format:1,kind:'local-native-retained-host',operationId:randomUUID(),workspaceRoot,releaseRoot,
    expectedVersion:'2.28.10',expectedBuildVersion:'1.0.383',expectedSchema:60,readyTimeoutMs:behavior.timeout??2000,resultPath:join(base,'private-result.json')};
  t.after(()=>{assert(closed,'Synthetic owner must be closed before fixture cleanup');rmSync(base,{recursive:true,force:true});});
  return {input,start,counts:()=>({starts,closes}),read:()=>JSON.parse(readFileSync(input.resultPath,'utf8'))};
}
test('synthetic host reaches ready once and closes original owner with private bindings',async t=>{
  const f=fixture(t), original=await runHost(f.input,f.start);
  assert.equal(original.report.passed,true);assert.deepEqual(f.counts(),{starts:1,closes:1});
  assert.equal(f.read().moduleBridge.url,f.read().origin+'/workspace');assert.equal(f.read().browserProxy.port,4490);
  assert.deepEqual(original.report.observedNativePids,[123456]);assert.equal(original.report.providerRequestSubmitted,false);
});
test('late synthetic readiness cannot pass the original deadline and still drains',async t=>{
  const f=fixture(t,{delay:1020,timeout:1000}), original=await runHost(f.input,f.start);
  assert.equal(original.report.ready,false);assert.equal(original.report.closed,true);assert.equal(original.report.passed,false);
  assert.match(original.report.primaryError.message,/original native readiness deadline/i);assert.deepEqual(f.counts(),{starts:1,closes:1});
});
test('pending synthetic close retains original owner for explicit observation without replay',async t=>{
  const f=fixture(t,{pending:true}), original=await runHost(f.input,f.start);
  assert.equal(original.report.closed,false);assert.equal(original.report.originalOwnerRetained,true);
  assert.match(original.report.cleanupError.message,/original drain pending/);
  await original.closeOriginal();assert.deepEqual(f.counts(),{starts:1,closes:2});
  assert.equal(f.read().closed,false,'Original uncertain receipt remains immutable');
});
test('synthetic startup and close failures remain separate and recoverable',async t=>{
  const f=fixture(t,{state:'error',pending:true}), original=await runHost(f.input,f.start);
  assert.match(original.report.primaryError.message,/startup reached error/);assert.match(original.report.cleanupError.message,/drain pending/);
  assert.equal(original.report.ready,false);assert.equal(original.report.passed,false);
  await original.closeOriginal();assert.deepEqual(f.counts(),{starts:1,closes:2});
});

test('receipt and transport failures cannot reject pending original-close observation',async()=>{
  const original={async closeOriginal(){throw new Error('still owns synthetic work');}};
  const input={operationId:randomUUID(),resultPath:'unused-injected-writer'};
  const result=await observeClose(original,input,1,()=>{throw new Error('disk unavailable');},()=>{throw new Error('pipe unavailable');});
  assert.equal(result.observation.closed,false);assert.equal(result.receiptWritten,false);
  assert.match(result.observation.error.message,/still owns/);
  assert.match(original.closeObservations[0].receiptWriteError.message,/disk unavailable/);
  assert.match(original.closeObservations[0].summaryError.message,/pipe unavailable/);
});

test('asynchronous pipe errors stay observed without terminating the original owner',()=>{
  const stdout=new EventEmitter(), stderr=new EventEmitter(), errors=[];
  guardTransports({stdout,stderr},errors);
  assert.doesNotThrow(()=>stdout.emit('error',Object.assign(new Error('pipe closed'),{code:'EPIPE'})));
  assert.doesNotThrow(()=>stderr.emit('error',new Error('diagnostic pipe closed')));
  assert.equal(errors.length,2);assert.deepEqual(errors.map(e=>e.transport),['stdout','stderr']);
});
