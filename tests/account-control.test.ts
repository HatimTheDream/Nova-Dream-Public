import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantConnection } from '../packages/domain/assistant.js';
import type { AccessTransport } from '../apps/service/full-access.js';
import { ChatGptAccountControl } from '../apps/service/account-control.js';
import { Fault } from '../apps/service/store.js';

function transport(admin = false) {
  let state: AssistantConnection = { state: 'ready', generation: 'same-host', url: 'ws://127.0.0.1:49998', message: '', methods: ['models.authOrderSet'], modelAuthReady: true, grantedScopes: admin ? ['operator.read', 'operator.admin'] : ['operator.read', 'operator.write'] };
  const calls: unknown[] = [], lifecycle = { starts: 0, stops: 0 };
  const client: AccessTransport = { status: () => state, subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({ maxBytes: 1, maxPayload: 2 }), start() { lifecycle.starts++; }, async stop() { lifecycle.stops++; }, async request<T>(method: string, params: unknown) { calls.push({ method, params }); return { confirmed: true } as T; } };
  return { client, calls, lifecycle, set(patch: Partial<AssistantConnection>) { state = { ...state, ...patch }; } };
}

test('account order uses only a matching isolated administrator connection and closes it after dispatch', async () => {
  const normal = transport(), control = transport(true), access = new ChatGptAccountControl(normal.client, () => control.client);
  const params = { provider: 'openai', agentId: 'main', profileIds: ['openai:a', 'openai:b'] };
  try {
    assert.deepEqual(await access.request('models.authOrderSet', params), { confirmed: true });
    assert.deepEqual(normal.calls, []); assert.deepEqual(control.calls, [{ method: 'models.authOrderSet', params }]); assert.deepEqual(control.lifecycle, { starts: 1, stops: 1 });
    control.set({ generation: 'another-host' }); await assert.rejects(access.request('models.authOrderSet', params), { code: 'account_order_not_sent' });
    assert.equal(control.calls.length, 1); assert.equal(control.lifecycle.stops, 2);
  } finally { await access.close(); }
});

test('a turn starting during control authorization prevents account-order mutation at the send boundary', async () => {
  const normal = transport(), control = transport(true), access = new ChatGptAccountControl(normal.client, () => control.client);
  let busy = false, checks = 0;
  control.set({ state: 'connecting' });
  const pending = access.request('models.authOrderSet', {}, () => { checks++; if (busy) throw new Fault(409, 'account_order_not_sent', 'A turn started.'); });
  busy = true; control.set({ state: 'ready' });
  try { await assert.rejects(pending, { code: 'account_order_not_sent' }); assert.equal(checks, 1); assert.equal(control.calls.length, 0); assert.equal(control.lifecycle.stops, 1); }
  finally { await access.close(); }
});
