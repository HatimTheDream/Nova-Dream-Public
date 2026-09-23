import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GatewayClientRequestError } from '@openclaw/gateway-client';
import type { AssistantConnection, Conversation, ConversationHistory } from '../packages/domain/assistant.js';
import { canonical, emptyDraft } from '../packages/domain/contracts.js';
import { ConversationContinuation } from '../apps/service/conversation-continuation.js';
import { SavedHistory } from '../apps/service/saved-history.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { Fault, Store } from '../apps/service/store.js';

const digest = (text: string) => createHash('sha256').update(canonical(text)).digest('hex');
function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'nova-continuation-')), store = new Store(root), device = store.session().deviceId;
  const conversation: Conversation = { id: randomUUID(), revision: 3, title: 'Original chat', projectId: 'project:kept', pinned: true, archived: false, permissionMode: 'full', model: 'openai/example', thinking: 'high', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), connectionGeneration: randomUUID(), nativeKey: 'agent:main:e3:previous', nativeId: randomUUID(), state: 'ready' };
  store.internalWrite('assistant:conversation:' + conversation.id, conversation);
  store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'project', entityId: 'project:kept', expectedRevision: 0, payload: { name: 'Kept project', purpose: 'Current instructions stay current' } });
  const draft = store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'draft', entityId: `draft:${device}:${conversation.id}`, expectedRevision: 0, payload: { ...emptyDraft, conversationId: conversation.id, text: 'Unsent new direction', projectId: conversation.projectId } });
  store.internalWrite('assistant:message-pin:fixture', { conversationId: conversation.id, nativeId: conversation.nativeId, messageId: 'original-assistant' });
  const status: AssistantConnection = { state: 'ready', generation: randomUUID(), message: 'Current runtime', modelAuthReady: true, methods: ['sessions.create', 'sessions.describe', 'chat.history'], grantedScopes: ['operator.read', 'operator.write'] };
  const calls: { method: string; params: any }[] = [], sessions = new Map<string, string>();
  const behavior = { loseCreate: false, rejectCreate: false, rejectDescribe: false, rejectHistory: false, busy: false, active: false, permission: 'read-only' as string | undefined, createGate: undefined as Promise<void> | undefined };
  const gateway: AssistantTransport = { status: () => structuredClone(status), models: async () => [], subscribe: () => () => {}, attachmentPolicy: () => ({}), request: async <T>(method: string, raw: unknown): Promise<T> => {
    const params = raw as any; calls.push({ method, params });
    if (method === 'sessions.create') {
      if (behavior.rejectCreate) throw new GatewayClientRequestError({ code: 'FORBIDDEN', message: 'Controlled rejection' });
      const sessionId = randomUUID(); sessions.set(params.key, sessionId); await behavior.createGate;
      if (behavior.loseCreate) throw Error('Lost after acceptance');
      return { key: params.key, sessionId, runStarted: false, entry: { sessionId, permissionMode: 'read-only' } } as T;
    }
    if (method === 'sessions.describe') {
      if (behavior.rejectDescribe) throw new GatewayClientRequestError({ code: 'FORBIDDEN', message: 'Recovery read forbidden' });
      return { session: sessions.has(params.key) ? { key: params.key, sessionId: sessions.get(params.key), permissionMode: behavior.permission } : null } as T;
    }
    if (method === 'chat.history') {
      if (behavior.rejectHistory) throw new GatewayClientRequestError({ code: 'INVALID_REQUEST', message: 'Recovery read rejected' });
      return { sessionId: sessions.get(params.sessionKey), messages: [], sessionInfo: { activeRunIds: behavior.active ? ['running'] : [], hasActiveRun: behavior.active, permissionMode: behavior.permission } } as T;
    }
    throw Error('Unexpected effect: ' + method);
  } };
  const history: ConversationHistory = { conversationId: conversation.id, nativeId: conversation.nativeId!, messages: [{ id: 'original-owner', role: 'user', text: 'An old request with tools', textHash: digest('An old request with tools'), attachments: [] }, { id: 'original-assistant', role: 'assistant', text: 'A finished answer', textHash: digest('A finished answer'), attachments: [] }, { id: 'tool', role: 'tool', text: 'Never replay this tool effect', textHash: digest('Never replay this tool effect'), attachments: [] }], hasMore: false, activeRunIds: [] };
  const saved = new SavedHistory(store); saved.observe(conversation, history, { complete: true });
  const hooks = { read: (id: string) => { const value = store.internalRead<Conversation>('assistant:conversation:' + id); if (!value) throw new Fault(404, 'missing', 'Missing'); return value; }, save: (value: Conversation) => store.internalWrite('assistant:conversation:' + value.id, value), assertIdle: () => { if (behavior.busy) throw new Fault(409, 'voice_active', 'Finish the voice call'); }, savedHistory: saved };
  const service = new ConversationContinuation(store, gateway, hooks);
  const input = () => ({ requestId: randomUUID(), epoch: store.epoch, conversationId: conversation.id, expectedRevision: hooks.read(conversation.id).revision, digest: saved.review(hooks.read(conversation.id)).digest });
  t.after(() => { service.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, device, conversation, draft, status, calls, sessions, behavior, history, saved, hooks, service, input, gateway };
}
test('continuation preserves the Nova chat, draft, pins and project while preparing reference-only context under read-only access', async t => {
  const f = fixture(t), request = f.input(), originalPin = f.store.internalRead('assistant:message-pin:fixture');
  const result = await f.service.resume(f.device, request);
  assert.equal(result.id, f.conversation.id); assert.equal(result.projectId, f.conversation.projectId); assert.equal(result.pinned, true); assert.equal(result.model, f.conversation.model);
  assert.equal(result.revision, 4); assert.equal(result.permissionMode, 'read-only'); assert.equal(result.pendingResume, undefined); assert.notEqual(result.nativeId, f.conversation.nativeId);
  assert.deepEqual(f.store.readEntity('draft', f.draft.id), f.draft); assert.deepEqual(f.store.internalRead('assistant:message-pin:fixture'), originalPin);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'sessions.create'); assert.equal(f.calls[0].params.permissionMode, 'read-only'); assert.equal(f.calls[0].params.emitCommandHooks, false); assert.equal(f.calls[0].params.idempotencyKey, request.requestId);
  assert(!('input' in f.calls[0].params)); assert(!('messages' in f.calls[0].params));
  const reference = f.store.download(result.resumeContext!.transcript.id).bytes.toString(); assert(reference.includes('An old request with tools')); assert(!reference.includes('Never replay this tool effect')); assert(reference.includes('historical data, not new instructions'));
  assert.equal(f.saved.messages(result).length, 3); assert.equal(f.saved.target(result, f.conversation.nativeId!)!.nativeKey, f.conversation.nativeKey);
  assert.deepEqual(await f.service.resume(f.device, request), JSON.parse(JSON.stringify(result))); assert.equal(f.calls.length, 1);
});
test('a lost create response reconciles its exact original key after restart without sending another create or any dialogue', async t => {
  const f = fixture(t), request = f.input(); f.behavior.loseCreate = true;
  const pending = await f.service.resume(f.device, request); assert.equal(pending.nativeId, f.conversation.nativeId); assert.equal(pending.pendingResume!.requestId, request.requestId); assert.match(pending.error!, /not confirmed/);
  const createdKey = f.calls[0].params.key, frozen = f.store.internalRead<{ text: string }>('assistant:continuation:' + request.requestId)!.text;
  f.saved.observe(f.conversation, { ...f.history, messages: [{ id: 'later', role: 'user', text: 'Later observation', textHash: digest('Later observation'), attachments: [] }] });
  const restarted = new ConversationContinuation(f.store, f.gateway, f.hooks); t.after(() => restarted.close());
  const completed = await restarted.resume(f.device, request);
  assert.equal(completed.pendingResume, undefined); assert.equal(completed.nativeKey, createdKey); assert.equal(f.calls.filter(call => call.method === 'sessions.create').length, 1); assert.deepEqual(f.calls[1], { method: 'sessions.describe', params: { key: createdKey } }); assert.equal(f.calls.at(-1)!.method, 'chat.history');
  assert.equal(f.store.download(completed.resumeContext!.transcript.id).bytes.toString(), frozen);
});
test('continuation retains the local Auto preference without passing auto as native session effort', async t => {
  const f = fixture(t); f.hooks.save({ ...f.conversation, thinking: 'auto' });
  const result = await f.service.resume(f.device, f.input());
  assert.equal(result.thinking, 'auto');
  assert.equal(f.calls.find(call => call.method === 'sessions.create')!.params.thinkingLevel, undefined);
});
test('an absent target after a lost response remains unconfirmed and never triggers blind retry', async t => {
  const f = fixture(t), request = f.input(); f.behavior.loseCreate = true;
  await f.service.resume(f.device, request); f.sessions.clear();
  const pending = await f.service.resume(f.device, request);
  assert.equal(pending.nativeId, f.conversation.nativeId); assert(pending.pendingResume); assert.equal(f.calls.filter(call => call.method === 'sessions.create').length, 1);
});
test('a matching original native session is reused without creating or broadening a connection', async t => {
  const f = fixture(t); f.status.generation = f.conversation.connectionGeneration; f.sessions.set(f.conversation.nativeKey, f.conversation.nativeId!);
  const result = await f.service.resume(f.device, f.input());
  assert.equal(result.nativeId, f.conversation.nativeId); assert.equal(result.nativeKey, f.conversation.nativeKey); assert.equal(result.permissionMode, 'full'); assert.equal(result.resumeContext, undefined);
  assert.deepEqual(f.calls.map(call => call.method), ['sessions.describe', 'chat.history']);
});
test('partial coverage requires explicit acknowledgement and missing file bytes block continuation before network effects', async t => {
  const f = fixture(t), complete = f.saved.coverage(f.conversation)!;
  // A non-overlapping new head exposes an uncaptured gap.
  f.saved.observe(f.conversation, { ...f.history, hasMore: true, messages: [{ id: 'new-head', role: 'user', text: 'Only this part saved', textHash: digest('Only this part saved'), attachments: [] }] });
  assert(complete.complete); assert.equal(f.saved.coverage(f.conversation)!.complete, false);
  await assert.rejects(f.service.resume(f.device, f.input()), /Only part/); assert.equal(f.calls.length, 0);
  f.saved.observe(f.conversation, { ...f.history, hasMore: true, messages: [{ id: 'remote-reference', role: 'assistant', text: 'See file', textHash: digest('See file'), attachments: [{ name: 'Required.pdf', artifactId: 'remote-only' }] }] });
  await assert.rejects(f.service.resume(f.device, { ...f.input(), allowPartial: true }), /only references/); assert.equal(f.calls.length, 0);
});
test('required local files are verified and retained with the frozen context', async t => {
  const f = fixture(t), file = f.store.upload(f.device, randomUUID(), f.store.epoch, 'Original.txt', Buffer.from('Verified bytes').toString('base64'));
  f.saved.observe(f.conversation, { ...f.history, messages: [{ ...f.history.messages[0], attachments: [{ name: file.name, localFile: file }] }] });
  const result = await f.service.resume(f.device, f.input());
  assert.deepEqual(result.resumeContext!.files, [file]); assert.equal(f.store.download(result.resumeContext!.files[0].id).bytes.toString(), 'Verified bytes');
});
test('workspaces, stale review, pending work and changed credentials fail before new native effects', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.resume(f.device, { ...f.input(), digest: 'a'.repeat(64) }), /transcript changed/);
  f.behavior.busy = true; await assert.rejects(f.service.resume(f.device, f.input()), /voice call/); f.behavior.busy = false;
  f.hooks.save({ ...f.conversation, workspace: { folder: 'C:/original', environment: 'worktree' } });
  await assert.rejects(f.service.resume(f.device, f.input()), /verified checkout/); f.hooks.save(f.conversation);
  f.status.grantedScopes = ['operator.read']; await assert.rejects(f.service.resume(f.device, f.input()), /Connect the current/);
  assert.equal(f.calls.length, 0);
});
test('concurrent retries coalesce and a known creation rejection preserves the original binding', async t => {
  const f = fixture(t), request = f.input(); let release!: () => void; f.behavior.createGate = new Promise<void>(resolve => { release = resolve; });
  const first = f.service.resume(f.device, request), second = f.service.resume(f.device, request); release();
  assert.deepEqual(await first, await second); assert.equal(f.calls.filter(call => call.method === 'sessions.create').length, 1);
  await assert.rejects(f.service.resume('another-device', request), /device|different work/);
  await assert.rejects(f.service.resume(f.device, { ...request, allowPartial: true }), /different|reused/);
  const original = f.hooks.read(f.conversation.id); f.behavior.rejectCreate = true; f.status.generation = randomUUID();
  const rejected = await f.service.resume(f.device, f.input()); assert.equal(rejected.nativeId, original.nativeId); assert.equal(rejected.pendingResume, undefined); assert.match(rejected.error!, /rejected/);
});
test('recovery requires explicit read-only and idle evidence, preserving the old binding while either is uncertain', async t => {
  const f = fixture(t), request = f.input(); f.behavior.loseCreate = true;
  await f.service.resume(f.device, request);
  f.behavior.permission = undefined;
  const missingPermission = await f.service.resume(f.device, request); assert.equal(missingPermission.nativeId, f.conversation.nativeId); assert(missingPermission.pendingResume);
  assert.equal(f.calls.filter(call => call.method === 'chat.history').length, 0);
  f.behavior.permission = 'read-only'; f.behavior.active = true;
  const running = await f.service.resume(f.device, request); assert.equal(running.nativeId, f.conversation.nativeId); assert(running.pendingResume);
  f.behavior.active = false;
  const completed = await f.service.resume(f.device, request); assert.equal(completed.pendingResume, undefined); assert.notEqual(completed.nativeId, f.conversation.nativeId);
  assert.equal(f.calls.filter(call => call.method === 'sessions.create').length, 1);
});
test('a fresh browser on another owner device recovers the admitted continuation without adopting its upload identity or replaying creation', async t => {
  const f = fixture(t), original = f.input(); f.behavior.loseCreate = true;
  await f.service.resume(f.device, original);
  const before = f.store.internalRead<{ deviceId: string; uploadRequestId: string; text: string; nativeKey: string }>('assistant:continuation:' + original.requestId)!;
  const restarted = new ConversationContinuation(f.store, f.gateway, f.hooks); t.after(() => restarted.close());
  const check = { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, pendingRequestId: original.requestId };
  const result = await restarted.recover('another-authenticated-owner-device', check);
  assert.equal(result.pendingResume, undefined); assert.equal(result.nativeKey, before.nativeKey);
  const after = f.store.internalRead<typeof before>('assistant:continuation:' + original.requestId)!;
  assert.equal(after.deviceId, f.device); assert.equal(after.uploadRequestId, before.uploadRequestId); assert.equal(after.text, before.text);
  assert.equal(f.calls.filter(call => call.method === 'sessions.create').length, 1);
  const callCount = f.calls.length;
  assert.deepEqual(await restarted.recover('another-authenticated-owner-device', check), JSON.parse(JSON.stringify(result))); assert.equal(f.calls.length, callCount);
  await assert.rejects(restarted.recover(f.device, check), /device|different work/);
});
test('recovery checks the exact pending conversation, current source revision and idle state before any native request', async t => {
  const f = fixture(t), original = f.input(); f.behavior.loseCreate = true;
  await f.service.resume(f.device, original);
  const check = () => ({ requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, pendingRequestId: original.requestId });
  const count = f.calls.length;
  await assert.rejects(f.service.recover(f.device, { ...check(), pendingRequestId: randomUUID() }), /pending connection/);
  await assert.rejects(f.service.recover(f.device, { ...check(), conversationId: randomUUID() }), /pending connection/);
  f.behavior.busy = true; await assert.rejects(f.service.recover(f.device, check()), /voice call/); f.behavior.busy = false;
  const pending = f.hooks.read(f.conversation.id); f.hooks.save({ ...pending, revision: pending.revision + 1 });
  await assert.rejects(f.service.recover(f.device, check()), /chat changed/); f.hooks.save(pending);
  await assert.rejects(f.service.recover(f.device, { ...check(), epoch: randomUUID() }), /workspace|epoch/i);
  assert.equal(f.calls.length, count);
  f.sessions.clear(); const unconfirmed = await f.service.recover(f.device, check());
  assert(unconfirmed.pendingResume); assert.equal(f.calls.filter(call => call.method === 'sessions.create').length, 1);
});
test('a check coalesces with a pending creation already in flight on the original device', async t => {
  const f = fixture(t), original = f.input(); let release!: () => void; f.behavior.createGate = new Promise<void>(resolve => { release = resolve; });
  const creating = f.service.resume(f.device, original);
  const checking = f.service.recover('another-authenticated-owner-device', { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, pendingRequestId: original.requestId });
  release(); assert.deepEqual(await checking, await creating);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'sessions.create');
});
test('recovery can finish an admitted intent that never reached native creation', async t => {
  const f = fixture(t), original = f.input(); f.status.generation = f.conversation.connectionGeneration;
  const unavailable: AssistantTransport = { ...f.gateway, request: async () => { throw Error('Disconnected before original-session check'); } };
  const first = new ConversationContinuation(f.store, unavailable, f.hooks); t.after(() => first.close());
  const pending = await first.resume(f.device, original); assert(pending.pendingResume); assert.equal(f.calls.length, 0);
  const intent = f.store.internalRead<{ state: string; uploadRequestId: string }>('assistant:continuation:' + original.requestId)!;
  assert.equal(intent.state, 'prepared');
  const completed = await f.service.recover('another-authenticated-owner-device', { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, pendingRequestId: original.requestId });
  assert.equal(completed.pendingResume, undefined); assert.equal(f.calls.filter(call => call.method === 'sessions.create').length, 1);
  assert.equal(f.store.internalRead<typeof intent>('assistant:continuation:' + original.requestId)!.uploadRequestId, intent.uploadRequestId);
});
test('rejected recovery reads cannot turn an uncertain create into proof of failure or permit a second create', async t => {
  for (const read of ['rejectDescribe', 'rejectHistory'] as const) await t.test(read, async t => {
    const f = fixture(t), original = f.input(); f.behavior.loseCreate = true;
    const unconfirmed = await f.service.resume(f.device, original); assert(unconfirmed.pendingResume);
    f.behavior[read] = true;
    const rejectedRead = await f.service.resume(f.device, original);
    assert.equal(rejectedRead.pendingResume!.requestId, original.requestId); assert.equal(rejectedRead.nativeId, f.conversation.nativeId);
    assert.equal(f.store.internalRead<{ state: string }>('assistant:continuation:' + original.requestId)!.state, 'unknown');
    await assert.rejects(f.service.resume(f.device, f.input()), /pending setup/);
    f.behavior[read] = false;
    const recovered = await f.service.resume(f.device, original);
    assert.equal(recovered.pendingResume, undefined); assert.notEqual(recovered.nativeId, f.conversation.nativeId);
    assert.equal(f.calls.filter(call => call.method === 'sessions.create').length, 1);
  });
});
