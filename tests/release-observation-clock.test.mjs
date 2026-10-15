import test from 'node:test';
import assert from 'node:assert/strict';
import {awaitObservationTime} from '../scripts/release-observation-clock.mjs';
function time(advance){let wall=1000000,mono=0;const waits=[];return{clock:()=>wall,monotonic:()=>mono,waits,wait:async ms=>{waits.push(ms);const next=advance?advance({wall,mono,ms}):{wall:wall+ms,mono:mono+ms};wall=next.wall;mono=next.mono;}};}
test('measured2016ms and exact5s leads wait for genuine local time without changing observation age',async()=>{
 for(const offset of [0,2016,5000]){const c=time(),observed=1000000+offset,r=await awaitObservationTime(observed,c);
  assert.equal(r.observedAtMilliseconds,observed);assert.equal(r.admittedAtMilliseconds,observed);assert.equal(r.factsAgeMilliseconds,0);
  assert.equal(r.maximumWaitMilliseconds,5000);assert.equal(r.maximumFactsAgeMilliseconds,300000);
  assert.equal(r.clockAdjusted,false);assert.equal(r.factsTimestampChanged,false);assert.equal(r.freshnessExtended,false);
  assert.equal(c.waits.reduce((a,b)=>a+b,0),offset);assert.ok(r.samples.length<=128);
 }
});
test('future beyond5s, expired, invalid and broadened policies refuse without waiting',async()=>{
 for(const [observed,options,reason]of [[1005001,{},/offset-exceeded/],[699999,{},/expired/],[NaN,{},/timestamp-invalid/],[1000000,{maximumWaitMilliseconds:5001},/policy-invalid/],[1000000,{maximumAgeMilliseconds:900001},/policy-invalid/]]){
  const c=time();await assert.rejects(awaitObservationTime(observed,{...c,...options}),reason);assert.equal(c.waits.length,0);
 }
 assert.equal((await awaitObservationTime(700000,time())).factsAgeMilliseconds,300000);
 assert.equal((await awaitObservationTime(100000,{...time(),maximumAgeMilliseconds:900000})).factsAgeMilliseconds,900000);
});
test('stalled/backward/oversleep clocks and interrupted wait cannot qualify an observation',async()=>{
 const cases=[
  [({wall,mono,ms})=>({wall,mono:mono+ms}),/did-not-catch-up/],
  [({wall,mono,ms})=>({wall:wall-1,mono:mono+ms}),/moved-backward/],
  [({wall,mono})=>({wall,mono:mono-1}),/monotonic-clock-invalid/],
  [({wall,mono})=>({wall:wall+6000,mono:mono+6000}),/wait-budget-expired/],
  [({wall,mono,ms})=>({wall:wall+302017,mono:mono+ms}),/expired/],
  [({wall,mono})=>({wall,mono}),/did-not-progress/],
 ];
 for(const [advance,reason]of cases){const c=time(advance);await assert.rejects(awaitObservationTime(1002016,c),e=>{assert.match(e.message,reason);assert.equal(e.clockObservation.observedAtMilliseconds,1002016);return true;});assert.ok(c.waits.length<=128);}
 const c=time();c.wait=async()=>{throw Error('interrupted');};await assert.rejects(awaitObservationTime(1002016,c),/wait-interrupted/);
});
