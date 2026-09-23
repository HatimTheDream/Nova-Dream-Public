import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatewayClientOptions } from '@openclaw/gateway-client';
import type { HelloOk } from '@openclaw/gateway-protocol/frame-guards';
import type { AssistantConnection } from '../packages/domain/assistant.js';
import type { AccessTransport } from '../apps/service/full-access.js';
import { Gateway, type AssistantTransport } from '../apps/service/gateway.js';
import { SpeechGatewayControl } from '../apps/service/speech-control.js';
import { Store } from '../apps/service/store.js';

function fixture() {
  const state: AssistantConnection = { state: 'ready', generation: 'host-a', url: 'ws://127.0.0.1:1', message: '', grantedScopes: ['operator.read', 'operator.write'], methods: ['talk.catalog', 'talk.speak'], modelAuthReady: true };
  const ordinaryCalls: string[] = [], speechCalls: string[] = [];
  const ordinary: AssistantTransport = { status: () => ({ ...state }), models: async () => [], attachmentPolicy: () => ({}), subscribe: () => () => {}, request: async <T>(method: string) => { ordinaryCalls.push(method); return {} as T; } };
  let stopped = 0, created = 0, scopes = ['operator.read', 'operator.talk'];
  let response: () => Promise<unknown> = async () => ({ audio: 'fixture' });
  const control = new SpeechGatewayControl(ordinary, () => {
    created++; const captured = { ...state };
    const client: AccessTransport = { ...ordinary, status: () => ({ ...captured, grantedScopes: scopes }), start() {}, stop: async () => { stopped++; }, request: async <T>(method: string) => { speechCalls.push(method); return await response() as T; } }; return client;
  });
  return { control, state, ordinaryCalls, speechCalls, get stopped() { return stopped; }, get created() { return created; }, scopes: (value: string[]) => { scopes = value; }, response: (value: () => Promise<unknown>) => { response = value; } };
}
test('speech denial and disallowed methods never widen, stop or dispatch through ordinary chat', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.control.request('chat.send', {}), { code: 'speech_method' }); assert.equal(f.created, 0);
    f.scopes(['operator.read']); await assert.rejects(f.control.request('talk.speak', { text: 'Hello' }), { code: 'speech_permission' });
    assert.equal(f.stopped, 1); assert.deepEqual(f.ordinaryCalls, []); assert.equal(f.state.state, 'ready');
  } finally { await f.control.close(); }
});
test('concurrent reading requests share one isolated connection and discard a replaced host result', async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  try {
    await Promise.all([f.control.request('talk.catalog', {}), f.control.request('talk.speak', { text: 'Hi' })]);
    assert.equal(f.created, 1); assert.deepEqual(f.ordinaryCalls, []);
    f.response(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.control.request('talk.speak', { text: 'Late' });
    while (!finish) await Promise.resolve();
    f.state.generation = 'host-b'; finish({ audio: 'stale' });
    await assert.rejects(pending, { code: 'speech_changed' });
  } finally { await f.control.close(); }
});
test('closing during speech preparation rejects before dispatch instead of dereferencing a discarded client', async () => {
  const f = fixture();
  const pending = f.control.request('talk.speak', { text: 'Must not start' });
  const rejected = assert.rejects(pending, error => error instanceof Error && 'code' in error && error.code === 'speech_changed');
  await f.control.close(); await rejected;
  assert.deepEqual(f.speechCalls, []); assert.deepEqual(f.ordinaryCalls, []);
});
test('the real speech Gateway requests only read/talk authority and exposes only catalog and synthesis', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-speech-gateway-')), store = new Store(directory), clients: GatewayClientOptions[] = [], calls: string[] = [];
  const factory = (options: GatewayClientOptions) => { clients.push(options); return { start() {}, stopAndWait: async () => {}, request: async <T>(method: string) => { calls.push(method); return (method === 'models.list' ? { models: [] } : {}) as T; } }; };
  const ordinary = new Gateway(store, 'fixture', factory), speech = new Gateway(store, 'fixture', factory, 'speech-playback');
  const hello = (scopes: string[]) => ({ protocol: 4, features: { methods: ['models.list', 'chat.send', 'talk.catalog', 'talk.speak'], events: [] }, auth: { scopes }, policy: {} }) as unknown as HelloOk;
  try {
    await ordinary.configure('ws://127.0.0.1:59999', 'fixture'); clients[0].onHelloOk?.(hello(['operator.read', 'operator.write']));
    speech.start(); clients[1].onHelloOk?.(hello(['operator.read', 'operator.talk']));
    assert.deepEqual(clients[0].scopes, ['operator.read', 'operator.write']); assert.deepEqual(clients[1].scopes, ['operator.read', 'operator.talk']);
    assert.notEqual(clients[0].deviceIdentity?.deviceId, clients[1].deviceIdentity?.deviceId);
    await assert.rejects(speech.request('chat.send', {}), /not exposed/); await assert.rejects(speech.request('sessions.patch', {}), /not exposed/);
    await speech.request('talk.catalog', {}); await speech.request('talk.speak', { text: 'Read this answer' });
    assert.equal(calls.filter(method => method === 'models.list').length, 1);
    clients[1].onHelloOk?.(hello(['operator.read'])); await assert.rejects(speech.request('talk.speak', {}), /not granted/);
    assert.equal(ordinary.status().state, 'ready');
  } finally { await speech.stop(); await ordinary.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
