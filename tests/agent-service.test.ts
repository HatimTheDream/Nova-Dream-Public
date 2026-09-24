import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { GatewayClientOptions } from '@openclaw/gateway-client';
import type { HelloOk } from '@openclaw/gateway-protocol/frame-guards';
import { Gateway, type AssistantTransport } from '../apps/service/gateway.js';
import { startServer } from '../apps/service/http.js';
import { Store } from '../apps/service/store.js';
import { agentServiceInfo, type AgentServiceInfo } from '../packages/domain/agent-service.js';

const unknownService = { id: 'unknown', name: 'Agent service', state: 'unavailable' };
const hello = (version?: unknown) => ({ protocol: 4, server: { version }, features: { methods: [], events: [] }, policy: {} }) as unknown as HelloOk;

test('agent version follows the connected gateway hello, never the local app or stale host', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-agent-version-')), store = new Store(directory);
  const clients: GatewayClientOptions[] = [];
  const gateway = new Gateway(store, '1.12.10', options => {
    clients.push(options);
    return { start() {}, async stopAndWait() {}, async request<T>() { return {} as T; } };
  });
  t.after(async () => { await gateway.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.deepEqual(gateway.serviceInfo(), { id: 'openclaw', name: 'OpenClaw', state: 'unconfigured' });
  await gateway.configure('wss://external.example.test', 'fixture');
  assert.equal(gateway.serviceInfo().version, undefined);
  clients[0].onHelloOk?.(hello('2026.9.7'));
  assert.deepEqual(gateway.serviceInfo(), { id: 'openclaw', name: 'OpenClaw', state: 'ready', version: '2026.9.7' });
  clients[0].onClose?.(1006, 'disconnected');
  assert.deepEqual(gateway.serviceInfo(), { id: 'openclaw', name: 'OpenClaw', state: 'disconnected' });
  clients[0].onHelloOk?.(hello('2026.9.8'));
  assert.equal(gateway.serviceInfo().version, '2026.9.8');
  clients[0].onConnectError?.(new Error('authentication failed'));
  assert.equal(gateway.serviceInfo().state, 'error');
  assert.equal(gateway.serviceInfo().version, undefined);
  await gateway.configure('wss://other.example.test', 'other-fixture');
  assert.equal(gateway.serviceInfo().state, 'connecting');
  clients[0].onHelloOk?.(hello('stale'));
  assert.equal(gateway.serviceInfo().version, undefined);
  clients[1].onHelloOk?.(hello('2026.9.9'));
  clients[0].onClose?.(1006, 'stale close');
  assert.equal(gateway.serviceInfo().version, '2026.9.9');
  for (const version of [undefined, '', 'x'.repeat(65), '<script>', 'version\nsecret', 2026]) {
    clients[1].onHelloOk?.(hello(version));
    assert.equal(gateway.serviceInfo().state, 'ready');
    assert.equal(gateway.serviceInfo().version, undefined);
  }
  await gateway.stop(); clients[1].onHelloOk?.(hello('stopped'));
  assert.deepEqual(gateway.serviceInfo(), { id: 'openclaw', name: 'OpenClaw', state: 'unconfigured' });
});

test('agent descriptors are bounded, omit unrelated data, and never retain a disconnected version', () => {
  const descriptor = { id: 'hermes', name: 'Hermes', state: 'ready', version: '0.8.0-beta.2', token: 'private', url: 'wss://private', path: '/private' };
  assert.deepEqual(agentServiceInfo(descriptor), { id: 'hermes', name: 'Hermes', state: 'ready', version: '0.8.0-beta.2' });
  assert.deepEqual(agentServiceInfo({ ...descriptor, state: 'disconnected' }), { id: 'hermes', name: 'Hermes', state: 'disconnected' });
  for (const value of [undefined, { ...descriptor, id: '../private' }, { ...descriptor, name: 'x'.repeat(81) }, { ...descriptor, name: 'Agent\nsecret' }, { ...descriptor, state: 'invented' }]) assert.deepEqual(agentServiceInfo(value), unknownService);
});

function call(target: string, path: string, value?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; data: any; cookie?: string }>((accept, reject) => {
    const req = httpRequest(target + '/api/' + path, { method: value === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Edition3-Client': '1', ...headers } }, response => {
      const chunks: Buffer[] = []; response.on('data', bytes => chunks.push(bytes)); response.on('end', () => accept({ status: response.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()), cookie: response.headers['set-cookie']?.[0] }));
    }); req.on('error', reject); req.end(value === undefined ? undefined : JSON.stringify(value));
  });
}

test('authenticated desktop and paired phone receive only adapter metadata without runtime control or RPCs', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-agent-service-api-'));
  let descriptor: unknown = { id: 'hermes', name: 'Hermes', state: 'ready', version: '0.8.0', token: 'must-not-leak', url: 'wss://private' }, reads = 0, rpc = 0;
  const gateway: AssistantTransport = {
    status: () => ({ state: 'unconfigured', message: 'Fixture', methods: [], grantedScopes: [], modelAuthReady: false }),
    serviceInfo: () => { ++reads; return descriptor as AgentServiceInfo; },
    request: async <T>() => { ++rpc; return {} as T; },
    subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}),
  };
  const origin = 'https://phone.example.ts.net:8443';
  const service = await startServer({ directory, port: 0, phonePort: 0, gateway, phoneTransport: { reconcile: async () => ({ state: 'ready', origin, message: 'Fixture' }), disable: async () => {} } });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal((await call(service.origin, 'assistant/service')).status, 401); assert.equal(reads, 0);
  const owner = await call(service.origin, 'session', {}), ownerHeaders = { Cookie: owner.cookie!.split(';')[0] };
  const expected = { id: 'hermes', name: 'Hermes', state: 'ready', version: '0.8.0' };
  const baselineRpc = rpc;
  assert.deepEqual((await call(service.origin, 'assistant/service', undefined, ownerHeaders)).data, expected);
  assert.equal((await call(service.origin, 'assistant/service', undefined, { ...ownerHeaders, Origin: 'https://hostile.example' })).status, 403);
  const command = () => ({ requestId: randomUUID(), epoch: service.store.epoch });
  await call(service.origin, 'phone/enable', command(), ownerHeaders);
  const remote = { Host: new URL(origin).host, Origin: origin, 'Tailscale-User-Login': 'owner@example.test' };
  assert.equal((await call(service.phoneHost.localOrigin, 'assistant/service', undefined, remote)).status, 401);
  const challenge = await call(service.origin, 'phone/pairing', command(), ownerHeaders);
  const paired = await call(service.phoneHost.localOrigin, 'pair', { requestId: randomUUID(), code: challenge.data.code, name: 'Fixture phone' }, remote);
  assert.equal(paired.status, 200);
  const phoneHeaders = { ...remote, Cookie: paired.cookie!.split(';')[0] };
  assert.deepEqual((await call(service.phoneHost.localOrigin, 'assistant/service', undefined, phoneHeaders)).data, expected);
  assert.equal((await call(service.phoneHost.localOrigin, 'assistant/runtime', undefined, phoneHeaders)).status, 403);
  assert.equal((await call(service.phoneHost.localOrigin, 'assistant/service', {}, phoneHeaders)).status, 403);
  assert.equal((await call(service.phoneHost.localOrigin, 'assistant/runtime/start', command(), phoneHeaders)).status, 403);
  descriptor = { ...expected, state: 'disconnected' };
  assert.deepEqual((await call(service.origin, 'assistant/service', undefined, ownerHeaders)).data, { id: 'hermes', name: 'Hermes', state: 'disconnected' });
  delete gateway.serviceInfo;
  assert.deepEqual((await call(service.origin, 'assistant/service', undefined, ownerHeaders)).data, unknownService);
  assert.equal(rpc, baselineRpc, 'metadata reads never query or update the agent runtime');
  await call(service.origin, 'phone/revoke', { ...command(), deviceId: paired.data.deviceId }, ownerHeaders);
  assert.equal((await call(service.phoneHost.localOrigin, 'assistant/service', undefined, phoneHeaders)).status, 401);
});
