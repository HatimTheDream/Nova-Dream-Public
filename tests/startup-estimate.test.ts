import assert from 'node:assert/strict';
import test from 'node:test';
import { StartupClock, startupHistory, startupRemaining, startupWaitLabel, type StartupTiming } from '../apps/client/src/startup-estimate';

const at = 1_800_000_000_000;
const previous: StartupTiming = { at, points: [{percent:0,ms:0},{percent:25,ms:2_000},{percent:80,ms:22_000},{percent:100,ms:30_000}] };

test('first startup waits for preparation evidence and never turns time into progress', () => {
  const clock = new StartupClock(100);
  clock.observe(10, 1_100);
  assert.equal(startupRemaining(clock.points, 1_000, []), undefined);
  clock.observe(25, 2_100);
  assert.equal(startupRemaining(clock.points, 2_000, []), 6_000);
  assert.equal(startupRemaining(clock.points, 4_000, []), 4_000);
  assert.equal(clock.points.at(-1)?.percent, 25);
  assert.equal(startupRemaining(clock.points, 9_000, []), undefined);
  assert.equal(clock.points.at(-1)?.percent, 25);
});

test('learned preparation timing accounts for slow later work instead of assuming a linear bar', () => {
  const current = [{percent:0,ms:0},{percent:25,ms:2_000}];
  assert.equal(startupRemaining(current, 2_000, [previous]), 28_000);
  assert.equal(startupRemaining(current, 7_000, [previous]), 23_000);
  assert.equal(startupRemaining([...current,{percent:80,ms:22_000}], 22_000, [previous]), 8_000);
  assert.equal(startupRemaining([...current,{percent:80,ms:33_000}], 33_000, [previous]), 12_000);
});

test('stalled and overdue estimates stop promising seconds while a resumed advance recalculates', () => {
  const current = [{percent:0,ms:0},{percent:25,ms:2_000}];
  assert.equal(startupRemaining(current, 18_000, [previous]), undefined);
  assert.equal(startupWaitLabel(undefined, false), '');
  assert.equal(startupRemaining([...current,{percent:80,ms:22_000}], 23_000, [previous]), 7_000);
  assert.equal(startupRemaining([...current,{percent:80,ms:22_000}], 31_000, [previous]), undefined);
});

test('only successful bounded foreground runs can become history', () => {
  const clock = new StartupClock(50);
  for(let percent=1;percent<100;percent++)clock.observe(percent, 50+percent*100);
  clock.observe(50, 9_950); // A retry/report regression must not add a backward sample.
  const run = clock.finish(10_050, at)!;
  assert.equal(run.points.length,101);assert.equal(run.points.at(-1)?.ms,10_000);
  const interrupted = new StartupClock(0);interrupted.observe(25,2_000);interrupted.interrupt();
  assert.equal(interrupted.finish(10_000,at),undefined);
  assert.equal(new StartupClock(0).finish(400,at),undefined);
  assert.equal(new StartupClock(0).finish(301_000,at),undefined);
});

test('stored history rejects malformed, future, old and non-monotonic data and keeps five runs', () => {
  for(const value of [null,{},'bad'])assert.deepEqual(startupHistory(value,at),[]);
  const bad = [null,{at,points:[]},{...previous,at:at+1},{...previous,at:at-15*24*60*60_000},{at,points:[{percent:0,ms:0},{percent:50,ms:20_000},{percent:100,ms:10_000}]},{at,points:[{percent:0,ms:0},{percent:100,ms:Infinity}]}];
  assert.deepEqual(startupHistory(bad,at),[]);
  const runs=Array.from({length:8},(_,i)=>({...previous,at:at-8+i}));
  assert.deepEqual(startupHistory(runs,at),runs.slice(-5));
});

test('wait uses only numerical durations with second precision and no false zero', () => {
  assert.equal(startupWaitLabel(undefined,false),'');
  assert.equal(startupWaitLabel(1_000,false),'1 second');
  assert.equal(startupWaitLabel(4_000,false),'4 seconds');
  assert.equal(startupWaitLabel(12_001,false),'13 seconds');
  assert.equal(startupWaitLabel(60_000,false),'1 minute');
  assert.equal(startupWaitLabel(68_000,false),'1 minute 8 seconds');
  assert.equal(startupWaitLabel(3_665_000,false),'1 hour 1 minute 5 seconds');
  assert.equal(startupWaitLabel(0,false),'');
  assert.equal(startupWaitLabel(0,true),'0 seconds');
});

test('displayed duration moves down and up as elapsed time and observed speed change', () => {
  const current = [{percent:0,ms:0},{percent:25,ms:2_000}];
  const label = (points: typeof current, elapsed: number) => startupWaitLabel(startupRemaining(points,elapsed,[previous]),false);
  assert.equal(label(current,2_000),'28 seconds');
  assert.equal(label(current,3_000),'27 seconds');
  assert.equal(label([...current,{percent:30,ms:5_000}],5_000),'35 seconds');
  assert.equal(label([...current,{percent:80,ms:10_000}],10_000),'4 seconds');
});
