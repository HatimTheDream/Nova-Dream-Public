import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {sha256} from '../scripts/release-plan.mjs';
import {awaitFullPrestageFactsTime,advanceFullPrestage} from '../scripts/release-delivery-full-prestage.mjs';

function time({wall=1000,mono=0,advance}={}){
 const waits=[],clock=()=>wall,monotonic=()=>mono;
 const wait=async ms=>{waits.push(ms);if(advance){const next=advance({wall,mono,ms});wall=next.wall;mono=next.mono;}else{wall+=ms;mono+=ms;}};
 return{clock,monotonic,wait,waits};
}
test('genuine2016/2254ms and exact5s future facts wait without changing facts or extending freshness',async()=>{
 for(const offset of [0,456,2016,2254,5000]){
  const c=time(),result=await awaitFullPrestageFactsTime(1000+offset,c);
  assert.equal(result.observedAtMilliseconds,1000+offset);assert.equal(result.admittedAtMilliseconds,1000+offset);
  assert.equal(result.factsAgeMilliseconds,0);assert.equal(result.maximumFactsAgeMilliseconds,300000);assert.equal(result.maximumWaitMilliseconds,5000);assert.ok(result.samples.length<=128);
  assert.equal(result.clockAdjusted,false);assert.equal(result.factsTimestampChanged,false);assert.equal(result.freshnessExtended,false);
  assert.equal(c.waits.reduce((a,b)=>a+b,0),offset);assert.ok(result.samples.at(-1).elapsedMilliseconds<=5000);
 }
});
test('excessive skew and expired or invalid facts fail immediately;300s boundary stays unchanged',async()=>{
 for(const [timestamp,reason]of [[6001,/offset-exceeds-5s/],[-299001,/expired/],[NaN,/timestamp-invalid/]]){
  const c=time();await assert.rejects(awaitFullPrestageFactsTime(timestamp,c),reason);assert.equal(c.waits.length,0);
 }
 assert.equal((await awaitFullPrestageFactsTime(-299000,time())).factsAgeMilliseconds,300000);
});
test('stalled, backward, non-monotonic and oversleep clocks cannot admit a plan',async()=>{
 const cases=[
  [{advance:({wall,mono,ms})=>({wall,mono:mono+ms})},/did-not-catch-up/],
  [{advance:({wall,mono,ms})=>({wall:wall-1,mono:mono+ms})},/moved-backward/],
  [{advance:({wall,mono})=>({wall,mono:mono-1})},/monotonic-clock-invalid/],
  [{advance:({wall,mono})=>({wall:wall+6000,mono:mono+6000})},/wait-budget-expired/],
  [{advance:({wall,mono,ms})=>({wall:wall+300457,mono:mono+ms})},/facts-expired/],
  [{advance:({wall,mono})=>({wall,mono})},/did-not-progress/],
 ];
 for(const [options,reason]of cases){const c=time(options);await assert.rejects(awaitFullPrestageFactsTime(1456,c),reason);assert.ok(c.waits.length<=128);}
 const c=time();c.wait=async()=>{throw Error('interrupted');};await assert.rejects(awaitFullPrestageFactsTime(1456,c),/wait-interrupted/);
});
test('actual prestage preserves exact original facts and clock diagnosis before any plan or mutation',async t=>{
 const root=mkdtempSync(join(tmpdir(),'nova-prestage-clock-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(name,value)=>{const path=join(root,name),raw=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)+'\n');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,raw);return{path,sha256:sha256(raw)};};
 const transport=put('transport.json',{sshConfig:put('ssh.config',Buffer.from('synthetic'))}),tools={python:put('python',Buffer.from('synthetic'))};
 const facts={observedAtMilliseconds:6001},raw=Buffer.from(JSON.stringify(facts)+'\n'),wrapped={remoteResult:facts,stdoutRawBase64:raw.toString('base64'),stdoutSha256:sha256(raw)};
 const calls=[],c={descriptor:{operation:{id:'original-op'}},intent:{key:'original-key',inputSha256:'a'.repeat(64)},journal:{directory:root},beforeNewEffect:async()=>{throw Error('Must not start an effect');}};
 const result=await advanceFullPrestage(c,{assets:[],transport,options:{},tools,clock:()=>1000,command:async(_binary,args)=>{calls.push(args[2]);return JSON.stringify({state:'completed',externalId:'original-op',output:wrapped});},storeReceipt:(_j,key,name,bytes)=>put('delivery-evidence/'+key+'-'+name,bytes)});
 assert.equal(result.state,'failed');assert.equal(result.reason,'full-prestage-facts-clock-offset-exceeds-5s');assert.deepEqual(calls,['facts']);
 const diagnostic=JSON.parse(readFileSync(result.output.diagnostic.path));assert.equal(diagnostic.operationId,'original-op');assert.equal(diagnostic.key,'original-key');
 assert.equal(diagnostic.planStarted,false);assert.equal(diagnostic.hostEffectStarted,false);assert.equal(diagnostic.automaticReplayPermitted,false);
 assert.deepEqual(JSON.parse(readFileSync(diagnostic.actualFacts.path)),wrapped);assert.equal(diagnostic.clockObservation.observedAtMilliseconds,6001);
});
