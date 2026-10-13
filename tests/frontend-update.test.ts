import test from 'node:test';
import assert from 'node:assert/strict';
import { availableFrontend, refreshFrontend, startFrontendUpdatePolling } from '../apps/client/src/frontend-update';
import { registerAssistantDraftNavigation } from '../apps/client/src/assistant-draft-navigation';

const candidateId = 'a'.repeat(64), originalId = 'b'.repeat(64), updateId = 'c'.repeat(64);
const loaded = { candidateId, frontendId: originalId };
const health = (id = updateId) => ({ application: 'nova-dream-edition-3', status: 'ready', candidateId,
  frontend: { id, version: '2.3.1', buildVersion: '1.0.288', source: 'frontend' } });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function clock() {
  let now = 0, next = 0, visible = true;
  const timers = new Map<number, { at: number; run: () => void }>(), listeners = new Set<() => void>();
  return {
    timers, listeners,
    environment: {
      visible: () => visible,
      schedule: (run: () => void, delay: number) => { const id = next++; timers.set(id, { at: now + delay, run }); return () => { timers.delete(id); }; },
      subscribe: (changed: () => void) => { listeners.add(changed); return () => { listeners.delete(changed); }; },
    },
    focus: (isVisible = true) => { visible = isVisible; for (const listener of listeners) listener(); },
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

test('only a healthy compatible selected frontend offers refresh, including a bundled rollback', () => {
  assert.equal(availableFrontend(loaded, health()), updateId);
  assert.equal(availableFrontend(loaded, health(originalId)), null);
  assert.equal(availableFrontend(loaded, { ...health(candidateId), frontend: { ...health(candidateId).frontend, source: 'bundled' } }), candidateId);
  assert.equal(availableFrontend(loaded, { ...health(), candidateId: 'd'.repeat(64) }), null);
  assert.equal(availableFrontend(loaded, { ...health(), frontend: { ...health().frontend, blocked: true } }), null);
  for (const value of [null, {}, { ...health(), application: 'other' }, { ...health(), status: 'starting' },
    { ...health(), frontend: { ...health().frontend, id: 'invalid' } },
    { ...health(), frontend: { ...health().frontend, source: 'bundled' } },
    { ...health(), frontend: { ...health().frontend, blocked: 'false' } }]) {
    assert.equal(availableFrontend(loaded, value), undefined);
  }
  assert.equal(availableFrontend({ candidateId }, health()), undefined);
});

test('polling keeps captured identity and ignores transient failures without repeating or adopting selections', async () => {
  const c = clock(), changes: (string | null)[] = [], identity = { ...loaded };
  let result: unknown = health(), failure = false, reads = 0;
  const stop = startFrontendUpdatePolling({ identity, read: async () => { reads++; if (failure) throw Error('offline'); return result; }, changed: id => changes.push(id) }, c.environment);
  identity.frontendId = updateId;
  await c.advance(10000); assert.deepEqual(changes, [updateId]);
  await c.advance(10000); assert.deepEqual(changes, [updateId]);
  failure = true; await c.advance(10000); await c.advance(10000); await c.advance(10000);
  const beforeBackoff = reads; await c.advance(10000); assert.equal(reads, beforeBackoff);
  failure = false; result = {}; await c.advance(10000); assert.deepEqual(changes, [updateId]);
  result = health(originalId); c.focus(); await flush(); assert.deepEqual(changes, [updateId, null]);
  result = health(); c.focus(false); const beforeHidden = reads;
  await c.advance(29999); assert.equal(reads, beforeHidden);
  await c.advance(1); assert.deepEqual(changes, [updateId, null, updateId]);
  stop(); assert.equal(c.timers.size, 0); assert.equal(c.listeners.size, 0);
});

test('closed or unpaired windows cannot receive a late update observation', async () => {
  const c = clock(), changes: (string | null)[] = [];
  let finish!: (value: unknown) => void, enabled = true, reads = 0;
  const stop = startFrontendUpdatePolling({ identity: loaded, read: () => { reads++; return new Promise(resolve => { finish = resolve; }); }, changed: id => changes.push(id), enabled: () => enabled }, c.environment);
  c.focus(); c.focus(); assert.equal(reads, 1);
  enabled = false; finish(health()); await flush(); assert.deepEqual(changes, []);
  enabled = true; c.focus(); assert.equal(reads, 2);
  stop(); finish(health()); await flush(); assert.deepEqual(changes, []);
  assert.equal(c.timers.size, 0); assert.equal(c.listeners.size, 0);
  startFrontendUpdatePolling({ identity: {}, read: async () => { throw Error('Development clients must not poll'); }, changed: () => assert.fail() }, c.environment)();
  assert.equal(c.timers.size, 0);
});

test('refresh remains explicit and refuses to replace a composer whose latest writing cannot be retained', () => {
  let stored = '', writing = 'latest unsent writing', canRetain = false, warnings = 0, reloads = 0;
  const release = registerAssistantDraftNavigation(() => {
    if (!canRetain) { warnings++; return false; }
    stored = writing; return true;
  });
  try {
    assert.equal(availableFrontend(loaded, health()), updateId);
    assert.equal(reloads, 0);
    assert.equal(refreshFrontend(() => reloads++), false);
    assert.equal(reloads, 0); assert.equal(warnings, 1); assert.equal(writing, 'latest unsent writing');
    canRetain = true;
    assert.equal(refreshFrontend(() => { assert.equal(stored, writing); reloads++; }), true);
    assert.equal(reloads, 1);
  } finally { release(); }
});
