import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatGptAccount } from '../apps/service/chatgpt-account.js';
import { Store } from '../apps/service/store.js';
import type { AssistantTransport } from '../apps/service/gateway.js';

test('Feed account policy is stable, fences account reorder drift and excludes dialogue busy state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-feed-account-policy-')), store = new Store(directory);
  const command = { file: process.execPath, args: ['fixture-secret'], cwd: directory, env: {} };
  let generation = randomUUID(), globalBusy = true, reads = 0, allowRuntimePreparation = false;
  let release!: (value: string) => void;
  const pendingMetadata = new Promise<string>(resolve => { release = resolve; });
  const metadata = JSON.stringify({ agentId: 'main', provider: 'openai', profiles: [
    { id: 'openai:fixture', provider: 'openai', type: 'oauth', email: 'fixture@example.com' },
  ] });
  const gateway: AssistantTransport = {
    status: () => ({ state: 'ready', generation, url: 'ws://127.0.0.1:49998', message: 'Synthetic policy fixture',
      methods: ['models.authOrderSet'], grantedScopes: ['operator.read', 'operator.write'], modelAuthReady: true }),
    async request<T>(): Promise<T> { throw Error('No gateway request expected'); },
    subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}),
  };
  const service = new ChatGptAccount({ accountCommand: () => {
    assert(allowRuntimePreparation, 'routing policy must not prepare runtime paths'); return command;
  } }, async () => ++reads === 1 ? pendingMetadata : metadata,
    () => 1000, { store, gateway, busy: () => globalBusy, control: {
      async request<T>(_method: 'models.authOrderSet', _params: unknown, beforeSend?: () => void): Promise<T> {
        beforeSend?.(); return { provider: 'openai', profileIds: ['openai:fixture'] } as T;
      },
    } });
  try {
    assert.throws(() => service.internalRoutingPolicy(), /unavailable/, 'missing configuration refuses routing');
    store.internalWrite('gateway:configuration', { url: 'ws://127.0.0.1:49998', token: 'synthetic-fixture' });
    const initial = service.internalRoutingPolicy();
    assert.equal(initial.busy, false, 'dialogue activity must not self-block the Feed route');
    assert.deepEqual(service.internalRoutingPolicy(), initial); assert.equal(reads, 0);
    assert.match(initial.revision, /^[a-f0-9]{64}$/);
    assert(!JSON.stringify(initial).includes('fixture-secret')); assert(!JSON.stringify(initial).includes(directory));
    globalBusy = false; allowRuntimePreparation = true;
    const changing = service.configureOrder(store.session().deviceId, { requestId: randomUUID(), epoch: store.epoch, profileIds: ['openai:fixture'] });
    allowRuntimePreparation = false;
    assert.equal(service.internalRoutingPolicy().busy, true, 'the original reorder is held while metadata is pending');
    allowRuntimePreparation = true; release(metadata); await changing; allowRuntimePreparation = false;
    const confirmed = service.internalRoutingPolicy();
    assert.equal(confirmed.busy, false); assert.notEqual(confirmed.revision, initial.revision);
    assert.deepEqual(service.internalRoutingPolicy(), confirmed);
    const requestId = randomUUID(), order = { requestId, generation, profileIds: ['openai:fixture'], nativeIds: ['openai:fixture'], state: 'unknown' };
    store.internalWrite(`accounts:order:${requestId}`, order);
    const unresolved = service.internalRoutingPolicy(); assert.equal(unresolved.busy, true);
    assert.notEqual(unresolved.revision, confirmed.revision); assert.deepEqual(service.internalRoutingPolicy(), unresolved);
    store.internalWrite(`accounts:order:${requestId}`, { ...order, state: 'confirmed' });
    assert.equal(service.internalRoutingPolicy().busy, false);
    store.internalWrite(`accounts:order:${requestId}`, order);
    generation = randomUUID(); const nextGeneration = service.internalRoutingPolicy();
    assert.equal(nextGeneration.busy, false, 'a historical generation does not hold the current route');
    assert.notEqual(nextGeneration.revision, unresolved.revision);
    service.invalidate(); const invalidated = service.internalRoutingPolicy();
    assert.notEqual(invalidated.revision, nextGeneration.revision);
    store.internalWrite('gateway:configuration', { url: 'ws://127.0.0.1:49998', token: 'synthetic-revision' });
    assert.notEqual(service.internalRoutingPolicy().revision, invalidated.revision);
    store.setUpdateMaintenanceHeld(true); assert.throws(() => service.internalRoutingPolicy(), /unavailable/);
    store.setUpdateMaintenanceHeld(false); await service.close(); assert.throws(() => service.internalRoutingPolicy(), /unavailable/);
    const unavailable = new ChatGptAccount({ accountCommand: () => command }, async () => { throw Error('No read allowed'); });
    try { assert.throws(() => unavailable.internalRoutingPolicy(), /unavailable/); } finally { await unavailable.close(); }
  } finally { release(metadata); await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
