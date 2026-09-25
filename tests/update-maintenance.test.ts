import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GatewayClientOptions } from '@openclaw/gateway-client';
import type { HelloOk } from '@openclaw/gateway-protocol/frame-guards';
import { Store } from '../apps/service/store.js';
import { Gateway } from '../apps/service/gateway.js';
import { Accounts } from '../apps/service/accounts.js';
import { Providers, accountCapabilities, accountScopes } from '../apps/service/providers.js';
import { maintenanceGatewayKind, updateMaintenanceBlockers } from '../apps/service/update-maintenance.js';
import { AssignmentService } from '../apps/service/assignments.js';
import { WorkerTransport } from './fixtures/assignment-worker.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import { GitHubConnection } from '../apps/service/github.js';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; }
async function fixture(run: (store: Store, directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-update-maintenance-')), store = new Store(directory);
  try { await run(store, directory); } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('maintenance drains parallel native calls without replay, while reads and cancellation stay available', () => fixture(async store => {
  let client!: GatewayClientOptions;
  const pending = [deferred<unknown>(), deferred<unknown>()], sent: string[] = [];
  const gateway = new Gateway(store, 'fixture', options => {
    client = options;
    return { start() {}, async stopAndWait() {}, async request<T>(method: string): Promise<T> {
      if (method === 'models.list') return { models: [] } as T;
      sent.push(method);
      if (method === 'chat.send') return await pending[sent.filter(value => value === method).length - 1].promise as T;
      return { confirmed: true } as T;
    } };
  });
  try {
    await gateway.configure('ws://127.0.0.1:59999', 'fixture');
    client.onHelloOk?.({ protocol: 4, features: { methods: ['models.list', 'chat.send', 'chat.history', 'chat.abort', 'agent.wait'], events: [] }, auth: { scopes: ['operator.read', 'operator.write'] }, policy: {} } as unknown as HelloOk);
    const first = gateway.request('chat.send', {}), second = gateway.request('chat.send', {});
    assert.deepEqual(store.updateEffectsInFlight(), { 'native-requests': 2 });
    store.setUpdateMaintenanceHeld(true);
    await assert.rejects(gateway.request('chat.send', {}), { code: 'update_maintenance' });
    await gateway.request('chat.history', {}); await gateway.request('agent.wait', {}); await gateway.request('chat.abort', {});
    pending[0].resolve({ runId: 'original-one' }); assert.deepEqual(await first, { runId: 'original-one' });
    assert.deepEqual(store.updateEffectsInFlight(), { 'native-requests': 1 });
    const rejected = assert.rejects(second, /unconfirmed/); pending[1].reject(new Error('unconfirmed')); await rejected;
    assert.deepEqual(store.updateEffectsInFlight(), {});
    assert.equal(sent.filter(method => method === 'chat.send').length, 2);
    assert.equal(store.recoveryEffectsPaused, false, 'Update admission does not activate recovery mode.');
    store.setUpdateMaintenanceHeld(false); assert.doesNotThrow(() => store.assertUpdateAdmission());
  } finally { await gateway.stop(); }
}));

test('provider write admission checks the final request while accepted parallel results can settle', () => fixture(async store => {
  const pending = [deferred<unknown>(), deferred<unknown>()], started = deferred<void>(), methods: string[] = [];
  class ProviderFixture extends Providers {
    override mailRequest() { return async (_path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'; methods.push(method);
      if (method === 'GET') return { observed: true };
      const index = methods.filter(value => value === 'POST').length - 1;
      if (index === 1) started.resolve();
      return pending[index].promise;
    }; }
  }
  const generation = randomUUID(), id = 'fixture-account', scopes = accountScopes('google', ['mailSend']);
  store.internalWrite('accounts:item:' + id, { id, provider: 'google', subject: 'fixture', generation, state: 'connected', revision: 1, scopes, capabilities: accountCapabilities('google', scopes) });
  store.internalWrite('accounts:credential:' + id, { generation, configuration: { provider: 'google', clientId: 'fixture' }, tokens: { accessToken: 'fixture', expiresAt: Date.now() + 3600000 } });
  const accounts = new Accounts(store, new ProviderFixture());
  const operation = (method: string) => accounts.mailOperation(id, generation, ['mailRead'], new AbortController().signal, async (_account, request, check) => { check(); return request('/fixture', { method }); });
  try {
    const first = operation('POST'), second = operation('POST'); await started.promise;
    store.setUpdateMaintenanceHeld(true);
    assert.deepEqual(store.updateEffectsInFlight(), { 'provider-writes': 2 });
    await assert.rejects(operation('POST'), { code: 'update_maintenance' });
    assert.deepEqual(await operation('GET'), { observed: true });
    pending[0].resolve({ accepted: 'one' }); assert.deepEqual(await first, { accepted: 'one' });
    assert.deepEqual(store.updateEffectsInFlight(), { 'provider-writes': 1 });
    pending[1].resolve({ accepted: 'two' }); assert.deepEqual(await second, { accepted: 'two' });
    assert.deepEqual(store.updateEffectsInFlight(), {});
    assert.equal(methods.filter(method => method === 'POST').length, 2);
  } finally { await accounts.close(); }
}));

test('an assignment held during asynchronous preflight never crosses its native dispatch boundary', () => fixture(async (store, directory) => {
  const hold = deferred<void>(), reached = deferred<void>();
  class HeldWorker extends WorkerTransport {
    override async request<T>(method: string, params: unknown): Promise<T> {
      if (method === 'e3.assignments.capabilities') { reached.resolve(); await hold.promise; }
      return super.request<T>(method, params);
    }
  }
  const gateway = new HeldWorker(directory, store.epoch), service = new AssignmentService(store, gateway), device = store.session().deviceId;
  const create = (kind: any, payload: any) => store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind, entityId: kind + ':' + randomUUID(), expectedRevision: 0, payload });
  const agent = create('agent', { ...blankRecord('agent', 'UTC'), name: 'Reviewer', position: 'Editor' });
  const plan = create('assignment', { ...blankRecord('assignment', 'UTC'), title: 'Review', brief: 'Read only', agentId: agent.id, agentRevision: agent.revision, maxMinutes: 1 });
  try {
    const attempt = service.start(device, { requestId: randomUUID(), epoch: store.epoch, assignmentId: plan.id, revision: plan.revision, projectRevision: null });
    await reached.promise; store.setUpdateMaintenanceHeld(true); hold.resolve();
    for (let i = 0; i < 50 && service.detail(attempt.id).attempt.state === 'prepared'; i++) await new Promise(resolve => setTimeout(resolve, 2));
    const result = service.detail(attempt.id).attempt;
    assert.equal(result.state, 'failed'); assert.equal(result.runId, undefined);
    assert.equal(gateway.nativeCalls.length, 0);
  } finally { hold.resolve(); await service.close(); gateway.stopJournal?.(); }
}));

test('GitHub maintenance tracks the entire accepted response and still allows status reads', () => fixture(async store => {
  const response = deferred<Response>(), reached = deferred<void>(), methods: string[] = [];
  const github = new GitHubConnection(store, async () => Buffer.alloc(0), async (_url, init) => {
    const method = init?.method ?? 'GET'; methods.push(method);
    if (method === 'POST') { reached.resolve(); return response.promise; }
    return new Response(JSON.stringify({ observed: true }));
  });
  try {
    const accepted = github.api('/repos/fixture/repo/pulls', { method: 'POST', token: 'fixture' });
    await reached.promise; store.setUpdateMaintenanceHeld(true);
    assert.deepEqual(store.updateEffectsInFlight(), { 'github-writes': 1 });
    await assert.rejects(github.api('/repos/fixture/repo/pulls', { method: 'POST', token: 'fixture' }), { code: 'update_maintenance' });
    assert.deepEqual(await github.api('/repos/fixture/repo/pulls', { token: 'fixture' }), { observed: true });
    response.resolve(new Response(JSON.stringify({ number: 12 })));
    assert.deepEqual(await accepted, { number: 12 });
    assert.deepEqual(store.updateEffectsInFlight(), {}); assert.deepEqual(methods, ['POST', 'GET']);
  } finally { await github.close(); }
}));

test('blockers include unknown acknowledged work, unsaved voice finals, dictation cleanup and all devices', () => fixture(async store => {
  store.internalWrite('assignments:summary:old', { state: 'unknown', unresolvedReview: { acknowledged: true } });
  store.internalWrite('voice:attempt:old', { state: 'ended', entries: [{ saved: false }], consults: [] });
  store.internalWrite('dictation:other-device', { state: 'failed', cleanupPending: true });
  store.internalWrite('accounts:attempt:other-device', { state: 'exchanging', deviceId: 'other' });
  store.internalWrite('mail:triage:items:plan:item', { outcome: { state: 'applied', undo: 'uncertain' } });
  store.internalWrite('backup:job:other-device', { state: 'working', deviceId: 'other' });
  store.internalWrite('hub:meeting:current', { state: 'running', turns: [] });
  const kinds = updateMaintenanceBlockers(store, { 'backup-upload': true, 'workspace-switch': 1 }).map(row => row.kind);
  for (const kind of ['assignments', 'voice', 'dictation', 'sign-in', 'mail-triage', 'backup', 'backup-upload', 'workspace-switch', 'meetings']) assert.ok(kinds.includes(kind), kind);
  assert.equal(store.internalRead<{ state: string }>('assignments:summary:old')?.state, 'unknown');
  assert.equal(maintenanceGatewayKind('question.resolve', { cancel: true }), 'settling');
  assert.equal(maintenanceGatewayKind('question.resolve', { answers: [] }), 'effect');
  assert.equal(maintenanceGatewayKind('approval.resolve', { decision: 'deny' }), 'settling');
  assert.equal(maintenanceGatewayKind('approval.resolve', { decision: 'allow-once' }), 'effect');
  assert.equal(maintenanceGatewayKind('unknown.future.method', {}), 'effect');
}));

function retainedHistory(store: Store) {
  const conversation = { id: randomUUID(), state: 'ready', nativeKey: 'agent:main:fixture', nativeId: randomUUID(), connectionGeneration: randomUUID() };
  const operation = { id: randomUUID(), requestId: randomUUID(), epoch: store.epoch, conversationId: conversation.id, nativeKey: conversation.nativeKey, nativeId: conversation.nativeId, nativeRunId: randomUUID(), connectionGeneration: conversation.connectionGeneration, state: 'unknown', input: 'Kept input', context: { digest: 'kept-context' }, error: 'Outcome unconfirmed.' };
  const meeting = { id: randomUUID(), epoch: randomUUID(), state: 'ended', turns: [{ planId: 'assignment:old-meeting', state: 'unknown' }] };
  const mail = { review: { id: randomUUID(), epoch: randomUUID(), state: 'uncertain', mode: 'draft', phase: 'create' }, attempted: 'create', completed: [] };
  const rows = { ['assistant:conversation:' + conversation.id]: conversation, ['assistant:operation:' + operation.id]: operation, ['hub:meeting:' + meeting.id]: meeting, ['mail:delivery:head:' + mail.review.id]: mail };
  for (const [key, value] of Object.entries(rows)) store.internalWrite(key, value);
  return { conversation, operation, meeting, mail, rows };
}

test('retained uncertainty can reach native qualification without changing any saved outcome', () => fixture(async store => {
  const { rows } = retainedHistory(store);
  const before = Object.keys(rows).map(key => JSON.stringify(store.internalRead(key)));
  const original = store.internalWrite;
  store.internalWrite = (() => { throw Error('Readiness must not write saved records.'); }) as typeof store.internalWrite;
  try {
    assert.deepEqual(updateMaintenanceBlockers(store), []);
    store.setUpdateMaintenanceHeld(true);
    assert.deepEqual(updateMaintenanceBlockers(store), []);
    assert.deepEqual(Object.keys(rows).map(key => JSON.stringify(store.internalRead(key))), before);
  } finally { store.internalWrite = original; }
}));

test('active, unbound, cancelling and steering Assistant work still blocks independently of age', () => fixture(async store => {
  const { operation, conversation } = retainedHistory(store), key = 'assistant:operation:' + operation.id;
  for (const patch of [{ state: 'prepared' }, { state: 'dispatching' }, { state: 'accepted' }, { state: 'running' }, { nativeRunId: null }, { nativeId: 'different' }, { connectionGeneration: 'different' }, { epoch: randomUUID() }, { cancelRequested: true }, { steerTarget: 'original' }]) {
    store.internalWrite(key, { ...operation, createdAt: '2000-01-01T00:00:00Z', ...patch });
    assert.ok(updateMaintenanceBlockers(store).some(row => row.kind === 'assistant'), JSON.stringify(patch));
  }
  store.internalWrite(key, operation);
  for (const patch of [{ state: 'unknown' }, { pendingSettings: { requestId: randomUUID() } }, { pendingResume: { requestId: randomUUID() } }]) {
    store.internalWrite('assistant:conversation:' + conversation.id, { ...conversation, ...patch });
    assert.ok(updateMaintenanceBlockers(store).some(row => row.kind === 'assistant-context'));
  }
}));

test('ended meeting history never hides a current or linked uncertain assignment', () => fixture(async store => {
  const { meeting } = retainedHistory(store), key = 'hub:meeting:' + meeting.id;
  for (const state of ['unknown', 'running', 'dispatching', 'stopping']) {
    store.internalWrite(key, { ...meeting, epoch: store.epoch, turns: [{ ...meeting.turns[0], state }] });
    assert.ok(updateMaintenanceBlockers(store).some(row => row.kind === 'meetings'), state);
  }
  store.internalWrite(key, meeting);
  store.internalWrite('assignments:summary:linked', { id: 'linked', assignmentId: meeting.turns[0].planId, state: 'unknown', unresolvedReview: { acknowledged: true } });
  const kinds = updateMaintenanceBlockers(store).map(row => row.kind);
  assert.ok(kinds.includes('meetings')); assert.ok(kinds.includes('assignments'));
}));

test('only a parked older-epoch draft creation qualifies, never live or multi-stage mail effects', () => fixture(async store => {
  const { mail } = retainedHistory(store), key = 'mail:delivery:head:' + mail.review.id;
  for (const patch of [{ epoch: store.epoch }, { mode: 'send' }, { state: 'running' }, { phase: 'update-draft' }, { providerDraftId: 'provider-draft' }, { providerMessageId: 'provider-message' }]) {
    store.internalWrite(key, { ...mail, review: { ...mail.review, ...patch } });
    assert.ok(updateMaintenanceBlockers(store).some(row => row.kind === 'mail-delivery'), JSON.stringify(patch));
  }
  for (const patch of [{ attempted: 'send' }, { completed: ['create'] }, { files: { cursor: 0, pending: true } }]) {
    store.internalWrite(key, { ...mail, ...patch });
    assert.ok(updateMaintenanceBlockers(store).some(row => row.kind === 'mail-delivery'), JSON.stringify(patch));
  }
}));

test('automatic sources and accepted effects still block alongside qualified historical records', () => fixture(async store => {
  retainedHistory(store);
  store.internalWrite('assistant:queue:future', { state: 'paused', automatic: true });
  store.internalWrite('assistant:plan:future', { kind: 'research', state: 'ready', autoStartAt: '2099-01-01T00:00:00Z', autoStartRequestId: randomUUID() });
  store.internalWrite('agent-routines:item:future', { value: { enabled: true }, nextAt: Date.parse('2099-01-01T00:00:00Z') });
  store.internalWrite('accounts:item:contacts', { id: 'contacts', generation: 'current', state: 'connected', capabilities: { contactsRead: true } });
  store.internalWrite('crm:address-link:automatic', { accountId: 'contacts', generation: 'current', mode: 'both', state: 'synced' });
  store.internalWrite('crm:address-link:uncertain', { mode: 'read', state: 'unknown', intent: { requestId: 'original' } });
  const result = deferred<void>(), reached = deferred<void>();
  const effect = store.trackUpdateEffect('provider-writes', async () => { reached.resolve(); await result.promise; });
  await reached.promise;
  try {
    store.setUpdateMaintenanceHeld(true);
    const kinds = updateMaintenanceBlockers(store).map(row => row.kind);
    for (const kind of ['automatic-queue', 'automatic-research', 'agent-routines', 'automatic-contacts', 'contact-write', 'provider-writes']) assert.ok(kinds.includes(kind), kind);
    assert.equal(kinds.includes('assistant'), false);
  } finally { result.resolve(); await effect; }
}));
