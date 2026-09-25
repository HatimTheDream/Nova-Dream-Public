import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { GatewayClientOptions } from '@openclaw/gateway-client';
import type { HelloOk } from '@openclaw/gateway-protocol/frame-guards';
import { Gateway } from '../apps/service/gateway.js';
import { Store } from '../apps/service/store.js';

test('cold preparation waits for one native read while send timeouts remain bounded and never retry', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-cold-preparation-')), store = new Store(directory);
  let options!: GatewayClientOptions, coldMs = 57187;
  const calls: { method: string; timeout: number }[] = [];
  const gateway = new Gateway(store, 'fixture', value => {
    options = value;
    return { start() {}, async stopAndWait() {}, request<T>(method: string, _params: unknown, requestOptions?: { timeoutMs?: number }) {
      const timeout = requestOptions?.timeoutMs ?? options.requestTimeoutMs!;
      calls.push({ method, timeout });
      if (method === 'models.list') return Promise.resolve({ models: [] } as T);
      return new Promise<T>((resolve, reject) => {
        const failure = setTimeout(() => { clearTimeout(success); reject(new Error('Native request timed out')); }, timeout);
        const success = setTimeout(() => { clearTimeout(failure); resolve({ ready: true } as T); }, method === 'chat.send' ? 12001 : coldMs);
      });
    } };
  });
  try {
    await gateway.configure('ws://127.0.0.1:59999', 'fixture');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    options.onHelloOk?.({ protocol: 4, features: { methods: ['models.list', 'e3.accounts.snapshot', 'chat.history', 'chat.send'], events: [] }, auth: { scopes: ['operator.read', 'operator.write'] }, policy: {} } as unknown as HelloOk);
    for (const method of ['chat.history', 'e3.accounts.snapshot']) {
      let settled = false;
      const reading = gateway.request(method, { epoch: store.epoch, includeUsage: false }).finally(() => { settled = true; });
      t.mock.timers.tick(12000); await Promise.resolve();
      assert.equal(settled, false, 'cold preparation is still waiting after the former timeout');
      t.mock.timers.tick(45187);
      assert.deepEqual(await reading, { ready: true });
      assert.equal(calls.filter(call => call.method === method).length, 1, 'the original read is awaited without a retry');
    }
    const sending = assert.rejects(gateway.request('chat.send', { message: 'fixture', idempotencyKey: 'original' }), /timed out/);
    t.mock.timers.tick(12000); await sending;
    assert.deepEqual(calls.filter(call => call.method === 'chat.send'), [{ method: 'chat.send', timeout: 12000 }]);
    coldMs = 90001;
    const unavailable = assert.rejects(gateway.request('e3.accounts.snapshot', { epoch: store.epoch, includeUsage: false }), /timed out/);
    t.mock.timers.tick(90000); await unavailable;
    assert.equal(calls.filter(call => call.method === 'e3.accounts.snapshot').length, 2, 'a failed preparation does not automatically repeat');
    const usage = assert.rejects(gateway.request('e3.accounts.snapshot', { epoch: store.epoch, includeUsage: true }), /timed out/);
    t.mock.timers.tick(12000); await usage;
    assert.equal(calls.at(-1)?.timeout, 12000, 'unrelated usage refreshes retain their ordinary timeout');
  } finally { await gateway.stop(); t.mock.timers.reset(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('account ordering has separate finite authority while usage stays read-only', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-account-control-')), store = new Store(directory);
  const clients: GatewayClientOptions[] = [], calls: string[] = [];
  const factory = (options: GatewayClientOptions) => { clients.push(options); return { start() {}, async stopAndWait() {}, async request<T>(method: string) { calls.push(method); return (method === 'models.list' ? { models: [] } : { ok: true }) as T; } }; };
  const ordinary = new Gateway(store, 'fixture', factory), control = new Gateway(store, 'fixture', factory, 'account-control');
  const hello = { protocol: 4, features: { methods: ['models.list', 'e3.accounts.snapshot', 'models.authOrderSet', 'chat.send'], events: [] }, policy: {} } as unknown as HelloOk;
  try {
    await ordinary.configure('ws://127.0.0.1:59999', 'fixture'); clients[0].onHelloOk?.({ ...hello, auth: { scopes: ['operator.read', 'operator.write'] } } as HelloOk);
    control.start(); clients[1].onHelloOk?.({ ...hello, auth: { scopes: ['operator.read', 'operator.admin'] } } as HelloOk);
    assert.deepEqual(clients[0].scopes, ['operator.read', 'operator.write']); assert.notEqual(clients[0].deviceIdentity?.deviceId, clients[1].deviceIdentity?.deviceId);
    await ordinary.request('e3.accounts.snapshot', { epoch: store.epoch });
    await assert.rejects(ordinary.request('models.authOrderSet', { provider: 'openai', agentId: 'main', profileIds: ['openai:a'] }), /not exposed/);
    await assert.rejects(control.request('chat.send', {}), /not exposed/);
    await assert.rejects(control.request('models.authOrderSet', { provider: 'other', agentId: 'main', profileIds: ['openai:a'] }), /only the complete/);
    await assert.rejects(control.request('models.authOrderSet', { provider: 'openai', agentId: 'other', profileIds: ['openai:a'] }), /only the complete/);
    await assert.rejects(control.request('models.authOrderSet', { provider: 'openai', agentId: 'main', profileIds: ['openai:a', 'openai:a'] }), /only the complete/);
    await control.request('models.authOrderSet', { provider: 'openai', agentId: 'main', profileIds: ['openai:b', 'openai:a'] });
    assert.equal(calls.filter(method => method === 'models.authOrderSet').length, 1);
  } finally { await control.stop(); await ordinary.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('replacing a client on the same Gateway fences old events, credentials, and pending results', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-gateway-'));
  const store = new Store(directory);
  const clients: { options: GatewayClientOptions; pending: ((value: unknown) => void)[] }[] = [];
  const gateway = new Gateway(store, 'fixture', options => {
    const client = { options, pending: [] as ((value: unknown) => void)[] }; clients.push(client);
    return { start() {}, async stopAndWait() {}, request: <T>() => new Promise<T>(resolve => client.pending.push(value => resolve(value as T))) };
  });
  const hello = { protocol: 4, features: { methods: ['models.list', 'chat.history'], events: [] }, auth: { scopes: ['operator.read', 'operator.write'] }, policy: {} } as unknown as HelloOk;
  const events: string[] = [];
  const unsubscribe = gateway.subscribe(event => events.push(event.event));
  try {
    await gateway.configure('ws://127.0.0.1:59999', 'fixture-credential');
    const generation = gateway.status().generation;
    clients[0].options.onHelloOk?.(hello);
    clients[0].pending.shift()!({ models: [] });
    await new Promise(resolve => setImmediate(resolve));
    const pending = gateway.request('chat.history', { sessionKey: 'fixture' });
    await gateway.configure('ws://127.0.0.1:59999');
    assert.equal(gateway.status().generation, generation, 'the durable host identity stays the same');
    clients[1].options.onHelloOk?.(hello);
    clients[1].pending.shift()!({ models: [{ id: 'fixture', provider: 'openai', available: true, reasoning: false }] });
    await new Promise(resolve => setImmediate(resolve));
    const priorEventCount = events.length;
    clients[0].options.onHelloOk?.({ ...hello, auth: { ...hello.auth, scopes: [] } } as HelloOk);
    clients[0].options.onEvent?.({ type: 'event', event: 'stale-event' });
    clients[0].options.onClose?.(1006, 'old transport closed');
    clients[0].options.hostDeps?.storeDeviceAuthToken?.({ deviceId: 'fixture', role: 'operator', token: 'stale-token', scopes: [] });
    clients[0].pending.shift()!({ sessionId: 'stale-history' });
    await assert.rejects(pending, /connection changed/);
    assert.equal(events.length, priorEventCount);
    assert.equal(gateway.status().state, 'ready');
    assert.equal(gateway.status().modelAuthReady, true);
    assert.deepEqual(gateway.status().grantedScopes, ['operator.read', 'operator.write']);
    assert.equal(store.internalRead(`gateway:device-token:${generation}`), undefined);
    gateway.start(); assert.equal(clients.length, 2, 'starting an already owned client is a no-op');
  } finally { unsubscribe(); await gateway.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('skill management uses a separate explicit identity and finite authority without widening ordinary chat', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-skill-management-')), store = new Store(directory);
  const clients: { options: GatewayClientOptions; methods: string[]; finish?: (value: unknown) => void }[] = [];
  const create = (options: GatewayClientOptions) => {
    const client = { options, methods: [] as string[], finish: undefined as ((value: unknown) => void) | undefined }; clients.push(client);
    return { start() {}, async stopAndWait() {}, request: <T>(method: string) => { client.methods.push(method); if (method === 'models.list') return Promise.resolve({ models: [] } as T); return new Promise<T>(resolve => { client.finish = value => resolve(value as T); }); } };
  };
  const ordinary = new Gateway(store, 'fixture', create), manager = new Gateway(store, 'fixture', create, 'skill-management');
  const hello = (scopes: string[]) => ({ protocol: 4, features: { methods: ['models.list', 'chat.send', 'skills.proposals.inspect', 'skills.proposals.apply', 'config.set'], events: [] }, auth: { scopes }, policy: {} }) as unknown as HelloOk;
  try {
    assert.equal(clients.length, 0, 'constructing a manager requests no permission');
    await ordinary.configure('ws://127.0.0.1:59999', 'fixture'); clients[0].options.onHelloOk?.(hello(['operator.read', 'operator.write']));
    manager.start(); clients[1].options.onHelloOk?.(hello(['operator.read', 'operator.admin']));
    assert.deepEqual(clients[0].options.scopes, ['operator.read', 'operator.write']); assert.deepEqual(clients[1].options.scopes, ['operator.read', 'operator.admin']);
    assert.notEqual(clients[0].options.deviceIdentity?.deviceId, clients[1].options.deviceIdentity?.deviceId);
    assert.deepEqual(clients[1].methods, [], 'management never starts model reads or model runs');
    await assert.rejects(ordinary.request('skills.proposals.apply', {}), /not exposed/);
    await assert.rejects(manager.request('chat.send', {}), /not exposed/); await assert.rejects(manager.request('config.set', {}), /not exposed/);
    await assert.rejects(manager.configure('ws://127.0.0.1:60000', 'foreign'), /configured host/);
    const generation = ordinary.status().generation;
    clients[0].options.hostDeps?.storeDeviceAuthToken?.({ deviceId: 'ordinary', role: 'operator', token: 'ordinary', scopes: ['operator.read', 'operator.write'] });
    clients[1].options.hostDeps?.storeDeviceAuthToken?.({ deviceId: 'manager', role: 'operator', token: 'manager', scopes: ['operator.read', 'operator.admin'] });
    assert.equal(store.internalRead<{ token: string }>(`gateway:device-token:${generation}`)?.token, 'ordinary');
    assert.equal(store.internalRead<{ token: string }>(`gateway:skill-management:device-token:${generation}`)?.token, 'manager');
    clients[1].options.onHelloOk?.(hello(['operator.read'])); await assert.rejects(manager.request('skills.proposals.apply', {}), /not granted/);
    clients[1].options.onHelloOk?.(hello(['operator.read', 'operator.admin']));
    const pending = manager.request('skills.proposals.inspect', {});
    await ordinary.configure('ws://127.0.0.1:60000', 'foreign'); clients[1].finish?.({ record: 'old host' });
    await assert.rejects(pending, /host changed before/);
    await assert.rejects(manager.request('skills.proposals.apply', {}), /original Assistant host/);
  } finally { await manager.stop(); await ordinary.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('permission controls use a separate identity and accept only captured Full access changes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-permission-control-')), store = new Store(directory);
  const clients: { options: GatewayClientOptions; calls: { method: string; params: unknown }[] }[] = [];
  const factory = (options: GatewayClientOptions) => {
    const client = { options, calls: [] as { method: string; params: unknown }[] }; clients.push(client);
    return { start() {}, async stopAndWait() {}, request: async <T>(method: string, params: unknown) => { client.calls.push({ method, params }); return { models: [] } as T; } };
  };
  const ordinary = new Gateway(store, 'fixture', factory), control = new Gateway(store, 'fixture', factory, 'permission-control');
  const hello = (scopes: string[]) => ({ protocol: 4, features: { methods: ['models.list', 'chat.send', 'sessions.patch', 'sessions.create', 'config.set'], events: [] }, auth: { scopes }, policy: {} }) as unknown as HelloOk;
  try {
    assert.equal(clients.length, 0);
    await ordinary.configure('ws://127.0.0.1:59998', 'fixture'); clients[0].options.onHelloOk?.(hello(['operator.read', 'operator.write']));
    control.start(); clients[1].options.onHelloOk?.(hello(['operator.read', 'operator.admin']));
    assert.deepEqual(clients[0].options.scopes, ['operator.read', 'operator.write']); assert.deepEqual(clients[1].options.scopes, ['operator.read', 'operator.admin']);
    assert.notEqual(clients[0].options.deviceIdentity?.deviceId, clients[1].options.deviceIdentity?.deviceId);
    assert.deepEqual(clients[1].calls, []);
    for (const method of ['chat.send', 'config.set', 'skills.proposals.apply', 'sessions.list']) await assert.rejects(control.request(method, {}), /not exposed/);
    for (const params of [{ key: 'e3:one', permissionMode: 'full' }, { key: 'e3:one', expectedSessionId: 'native', permissionMode: 'workspace' }, { key: 'e3:one', expectedSessionId: 'native', permissionMode: 'full', systemPrompt: 'extra' }]) await assert.rejects(control.request('sessions.patch', params), /only an explicit Full/);
    await assert.rejects(control.request('sessions.create', { key: 'e3:one', idempotencyKey: 'create', permissionMode: 'full', emitCommandHooks: true }), /only an explicit Full/);
    await control.request('sessions.patch', { key: 'e3:one', expectedSessionId: 'native', permissionMode: 'full' });
    await control.request('sessions.create', { key: 'e3:two', idempotencyKey: 'create', permissionMode: 'full', emitCommandHooks: false });
    assert.equal(clients[1].calls.length, 2);
    clients[1].options.onHelloOk?.(hello(['operator.read'])); await assert.rejects(control.request('sessions.patch', { key: 'e3:one', expectedSessionId: 'native', permissionMode: 'full' }), /not granted/);
    await ordinary.configure('ws://127.0.0.1:59997', 'new-fixture'); await assert.rejects(control.request('sessions.patch', { key: 'e3:one', expectedSessionId: 'native', permissionMode: 'full' }), /original Assistant host/);
  } finally { await control.stop(); await ordinary.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('ordinary Assistant transport exposes supported forks without administrative authority', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-fork-gateway-')), store = new Store(directory);
  let options: GatewayClientOptions; const calls: { method: string; params: unknown }[] = [];
  const gateway = new Gateway(store, 'fixture', input => { options = input; return { start() {}, async stopAndWait() {}, async request<T>(method: string, params: unknown) { calls.push({ method, params }); return (method === 'models.list' ? { models: [] } : { sessionKey: 'e3:child' }) as T; } }; });
  try {
    await gateway.configure('ws://127.0.0.1:59999', 'fixture-credential');
    options!.onHelloOk?.({ protocol: 4, features: { methods: ['models.list', 'sessions.fork'], events: [] }, auth: { scopes: ['operator.read', 'operator.write'] }, policy: {} } as unknown as HelloOk);
    const params = { sessionKey: 'e3:source', entryId: 'exact-message' };
    assert.deepEqual(await gateway.request('sessions.fork', params), { sessionKey: 'e3:child' });
    assert.deepEqual(calls.find(c => c.method === 'sessions.fork')?.params, params);
    assert.deepEqual(options!.scopes, ['operator.read', 'operator.write']);
    await assert.rejects(gateway.request('chat.inject', {}), /not exposed/);
  } finally { await gateway.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('approval reviewer advertises delivery and exposes only review methods on the originating owner device', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-review-gateway-')), store = new Store(directory);
  const clients: { options: GatewayClientOptions; calls: string[] }[] = [];
  const factory = (options: GatewayClientOptions) => { const client = { options, calls: [] as string[] }; clients.push(client); return { start() {}, async stopAndWait() {}, async request<T>(method: string) { client.calls.push(method); return { models: [] } as T; } }; };
  const ordinary = new Gateway(store, 'fixture', factory), reviewer = new Gateway(store, 'fixture', factory, 'approval-review');
  const hello = (scopes: string[]) => ({ protocol: 4, features: { methods: ['models.list', 'approval.get', 'approval.resolve', 'sessions.messages.subscribe', 'exec.approval.request', 'chat.send', 'config.set'], events: [] }, auth: { scopes }, policy: {} }) as unknown as HelloOk;
  try {
    await ordinary.configure('ws://127.0.0.1:59999', 'fixture'); clients[0].options.onHelloOk?.(hello(['operator.read', 'operator.write']));
    const generation = ordinary.status().generation;
    store.internalWrite(`gateway:approval-review:device-token:${generation}`, { token: 'former-review-device', scopes: ['operator.read', 'operator.approvals'] });
    reviewer.start(); clients[1].options.onHelloOk?.(hello(['operator.read', 'operator.approvals']));
    assert.equal(clients[1].options.hostDeps?.loadDeviceAuthToken?.({ deviceId: 'fixture', role: 'operator' }), null, 'the former separate-device token is never reused');
    clients[1].options.hostDeps?.storeDeviceAuthToken?.({ deviceId: clients[1].options.deviceIdentity!.deviceId, role: 'operator', token: 'owner-review', scopes: ['operator.read', 'operator.approvals'] });
    assert.equal(store.internalRead<{ token: string }>(`gateway:approval-review:device-token:${generation}`)?.token, 'former-review-device');
    assert.equal(store.internalRead<{ token: string }>(`gateway:approval-review:owner-bound:device-token:${generation}`)?.token, 'owner-review');
    assert.deepEqual(clients[0].options.scopes, ['operator.read', 'operator.write']);
    assert.deepEqual(clients[0].options.caps, ['tool-events']);
    assert.deepEqual(clients[1].options.caps, ['approvals']); assert.deepEqual(clients[1].options.scopes, ['operator.read', 'operator.approvals']); assert.equal(clients[0].options.deviceIdentity?.deviceId, clients[1].options.deviceIdentity?.deviceId, 'native routing binds reviews to the device that submitted the turn');
    await assert.rejects(ordinary.request('approval.resolve', {}), /not exposed/);
    for (const method of ['exec.approval.request', 'chat.send', 'config.set']) await assert.rejects(reviewer.request(method, {}), /not exposed/);
    await reviewer.request('approval.get', { id: 'original' }); assert.deepEqual(clients[1].calls, ['approval.get']);
    clients[1].options.onHelloOk?.(hello(['operator.read'])); await assert.rejects(reviewer.request('approval.resolve', { id: 'original', kind: 'exec', decision: 'deny' }), /not granted/);
  } finally { await reviewer.stop(); await ordinary.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('question reviewer separates transient question authority and exposes only review methods on its separate identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-question-gateway-')), store = new Store(directory);
  const clients: { options: GatewayClientOptions; calls: string[] }[] = [];
  const factory = (options: GatewayClientOptions) => { const client = { options, calls: [] as string[] }; clients.push(client); return { start() {}, async stopAndWait() {}, async request<T>(method: string) { client.calls.push(method); return { models: [] } as T; } }; };
  const ordinary = new Gateway(store, 'fixture', factory), reviewer = new Gateway(store, 'fixture', factory, 'question-review');
  const hello = (scopes: string[]) => ({ protocol: 4, features: { methods: ['models.list', 'question.get', 'question.resolve', 'sessions.messages.subscribe', 'question.request', 'chat.send', 'config.set'], events: [] }, auth: { scopes }, policy: {} }) as unknown as HelloOk;
  try {
    await ordinary.configure('ws://127.0.0.1:59999', 'fixture'); clients[0].options.onHelloOk?.(hello(['operator.read', 'operator.write']));
    reviewer.start(); clients[1].options.onHelloOk?.(hello(['operator.read', 'operator.questions']));
    assert.deepEqual(clients[1].options.caps, []); assert.deepEqual(clients[1].options.scopes, ['operator.read', 'operator.questions']); assert.notEqual(clients[0].options.deviceIdentity?.deviceId, clients[1].options.deviceIdentity?.deviceId);
    await assert.rejects(ordinary.request('question.resolve', {}), /not exposed/);
    for (const method of ['question.request', 'chat.send', 'config.set']) await assert.rejects(reviewer.request(method, {}), /not exposed/);
    await reviewer.request('question.get', { id: 'original' }); assert.deepEqual(clients[1].calls, ['question.get']);
    clients[1].options.onHelloOk?.(hello(['operator.read'])); await assert.rejects(reviewer.request('question.resolve', { id: 'original', kind: 'exec', decision: 'deny' }), /not granted/);
  } finally { await reviewer.stop(); await ordinary.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});


test('model discovery enriches prepared catalogs, shares concurrent reads and retries failures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-catalog-')), store = new Store(directory);
  let options: GatewayClientOptions;
  const calls: { params: unknown; resolve: (value: unknown) => void; reject: (reason: Error) => void }[] = [];
  const gateway = new Gateway(store, 'fixture', input => { options = input; return { start() {}, async stopAndWait() {}, request: <T>(_method: string, params: unknown) => new Promise<T>((resolve, reject) => calls.push({ params, resolve: value => resolve(value as T), reject })) }; });
  const hello = { protocol: 4, features: { methods: ['models.list'], events: [] }, auth: { scopes: ['operator.read', 'operator.write'] }, policy: {} } as unknown as HelloOk;
  const prepared = { models: [{ id: 'native', provider: 'openai', available: true, tags: ['default'] }] };
  const complete = { models: [{ ...prepared.models[0], reasoning: true, thinkingLevels: [{ id: 'low' }, { id: 'ultra' }] }] };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  try {
    await gateway.configure('ws://127.0.0.1:59999', 'fixture'); options!.onHelloOk?.(hello);
    const pending = gateway.models(); assert.equal(gateway.models(), pending); assert.equal(calls.length, 1); assert.deepEqual(calls[0].params, { agentId: 'main' });
    calls.shift()!.resolve(prepared); await tick(); assert.deepEqual(calls[0].params, { agentId: 'main', refresh: true }); assert.equal(gateway.models(), pending);
    calls.shift()!.resolve(complete); const found = await pending; assert.deepEqual(found[0].reasoning, ['low', 'ultra']); assert.equal(found[0].isDefault, true); assert.equal(gateway.status().modelAuthReady, true);
    const cached = gateway.models(); calls.shift()!.resolve(complete); await cached; assert.equal(calls.length, 0, 'complete catalogs never force discovery');
    const retry = gateway.models(); calls.shift()!.resolve(prepared); await tick(); calls.shift()!.reject(new Error('Discovery failed')); await assert.rejects(retry, /Discovery failed/);
    const recovered = gateway.models(); calls.shift()!.resolve(prepared); await tick(); assert.deepEqual(calls[0].params, { agentId: 'main', refresh: true }); calls.shift()!.resolve(complete); await recovered;
    const unknown = gateway.models(); calls.shift()!.resolve(prepared); await tick(); calls.shift()!.resolve(prepared); assert.equal((await unknown)[0].reasoning, undefined);
    const unchanged = gateway.models(); calls.shift()!.resolve(prepared); await unchanged; assert.equal(calls.length, 0, 'unchanged metadata-free catalogs do not rediscover every poll');
    options!.onClose?.(1006, 'fixture reconnect'); options!.onHelloOk?.(hello);
    const reconnected = gateway.models(); calls.shift()!.resolve(prepared); await tick(); assert.deepEqual(calls[0].params, { agentId: 'main', refresh: true });
    options!.onClose?.(1006, 'fixture disconnect during discovery'); calls.shift()!.resolve(complete); await assert.rejects(reconnected, /connection changed/); assert.equal(gateway.status().modelAuthReady, false);
    options!.onHelloOk?.(hello); const noReasoning = gateway.models(); calls.shift()!.resolve({ models: [{ ...prepared.models[0], reasoning: false }] }); await noReasoning; assert.equal(calls.length, 0, 'an explicit non-reasoning model does not need discovery');
  } finally { await gateway.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});


test('response controls use a separate temporary authority limited to captured settings', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-response-control-')), store = new Store(directory);
  const clients: { options: GatewayClientOptions; calls: { method: string; params: unknown }[] }[] = [];
  const factory = (options: GatewayClientOptions) => { const client = { options, calls: [] as { method: string; params: unknown }[] }; clients.push(client); return { start() {}, async stopAndWait() {}, async request<T>(method: string, params: unknown) { client.calls.push({ method, params }); return { models: [] } as T; } }; };
  const ordinary = new Gateway(store, 'fixture', factory), control = new Gateway(store, 'fixture', factory, 'response-control');
  const hello = (scopes: string[]) => ({ protocol: 4, features: { methods: ['models.list', 'sessions.patch', 'sessions.create', 'config.set', 'chat.send'], events: [] }, auth: { scopes }, policy: {} }) as unknown as HelloOk;
  try {
    await ordinary.configure('ws://127.0.0.1:59999', 'fixture'); clients[0].options.onHelloOk?.(hello(['operator.read', 'operator.write']));
    control.start(); clients[1].options.onHelloOk?.(hello(['operator.read', 'operator.admin']));
    assert.notEqual(clients[0].options.deviceIdentity?.deviceId, clients[1].options.deviceIdentity?.deviceId); assert.deepEqual(clients[0].options.scopes, ['operator.read', 'operator.write']); assert.deepEqual(clients[1].calls, []);
    for (const method of ['sessions.create', 'config.set', 'chat.send']) await assert.rejects(control.request(method, {}), /not exposed/);
    for (const params of [{ key: 'e3:one', thinkingLevel: 'high' }, { key: 'e3:one', expectedSessionId: 'native', model: 'test' }, { key: 'e3:one', expectedSessionId: 'native', model: 'test', thinkingLevel: 'high' }, { key: 'e3:one', expectedSessionId: 'native', thinkingLevel: 'high', permissionMode: 'full' }, { key: 'e3:one', expectedSessionId: 'native', fastMode: true, systemPrompt: 'extra' }]) await assert.rejects(control.request('sessions.patch', params), /captured conversation/);
    const params = { key: 'e3:one', expectedSessionId: 'native', thinkingLevel: null, fastMode: false, label: 'A title', permissionMode: 'read-only' };
    await control.request('sessions.patch', params); assert.deepEqual(clients[1].calls, [{ method: 'sessions.patch', params }]);
    clients[1].options.onHelloOk?.(hello(['operator.read'])); await assert.rejects(control.request('sessions.patch', params), /not granted/);
    await ordinary.configure('ws://127.0.0.1:59998', 'other'); await assert.rejects(control.request('sessions.patch', params), /original Assistant host/);
  } finally { await control.stop(); await ordinary.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
