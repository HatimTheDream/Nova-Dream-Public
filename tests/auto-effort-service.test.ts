import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventFrame } from '@openclaw/gateway-protocol/frame-guards';
import type { AssistantConnection, AssistantModel, AssistantOperation, Conversation } from '../packages/domain/assistant.js';
import type { WorkMode } from '../packages/domain/work-mode.js';
import { emptyDraft } from '../packages/domain/contracts.js';
import { AssistantService } from '../apps/service/assistant.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { Store } from '../apps/service/store.js';

async function fixture(t: import('node:test').TestContext, thinking: string | null = 'auto') {
  const directory = mkdtempSync(join(tmpdir(), 'nova-auto-effort-')), store = new Store(directory), device = store.session().deviceId;
  const generation = randomUUID(), sessions = new Map<string, string>(), listeners = new Set<(event: EventFrame) => void>();
  const calls: { method: string; params: any }[] = [];
  const behavior = { loseSend: false, loseEdit: false, failCatalog: false, activeRun: '' };
  let catalog: AssistantModel[] = [{ id: 'test/model', provider: 'test', name: 'Test', isDefault: true, available: true, reasoning: ['low', 'medium', 'high'] }];
  let nativeThinking: string | null = thinking === 'auto' ? null : thinking;
  const gateway: AssistantTransport = {
    status: (): AssistantConnection => ({ state: 'ready', generation, message: 'Isolated fixture', grantedScopes: ['operator.read', 'operator.write'], methods: [], modelAuthReady: true }),
    models: async () => { calls.push({ method: 'models', params: {} }); if (behavior.failCatalog) throw Error('Catalog unavailable'); return catalog; },
    attachmentPolicy: () => ({}), subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    request: async <T>(method: string, raw: unknown): Promise<T> => {
      const params = raw as any; calls.push({ method, params });
      if (method === 'sessions.create') { const sessionId = randomUUID(); sessions.set(params.key, sessionId); return { key: params.key, sessionId, entry: { sessionId } } as T; }
      if (method === 'sessions.patch') { if (Object.hasOwn(params, 'thinkingLevel')) nativeThinking = params.thinkingLevel; if (behavior.loseEdit) throw Error('Lost settings response'); return { entry: { sessionId: sessions.get(params.key), thinkingLevel: nativeThinking, fastMode: params.fastMode } } as T; }
      if (method === 'chat.history') return { sessionId: sessions.get(params.sessionKey), messages: [], sessionInfo: { activeRunIds: behavior.activeRun ? [behavior.activeRun] : [], model: 'test/model', thinkingLevel: nativeThinking } } as T;
      if (method === 'chat.send') { if (behavior.loseSend) throw Error('Lost after admission'); return { runId: `run:${params.idempotencyKey}` } as T; }
      return {} as T;
    },
  };
  let service = new AssistantService(store, gateway);
  const conversation = await service.create(device, { requestId: randomUUID(), epoch: store.epoch, title: 'Auto effort fixture', projectId: null, model: 'test/model', ...(thinking ? { thinking } : {}) });
  let draftRevision = 0;
  const draft = (text: string, workMode?: WorkMode) => {
    const result = store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'draft', entityId: `draft:${device}:${conversation.id}`, expectedRevision: draftRevision, payload: { ...emptyDraft, conversationId: conversation.id, text, ...(workMode ? { workMode } : {}) } });
    draftRevision = result.revision;
    return { requestId: randomUUID(), epoch: store.epoch, conversationId: conversation.id, conversationRevision: current().revision, draftId: result.id, draftRevision, projectRevision: 0 };
  };
  const current = () => store.internalRead<Conversation>(`assistant:conversation:${conversation.id}`)!;
  const operation = (id: string) => service.operations().find(op => op.id === id)!;
  const wait = async (id: string) => { for (let attempt = 0; attempt < 100 && ['prepared', 'dispatching'].includes(operation(id).state); attempt++) await new Promise(resolve => setTimeout(resolve, 5)); return operation(id); };
  const finish = (op: AssistantOperation) => { for (const listener of listeners) listener({ type: 'event', event: 'chat', payload: { runId: op.nativeRunId, sessionKey: op.nativeKey, state: 'final', message: { role: 'assistant', content: 'Finished fixture reply.' } } }); behavior.activeRun = ''; };
  t.after(() => { service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, device, gateway, calls, behavior, conversation, current, draft, operation, wait, finish, service: () => service, setCatalog: (value: AssistantModel[]) => { catalog = value; }, saveLegacyPreference: (value: string | null) => store.internalWrite(`assistant:conversation:${conversation.id}`, { ...current(), thinking: value }), restart: () => { service.close(); service = new AssistantService(store, gateway); } };
}

test('Auto is a retained local preference with a supported per-task level and no native auto value', async t => {
  const f = await fixture(t);
  assert.equal(f.current().thinking, 'auto'); assert.equal(f.calls[0].params.thinkingLevel, undefined);
  const input = f.draft('Rewrite: It will happen tomorrow.'), op = await f.wait(f.service().submit(f.device, input).id);
  assert.equal(op.thinking, 'auto'); assert.equal(op.autoEffort?.level, 'low'); assert.equal(op.autoEffort?.reason, 'task');
  assert.equal(f.calls.find(call => call.method === 'chat.send')!.params.thinking, 'low');
  assert.equal(f.calls.filter(call => call.method === 'chat.send').length, 1);
  assert.equal(f.calls.some(call => call.params.thinkingLevel === 'auto' || call.params.thinking === 'auto'), false);
});
test('Auto settings clear native manual effort, reconcile an uncertain edit and retain the local choice after restart', async t => {
  const f = await fixture(t, 'high'); f.behavior.loseEdit = true;
  const input = { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, thinking: 'auto' };
  await assert.rejects(f.service().edit(f.device, input), { code: 'edit_unknown' });
  assert.equal(f.current().pendingSettings?.thinking, 'auto');
  assert.equal(f.calls.find(call => call.method === 'sessions.patch')!.params.thinkingLevel, null);
  await f.service().reconcile(f.conversation.id);
  assert.equal(f.current().thinking, 'auto'); assert.equal(f.current().pendingSettings, undefined);
  f.restart(); assert.equal(f.current().thinking, 'auto');
  assert.equal((await f.service().edit(f.device, input)).thinking, 'auto');
  assert.equal(f.calls.filter(call => call.method === 'sessions.patch').length, 1);
});
test('new conversations use Auto for omitted or legacy Default preferences', async t => {
  for (const thinking of [null, 'default']) await t.test(String(thinking), async t => {
    const f = await fixture(t, thinking);
    assert.equal(f.current().thinking, 'auto');
    assert.equal(f.calls.find(call => call.method === 'sessions.create')!.params.thinkingLevel, undefined);
    const op = await f.wait(f.service().submit(f.device, f.draft('Define a byte.')).id);
    assert.equal(op.thinking, 'auto'); assert.equal(op.autoEffort?.level, 'low');
    assert.equal(f.calls.find(call => call.method === 'chat.send')!.params.thinking, 'low');
  });
});

test('manual choices keep their original native behavior without classification', async t => {
  const f = await fixture(t, 'high'), op = await f.wait(f.service().submit(f.device, f.draft('Define a byte.')).id);
  assert.equal(op.thinking, 'high'); assert.equal(op.autoEffort, undefined); assert.equal(op.effortDemand, undefined);
  assert.equal(f.calls.find(call => call.method === 'chat.send')!.params.thinking, 'high');
  assert.equal(f.calls.filter(call => call.method === 'models').length, 0);
});

test('saved Default conversations capture real Auto for future sends and queues without rewriting the conversation', async t => {
  for (const thinking of [null, 'default']) await t.test(String(thinking), async t => {
    const f = await fixture(t); f.saveLegacyPreference(thinking);
    const first = await f.wait(f.service().submit(f.device, f.draft('Define a byte.')).id);
    assert.equal(first.thinking, 'auto'); assert.equal(first.autoEffort?.level, 'low');
    assert.equal(f.current().thinking, thinking); f.finish(first);
    const queued = f.service().enqueue(f.device, f.draft('Audit and debug the failure.'));
    assert.equal(queued.thinking, 'auto'); assert.equal(queued.effortDemand, 'high');
    const input = { requestId: randomUUID(), epoch: f.store.epoch, queueId: queued.id, expectedRevision: queued.revision };
    const op = await f.wait(f.service().runQueued(f.device, input).id);
    assert.equal(op.state, 'accepted'); assert.equal(op.autoEffort?.level, 'high');
    assert.equal(f.service().runQueued(f.device, input).id, op.id);
    assert.equal(f.current().thinking, thinking);
    assert.deepEqual(f.calls.filter(call => call.method === 'chat.send').map(call => call.params.thinking), ['low', 'high']);
  });
});

test('captured legacy queues and directions retain their original effort instead of adopting new defaults', async t => {
  const f = await fixture(t); f.saveLegacyPreference(null);
  const queued = f.service().enqueue(f.device, f.draft('Define a byte.'));
  const legacy = { ...queued, thinking: null, effortDemand: undefined };
  f.store.internalWrite(`assistant:queue:${legacy.id}`, legacy);
  const input = { requestId: randomUUID(), epoch: f.store.epoch, queueId: legacy.id, expectedRevision: legacy.revision };
  const op = await f.wait(f.service().runQueued(f.device, input).id);
  assert.equal(op.thinking, null); assert.equal(op.autoEffort, undefined); assert.equal(op.effortDemand, undefined);
  f.behavior.activeRun = op.nativeRunId!;
  const direction = await f.wait(f.service().submit(f.device, { ...f.draft('Keep the explanation short.'), targetOperationId: op.id }, true).id);
  assert.equal(direction.thinking, null); assert.equal(direction.autoEffort, undefined);
  assert.equal(f.calls.filter(call => call.method === 'models').length, 0);
  assert.deepEqual(f.calls.filter(call => call.method === 'chat.send').map(call => call.params.thinking), [undefined, undefined]);
});

test('a legacy unknown submission receipt replays unchanged after restart without resolving Auto or sending again', async t => {
  const f = await fixture(t); f.saveLegacyPreference(null);
  const input = f.draft('Keep the original attempt.'), conversation = f.current(), at = new Date().toISOString();
  const original: AssistantOperation = { id: randomUUID(), requestId: input.requestId, deviceId: f.device, epoch: f.store.epoch, conversationId: conversation.id, conversationRevision: conversation.revision, connectionGeneration: conversation.connectionGeneration, nativeKey: conversation.nativeKey, nativeId: conversation.nativeId!, nativeRunId: null, state: 'unknown', input: 'Keep the original attempt.', context: { project: null, attachments: [], draftId: input.draftId, draftRevision: input.draftRevision, digest: 'a'.repeat(64) }, model: conversation.model, thinking: null, createdAt: at, updatedAt: at, text: '', lastSequence: 0 };
  f.store.admit(f.device, input, { type: 'assistant.submit', ...input }, () => f.store.internalWrite(`assistant:operation:${original.id}`, original));
  f.restart(); const before = f.calls.length;
  const { updatedAt: _updatedAt, error, ...captured } = f.service().submit(f.device, input);
  const { updatedAt: _originalUpdatedAt, ...originalCapture } = original;
  assert.deepEqual(captured, originalCapture); assert.match(error!, /restarted/);
  assert.equal(f.calls.length, before); assert.equal(f.operation(original.id).thinking, null);
});

test('a lost legacy conversation creation receipt keeps its original preference and identity on retry', async t => {
  const f = await fixture(t), id = randomUUID();
  const input = { requestId: randomUUID(), epoch: f.store.epoch, title: 'Retained creation', projectId: null };
  const original: Conversation = { ...f.current(), id, title: input.title, nativeKey: `agent:main:e3:${id}`, nativeId: null, state: 'unknown', thinking: null };
  f.store.admit(f.device, input, { type: 'conversation.create', ...input }, () => f.store.internalWrite(`assistant:conversation:${id}`, original));
  f.restart(); const before = f.calls.length;
  assert.deepEqual(await f.service().create(f.device, input), original);
  assert.equal(f.calls.length, before);
});

test('an uncertain legacy reset retains its exact settings receipt while the next new task uses Auto', async t => {
  const f = await fixture(t, 'high'); f.behavior.loseEdit = true;
  const input = { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, thinking: null };
  await assert.rejects(f.service().edit(f.device, input), { code: 'edit_unknown' });
  assert.equal(f.current().pendingSettings?.thinking, null);
  assert.equal(f.calls.find(call => call.method === 'sessions.patch')!.params.thinkingLevel, null);
  f.restart(); await f.service().reconcile(f.conversation.id);
  assert.equal(f.current().thinking, null); assert.equal(f.current().pendingSettings, undefined);
  assert.equal((await f.service().edit(f.device, input)).thinking, null);
  assert.equal(f.calls.filter(call => call.method === 'sessions.patch').length, 1);
  const op = await f.wait(f.service().submit(f.device, f.draft('Define a byte.')).id);
  assert.equal(op.thinking, 'auto'); assert.equal(op.autoEffort?.level, 'low');
});
test('queued edits recapture task demand and resolve once against the supported model at first dispatch', async t => {
  const f = await fixture(t), queued = f.service().enqueue(f.device, f.draft('Rewrite this sentence.'));
  assert.equal(queued.effortDemand, 'low');
  const edited = f.service().editQueued(f.device, { requestId: randomUUID(), epoch: f.store.epoch, queueId: queued.id, expectedRevision: queued.revision, input: 'Debug the crash and audit retries.' });
  assert.equal(edited.effortDemand, 'high');
  f.setCatalog([{ id: 'test/model', provider: 'test', name: 'Test', available: true, reasoning: ['low', 'medium'] }]);
  const input = { requestId: randomUUID(), epoch: f.store.epoch, queueId: edited.id, expectedRevision: edited.revision };
  const op = await f.wait(f.service().runQueued(f.device, input).id);
  assert.equal(op.effortDemand, 'high'); assert.equal(op.autoEffort?.level, 'medium');
  assert.equal(f.service().runQueued(f.device, input).id, op.id);
  assert.equal(f.calls.filter(call => call.method === 'chat.send').length, 1);
});
test('continue preserves the prior task demand and steering never retunes the running reply', async t => {
  const f = await fixture(t), first = await f.wait(f.service().submit(f.device, f.draft('Audit this workflow and debug failures.')).id);
  f.finish(first);
  const next = await f.wait(f.service().submit(f.device, f.draft('Continue')).id);
  assert.equal(next.effortDemand, 'high'); assert.equal(next.autoEffort?.level, 'high');
  f.behavior.activeRun = next.nativeRunId!;
  const steer = await f.wait(f.service().submit(f.device, { ...f.draft('Rewrite the description too.'), targetOperationId: next.id }, true).id);
  assert.equal(steer.autoEffort?.level, 'high'); assert.equal(steer.autoEffort?.reason, 'steering');
  assert.equal(f.calls.filter(call => call.method === 'chat.send').at(-1)!.params.thinking, undefined);
});
test('lost responses retain the exact resolved effort across restart and never resend or reclassify', async t => {
  const f = await fixture(t); f.behavior.loseSend = true;
  const input = f.draft('Audit and debug the workflow.'), op = await f.wait(f.service().submit(f.device, input).id);
  assert.equal(op.state, 'unknown'); assert.equal(op.autoEffort?.level, 'high');
  f.setCatalog([]); f.restart();
  const retained = f.service().submit(f.device, input);
  assert.deepEqual(retained.autoEffort, op.autoEffort);
  await f.service().reconcile(f.conversation.id);
  assert.equal(f.calls.filter(call => call.method === 'chat.send').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'models').length, 1);
});
test('unavailable effort capabilities use provider defaults and record that limitation', async t => {
  const f = await fixture(t); f.behavior.failCatalog = true;
  const op = await f.wait(f.service().submit(f.device, f.draft('Audit this workflow.')).id);
  assert.equal(op.autoEffort?.level, null); assert.equal(op.autoEffort?.reason, 'capability-unavailable');
  assert.equal(op.state, 'accepted'); assert.equal(f.calls.find(call => call.method === 'chat.send')!.params.thinking, undefined);
});
test('Goal keeps its separate native session effort contract without claiming adaptive reasoning', async t => {
  const f = await fixture(t), op = await f.wait(f.service().submit(f.device, f.draft('Review these options.', 'goal')).id);
  assert.equal(op.autoEffort?.reason, 'session-managed'); assert.equal(op.autoEffort?.level, null);
  const sent = f.calls.find(call => call.method === 'chat.send')!;
  assert.equal(sent.params.thinking, undefined); assert.equal(sent.params.intent.kind, 'session-goal-start');
  assert.equal(f.calls.filter(call => call.method === 'models').length, 0);
});
