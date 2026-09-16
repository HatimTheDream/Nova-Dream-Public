import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionSettingsControl, type AccessTransport } from '../apps/service/full-access.js';
import type { AssistantConnection } from '../packages/domain/assistant.js';

function transport(scopes = ['operator.read', 'operator.write']) {
  let state: AssistantConnection = { state: 'ready', generation: 'host-one', url: 'ws://127.0.0.1:12345', message: 'Fixture', methods: ['sessions.patch', 'sessions.create'], modelAuthReady: true, grantedScopes: scopes };
  const calls: { method: string; params: unknown }[] = [];
  const lifecycle = { starts: 0, stops: 0 };
  const client: AccessTransport = {
    status: () => state, subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({ maxBytes: 10, maxPayload: 20 }),
    start: () => { lifecycle.starts++; }, stop: async () => { lifecycle.stops++; },
    request: async <T>(method: string, params: unknown) => { calls.push({ method, params }); return { confirmed: true } as T; }
  };
  return { client, calls, lifecycle, set: (patch: Partial<AssistantConnection>) => { state = { ...state, ...patch }; } };
}
test('Full access control is lazy, request-scoped and closes after success or uncertain response', async () => {
  const ordinary = transport(), privileged = transport(['operator.read', 'operator.admin']); let factories = 0;
  const access = new SessionSettingsControl(ordinary.client, () => { factories++; return privileged.client; });
  assert.equal(factories, 0);
  const params = { key: 'e3:fixture', expectedSessionId: 'native-one', permissionMode: 'full' };
  assert.deepEqual(await access.request('sessions.patch', params), { confirmed: true });
  assert.equal(factories, 1); assert.deepEqual(privileged.lifecycle, { starts: 1, stops: 1 });
  assert.deepEqual(privileged.calls, [{ method: 'sessions.patch', params }]); assert.deepEqual(ordinary.calls, []);
  privileged.client.request = async () => { throw Error('Response lost'); };
  await assert.rejects(access.request('sessions.patch', params), /Response lost/);
  assert.equal(privileged.lifecycle.stops, 2);
  await access.close(); await assert.rejects(access.request('sessions.patch', params), { code: 'access_not_sent' });
});
test('Full access is not sent without an authorized matching host, or during shutdown', async () => {
  const ordinary = transport(), control = transport();
  for (const patch of [{ grantedScopes: ['operator.read'] }, { grantedScopes: ['operator.admin'], generation: 'other-host' }, { grantedScopes: ['operator.admin'], generation: 'host-one', url: 'ws://127.0.0.1:54321' }]) {
    control.set(patch); const access = new SessionSettingsControl(ordinary.client, () => control.client);
    await assert.rejects(access.request('sessions.patch', {}), { code: 'access_not_sent' }); await access.close();
  }
  assert.equal(control.calls.length, 0);
  control.set({ state: 'connecting' });
  const access = new SessionSettingsControl(ordinary.client, () => control.client), pending = access.request('sessions.patch', {});
  await access.close(); await assert.rejects(pending, { code: 'access_not_sent' });
  assert.equal(control.calls.length, 0);
});
test('cleanup failure does not discard a confirmed access result and is retried at shutdown', async () => {
  const ordinary = transport(), control = transport(['operator.admin']);
  control.client.stop = async () => { control.lifecycle.stops++; if (control.lifecycle.stops === 1) throw Error('cleanup interrupted'); };
  const access = new SessionSettingsControl(ordinary.client, () => control.client);
  assert.deepEqual(await access.request('sessions.patch', {}), { confirmed: true });
  await access.close(); assert.equal(control.lifecycle.stops, 2);
});


test('response settings reuse request-scoped controls with a distinct failure result', async () => {
  const ordinary = transport(), control = transport(); const response = new SessionSettingsControl(ordinary.client, () => control.client, 'response');
  await assert.rejects(response.request('sessions.patch', {}), { code: 'response_not_sent' }); assert.equal(control.calls.length, 0);
  control.set({ grantedScopes: ['operator.admin'] }); await response.request('sessions.patch', { key: 'e3:one', expectedSessionId: 'native', thinkingLevel: 'high' }); assert.equal(control.calls.length, 1); assert.equal(control.lifecycle.starts, control.lifecycle.stops); await response.close();
});


test('combined model/effort changes keep model selection ordinary and retain partial outcomes', async () => {
  const ordinary = transport(), control = transport(['operator.admin']); const response = new SessionSettingsControl(ordinary.client, () => control.client, 'response');
  const params = { key: 'e3:one', expectedSessionId: 'native', model: 'chosen', thinkingLevel: 'high', fastMode: false };
  await response.request('sessions.patch', params);
  assert.deepEqual(ordinary.calls[0].params, { key: 'e3:one', expectedSessionId: 'native', model: 'chosen' });
  assert.deepEqual(control.calls[0].params, { key: 'e3:one', expectedSessionId: 'native', thinkingLevel: 'high', fastMode: false });
  control.client.request = async () => { throw Error('Effort rejected after model applied'); };
  await assert.rejects(response.request('sessions.patch', params), { code: 'response_partial' });
  assert.equal(control.lifecycle.starts, control.lifecycle.stops); await response.close();
});
