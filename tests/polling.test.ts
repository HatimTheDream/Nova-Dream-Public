import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPolling } from '../apps/client/src/polling.js';
import { RefreshReader } from '../apps/client/src/refresh-reader.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function clock(visible = true) {
  let now = 0, next = 0;
  const timers = new Map<number, { at: number; run: () => void }>(), listeners = new Set<() => void>();
  const environment = {
    visible: () => visible,
    schedule: (run: () => void, delay: number) => { const id = next++; timers.set(id, { at: now + delay, run }); return () => { timers.delete(id); }; },
    subscribe: (change: () => void) => { listeners.add(change); return () => { listeners.delete(change); }; },
  };
  return {
    environment, timers, listeners, now: () => now,
    change: (value: boolean) => { visible = value; for (const listener of listeners) listener(); },
    advance: async (duration: number) => {
      const until = now + duration;
      while (true) {
        const due = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!due || due[1].at > until) break;
        now = due[1].at; timers.delete(due[0]); due[1].run(); await flush();
      }
      now = until; await flush();
    },
  };
}

test('hidden secondary surfaces have no polling; visible and focus refresh without overlapping slow reads', async () => {
  const c = clock(false), reads: (() => void)[] = [];
  const stop = startPolling({ read: () => new Promise<void>(resolve => reads.push(resolve)), interval: () => 1500 }, c.environment);
  await c.advance(600000); assert.equal(reads.length, 0); assert.equal(c.timers.size, 0);
  c.change(true); c.change(true); await c.advance(20000);
  assert.equal(reads.length, 1); assert.equal(c.timers.size, 0);
  reads[0](); await flush(); await c.advance(1500); assert.equal(reads.length, 2);
  c.change(false); reads[1](); await flush(); await c.advance(600000); assert.equal(reads.length, 2);
  stop(); assert.equal(c.listeners.size, 0); assert.equal(c.timers.size, 0);
});

test('workspace heartbeat uses ten seconds visible, thirty hidden, and refreshes immediately on return', async () => {
  const c = clock(), reads: number[] = [];
  const stop = startPolling({ read: async () => { reads.push(c.now()); }, interval: () => 10000, hiddenInterval: 30000, immediate: false }, c.environment);
  await c.advance(10000); c.change(false); await c.advance(29999);
  assert.deepEqual(reads, [10000]); await c.advance(1); assert.deepEqual(reads, [10000, 40000]);
  c.change(true); await flush(); assert.deepEqual(reads, [10000, 40000, 40000]);
  await c.advance(10000); assert.equal(reads.at(-1), 50000); stop();
});

test('completed surfaces can refresh once without leaving a timer, then resume an active cadence', async () => {
  const c = clock(); let interval: number | null = null, reads = 0;
  const stop = startPolling({ read: async () => { reads++; }, interval: () => interval }, c.environment);
  await flush(); await c.advance(600000); assert.equal(reads, 1); assert.equal(c.timers.size, 0);
  interval = 1500; c.change(true); await flush(); await c.advance(1500); assert.equal(reads, 3);
  interval = null; await c.advance(1500); assert.equal(reads, 4); assert.equal(c.timers.size, 0); stop();
});

test('fast errors back off to two minutes and success restores active updates', async () => {
  const c = clock(), reads: number[] = []; let fail = true;
  const stop = startPolling({ read: async () => { reads.push(c.now()); if (fail) throw Error('offline'); }, interval: () => 1500 }, c.environment);
  await flush(); await c.advance(395000);
  assert.deepEqual(reads, [0, 5000, 15000, 35000, 75000, 155000, 275000, 395000]);
  fail = false; await c.advance(120000); await c.advance(1500);
  assert.deepEqual(reads.slice(-2), [515000, 516500]); stop();
});

test('failed hidden heartbeats never retry faster than their background interval', async () => {
  const c = clock(false), reads: number[] = [];
  const stop = startPolling({ read: async () => { reads.push(c.now()); return false; }, interval: () => 1500, hiddenInterval: 60000 }, c.environment);
  await c.advance(440000);
  assert.deepEqual(reads, [60000, 120000, 180000, 240000, 300000, 380000]);
  stop(); await c.advance(300000); assert.equal(reads.length, 6);
});

test('cleanup cannot rearm after an unfinished request resolves', async () => {
  const c = clock(); let resolve!: () => void;
  const stop = startPolling({ read: () => new Promise<void>(done => { resolve = done; }), interval: () => 1500 }, c.environment);
  stop(); resolve(); await flush(); c.change(true); await c.advance(600000);
  assert.equal(c.timers.size, 0); assert.equal(c.listeners.size, 0);
});

test('reader failures feed backoff while explicit receipt refresh bypasses its timer', async () => {
  const c = clock(), reads: number[] = [], accepted: string[] = []; let fail = true;
  const reader = new RefreshReader({ identity: () => 'workspace', read: async () => { reads.push(c.now()); if (fail) throw Error('offline'); return 'acknowledged'; }, accept: value => { accepted.push(value); } });
  const stop = startPolling({ read: async () => { await reader.poll(); return !reader.failed; }, interval: () => 1500 }, c.environment);
  await flush(); await c.advance(15000); assert.deepEqual(reads, [0, 5000, 15000]);
  fail = false; await reader.refresh(); assert.deepEqual(accepted, ['acknowledged']); assert.equal(reader.failed, false);
  assert.equal(reads.at(-1), 15000); stop(); reader.cancel();
});

test('model initialization after cancellation reads immediately even when an earlier read was healthy', async () => {
  const c = clock(); let identity = 'old', models: string[] = [];
  const reads: { signal: AbortSignal; resolve: (value: string[]) => void }[] = [];
  const reader = new RefreshReader({ identity: () => identity, read: signal => new Promise<string[]>(resolve => reads.push({ signal, resolve })), accept: value => { models = value; } });
  const start = () => startPolling({ read: async () => { await reader.poll(); return !reader.failed; }, interval: () => reader.failed ? 5000 : 60000, hiddenInterval: 120000 }, c.environment);
  const old = start(); await flush(); reads[0].resolve(['old model']); await flush();
  await c.advance(60000); assert.equal(reads.length, 2);
  old(); reader.cancel(); identity = 'new'; models = [];
  assert.equal(reader.failed, false);
  const current = start(); await flush(); assert.equal(reads.length, 3, 'Initialization does not wait for the healthy interval');
  reads[1].resolve(['obsolete model']); await flush(); assert.deepEqual(models, []);
  reads[2].resolve(['new model']); await flush(); assert.deepEqual(models, ['new model']);
  await c.advance(59999); assert.equal(reads.length, 3);
  current(); reader.cancel();
});
