import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { GatewayClientOptions } from '@openclaw/gateway-client';
import type { HelloOk } from '@openclaw/gateway-protocol/frame-guards';
import { Gateway } from '../apps/service/gateway.js';
import { Store } from '../apps/service/store.js';

test('reading uses a separate speech identity without widening ordinary chat or accepting unrelated effects', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-speech-gateway-')), store = new Store(directory);
  const clients: GatewayClientOptions[] = [], calls: { method: string; options: unknown }[] = [];
  const factory = (options: GatewayClientOptions) => {
    clients.push(options);
    return { start() {}, async stopAndWait() {}, async request<T>(method: string, _params: unknown, options?: unknown) {
      calls.push({ method, options }); return (method === 'models.list' ? { models: [] } : { ok: true }) as T;
    } };
  };
  const ordinary = new Gateway(store, 'fixture', factory), speech = new Gateway(store, 'fixture', factory, 'speech-playback');
  const hello = (scopes: string[]) => ({ protocol: 4, features: { methods: ['models.list', 'talk.catalog', 'talk.speak', 'chat.send', 'talk.client.create'], events: [] }, auth: { scopes }, policy: {} }) as unknown as HelloOk;
  try {
    assert.equal(clients.length, 0);
    await ordinary.configure('ws://127.0.0.1:59999', 'fixture'); clients[0].onHelloOk?.(hello(['operator.read', 'operator.write']));
    speech.start(); clients[1].onHelloOk?.(hello(['operator.read', 'operator.talk']));
    assert.deepEqual(clients[0].scopes, ['operator.read', 'operator.write']);
    assert.deepEqual(clients[1].scopes, ['operator.read', 'operator.talk']);
    assert.notEqual(clients[0].deviceIdentity?.deviceId, clients[1].deviceIdentity?.deviceId);
    await speech.request('talk.catalog', {});
    await speech.request('talk.speak', { text: 'A short reply.' });
    assert.deepEqual(calls.find(call => call.method === 'talk.speak')?.options, { timeoutMs: 45000 });
    await assert.rejects(speech.request('chat.send', {}), /not exposed/);
    await assert.rejects(speech.request('talk.client.create', {}), /not exposed/);
    await assert.rejects(speech.request('config.set', {}), /not exposed/);
    clients[1].onHelloOk?.(hello(['operator.read']));
    await speech.request('talk.catalog', {});
    await assert.rejects(speech.request('talk.speak', { text: 'No authority.' }), /not granted/);
    assert.equal(calls.filter(call => call.method === 'talk.speak').length, 1);
    assert.equal(ordinary.status().state, 'ready');
  } finally { await speech.stop(); await ordinary.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
