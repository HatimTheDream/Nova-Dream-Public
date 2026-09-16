import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventFrame } from '@openclaw/gateway-protocol/frame-guards';
import { AssistantApprovals } from '../apps/service/approvals.js';
import { Store } from '../apps/service/store.js';
import type { AccessTransport } from '../apps/service/full-access.js';
import type { Conversation } from '../packages/domain/assistant.js';

async function fixture(run: (f: any) => Promise<void>, nativeKey = 'agent:main:e3:fixture') {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-approvals-')), store = new Store(directory), device = store.session().deviceId;
  const conversation: Conversation = { id: randomUUID(), revision: 1, title: 'Review fixture', projectId: null, archived: false, model: null, thinking: null, createdAt: '', updatedAt: '', connectionGeneration: 'host-one', nativeKey, nativeId: randomUUID(), state: 'ready' };
  const listeners = new Set<(event: EventFrame) => void>();
  const f: any = { store, device, conversation, generation: 'host-one', calls: [], lose: false, failBeforeResolve: false, stops: 0, hold: undefined };
  f.native = { id: randomUUID(), status: 'pending', createdAtMs: 100, expiresAtMs: Date.now() + 60000, presentation: { kind: 'exec', commandText: 'echo harmless-fixture', allowedDecisions: ['allow-once', 'deny'] }, urlPath: '/approve/fixture', environment: 'must-not-be-retained' };
  const control: AccessTransport = {
    status: () => ({ state: 'ready', generation: f.generation, url: 'ws://127.0.0.1:50000', message: 'Fixture', methods: ['approval.get', 'approval.resolve', 'sessions.messages.subscribe'], grantedScopes: ['operator.read', 'operator.approvals'], modelAuthReady: true }),
    start() {}, async stop() { f.stops++; }, models: async () => [], attachmentPolicy: () => ({}), subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async request<T>(method: string, params: any): Promise<T> {
      f.calls.push({ method, params });
      if (method === 'sessions.messages.subscribe') return { subscribed: true, key: conversation.nativeKey, approvalReplay: { sessionKey: 'audience:fixture', approvals: [f.native], updatedAtMs: 200, truncated: false } } as T;
      if (method === 'approval.get') { if (f.failBeforeResolve) throw Error('Disconnected'); return { approval: structuredClone(f.native) } as T; }
      if (method === 'approval.resolve') { await f.hold; f.native = { ...f.native, status: params.decision === 'deny' ? 'denied' : 'allowed', decision: params.decision, resolvedAtMs: 190, reason: 'user' }; if (f.lose) throw Error('Response lost'); return { applied: true, approval: f.native } as T; }
      throw Error(method);
    },
  };
  f.control = control;
  f.service = new AssistantApprovals(store, control, () => [conversation], () => control);
  f.event = (snapshot: any, updatedAtMs = 210, sessionKey = 'audience:fixture') => { for (const fn of listeners) fn({ type: 'event', event: 'session.approval', payload: { sessionKey, updatedAtMs, approval: snapshot } }); };
  f.input = (decision = 'allow-once') => ({ requestId: randomUUID(), epoch: store.epoch, id: f.service.state().items[0].id, expectedRevision: f.service.state().items[0].revision, decision });
  try { await f.service.sync(); await run(f); }
  finally { await f.service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}
test('approval replay is scoped, safe, retained and resolves once to native truth', () => fixture(async f => {
  assert.equal(f.service.state().state, 'ready'); assert.equal(f.service.state().items.length, 1);
  assert.equal(JSON.stringify(f.service.state()).includes('must-not-be-retained'), false);
  f.event({ ...f.native, id: randomUUID() }, 300, 'another-session'); assert.equal(f.service.state().items.length, 1);
  const input = f.input(), result = await f.service.resolve(f.device, input);
  assert.equal(result.snapshot.status, 'allowed'); assert.equal(result.action.state, 'confirmed');
  assert.equal((await f.service.resolve(f.device, input)).snapshot.status, 'allowed');
  assert.equal(f.calls.filter((c: any) => c.method === 'approval.resolve').length, 1);
  f.event({ ...f.native, status: 'pending' }, 900); assert.equal(f.service.state().items[0].snapshot.status, 'allowed');
  await f.service.close(); f.service = new AssistantApprovals(f.store, f.control, () => [f.conversation], () => f.control);
  assert.equal(f.service.state().items[0].snapshot.status, 'allowed');
}));
test('lost decision response stays visible and check confirms without redispatch', () => fixture(async f => {
  f.lose = true; const input = f.input('deny'), result = await f.service.resolve(f.device, input);
  assert.equal(result.action.state, 'unknown'); assert.equal(result.snapshot.status, 'pending');
  await f.service.resolve(f.device, input); assert.equal(f.calls.filter((c: any) => c.method === 'approval.resolve').length, 1);
  const checked = await f.service.check({ requestId: randomUUID(), epoch: f.store.epoch, id: result.id });
  assert.equal(checked.snapshot.status, 'denied'); assert.equal(checked.action.state, 'confirmed');
}));
test('two windows cannot dispatch competing choices and stale views cannot approve changed actions', () => fixture(async f => {
  let release!: () => void; f.hold = new Promise<void>(r => { release = r; }); const old = f.input();
  const pending = f.service.resolve(f.device, old);
  await assert.rejects(f.service.resolve(f.device, { ...old, requestId: randomUUID(), decision: 'deny' }), { code: 'approval_changed' });
  release(); await pending; assert.equal(f.calls.filter((c: any) => c.method === 'approval.resolve').length, 1);
}));
test('unsupported choices, changed presentation, archive and replaced hosts never dispatch', () => fixture(async f => {
  await assert.rejects(f.service.resolve(f.device, f.input('allow-always')), { code: 'approval_choice' });
  f.conversation.archived = true; await assert.rejects(f.service.resolve(f.device, f.input()), { code: 'approval_read_only' }); f.conversation.archived = false;
  f.native.presentation = { ...f.native.presentation, commandText: 'A different action' };
  assert.equal((await f.service.resolve(f.device, f.input())).action.state, 'unknown');
  const current = f.service.state().items[0]; await f.service.check({ requestId: randomUUID(), epoch: f.store.epoch, id: current.id });
  assert.equal(f.service.state().items[0].action, undefined);
  f.generation = 'host-two'; await assert.rejects(f.service.resolve(f.device, { requestId: randomUUID(), epoch: f.store.epoch, id: current.id, expectedRevision: f.service.state().items[0]?.revision ?? 5, decision: 'deny' }), { code: 'approval_host_changed' });
  assert.equal(f.calls.filter((c: any) => c.method === 'approval.resolve').length, 0);
}));
test('native resolution from another reviewer wins and never reports our choice as applied', () => fixture(async f => {
  f.native = { ...f.native, status: 'denied', decision: 'deny', resolvedAtMs: 180, reason: 'user' };
  const result = await f.service.resolve(f.device, f.input());
  assert.equal(result.snapshot.status, 'denied'); assert.match(result.action.message, /different outcome/);
  assert.equal(f.calls.filter((c: any) => c.method === 'approval.resolve').length, 0);
}));

test('retired assignment targets retain their decisions but cannot approve another action',async()=>fixture(async f=>{
 f.conversation.readOnly=true;
 await assert.rejects(f.service.resolve(f.device,f.input()),/no longer active/);
 assert.equal(f.calls.filter((c:any)=>c.method==='approval.resolve').length,0);
},'agent:edition3-native-assignment:e3-assignment-fixture'));

test('expired approval cannot dispatch from a stale screen or another device', () => fixture(async f => {
  f.event({ ...f.native, expiresAtMs: Date.now() - 1 }, 400);
  const before = f.service.state().items[0];
  for (const decision of ['allow-once', 'deny']) await assert.rejects(f.service.resolve(f.device, f.input(decision)), { code: 'approval_expired' });
  assert.deepEqual(f.service.state().items[0], before);
  assert.equal(f.calls.filter((c: any) => c.method === 'approval.resolve').length, 0);
}));

test('expiry during the final native read never sends or repeats a decision', t => fixture(async f => {
  const before = Date.now(), original = f.control.request;
  const clock = t.mock.method(Date, 'now', () => before);
  f.control.request = async (method: string, params: unknown) => {
    const result = await original(method, params);
    if (method === 'approval.get') clock.mock.mockImplementation(() => f.native.expiresAtMs + 1);
    return result;
  };
  const input = f.input(), outcome = await f.service.resolve(f.device, input);
  assert.equal(outcome.snapshot.status, 'pending'); // Only native truth can settle it.
  assert.match(outcome.action.message, /no decision was sent/);
  assert.equal((await f.service.resolve(f.device, input)).action.requestId, input.requestId);
  assert.equal(f.calls.filter((c: any) => c.method === 'approval.resolve').length, 0);
  f.native = { ...f.native, status: 'expired', resolvedAtMs: f.native.expiresAtMs, reason: 'timeout' };
  const final = await f.service.check({ requestId: randomUUID(), epoch: f.store.epoch, id: outcome.id });
  assert.equal(final.snapshot.status, 'expired');
  assert.equal(f.calls.filter((c: any) => c.method === 'approval.resolve').length, 0);
}));

test('plugin review preserves only supplied presentation details and changed inputs require another review', () => fixture(async f => {
  f.native = { ...f.native, presentation: { kind: 'plugin', title: 'Read the selected record', description: 'Only this saved record will be read.', toolName: 'fixture__read', detail: 'Record: QA sample\nMode: read only', allowedDecisions: ['allow-once', 'deny'], severity: 'info' }, arguments: { credential: 'private-fixture-only' } };
  f.event(f.native, 400);
  assert.equal(f.service.state().items[0].snapshot.presentation.detail, f.native.presentation.detail);
  assert.equal(JSON.stringify(f.service.state()).includes('private-fixture-only'), false);
  const input = f.input(); f.native.presentation.detail = 'Record: a different record';
  const outcome = await f.service.resolve(f.device, input);
  assert.equal(outcome.action.state, 'unknown');
  assert.equal(f.calls.filter((c: any) => c.method === 'approval.resolve').length, 0);
}));
