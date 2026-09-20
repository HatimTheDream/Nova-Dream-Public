import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { EventFrame } from '@openclaw/gateway-protocol/frame-guards';
import { GatewayClientRequestError } from '@openclaw/gateway-client';
import type { AssistantConnection, Conversation } from '../packages/domain/assistant.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { Store } from '../apps/service/store.js';
import { AssistantService } from '../apps/service/assistant.js';
import { computerControlGuidance } from '../packages/domain/computer-control.js';
import { canonical, emptyDraft } from '../packages/domain/contracts.js';

class Transport implements AssistantTransport {
  generation = randomUUID();
  calls: { method: string; params: any }[] = [];
  sessions = new Map<string, string>();
  listeners = new Set<(event: EventFrame) => void>();
  rejectSend = false;
  rejectCreate = false;
  holdHistory?: Promise<void>;
  replaceSession = false;
  messages: any[] = [];
  forkHistories = new Map<string, any[]>();
  rejectEdit = false;
  holdEdit?: Promise<void>;
  sessionInfo: Record<string, unknown> = {};
  inFlightRun?: { runId: string; text: string };
  artifactReply: any;
  status(): AssistantConnection { return { state: 'ready', generation: this.generation, message: 'Fixture transport', grantedScopes: ['operator.read', 'operator.write'], methods: ['artifacts.download', 'sessions.fork'], modelAuthReady: true }; }
  attachmentPolicy() { return { maxBytes: 10000, maxPayload: 100000 }; }
  models() { return Promise.resolve([]); }
  subscribe(fn: (event: EventFrame) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  emit(payload: unknown) { for (const fn of this.listeners) fn({ type: 'event', event: 'agent', payload }); }
  async request<T>(method: string, raw: unknown): Promise<T> {
    const params = raw as any; this.calls.push({ method, params });
    if (method === 'artifacts.download') return this.artifactReply as T;
    if (method === 'sessions.create') { if (!/^agent:main:/.test(params.key)) throw new GatewayClientRequestError({ code: 'INVALID_REQUEST', message: 'Multiple agents are configured; session creation needs an explicit owner.' }); if (this.rejectCreate) throw new GatewayClientRequestError({ code: 'INVALID_REQUEST', message: 'label already in use' }); const sessionId = randomUUID(); this.sessions.set(params.key, sessionId); if (params.fork && params.parentSessionKey) this.forkHistories.set(params.key, [...this.messages]); return { key: params.key, sessionId, entry: { sessionId, permissionMode: params.permissionMode } } as T; }
    if (method === 'sessions.fork') { const key = `fixture:fork:${randomUUID()}`; this.sessions.set(key, randomUUID()); this.forkHistories.set(key, this.messages.slice(0, this.messages.findIndex(m => m.__openclaw?.id === params.entryId))); return { sessionKey: key } as T; }
    if (method === 'chat.history') { await this.holdHistory; return { sessionId: this.replaceSession ? randomUUID() : (params.sessionId ?? this.sessions.get(params.sessionKey)), messages: this.forkHistories.get(params.sessionKey) ?? this.messages, hasMore: false, inFlightRun: this.inFlightRun, sessionInfo: { activeRunIds: [], hasActiveRun: false, ...this.sessionInfo } } as T; }
    if (method === 'chat.send') { if (this.rejectSend) throw new Error('Response lost after send'); return { runId: `native:${params.idempotencyKey}` } as T; }
    if (method === 'sessions.patch') { await this.holdEdit; if (this.rejectEdit) throw new Error('Response lost after patch'); return { entry: { sessionId: this.sessions.get(params.key), thinkingLevel: params.thinkingLevel ?? undefined, fastMode: params.fastMode ?? undefined } } as T; }
    return {} as T;
  }
}
async function fixture(run: (f: { store: Store; service: AssistantService; gateway: Transport; device: string; conversation: Conversation; projectId: string; draftRevision: number }) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-assistant-'));
  const store = new Store(directory), gateway = new Transport(), service = new AssistantService(store, gateway), device = store.session().deviceId;
  const projectId = `project:${randomUUID()}`;
  store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'project', entityId: projectId, expectedRevision: 0, payload: { name: 'Project A', purpose: 'Required sentinel: silver-orbit-41' } });
  const file = store.upload(device, randomUUID(), store.epoch, 'context.txt', Buffer.from('Exact attachment bytes').toString('base64'));
  const draft = store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'draft', entityId: `draft:${device}`, expectedRevision: 0, payload: { ...emptyDraft, text: 'Use the selected context.', projectId, attachments: [file] } });
  const conversation = await service.create(device, { requestId: randomUUID(), epoch: store.epoch, title: 'Context proof', projectId, model: 'openai/test' });
  try { await run({ store, service, gateway, device, conversation, projectId, draftRevision: draft.revision }); }
  finally { service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}
const tick = () => new Promise(r => setTimeout(r, 15));
test('a fresh service reads, pins and saves archived source text after its runtime binding changes', () => fixture(async f => {
  f.gateway.messages = [{ id: 'stable-message', role: 'assistant', content: 'The retained original answer' }];
  const message = (await f.service.history(f.conversation.id)).messages[0];
  f.service.close(); f.gateway.generation = randomUUID();
  const replacement = { ...f.conversation, nativeId: randomUUID(), nativeKey: 'agent:main:new-binding', connectionGeneration: f.gateway.generation };
  f.store.internalWrite(`assistant:conversation:${f.conversation.id}`, replacement);
  const fresh = new AssistantService(f.store, f.gateway);
  const originalCalls = f.gateway.calls.length;
  try {
    const history = await fresh.historyForReading(f.conversation.id);
    assert.equal(history.messages[0].text, message.text);
    assert.equal(history.messages[0].source?.nativeId, f.conversation.nativeId);
    const source = { epoch: f.store.epoch, conversationId: f.conversation.id, nativeId: f.conversation.nativeId, messageId: message.id, messageHash: message.textHash };
    const pin = fresh.pins.change(f.device, { ...source, requestId: randomUUID(), role: 'assistant', pinned: true, expectedRevision: 0 });
    assert.equal(pin.nativeId, f.conversation.nativeId);
    const output = fresh.saveOutput(f.device, { ...source, requestId: randomUUID(), name: 'Original answer' });
    assert.equal(f.store.download(output.file!.id).bytes.toString(), message.text);
    assert.equal(f.gateway.calls.slice(originalCalls).some(c => ['chat.send', 'sessions.patch', 'sessions.create'].includes(c.method)), false);
    assert.equal(f.store.snapshot(f.device).drafts[0].value.text, 'Use the selected context.');
  } finally { fresh.close(); }
}));
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const queueDraft = (f: Parameters<Parameters<typeof fixture>[0]>[0]) => f.service.enqueue(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: f.conversation.revision, draftId: `draft:${f.device}`, draftRevision: f.draftRevision, projectRevision: 1 });

for (const [eventState, operationState] of [['final', 'completed'], ['error', 'failed'], ['aborted', 'cancelled']] as const) {
  test(`delayed active history cannot reopen a ${operationState} run or replace its final output`, () => fixture(async f => {
    const input = submission(f), submitted = f.service.submit(f.device, input); await tick();
    const live = f.service.operations().find(op => op.id === submitted.id)!;
    const held = deferred(); f.gateway.holdHistory = held.promise;
    f.gateway.inFlightRun = { runId: live.nativeRunId!, text: 'Stale partial output' };
    const reading = f.service.reconcile(live.conversationId);
    for (const listener of f.gateway.listeners) listener({ type: 'event', event: 'chat', payload: { runId: live.nativeRunId, sessionKey: live.nativeKey, state: eventState, message: { role: 'assistant', content: 'Retained final output' } } });
    const settled = f.service.operations().find(op => op.id === submitted.id)!;
    assert.equal(settled.state, operationState);
    held.resolve(); await reading; await tick();
    assert.deepEqual(f.service.operations().find(op => op.id === submitted.id), settled);
    assert.deepEqual(f.service.submit(f.device, input), settled);
    assert.equal(f.gateway.calls.filter(call => call.method === 'chat.send').length, 1);
  }));
}

test('a delayed abort rejection preserves a confirmed failure and replay never aborts again', () => fixture(async f => {
  const submitted = f.service.submit(f.device, submission(f)); await tick();
  const live = f.service.operations().find(op => op.id === submitted.id)!;
  const abort = deferred<unknown>(), entered = deferred(), request = f.gateway.request.bind(f.gateway);
  let aborts = 0;
  f.gateway.request = async <T>(method: string, raw: unknown): Promise<T> => {
    if (method !== 'chat.abort') return request<T>(method, raw);
    aborts++; entered.resolve(); return await abort.promise as T;
  };
  const input = { requestId: randomUUID(), epoch: f.store.epoch, operationId: live.id };
  const cancelling = f.service.cancel(f.device, input); await entered.promise;
  for (const listener of f.gateway.listeners) listener({ type: 'event', event: 'chat', payload: { runId: live.nativeRunId, sessionKey: live.nativeKey, state: 'error', message: { role: 'assistant', content: 'Failure with retained partial work' } } });
  const settled = f.service.operations().find(op => op.id === submitted.id)!;
  assert.equal(settled.state, 'failed'); assert.equal(settled.cancelRequested, true);
  abort.reject(new Error('Abort response lost after the failure event'));
  assert.deepEqual(await cancelling, settled);
  assert.deepEqual(await f.service.cancel(f.device, input), settled);
  assert.equal(aborts, 1);
}));

test('conflicting terminal receipts keep the first outcome while matching receipts enrich proof only once', () => fixture(async f => {
  const submitted = f.service.submit(f.device, submission(f)); await tick();
  const live = f.service.operations().find(op => op.id === submitted.id)!;
  const status = f.gateway.status.bind(f.gateway), request = f.gateway.request.bind(f.gateway);
  const receipt = deferred<unknown>(), entered = deferred();
  f.gateway.status = () => ({ ...status(), methods: [...status().methods, 'agent.wait'] });
  let result: unknown;
  f.gateway.request = async <T>(method: string, raw: unknown): Promise<T> => {
    if (method !== 'agent.wait') return request<T>(method, raw);
    entered.resolve(); return (result ?? await receipt.promise) as T;
  };
  const reading = f.service.reconcile(live.conversationId); await entered.promise;
  for (const listener of f.gateway.listeners) listener({ type: 'event', event: 'chat', payload: { runId: live.nativeRunId, sessionKey: live.nativeKey, state: 'error', message: { role: 'assistant', content: 'Original terminal failure' } } });
  const settled = f.service.operations().find(op => op.id === submitted.id)!;
  const proof = { runId: live.nativeRunId, sessionId: live.nativeId, turnId: 'exact-turn', effective: { provider: 'fixture', model: 'verified' } };
  result = { runId: live.nativeRunId, status: 'ok', terminalReceipt: proof, terminalReply: { text: 'Conflicting delayed completion' } };
  receipt.resolve(result); await reading; await tick();
  assert.deepEqual(f.service.operations().find(op => op.id === submitted.id), settled);
  result = { runId: live.nativeRunId, status: 'error', terminalReceipt: proof, terminalReply: { text: 'Different terminal receipt output' } };
  await f.service.reconcile(live.conversationId);
  const enriched = f.service.operations().find(op => op.id === submitted.id)!;
  assert.equal(enriched.state, 'failed'); assert.equal(enriched.text, settled.text); assert.equal(enriched.error, settled.error);
  assert.equal(enriched.effectiveModel, 'fixture/verified'); assert.equal(enriched.nativeTurnId, 'exact-turn');
  await f.service.reconcile(live.conversationId);
  assert.deepEqual(f.service.operations().find(op => op.id === submitted.id), enriched);
  assert.equal(f.gateway.calls.filter(call => call.method === 'chat.send').length, 1);
}));

test('duplicate conversation names get stable readable suffixes and rejected creation is not unknown', () => fixture(async f => {
  const input = { requestId: randomUUID(), epoch: f.store.epoch, title: f.conversation.title, projectId: f.projectId };
  const second = await f.service.create(f.device, input);
  assert.equal(second.title, `${f.conversation.title} (2)`);
  assert.equal((await f.service.create(f.device, input)).id, second.id);
  const third = await f.service.create(f.device, { ...input, requestId: randomUUID() });
  assert.equal(third.title, `${f.conversation.title} (3)`);
  assert.deepEqual(f.gateway.calls.filter(c => c.method === 'sessions.create').map(c => c.params.label), [f.conversation.title, second.title, third.title]);
  f.gateway.rejectCreate = true;
  const failed = await f.service.create(f.device, { ...input, requestId: randomUUID() });
  assert.equal(failed.state, 'failed'); assert.equal(failed.nativeId, null);
  assert.match(failed.error!, /rejected conversation setup/);
}));

test('queue keeps exact input and files after draft edits and restart without automatic dispatch', () => fixture(async f => {
  f.service.setVoiceGuard(() => true);
  const queued = queueDraft(f);
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId: `draft:${f.device}`, expectedRevision: f.draftRevision, payload: { ...emptyDraft, projectId: f.projectId, text: 'Another unsent draft' } });
  assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 0);
  f.service.close(); const restarted = new AssistantService(f.store, f.gateway);
  try {
    assert.deepEqual(restarted.queue(), [queued]);
    const operation = restarted.runQueued(f.store.session().deviceId, { requestId: randomUUID(), epoch: f.store.epoch, queueId: queued.id, expectedRevision: 1 });
    await tick();
    const sent = f.gateway.calls.find(c => c.method === 'chat.send')!;
    assert.ok(sent.params.message.endsWith('Use the selected context.'));
    assert(sent.params.message.includes(computerControlGuidance));
    assert.equal(operation.context.computerControlGuidance, queued.context.computerControlGuidance);
    assert.equal(Buffer.from(sent.params.attachments[0].content, 'base64').toString(), 'Exact attachment bytes');
    assert.equal(restarted.queue()[0].operationId, operation.id);
    assert.equal(f.store.readEntity('draft', `draft:${f.device}`)!.value.text, 'Another unsent draft');
  } finally { restarted.close(); }
}));

test('lost queued submission receipts cannot dispatch twice or resume automatically after restart', () => fixture(async f => {
  const queued = queueDraft(f); f.gateway.rejectSend = true;
  const input = { requestId: randomUUID(), epoch: f.store.epoch, queueId: queued.id, expectedRevision: 1 };
  const operation = f.service.runQueued(f.device, input); await tick();
  assert.equal(f.service.runQueued(f.device, input).id, operation.id);
  assert.equal(f.service.operations()[0].state, 'unknown');
  assert.throws(() => f.service.runQueued(f.device, { ...input, requestId: randomUUID() }), /already changed/);
  f.service.close(); const restarted = new AssistantService(f.store, f.gateway);
  try {
    assert.equal(restarted.queue()[0].state, 'submitted');
    assert.equal(restarted.runQueued(f.device, input).id, operation.id); await tick();
    assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 1);
  } finally { restarted.close(); }
}));

test('queued work fences changed context, model, incarnation, voice and stale restore commands', () => fixture(async f => {
  const queued = queueDraft(f);
  const input = () => ({ requestId: randomUUID(), epoch: f.store.epoch, queueId: queued.id, expectedRevision: 1 });
  f.service.setVoiceGuard(() => true); assert.throws(() => f.service.runQueued(f.device, input()), /End the voice/); f.service.setVoiceGuard(() => false);
  for (const patch of [{ model: 'changed/model' }, { archived: true }, { nativeId: randomUUID() }]) {
    f.store.internalWrite(`assistant:conversation:${f.conversation.id}`, { ...f.conversation, ...patch });
    assert.throws(() => f.service.runQueued(f.device, input()), /conversation or model changed/);
  }
  f.store.internalWrite(`assistant:conversation:${f.conversation.id}`, f.conversation);
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project', entityId: f.projectId, expectedRevision: 1, payload: { name: 'Project A', purpose: 'Changed context' } });
  assert.throws(() => f.service.runQueued(f.device, input()), /Project context changed/);
  const removed = f.service.setQueueState(f.device, { ...input(), state: 'removed' });
  assert.equal(removed.state, 'removed'); assert.equal(removed.input, queued.input);
  assert.throws(() => f.service.setQueueState(f.device, { ...input(), state: 'paused' }), /queue item changed/);
  const restored = f.service.setQueueState(f.device, { ...input(), expectedRevision: removed.revision, state: 'paused' });
  assert.equal(restored.state, 'paused'); assert.deepEqual(restored.context, queued.context);
  assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 0);
}));

test('Project changes during queued native preflight retain the input without dispatch', () => fixture(async f => {
  const queued = queueDraft(f);
  let release!: () => void; f.gateway.holdHistory = new Promise(resolve => { release = resolve; });
  const operation = f.service.runQueued(f.device, { requestId: randomUUID(), epoch: f.store.epoch, queueId: queued.id, expectedRevision: 1 });
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project', entityId: f.projectId, expectedRevision: 1, payload: { name: 'Project A', purpose: 'Changed during history read' } });
  release(); await tick();
  assert.equal(f.service.operations().find(o => o.id === operation.id)!.state, 'failed');
  assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 0);
  assert.deepEqual(f.service.queue()[0].context, queued.context);
}));

async function nativeArtifact(f: { store: Store; service: AssistantService; gateway: Transport; conversation: Conversation }, bytes = Buffer.from('Actual native file bytes')) {
  const artifactId = 'artifact_managed_media_fixture';
  f.gateway.messages = [{ id: 'native-output', role: 'assistant', content: [{ type: 'file', artifactId, fileName: 'result.txt', mimeType: 'text/plain', sizeBytes: bytes.length }] }];
  f.gateway.artifactReply = { artifact: { id: artifactId, sessionKey: f.conversation.nativeKey, type: 'file', title: 'result.txt', mimeType: 'text/plain', sizeBytes: bytes.length, download: { mode: 'bytes' } }, encoding: 'base64', data: bytes.toString('base64') };
  const history = await f.service.history(f.conversation.id);
  return { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, nativeId: f.conversation.nativeId!, messageId: history.messages[0].id, messageHash: history.messages[0].textHash, artifactId, name: 'result.txt' };
}

test('native artifact saves exact bytes once across concurrent retries and leaves the original draft unchanged', () => fixture(async f => {
  const input = await nativeArtifact(f), before = f.store.readEntity('draft', `draft:${f.device}`);
  const [first, retry] = await Promise.all([f.service.saveArtifact(f.device, input), f.service.saveArtifact(f.device, input)]);
  assert.equal(first.id, retry.id); assert.equal(first.file!.id, retry.file!.id);
  assert.equal(f.store.download(first.file!.id).bytes.toString(), 'Actual native file bytes');
  assert.equal(first.artifactId, input.artifactId); assert.equal(first.text, '');
  assert.equal(first.contentSha256, first.file!.sha256);
  assert.equal(f.service.outputs().length, 1);
  assert.deepEqual(f.store.readEntity('draft', `draft:${f.device}`), before);
  assert.equal('data' in first, false); assert.equal('url' in first, false);
  await assert.rejects(f.service.saveArtifact(f.device, { ...input, name: 'changed.txt' }), /different work/);
}));

test('native artifact source changes prevent a prepared save from obtaining any bytes', () => fixture(async f => {
  const input = await nativeArtifact(f);
  f.gateway.messages[0].content[0].sizeBytes = 1;
  await assert.rejects(f.service.saveArtifact(f.device, input), /reference changed/);
  assert.equal(f.gateway.calls.filter(call => call.method === 'artifacts.download').length, 0);
  assert.equal(f.service.outputs()[0].state, 'prepared');
}));

test('an asynchronous native attachment invalidates only its original conversation history', () => fixture(async f => {
  const emit = (sessionKey: string, sessionId: string) => f.gateway.listeners.forEach(listener => listener({ type: 'event', event: 'session.message', payload: { sessionKey, sessionId, messageId: 'new-generated-artifact' } }));
  emit('unrelated', f.conversation.nativeId!);
  emit(f.conversation.nativeKey, randomUUID());
  assert.deepEqual(f.service.state().historyVersions, {});
  emit(f.conversation.nativeKey, f.conversation.nativeId!);
  assert.equal(f.service.state().historyVersions![f.conversation.id], 1);
  f.gateway.generation = randomUUID(); emit(f.conversation.nativeKey, f.conversation.nativeId!);
  assert.equal(f.service.state().historyVersions![f.conversation.id], 1);
}));

test('an explicitly bound refinement saves an asynchronous native attachment as v2 after submitting the exact original bytes', () => fixture(async f => {
  const original = await f.service.saveArtifact(f.device, await nativeArtifact(f));
  const refineSource = { outputId: original.id, version: original.version, sha256: original.file!.sha256 };
  const child = await f.service.create(f.device, { requestId: randomUUID(), epoch: f.store.epoch, title: 'Refine original', projectId: f.projectId, refineSource });
  const childFixture = { ...f, conversation: child };
  const childOutput = await nativeArtifact(childFixture, Buffer.from('Refined native file bytes'));
  await assert.rejects(f.service.saveArtifact(f.device, childOutput), /Finish the refinement/);
  const draftId = `draft:${f.device}:${child.id}`;
  let draft = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId: draftId, expectedRevision: 0, payload: { ...emptyDraft, title: child.title, conversationId: child.id, projectId: f.projectId, text: 'Refine this original file.', attachments: [original.file!] } });
  const submit = () => f.service.submit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: child.id, conversationRevision: child.revision, draftId, draftRevision: draft.revision, projectRevision: 1 });
  assert.throws(submit, /original output version/);
  draft = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId: draftId, expectedRevision: draft.revision, payload: { ...(draft.value as Record<string, unknown>), refineSource } });
  const captured = draft.value as Record<string, unknown>;
  draft = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId: draftId, expectedRevision: draft.revision, payload: { ...captured, text: '' } });
  assert.throws(submit, /Describe what/);
  draft = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId: draftId, expectedRevision: draft.revision, payload: captured });
  const operation = submit(); await tick();
  const sent = f.gateway.calls.find(call => call.method === 'chat.send' && call.params.sessionKey === child.nativeKey)!;
  assert.equal(Buffer.from(sent.params.attachments[0].content, 'base64').toString(), 'Actual native file bytes');
  const run = f.service.operations().find(op => op.id === operation.id)!;
  f.gateway.emit({ runId: run.nativeRunId, sessionKey: child.nativeKey, seq: 1, stream: 'lifecycle', data: { phase: 'end' } });
  await tick(); await f.service.history(child.id);
  const refined = await f.service.saveArtifact(f.device, childOutput);
  assert.equal(refined.version, 2); assert.equal(refined.parentOutputId, original.id);
  assert.equal(f.store.download(refined.file!.id).bytes.toString(), 'Refined native file bytes');
  assert.equal(f.store.download(original.file!.id).bytes.toString(), 'Actual native file bytes');
  await assert.rejects(f.service.create(f.device, { requestId: randomUUID(), epoch: f.store.epoch, title: 'Wrong source', projectId: f.projectId, refineSource: { ...refineSource, version: 99 } }), /exact saved output/);
}));

test('artifact upload receipt survives a crash before linking and rejects changed retry bytes', () => fixture(async f => {
  const input = await nativeArtifact(f), upload = f.store.upload.bind(f.store);
  let calls = 0;
  f.store.upload = (...args) => { const file = upload(...args); if (++calls === 1) throw new Error('Simulated crash after durable upload'); return file; };
  await assert.rejects(f.service.saveArtifact(f.device, input), /Simulated crash/);
  const prepared = f.service.outputs()[0]; assert.ok(prepared.contentSha256); assert.equal(prepared.state, 'prepared');
  f.service.close();
  const restarted = new AssistantService(f.store, f.gateway);
  try {
    f.gateway.artifactReply.data = Buffer.from('Changed native file byte').toString('base64');
    await assert.rejects(restarted.saveArtifact(f.device, input), /bytes changed|source size/);
    f.gateway.artifactReply.data = Buffer.from('Actual native file bytes').toString('base64');
    const recovered = await restarted.saveArtifact(f.device, input);
    assert.equal(recovered.id, prepared.id); assert.equal(recovered.file!.sha256, prepared.contentSha256);
    assert.equal(f.store.download(recovered.file!.id).bytes.toString(), 'Actual native file bytes');
    assert.equal(restarted.outputs().length, 1);
  } finally { restarted.close(); }
}));
function submission(f: { device: string; store: Store; conversation: Conversation; draftRevision: number }) { return { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: f.conversation.revision, draftId: `draft:${f.device}`, draftRevision: f.draftRevision, projectRevision: 1 }; }

test('Assistant captures exact Project/draft/attachment identity and does not dispatch an exact retry twice', () => fixture(async f => {
  const request = submission(f), first = f.service.submit(f.device, request);
  await tick(); const retry = f.service.submit(f.device, request);
  assert.equal(first.id, retry.id); assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 1);
  const sent = f.gateway.calls.find(c => c.method === 'chat.send')!.params;
  assert.equal(sent.sessionId, f.conversation.nativeId); assert.equal(sent.deliver, false);
  assert.equal(sent.suppressCommandInterpretation, undefined); assert.match(sent.message, /^Nova Dream /); assert.match(sent.message, /silver-orbit-41/);
  assert.equal(Buffer.from(sent.attachments[0].content, 'base64').toString(), 'Exact attachment bytes');
  f.gateway.messages = [{ role: 'user', content: sent.message }, { role: 'user', content: 'Edition 3 owner message:\nUntracked original text' }];
  const history = await f.service.history(f.conversation.id);
  assert.equal(history.messages[0].authoredText, 'Use the selected context.');
  assert.equal(history.messages[0].text, sent.message);
  assert.equal(history.messages[1].authoredText, undefined);
  assert.throws(() => f.service.submit(f.device, { ...request, draftRevision: request.draftRevision + 1 }), /different work/);
  assert.throws(() => f.service.submit(randomUUID(), request), /different work/);
  assert.equal(f.store.readEntity('draft', `draft:${f.device}`)?.value.text, 'Use the selected context.');
}));

for (const version of [1, 2]) for (const legacy of [false, true]) test(`native-trimmed ${legacy ? 'legacy' : 'current'} v${version} envelopes display exact writing and repair older saved copies`, () => fixture(async f => {
  const input = '  Original words — 🦊\nOwner message:\nKeep this heading.\n\nEdition 3 work mode:\nMy own paragraph.\n  ';
  const draft = f.store.readEntity('draft', `draft:${f.device}`)!;
  const saved = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId: draft.id, expectedRevision: draft.revision, payload: { ...draft.value, text: input } });
  if (version === 2) f.store.internalWrite(`assistant:conversation:${f.conversation.id}`, { ...f.conversation, autoTitle: true });
  const op = f.service.submit(f.device, { ...submission(f), draftRevision: saved.revision }); await tick();
  let envelope = f.gateway.calls.find(c => c.method === 'chat.send')!.params.message;
  assert.equal(op.context.brandVersion, 1);
  assert.match(envelope, /Nova Dream work mode:/);
  if (legacy) {
    const { brandVersion: _brand, ...context } = op.context;
    f.store.internalWrite(`assistant:operation:${op.id}`, { ...f.service.operations().find(o => o.id === op.id)!, context });
    envelope = envelope.replace('Nova Dream work mode:', 'Edition 3 work mode:').replace('Nova Dream selected Project context', 'Edition 3 selected Project context');
  }
  assert.notEqual(envelope, envelope.trim(), 'fixture exercises the runtime whitespace change');
  assert.equal(op.context.messageVersion ?? 1, version);
  const native = envelope.trim(), literal = 'Owner message:\nThis is a literal heading, not an app envelope.';
  f.gateway.messages = [
    { role: 'user', content: native, __openclaw: { id: 'owner', seq: 1 } },
    { role: 'user', content: native.replace('My own paragraph.', 'Different internal wording.'), __openclaw: { id: 'different', seq: 2 } },
    { role: 'user', content: literal, __openclaw: { id: 'literal', seq: 3 } },
    { role: 'user', content: 'An ordinary final voice caption.', __openclaw: { id: 'voice', seq: 4 } },
    { role: 'assistant', content: native, __openclaw: { id: 'assistant-quote', seq: 5 } },
  ];
  const history = await f.service.history(f.conversation.id), message = history.messages[0];
  assert.equal(message.authoredText, input);
  assert.equal(message.text, native);
  assert.equal(message.textHash, createHash('sha256').update(canonical(native)).digest('hex'));
  assert(history.messages.slice(1).every(m => m.authoredText === undefined));
  // Simulate a pre-fix backup with no authored display field, then read offline.
  const older = { ...history, messages: history.messages.map(({ authoredText: _display, ...m }) => m) };
  // A pre-migration workspace has only these original caches, not a newer Nova archive.
  for (const row of f.store.internalPage(`assistant:transcript:${f.conversation.id}:`, '', 500)) f.store.internalDelete(row.id);
  f.store.internalDelete(`assistant:transcript-state:${f.conversation.id}`);
  f.store.internalWrite(`assistant:history:${f.conversation.id}`, older);
  const retained = { history: older, complete: true, capturedAt: '2026-09-16T12:00:00.000Z' };
  f.store.internalWrite(`assistant:retained-history:${f.conversation.id}`, retained);
  const retainedBefore = f.store.internalRead(`assistant:retained-history:${f.conversation.id}`), cachedBefore = f.store.internalRead(`assistant:history:${f.conversation.id}`);
  assert.equal(f.service.cachedHistory(f.conversation.id)!.messages[0].authoredText, input);
  const generation = f.gateway.generation; f.gateway.generation = randomUUID();
  const offline = await f.service.historyForReading(f.conversation.id);
  assert.equal(offline.retained?.complete, true); assert.equal(offline.messages[0].authoredText, input);
  assert.equal(offline.messages[0].textHash, message.textHash);
  const review = f.service.retainedTranscriptReview(f.conversation.id);
  const exported = f.service.exportRetainedTranscript(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, digest: review.digest });
  const dialogue = JSON.parse(f.store.download(exported.file.id).bytes.toString().split('Saved dialogue (JSON; text values preserve the captured wording):\n')[1]);
  assert.equal(dialogue[0].text, input); assert.equal(dialogue[0].sourceTextHash, message.textHash);
  assert.equal(dialogue[2].text, literal); assert.equal(dialogue[3].text, 'An ordinary final voice caption.');
  assert.deepEqual(f.store.internalRead(`assistant:retained-history:${f.conversation.id}`), retainedBefore, 'original archive stays immutable');
  assert.deepEqual(f.store.internalRead(`assistant:history:${f.conversation.id}`), cachedBefore, 'cached native record stays exact');
  f.gateway.generation = generation;
  f.store.internalWrite(`assistant:operation:${op.id}`, { ...f.service.operations().find(o => o.id === op.id)!, state: 'completed' });
  const branch = await f.service.fork(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: f.service.conversations().find(c => c.id === f.conversation.id)!.revision, nativeId: f.conversation.nativeId!, messageId: message.id, messageHash: message.textHash, purpose: 'retry' });
  assert.equal(branch.state, 'ready');
  const revised = f.store.readEntity('draft', `draft:${f.device}:${branch.id}`)!.value;
  assert.equal(revised.text, input); assert.deepEqual(revised.attachments, op.context.attachments);
  f.store.internalWrite(`assistant:operation:${op.id}`, { ...f.service.operations().find(o => o.id === op.id)!, connectionGeneration: randomUUID() });
  assert.equal((await f.service.history(f.conversation.id)).messages[0].authoredText, undefined, 'another connection generation cannot lend its display text');
}));

test('Project changes during history preflight fence the dispatch and retain the original input', () => fixture(async f => {
  let release!: () => void; f.gateway.holdHistory = new Promise<void>(r => { release = r; });
  f.service.submit(f.device, submission(f));
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project', entityId: f.projectId, expectedRevision: 1, payload: { name: 'Project A', purpose: 'Changed context' } });
  release(); await tick();
  assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 0);
  assert.equal(f.service.operations()[0].state, 'failed');
  assert.equal(f.service.operations()[0].context.project?.purpose, 'Required sentinel: silver-orbit-41');
}));

test('unknown send survives service restart without another dispatch and blocks an accidental new send', () => fixture(async f => {
  f.gateway.rejectSend = true;
  const request = submission(f); f.service.submit(f.device, request); await tick();
  assert.equal(f.service.operations()[0].state, 'unknown'); f.service.close();
  const restarted = new AssistantService(f.store, f.gateway);
  try {
    restarted.submit(f.device, request); await tick();
    assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 1);
    assert.throws(() => restarted.submit(f.device, { ...request, requestId: randomUUID() }), /reconcile/);
    assert.equal(restarted.operations()[0].input, 'Use the selected context.');
  } finally { restarted.close(); }
}));

test('late run events cannot cross Gateway generation or replace text with lower sequences', () => fixture(async f => {
  f.service.submit(f.device, submission(f)); await tick(); const op = f.service.operations()[0];
  f.gateway.emit({ runId: op.nativeRunId, sessionKey: op.nativeKey, seq: 2, stream: 'assistant', data: { text: 'Latest answer' } });
  f.gateway.emit({ runId: op.nativeRunId, sessionKey: op.nativeKey, seq: 1, stream: 'assistant', data: { text: 'Stale answer' } });
  assert.equal(f.service.operations()[0].text, 'Latest answer');
  f.gateway.generation = randomUUID();
  f.gateway.emit({ runId: op.nativeRunId, sessionKey: op.nativeKey, seq: 3, stream: 'lifecycle', data: { phase: 'end' } });
  assert.equal(f.service.operations()[0].state, 'running');
}));

test('native session replacement and uncertain model changes prevent new dispatch', () => fixture(async f => {
  f.gateway.replaceSession = true; f.service.submit(f.device, submission(f)); await tick();
  assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 0);
  f.gateway.replaceSession = false; f.gateway.rejectEdit = true;
  await assert.rejects(f.service.edit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, model: 'openai/another' }), /not confirmed/);
  assert.ok(f.service.conversations()[0].pendingSettings);
  assert.throws(() => f.service.submit(f.device, submission(f)), /Review/);
  assert.equal(f.service.conversations()[0].model, 'openai/test');
}));

test('cached history retains the same native settings and exact leaf as the live read', () => fixture(async f => {
  f.gateway.sessionInfo = { label: 'Verified title', archived: false, model: 'test', modelProvider: 'openai', activeLeafEntryId: 'leaf-17' };
  const live = await f.service.history(f.conversation.id);
  assert.equal(live.leafEntryId, 'leaf-17');
  assert.equal(live.nativeSettings?.model, 'openai/test');
  assert.deepEqual(JSON.parse(JSON.stringify(live)), f.service.cachedHistory(f.conversation.id));
}));

test('a late edit response cannot overwrite a newer edit already admitted after reconciliation', () => fixture(async f => {
  let release!: () => void;
  f.gateway.holdEdit = new Promise<void>(r => { release = r; });
  const firstId = randomUUID();
  const first = f.service.edit(f.device, { requestId: firstId, epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, title: 'First title' });
  f.gateway.sessionInfo = { label: 'First title' };
  await Promise.all([f.service.reconcile(f.conversation.id), f.service.reconcile(f.conversation.id)]);
  assert.equal(f.service.conversations()[0].revision, 2);
  assert.equal(f.store.internalRead<{ state: string }>(`assistant:edit:${firstId}`)?.state, 'completed');
  f.gateway.holdEdit = undefined;
  await f.service.edit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 2, title: 'Newer title' });
  release(); await first;
  assert.equal(f.service.conversations()[0].title, 'Newer title');
  assert.equal(f.service.conversations()[0].revision, 3);
  assert.equal(f.service.conversations()[0].pendingSettings, undefined);
}));

test('saved reply documents retain source identity and recover their original file receipt', () => fixture(async f => {
  f.gateway.messages = [{ role: 'assistant', content: [{ type: 'text', text: '# Original output\n\nKeep these exact bytes.' }], __openclaw: { id: 'native-message-1', seq: 1 } }];
  const message = (await f.service.history(f.conversation.id)).messages[0];
  const input = { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, nativeId: f.conversation.nativeId, messageId: message.id, messageHash: message.textHash, name: 'Project output' };
  const first = f.service.saveOutput(f.device, input), retry = f.service.saveOutput(f.device, input);
  assert.equal(first.id, retry.id); assert.equal(first.file?.id, retry.file?.id);
  assert.equal(f.store.download(first.file!.id).bytes.toString(), message.text);
  assert.equal(first.messageHash, message.textHash); assert.equal(first.nativeId, f.conversation.nativeId);
  assert.throws(() => f.service.saveOutput(f.device, { ...input, requestId: randomUUID(), messageHash: 'a'.repeat(64) }), /exact reply/);
  assert.throws(() => f.service.saveOutput(f.device, { ...input, name: 'Different intent' }), /different work/);
  f.store.internalWrite(`assistant:output:${first.id}`, { ...first, file: undefined, state: 'prepared' });
  assert.equal(f.service.saveOutput(f.device, input).file?.id, first.file?.id);
  assert.equal(f.store.readEntity('draft', `draft:${f.device}`)?.value.text, 'Use the selected context.');
}));

test('refinement draft cannot drop or replace its exact source attachment', () => fixture(async f => {
  f.gateway.messages = [{ role: 'assistant', content: [{ type: 'text', text: 'Original answer' }], __openclaw: { id: 'original', seq: 1 } }];
  const message = (await f.service.history(f.conversation.id)).messages[0];
  const output = f.service.saveOutput(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, nativeId: f.conversation.nativeId, messageId: message.id, messageHash: message.textHash, name: 'Original' });
  const draft = { ...emptyDraft, projectId: f.projectId, attachments: [output.file!], refineSource: { outputId: output.id, version: output.version, sha256: output.file!.sha256 } };
  const write = (payload: unknown) => f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId: `draft:${f.device}`, expectedRevision: f.draftRevision, payload });
  assert.throws(() => write({ ...draft, attachments: [] }), /exact output version/);
  assert.throws(() => write({ ...draft, refineSource: { ...draft.refineSource, version: 2 } }), /exact output version/);
  const saved = write(draft); assert.equal(saved.revision, f.draftRevision + 1);
  assert.equal(f.store.download(output.file!.id).bytes.toString(), 'Original answer');
}));


test('read-only archive and exact anchors preserve active cache, drafts, model and lifecycle', () => fixture(async f => {
  f.gateway.messages = [{role:'assistant',content:'Latest live answer',__openclaw:{id:'latest-entry',seq:8}}];
  const latest = await f.service.history(f.conversation.id), before = f.store.snapshot(f.device), conversation = f.service.conversations()[0];
  f.gateway.messages = [{role:'user',content:'Earlier matching words',__openclaw:{id:'old-entry',seq:2}},{role:'assistant',content:'Context surrounding it',__openclaw:{id:'old-answer',seq:3}}];
  const oldId = randomUUID();
  const read = await f.service.browse({epoch:f.store.epoch,conversationId:conversation.id,nativeId:oldId,messageId:'old-entry',role:'user'});
  assert.equal(read.nativeId,oldId); assert.equal(read.messages[0].id,'old-entry');
  assert.deepEqual(f.gateway.calls.at(-1),{method:'chat.history',params:{sessionKey:conversation.nativeKey,sessionId:oldId,limit:100,maxChars:300000,messageId:'old-entry'}});
  assert.deepEqual(f.store.internalRead(`assistant:history:${conversation.id}`),JSON.parse(JSON.stringify(latest)));
  assert.equal(f.service.cachedHistory(conversation.id)?.messages[0].text, 'Latest live answer');
  assert.deepEqual(f.store.snapshot(f.device),before);assert.deepEqual(f.service.conversations()[0],conversation);
  assert.equal(f.gateway.calls.filter(c=>['chat.send','sessions.patch'].includes(c.method)).length,0);
}));

test('missing anchored messages and returned native-ID mismatches never substitute the latest tail', () => fixture(async f => {
  f.gateway.messages=[{role:'assistant',content:'Different message',__openclaw:{id:'latest-entry',seq:8}}];
  const input={epoch:f.store.epoch,conversationId:f.conversation.id,nativeId:f.conversation.nativeId!,messageId:'missing-entry'};
  await assert.rejects(f.service.browse(input),/exact message is no longer available/);
  f.gateway.replaceSession=true;await assert.rejects(f.service.browse(input),/native conversation was replaced/);
  await assert.rejects(f.service.browse({...input,offset:1}),/cannot be combined/);
  assert.equal(f.store.internalRead(`assistant:history:${f.conversation.id}`),undefined);
  assert.equal(f.service.cachedHistory(f.conversation.id)?.messages.some(m => m.id === 'missing-entry'), false);
}));


test('Content source browsing retains the saved version and rejects a mismatched source hash without changing drafts', () => fixture(async f => {
  f.gateway.messages = [{ id: 'content-source', role: 'assistant', content: [{ type: 'text', text: 'Exact saved source' }] }];
  const history = await f.service.history(f.conversation.id), message = history.messages[0];
  const input = { epoch: f.store.epoch, conversationId: f.conversation.id, nativeId: f.conversation.nativeId, messageId: message.id, messageHash: message.textHash, role: 'assistant' };
  const before = f.store.snapshot(f.device).drafts;
  assert.equal((await f.service.browse(input)).messages[0].text, 'Exact saved source');
  f.gateway.messages = [{ id: 'content-source', role: 'assistant', content: [{ type: 'text', text: 'Revised source under the same ID' }] }];
  assert.equal((await f.service.browse(input)).messages[0].text, 'Exact saved source');
  await assert.rejects(f.service.browse({ ...input, messageHash: '0'.repeat(64) }), /source message has changed/);
  await assert.rejects(f.service.browse({ ...input, messageId: undefined }), /message anchor/);
  assert.deepEqual(f.store.snapshot(f.device).drafts, before);
}));


test('response effort and speed reach the native session and remain pending without matching readback', () => fixture(async f => {
  const changed = await f.service.edit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: f.conversation.revision, thinking: 'high', fastMode: true });
  const patch = f.gateway.calls.find(c => c.method === 'sessions.patch')!;
  assert.equal(patch.params.thinkingLevel, 'high'); assert.equal(patch.params.fastMode, true);
  assert.equal(changed.thinking, 'high'); assert.equal(changed.fastMode, true);
  f.gateway.rejectEdit = true;
  await assert.rejects(f.service.edit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: changed.id, expectedRevision: changed.revision, thinking: 'low', fastMode: false }), /not confirmed/);
  f.gateway.sessionInfo = { thinkingLevel: 'high', fastMode: true };
  await f.service.reconcile(changed.id); assert.ok(f.service.conversations()[0].pendingSettings);
  f.gateway.sessionInfo = { thinkingLevel: 'low', fastMode: false };
  await f.service.reconcile(changed.id); assert.equal(f.service.conversations()[0].thinking, 'low'); assert.equal(f.service.conversations()[0].pendingSettings, undefined);
}));

test('queue revisions and order retain originals, reject stale changes, and replay only their receipt', () => fixture(async f => {
  const a = queueDraft(f), b = queueDraft(f);
  const change = { requestId: randomUUID(), epoch: f.store.epoch, queueId: a.id, expectedRevision: a.revision, input: 'Revised direction' };
  const edited = f.service.editQueued(f.device, change);
  assert.deepEqual(edited.context, a.context); assert.equal(edited.input, 'Revised direction');
  assert.equal(f.service.editQueued(f.device, change).revision, edited.revision);
  assert.throws(() => f.service.editQueued(f.device, { ...change, requestId: randomUUID() }), /changed/);
  const order = { requestId: randomUUID(), epoch: f.store.epoch, conversationId: a.conversationId, items: [{ id: b.id, revision: b.revision }, { id: edited.id, revision: edited.revision }] };
  const reordered = f.service.reorderQueue(f.device, order);
  assert.deepEqual(reordered.map(q => q.id), [b.id, a.id]);
  assert.deepEqual(f.service.reorderQueue(f.device, order), reordered);
  assert.throws(() => f.service.reorderQueue(f.device, { ...order, requestId: randomUUID() }), /changed/);
  f.service.close(); const restored = new AssistantService(f.store, f.gateway);
  try { assert.deepEqual(restored.queue(), reordered); assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 0); } finally { restored.close(); }
}));

test('Deleted is reversible and prevents submission while retaining history and drafts', () => fixture(async f => {
  const deleted = await f.service.edit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, deleted: true });
  assert.equal(deleted.deleted, true); assert.equal(deleted.archived, true);
  assert.equal(f.gateway.calls.find(c => c.method === 'sessions.patch')!.params.archived, true);
  assert.throws(() => f.service.submit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: deleted.id, conversationRevision: deleted.revision, draftId: `draft:${f.device}`, draftRevision: f.draftRevision, projectRevision: 1 }), /Review the current/);
  assert.equal(f.store.readEntity('draft', `draft:${f.device}`)!.value.text, 'Use the selected context.');
  const restored = await f.service.edit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: deleted.id, expectedRevision: deleted.revision, deleted: false });
  assert.equal(restored.deleted, false); assert.equal(restored.archived, false); assert.equal(restored.nativeId, deleted.nativeId);
}));


test('editing a sent message branches once and keeps the original chat and its unsent draft', () => fixture(async f => {
  f.gateway.messages = [{ role: 'user', content: 'Original sent question', __openclaw: { id: 'source-user', seq: 1 } }];
  const history = await f.service.history(f.conversation.id), message = history.messages[0];
  const input = { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, nativeId: f.conversation.nativeId!, messageId: message.id, messageHash: message.textHash, purpose: 'edit', text: 'Revised question' };
  const branch = await f.service.fork(f.device, input);
  assert.equal(branch.state, 'ready'); assert.notEqual(branch.nativeId, f.conversation.nativeId);
  assert.equal(branch.forkSource?.messageId, message.id);
  assert.equal(f.store.readEntity('draft', `draft:${f.device}:${branch.id}`)!.value.text, 'Revised question');
  assert.equal(f.store.readEntity('draft', `draft:${f.device}`)!.value.text, 'Use the selected context.');
  assert.equal((await f.service.fork(f.device, input)).id, branch.id);
  assert.equal(f.gateway.calls.filter(c => c.method === 'sessions.fork').length, 1);
  assert.deepEqual(f.gateway.calls.find(c => c.method === 'sessions.fork')!.params, { sessionKey: f.conversation.nativeKey, entryId: 'source-user' });
  assert.equal(f.gateway.calls.some(c => c.method === 'chat.send'), false);
  assert.equal(f.service.conversations().find(c => c.id === f.conversation.id)?.nativeId, f.conversation.nativeId);
}));

test('steering keeps the original run active and never replays an uncertain direction', () => fixture(async f => {
  f.service.submit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: 1, draftId: `draft:${f.device}`, draftRevision: f.draftRevision, projectRevision: 1 }); await tick();
  const parent = f.service.operations()[0];
  f.gateway.emit({ runId: parent.nativeRunId, sessionKey: parent.nativeKey, seq: 1, stream: 'assistant', data: { text: 'Original work continues.' } });
  f.gateway.sessionInfo = { activeRunIds: [parent.nativeRunId], hasActiveRun: true };
  const draft = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId: `draft:${f.device}`, expectedRevision: f.draftRevision, payload: { ...emptyDraft, text: 'Use a shorter explanation.', projectId: f.projectId } });
  const input = { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: 1, draftId: draft.id, draftRevision: draft.revision, projectRevision: 1, targetOperationId: parent.id };
  f.gateway.rejectSend = true;
  const direction = f.service.submit(f.device, input, true); await tick();
  assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').at(-1)!.params.queueMode, 'steer');
  assert.equal(f.service.operations().find(o => o.id === parent.id)?.text, 'Original work continues.');
  assert.equal(f.service.operations().find(o => o.id === direction.id)?.state, 'unknown');
  f.service.submit(f.device, input, true); await tick();
  assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 2);
  assert.throws(() => f.service.submit(f.device, { ...input, requestId: randomUUID() }, true), /previous direction/);
}));


test('unconfirmed pin and unread changes require matching native readback', () => fixture(async f => {
  f.gateway.rejectEdit = true;
  await assert.rejects(f.service.edit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, pinned: true, unread: true }), /not confirmed/);
  await f.service.reconcile(f.conversation.id); assert.ok(f.service.conversations()[0].pendingSettings);
  f.gateway.sessionInfo = { pinned: true, unread: false };
  await f.service.reconcile(f.conversation.id); assert.ok(f.service.conversations()[0].pendingSettings);
  f.gateway.sessionInfo.unread = true;
  await f.service.reconcile(f.conversation.id); assert.equal(f.service.conversations()[0].pendingSettings, undefined); assert.equal(f.service.conversations()[0].pinned, true); assert.equal(f.service.conversations()[0].unread, true);
}));

test('unfinished conversations can move to Deleted and restore without a native session', () => fixture(async f => {
  const original = { ...f.conversation, nativeId: null, state: 'unknown' as const };
  f.store.internalWrite(`assistant:conversation:${original.id}`, original);
  const calls = f.gateway.calls.length, drafts = f.store.snapshot(f.device).drafts;
  const input = { requestId: randomUUID(), epoch: f.store.epoch, conversationId: original.id, expectedRevision: original.revision, deleted: true };
  const removed = await f.service.edit(f.device, input);
  assert.equal(removed.deleted, true); assert.equal(removed.archived, true); assert.equal(removed.nativeId, null);
  assert.equal((await f.service.edit(f.device, input)).revision, removed.revision);
  const restored = await f.service.edit(f.device, { ...input, requestId: randomUUID(), expectedRevision: removed.revision, deleted: false });
  assert.equal(restored.deleted, false); assert.equal(restored.state, 'unknown');
  assert.equal(f.gateway.calls.length, calls); assert.deepEqual(f.store.snapshot(f.device).drafts, drafts);
  await assert.rejects(f.service.edit(f.device, { ...input, requestId: randomUUID() }), /still changing/);
}));

test('permission changes require effective readback and retain mismatched changes for reconciliation', () => fixture(async f => {
  const originalRequest = f.gateway.request.bind(f.gateway);
  f.gateway.request = async <T>(method: string, raw: unknown): Promise<T> => {
    if (method === 'sessions.patch') { const p = raw as any; return { entry: { sessionId: f.conversation.nativeId, permissionMode: p.permissionMode === 'full' ? 'read-only' : p.permissionMode } } as T; }
    return originalRequest<T>(method, raw);
  };
  const changed = await f.service.edit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, permissionMode: 'guarded' });
  assert.equal(changed.permissionMode, 'guarded');
  await assert.rejects(f.service.edit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: changed.id, expectedRevision: changed.revision, permissionMode: 'full' }), /not confirmed/);
  assert.equal(f.service.conversations()[0].permissionMode, 'guarded');
  f.gateway.sessionInfo = { permissionMode: 'full', permissionModePending: true };
  await f.service.reconcile(changed.id); assert.ok(f.service.conversations()[0].pendingSettings);
  f.gateway.sessionInfo = { permissionMode: 'full', permissionModePending: false };
  await f.service.reconcile(changed.id); assert.equal(f.service.conversations()[0].permissionMode, 'full'); assert.equal(f.service.conversations()[0].pendingSettings, undefined);
}));

test('Plan and Research are retained with exact submitted inputs and affect runner instructions', async () => fixture(async f => {
  for (const mode of ['plan', 'research'] as const) {
    const draft = f.store.readEntity('draft', `draft:${f.device}`)!;
    const kept = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId: draft.id, expectedRevision: draft.revision, payload: { ...draft.value, workMode: mode } });
    const op = f.service.submit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: f.conversation.revision, draftId: draft.id, draftRevision: kept.revision, projectRevision: 1 });
    await tick();
    assert.equal(op.context.workMode, mode); assert.equal(op.input, draft.value.text);
    const sent = f.gateway.calls.filter(c => c.method === 'chat.send').at(-1)!;
    assert.match(sent.params.message, mode === 'plan' ? /selected Plan mode.*Produce a concrete plan/s : /selected Research mode.*cite direct source links/s);
    assert.ok(sent.params.message.endsWith(draft.value.text));
    const live = f.service.operations().find(o => o.id === op.id)!;
    f.gateway.emit({ runId: live.nativeRunId, sessionKey: live.nativeKey, seq: 10, stream: 'lifecycle', data: { phase: 'end' } }); await tick();
  }
}));

test('new automatic queue sends once after completion and stops after failure; older paused queues stay paused', async () => fixture(async f => {
  const input = { epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: f.conversation.revision, draftId: `draft:${f.device}`, draftRevision: f.draftRevision, projectRevision: 1 };
  const op = f.service.submit(f.device, { ...input, requestId: randomUUID() }); await tick();
  const queued = f.service.enqueue(f.device, { ...input, requestId: randomUUID(), automatic: true });
  await new Promise(r => setTimeout(r, 800)); assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 1);
  const live = f.service.operations().find(o => o.id === op.id)!;
  f.gateway.emit({ runId: live.nativeRunId, sessionKey: live.nativeKey, seq: 10, stream: 'lifecycle', data: { phase: 'end' } });
  await new Promise(r => setTimeout(r, 850));
  assert.equal(f.service.queue().find(q => q.id === queued.id)!.state, 'submitted');
  assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 2);
  const next = f.service.enqueue(f.device, { ...input, requestId: randomUUID(), automatic: true });
  const active = f.service.operations().find(o => o.requestId === queued.autoRequestId)!;
  f.gateway.emit({ runId: active.nativeRunId, sessionKey: active.nativeKey, seq: 10, stream: 'lifecycle', data: { phase: 'error' } });
  await new Promise(r => setTimeout(r, 850));
  assert.equal(f.service.queue().find(q => q.id === next.id)!.automatic, false);
  assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 2);
  const paused = queueDraft(f); await new Promise(r => setTimeout(r, 800));
  assert.equal(f.service.queue().find(q => q.id === paused.id)!.state, 'paused');
}));

test('a progress final cannot release queued work before the exact native terminal receipt', async () => fixture(async f => {
  const status = f.gateway.status.bind(f.gateway), request = f.gateway.request.bind(f.gateway);
  f.gateway.status = () => ({ ...status(), methods: [...status().methods, 'agent.wait'] });
  let receipt: any = { status: 'timeout' };
  f.gateway.request = async <T>(method: string, raw: unknown): Promise<T> => method === 'agent.wait' ? receipt : request<T>(method, raw);
  const input = submission(f), op = f.service.submit(f.device, input); await tick();
  const queued = f.service.enqueue(f.device, { ...input, requestId: randomUUID(), automatic: true });
  const live = f.service.operations().find(item => item.id === op.id)!;
  for (const listener of f.gateway.listeners) listener({ type: 'event', event: 'chat', payload: { runId: live.nativeRunId, sessionKey: live.nativeKey, state: 'final', message: { role: 'assistant', content: 'I will check now.' } } });
  f.gateway.emit({ runId: live.nativeRunId, sessionKey: live.nativeKey, seq: 1, stream: 'tool', data: { phase: 'start', toolCallId: 'still-working', name: 'fixture-read' } });
  await new Promise(resolve => setTimeout(resolve, 850));
  assert.equal(f.service.operations().find(item => item.id === op.id)!.state, 'running');
  assert.equal(f.service.queue().find(item => item.id === queued.id)!.state, 'paused');
  assert.equal(f.gateway.calls.filter(call => call.method === 'chat.send').length, 1);
  receipt = { runId: live.nativeRunId, status: 'ok', terminalReceipt: { runId: live.nativeRunId, sessionId: 'different-session', turnId: 'settled-turn', effective: { provider: 'fixture', model: 'verified' } }, terminalReply: { text: 'Actual final answer.' } };
  await f.service.reconcile(live.conversationId);
  assert.equal(f.service.operations().find(item => item.id === op.id)!.state, 'running');
  receipt.terminalReceipt.sessionId = live.nativeId;
  const deadline = Date.now() + 5000;
  while (f.service.queue().find(item => item.id === queued.id)!.state !== 'submitted' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
  const completed = f.service.operations().find(item => item.id === op.id)!;
  assert.equal(completed.state, 'completed'); assert.equal(completed.text, 'Actual final answer.'); assert.equal(completed.nativeTurnId, 'settled-turn');
  assert.equal(f.gateway.calls.filter(call => call.method === 'chat.send').length, 2);
}));

test('unavailable completion receipts retain the run for review and cannot start its follow-up', async () => fixture(async f => {
  const status = f.gateway.status.bind(f.gateway), request = f.gateway.request.bind(f.gateway);
  f.gateway.status = () => ({ ...status(), methods: [...status().methods, 'agent.wait'] });
  f.gateway.request = async <T>(method: string, raw: unknown): Promise<T> => { if (method === 'agent.wait') throw new Error('Connection lost during receipt read'); return request<T>(method, raw); };
  const input = submission(f), op = f.service.submit(f.device, input); await tick();
  const queued = f.service.enqueue(f.device, { ...input, requestId: randomUUID(), automatic: true });
  const live = f.service.operations().find(item => item.id === op.id)!;
  f.gateway.emit({ runId: live.nativeRunId, sessionKey: live.nativeKey, seq: 1, stream: 'lifecycle', data: { phase: 'end' } });
  await new Promise(resolve => setTimeout(resolve, 850));
  const kept = f.service.operations().find(item => item.id === op.id)!;
  assert.equal(kept.state, 'unknown'); assert.match(kept.error!, /not confirmed/);
  assert.equal(f.service.queue().find(item => item.id === queued.id)!.state, 'paused');
  assert.equal(f.gateway.calls.filter(call => call.method === 'chat.send').length, 1);
}));

test('pausing an automatic queue before editing cancels auto dispatch and guards saved revisions', async () => fixture(async f => {
  const item = f.service.enqueue(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: f.conversation.revision, draftId: `draft:${f.device}`, draftRevision: f.draftRevision, projectRevision: 1, automatic: true });
  const paused = f.service.setQueueState(f.device, { requestId: randomUUID(), epoch: f.store.epoch, queueId: item.id, expectedRevision: item.revision, state: 'paused' });
  assert.equal(paused.automatic, false);
  f.service.editQueued(f.device, { requestId: randomUUID(), epoch: f.store.epoch, queueId: item.id, expectedRevision: paused.revision, input: 'Revised and held.' });
  await new Promise(r => setTimeout(r, 850));
  assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 0);
  assert.equal(f.service.queue()[0].input, 'Revised and held.');
}));

test('automatic follow-up waits for delayed steering confirmation and then sends once', () => fixture(async f => {
  const input = { epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: f.conversation.revision, draftId: `draft:${f.device}`, draftRevision: f.draftRevision, projectRevision: 1 };
  const parent = f.service.submit(f.device, { ...input, requestId: randomUUID() }); await tick();
  const original = f.service.operations().find(o => o.id === parent.id)!;
  f.gateway.sessionInfo = { activeRunIds: [original.nativeRunId], hasActiveRun: true };
  const draft = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId: input.draftId, expectedRevision: f.draftRevision, payload: { ...emptyDraft, projectId: f.projectId, text: 'Use a shorter explanation.' } });
  const direction = f.service.submit(f.device, { ...input, draftRevision: draft.revision, requestId: randomUUID(), targetOperationId: original.id }, true); await tick();
  const queued = f.service.enqueue(f.device, { ...input, draftRevision: draft.revision, requestId: randomUUID(), automatic: true });
  f.gateway.sessionInfo = { activeRunIds: [], hasActiveRun: false };
  f.gateway.emit({ runId: original.nativeRunId, sessionKey: original.nativeKey, seq: 10, stream: 'lifecycle', data: { phase: 'end' } });
  await new Promise(r => setTimeout(r, 900));
  const waiting = f.service.queue().find(q => q.id === queued.id)!;
  assert.equal(waiting.automatic, true); assert.equal(waiting.state, 'paused'); assert.equal(waiting.autoError, undefined);
  assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 2);
  const steering = f.service.operations().find(o => o.id === direction.id)!;
  f.gateway.emit({ runId: steering.nativeRunId, sessionKey: steering.nativeKey, seq: 10, stream: 'lifecycle', data: { phase: 'end' } });
  await new Promise(r => setTimeout(r, 900));
  assert.equal(f.service.queue().find(q => q.id === queued.id)!.state, 'submitted');
  assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send' && c.params.idempotencyKey === queued.autoRequestId).length, 1);
  assert.equal(f.store.readEntity('draft', draft.id)!.value.text, 'Use a shorter explanation.');
}));

test('definite settings rejection releases Send and a later edit uses a fresh intent', () => fixture(async f => {
  const original = f.gateway.request.bind(f.gateway), drafts = f.store.snapshot(f.device).drafts;
  f.gateway.request = async <T>(method: string, raw: unknown): Promise<T> => {
    if (method === 'sessions.patch') throw new GatewayClientRequestError({ code: 'FORBIDDEN', message: 'missing scope: operator.admin' });
    return original<T>(method, raw);
  };
  const input = { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, permissionMode: 'full' };
  await assert.rejects(f.service.edit(f.device, input), { code: 'edit_rejected' });
  const current = f.service.conversations()[0];
  assert.equal(current.pendingSettings, undefined); assert.equal(current.permissionMode, 'read-only'); assert.equal(current.settingsResult?.requestId, input.requestId);
  assert.equal((await f.service.edit(f.device, input)).revision, current.revision);
  f.gateway.request = original;
  const renamed = await f.service.edit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: current.id, expectedRevision: current.revision, title: 'Recovered chat' });
  assert.equal(renamed.title, 'Recovered chat'); assert.equal(renamed.settingsResult?.state, 'completed'); assert.deepEqual(f.store.snapshot(f.device).drafts, drafts);
}));

test('unknown settings can keep verified current access without repeating a native mutation', () => fixture(async f => {
  f.gateway.rejectEdit = true;
  const originalId = randomUUID();
  await assert.rejects(f.service.edit(f.device, { requestId: originalId, epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, permissionMode: 'full' }), { code: 'edit_unknown' });
  const input = { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, pendingRequestId: originalId, action: 'use-current' };
  f.gateway.sessionInfo = { permissionMode: 'read-only', permissionModePending: true };
  await assert.rejects(f.service.recoverSettings(f.device, input), { code: 'settings_unverified' });
  assert.ok(f.service.conversations()[0].pendingSettings);
  f.gateway.sessionInfo.permissionModePending = false;
  const recovered = await f.service.recoverSettings(f.device, input);
  assert.equal(recovered.pendingSettings, undefined); assert.equal(recovered.permissionMode, 'read-only'); assert.equal(recovered.revision, 2);
  assert.equal((await f.service.recoverSettings(f.device, input)).revision, 2);
  assert.equal(f.gateway.calls.filter(c => c.method === 'sessions.patch').length, 1);
  assert.equal(f.store.internalRead<any>(`assistant:edit:${originalId}`).state, 'superseded');
}));

test('settings recovery fences native identity, revision, live voice and concurrent recovery', () => fixture(async f => {
  f.gateway.rejectEdit = true; const originalId = randomUUID();
  await assert.rejects(f.service.edit(f.device, { requestId: originalId, epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, permissionMode: 'full' }));
  const input = () => ({ requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, pendingRequestId: originalId, action: 'use-current' });
  await assert.rejects(f.service.recoverSettings(f.device, { ...input(), expectedRevision: 2 }), { code: 'conversation_changed' });
  f.service.setVoiceGuard(() => true); await assert.rejects(f.service.recoverSettings(f.device, input()), { code: 'settings_busy' }); f.service.setVoiceGuard(() => false);
  f.gateway.replaceSession = true; await assert.rejects(f.service.recoverSettings(f.device, input()), { code: 'session_replaced' }); f.gateway.replaceSession = false;
  f.gateway.sessionInfo = { permissionMode: 'read-only' };
  let finish!: () => void; f.gateway.holdHistory = new Promise(resolve => { finish = resolve; });
  const pending = f.service.recoverSettings(f.device, input());
  await assert.rejects(f.service.recoverSettings(f.device, { ...input(), action: 'retry' }), { code: 'settings_busy' });
  finish(); await pending;
  assert.equal(f.gateway.calls.filter(c => c.method === 'sessions.patch').length, 1);
}));

test('Full access create and explicit retry use the dedicated control; unknown retry is never automatic', () => fixture(async f => {
  f.service.close(); let calls = 0, fail = true;
  const service = new AssistantService(f.store, f.gateway, undefined, { request: async <T>(method: string, raw: unknown): Promise<T> => {
    calls++; const p = raw as any;
    if (fail) throw Error('Reply lost');
    if (method === 'sessions.create') return f.gateway.request<T>(method, raw);
    assert.equal(p.expectedSessionId, f.conversation.nativeId);
    return { entry: { sessionId: f.conversation.nativeId, permissionMode: 'full' } } as T;
  } });
  try {
    const originalId = randomUUID();
    await assert.rejects(service.edit(f.device, { requestId: originalId, epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, permissionMode: 'full' }), { code: 'edit_unknown' });
    const retry = { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, pendingRequestId: originalId, action: 'retry' };
    await assert.rejects(service.recoverSettings(f.device, retry), { code: 'edit_unknown' });
    assert.equal(calls, 2); await service.recoverSettings(f.device, retry); assert.equal(calls, 2);
    fail = false;
    assert.equal((await service.recoverSettings(f.device, { ...retry, requestId: randomUUID() })).permissionMode, 'full');
    assert.equal(calls, 3);
    const full = await service.create(f.device, { requestId: randomUUID(), epoch: f.store.epoch, title: 'Full access fixture', projectId: null, permissionMode: 'full' });
    assert.equal(full.state, 'ready'); assert.equal(full.pendingSettings, undefined);
    assert.equal(calls, 4);
  } finally { service.close(); }
}));

test('branching after a completed reply uses parent creation and before a later question uses its user boundary', () => fixture(async f => {
  f.gateway.messages = [{ role: 'user', content: 'First question', __openclaw: { id: 'question', seq: 1 } }, { role: 'assistant', content: 'Exact reply to keep', __openclaw: { id: 'answer', seq: 2 } }];
  const reply = (await f.service.history(f.conversation.id)).messages[1];
  const input = { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, nativeId: f.conversation.nativeId!, messageId: reply.id, messageHash: reply.textHash, purpose: 'branch' };
  const last = await f.service.fork(f.device, input); assert.equal(last.state, 'ready'); assert.equal(f.store.readEntity('draft', `draft:${f.device}:${last.id}`)!.value.text, '');
  const create = f.gateway.calls.find(c => c.method === 'sessions.create' && c.params.fork)!; assert.equal(create.params.parentSessionKey, f.conversation.nativeKey); assert.equal(create.params.forkFrom, 'last-completed'); assert.equal(create.params.emitCommandHooks, false); assert.equal(create.params.permissionMode, 'read-only'); assert.equal(create.params.message, undefined);
  f.gateway.messages.push({ role: 'user', content: 'Later question', __openclaw: { id: 'later-question', seq: 3 } }); await f.service.history(f.conversation.id);
  const earlier = await f.service.fork(f.device, { ...input, requestId: randomUUID() }); assert.equal(earlier.state, 'ready'); assert.equal(f.gateway.calls.find(c => c.method === 'sessions.fork')?.params.entryId, 'later-question');
  const child = await f.service.history(earlier.id); assert.deepEqual(child.messages.map(m => m.id), ['question', 'answer']); assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 0);
}));

test('a reply with no supported exact branch boundary is rejected without dispatching or silently keeping newer replies', () => fixture(async f => {
  f.gateway.messages = [{ role: 'assistant', content: 'Earlier answer', __openclaw: { id: 'answer', seq: 1 } }, { role: 'assistant', content: 'Later answer', __openclaw: { id: 'newer-answer', seq: 2 } }];
  const reply = (await f.service.history(f.conversation.id)).messages[0], before = f.gateway.calls.filter(c => ['sessions.create', 'sessions.fork'].includes(c.method)).length;
  const result = await f.service.fork(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, nativeId: f.conversation.nativeId!, messageId: reply.id, messageHash: reply.textHash, purpose: 'branch' });
  assert.equal(result.state, 'failed'); assert.match(result.error!, /complete reply/); assert.equal(f.gateway.calls.filter(c => ['sessions.create', 'sessions.fork'].includes(c.method)).length, before);
}));

test('a verified branch displays the original owner words from its native ancestry without leaking the app context envelope', () => fixture(async f => {
  const op = f.service.submit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: 1, draftId: `draft:${f.device}`, draftRevision: f.draftRevision, projectRevision: 1 }); await tick();
  const sent = f.gateway.calls.find(c => c.method === 'chat.send')!.params.message;
  f.store.internalWrite(`assistant:operation:${op.id}`, { ...f.service.operations()[0], state: 'completed' });
  f.gateway.messages = [{ role: 'user', content: sent, __openclaw: { id: 'original-question', seq: 1 } }, { role: 'assistant', content: 'Original response', __openclaw: { id: 'original-response', seq: 2 } }];
  const source = (await f.service.history(f.conversation.id)).messages[1];
  const branch = await f.service.fork(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, nativeId: f.conversation.nativeId!, messageId: source.id, messageHash: source.textHash, purpose: 'branch' });
  assert.equal(branch.state, 'ready'); const history = await f.service.history(branch.id);
  assert.equal(history.messages[0].authoredText, 'Use the selected context.'); assert.equal(history.messages[0].text, sent, 'native provenance remains exact');
  f.store.internalWrite(`assistant:conversation:${f.conversation.id}`, { ...f.conversation, nativeId: randomUUID() });
  assert.equal((await f.service.history(branch.id)).messages[0].authoredText, undefined, 'a replaced parent cannot lend its authority to the old branch');
}));

test('tool progress survives completion, late results, native history and restart without reopening a run', () => fixture(async f => {
  const queued = queueDraft(f), op = f.service.runQueued(f.device, { requestId: randomUUID(), epoch: f.store.epoch, queueId: queued.id, expectedRevision: queued.revision }); await tick();
  const running = f.service.operations().find(o => o.id === op.id)!;
  const emit = (seq: number, stream: string, data: unknown) => f.gateway.emit({ runId: running.nativeRunId, sessionKey: f.conversation.nativeKey, seq, stream, data });
  emit(1, 'tool', { phase: 'start', toolCallId: 'read-one', name: 'read' }); await tick(); assert.equal(f.service.operations()[0].tools?.[0].state, 'running');
  emit(3, 'lifecycle', { phase: 'end' }); await tick(); assert.equal(f.service.operations()[0].state, 'completed'); assert.equal(f.service.operations()[0].tools?.[0].state, 'unknown');
  emit(2, 'tool', { phase: 'result', toolCallId: 'read-one', name: 'read', isError: false, output: 'Exact fixture output' }); await tick();
  assert.equal(f.service.operations()[0].state, 'completed'); assert.equal(f.service.operations()[0].lastSequence, 3); assert.equal(f.service.operations()[0].tools?.[0].state, 'completed');
  f.gateway.messages = [{ role: 'toolResult', toolName: 'read', toolCallId: 'read-one', isError: false, content: [{ type: 'toolResult', text: 'Exact fixture output' }], __openclaw: { id: 'tool-result', runId: running.nativeRunId } }];
  const history = await f.service.history(f.conversation.id); assert.equal(history.messages[0].role, 'tool'); assert.equal(history.messages[0].toolInfo?.name, 'read'); assert.equal(history.messages[0].text, 'Exact fixture output'); assert.equal(f.service.operations()[0].tools?.[0].output, history.messages[0].text);
  f.service.close(); const restarted = new AssistantService(f.store, f.gateway); try { assert.equal(restarted.operations()[0].tools?.[0].output, 'Exact fixture output'); } finally { restarted.close(); }
}));

test('approval destination is prepared before dispatch and failure retains the unsent input', () => fixture(async f => {
  f.service.setApprovalReview(async () => { throw new Error('Review not ready'); });
  const queued = queueDraft(f); f.service.runQueued(f.device, { requestId: randomUUID(), epoch: f.store.epoch, queueId: queued.id, expectedRevision: queued.revision }); await tick();
  assert.equal(f.service.operations()[0].state, 'failed'); assert.equal(f.service.operations()[0].input, queued.input); assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 0);
}));


test('effort and speed use captured response authority with effective readback and ordinary history', () => fixture(async f => {
  f.service.close(); const ordinary = f.gateway.request.bind(f.gateway), controlled: { method: string; params: any }[] = [];
  f.gateway.request = async <T>(method: string, params: unknown) => { if (method === 'sessions.patch') throw Error('Response changes must use their own authority'); return ordinary<T>(method, params); };
  const service = new AssistantService(f.store, f.gateway, undefined, undefined, { request: async <T>(method: string, params: unknown) => { controlled.push({ method, params }); return ordinary<T>(method, params); } });
  try {
    const changed = await service.edit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, thinking: 'high', fastMode: true });
    assert.equal(changed.thinking, 'high'); assert.equal(changed.fastMode, true); assert.equal(changed.permissionMode, 'read-only'); assert.equal(changed.pendingSettings, undefined);
    assert.equal(controlled.length, 1); assert.equal(controlled[0].params.expectedSessionId, f.conversation.nativeId); assert.equal(controlled[0].params.permissionMode, undefined);
    const reset = await service.edit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: changed.id, expectedRevision: changed.revision, thinking: null, fastMode: null });
    assert.equal(reset.thinking, null); assert.equal(reset.fastMode, null); assert.equal(controlled.length, 2);
  } finally { service.close(); }
}));


test('shared Project files are verified, deduplicated and retained in captured context after removal', () => fixture(async f => {
  const draft = f.store.readEntity('draft', `draft:${f.device}`)!;
  const shared = f.store.upload(f.device, randomUUID(), f.store.epoch, 'shared.txt', Buffer.from('Shared source sentinel').toString('base64'));
  const saved = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project', entityId: f.projectId, expectedRevision: 1, payload: { name: 'Project A', purpose: 'Shared purpose', attachments: [shared, ...draft.value.attachments] } });
  const operation = f.service.submit(f.device, { ...submission(f), projectRevision: saved.revision }); await tick();
  const sent = f.gateway.calls.find(call => call.method === 'chat.send')!.params;
  assert.equal(sent.attachments.length, 2); assert.equal(Buffer.from(sent.attachments[0].content, 'base64').toString(), 'Shared source sentinel');
  assert.deepEqual(operation.context.project?.attachments, [shared, ...draft.value.attachments]);
  const oldEditor = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project', entityId: f.projectId, expectedRevision: saved.revision, payload: { name: 'Renamed Project', purpose: 'Updated purpose' } });
  assert.equal(f.store.readEntity('project', f.projectId)!.value.attachments?.length, 2, 'older name/purpose editors preserve files');
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project', entityId: f.projectId, expectedRevision: oldEditor.revision, payload: { name: 'Renamed Project', purpose: 'Updated purpose', attachments: [] } });
  assert.equal(f.service.operations()[0].context.project?.name, 'Project A');
  assert.equal(f.service.operations()[0].context.attachments[0].sha256, shared.sha256);
  assert.equal(f.store.download(shared.id).bytes.toString(), 'Shared source sentinel');
}));

test('Project source metadata cannot be forged and queued source changes require review', () => fixture(async f => {
  const file = f.store.readEntity('draft', `draft:${f.device}`)!.value.attachments[0];
  const change = { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project' as const, entityId: f.projectId, expectedRevision: 1, payload: { name: 'Project A', purpose: '', attachments: [{ ...file, sha256: '0'.repeat(64) }] } };
  assert.throws(() => f.store.mutate(f.device, change), /source could not be verified/);
  assert.equal(f.store.readEntity('project', f.projectId)!.revision, 1);
  f.store.mutate(f.device, { ...change, requestId: randomUUID(), payload: { ...change.payload, attachments: [file] } });
  const queued = f.service.enqueue(f.device, { ...submission(f), requestId: randomUUID(), projectRevision: 2 });
  assert.equal(queued.context.attachments.length, 1);
  f.store.mutate(f.device, { ...change, requestId: randomUUID(), expectedRevision: 2, payload: { ...change.payload, attachments: [] } });
  assert.throws(() => f.service.runQueued(f.device, { requestId: randomUUID(), epoch: f.store.epoch, queueId: queued.id, expectedRevision: queued.revision }), /Project context changed/);
  assert.equal(f.service.queue()[0].input, 'Use the selected context.');
  assert.equal(f.service.queue()[0].context.project?.attachments?.[0].id, file.id);
  assert.equal(f.gateway.calls.filter(call => call.method === 'chat.send').length, 0);
}));

test('combined Project and draft files honor the message limit without discarding writing', () => fixture(async f => {
  const files = Array.from({ length: 10 }, (_, index) => f.store.upload(f.device, randomUUID(), f.store.epoch, `shared-${index}.txt`, Buffer.from(`Source ${index}`).toString('base64')));
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project', entityId: f.projectId, expectedRevision: 1, payload: { name: 'Project A', purpose: '', attachments: files } });
  assert.throws(() => f.service.submit(f.device, { ...submission(f), projectRevision: 2 }), /up to 10 files/);
  assert.throws(() => f.service.enqueue(f.device, { ...submission(f), projectRevision: 2 }), /up to 10 files/);
  assert.equal(f.store.readEntity('draft', `draft:${f.device}`)!.value.text, 'Use the selected context.');
  assert.equal(f.service.operations().length, 0); assert.equal(f.gateway.calls.filter(call => call.method === 'chat.send').length, 0);
}));

test('text steering inherits shared Project files without resending them', () => fixture(async f => {
  const file = f.store.readEntity('draft', `draft:${f.device}`)!.value.attachments[0];
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project', entityId: f.projectId, expectedRevision: 1, payload: { name: 'Project A', purpose: '', attachments: [file] } });
  f.service.submit(f.device, { ...submission(f), projectRevision: 2 }); await tick();
  const parent = f.service.operations()[0]; f.gateway.sessionInfo = { activeRunIds: [parent.nativeRunId], hasActiveRun: true };
  const draft = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId: `draft:${f.device}`, expectedRevision: f.draftRevision, payload: { ...emptyDraft, text: 'Make the answer concise.', projectId: f.projectId } });
  const input = { ...submission(f), projectRevision: 2, draftRevision: draft.revision, targetOperationId: parent.id };
  const direction = f.service.submit(f.device, input, true); await tick();
  assert.deepEqual(direction.context.attachments, []); assert.deepEqual(direction.context.project, parent.context.project);
  const sends = f.gateway.calls.filter(call => call.method === 'chat.send'); assert.equal(sends.length, 2); assert.deepEqual(sends[1].params.attachments, []); assert.equal(sends[1].params.queueMode, 'steer');
}));

test('steering after shared Project sources change retains direction for queue review', () => fixture(async f => {
  f.service.submit(f.device, submission(f)); await tick();
  const parent = f.service.operations()[0]; f.gateway.sessionInfo = { activeRunIds: [parent.nativeRunId], hasActiveRun: true };
  const file = f.store.readEntity('draft', `draft:${f.device}`)!.value.attachments[0];
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project', entityId: f.projectId, expectedRevision: 1, payload: { name: 'Project A', purpose: '', attachments: [file] } });
  const draft = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId: `draft:${f.device}`, expectedRevision: f.draftRevision, payload: { ...emptyDraft, text: 'Use the new file.', projectId: f.projectId } });
  assert.throws(() => f.service.submit(f.device, { ...submission(f), projectRevision: 2, draftRevision: draft.revision, targetOperationId: parent.id }, true), /Project context changed since this reply started/);
  assert.equal(f.store.readEntity('draft', draft.id)!.value.text, 'Use the new file.');
  assert.equal(f.gateway.calls.filter(call => call.method === 'chat.send').length, 1);
}));


test('steering accepts the exact native visible reply when embedded activity omits its run list', () => fixture(async f => {
  const input = { epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: 1, draftId: `draft:${f.device}`, draftRevision: f.draftRevision, projectRevision: 1 };
  const parent = f.service.submit(f.device, { ...input, requestId: randomUUID() }); await tick();
  const original = f.service.operations().find(o => o.id === parent.id)!;
  f.gateway.sessionInfo = { activeRunIds: undefined, hasActiveRun: true };
  f.gateway.inFlightRun = { runId: original.nativeRunId!, text: 'Original work continues.' };
  const draft = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId: input.draftId, expectedRevision: f.draftRevision, payload: { ...emptyDraft, projectId: f.projectId, text: 'Change the final line.' } });
  const direction = f.service.submit(f.device, { ...input, draftRevision: draft.revision, requestId: randomUUID(), targetOperationId: original.id }, true); await tick();
  assert.equal(f.service.operations().find(o => o.id === direction.id)!.state, 'accepted');
  assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').at(-1)!.params.queueMode, 'steer');
  assert.equal(f.service.operations().find(o => o.id === parent.id)!.nativeRunId, original.nativeRunId);
}));

for (const kind of ['missing', 'different', 'contradictory', 'multiple'] as const) test(`steering rejects ${kind} native target evidence without sending`, () => fixture(async f => {
  const input = { epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: 1, draftId: `draft:${f.device}`, draftRevision: f.draftRevision, projectRevision: 1 };
  const parent = f.service.submit(f.device, { ...input, requestId: randomUUID() }); await tick();
  const original = f.service.operations().find(o => o.id === parent.id)!;
  f.gateway.sessionInfo = { activeRunIds: kind === 'multiple' ? [original.nativeRunId, 'other'] : kind === 'contradictory' ? [original.nativeRunId] : undefined, hasActiveRun: true };
  f.gateway.inFlightRun = kind === 'missing' ? undefined : { runId: kind === 'multiple' ? original.nativeRunId! : 'other', text: 'Native reply' };
  const draft = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId: input.draftId, expectedRevision: f.draftRevision, payload: { ...emptyDraft, projectId: f.projectId, text: 'Keep this direction.' } });
  const direction = f.service.submit(f.device, { ...input, draftRevision: draft.revision, requestId: randomUUID(), targetOperationId: original.id }, true); await tick();
  assert.equal(f.service.operations().find(o => o.id === direction.id)!.state, 'failed');
  assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 1);
  assert.equal(f.service.operations().find(o => o.id === direction.id)!.input, 'Keep this direction.');
}));


test('text and queued inputs capture explicit scoped memories and keep authored text separate from the native envelope', () => fixture(async f => {
  const memory = { requestId: randomUUID(), epoch: f.store.epoch, id: randomUUID(), expectedRevision: 0, action: 'save', text: 'Remember the cobalt-kite preference.', projectId: null };
  f.service.memory.change(f.device, memory);
  const queued = queueDraft(f);
  assert.equal(queued.context.memory!.entries[0].text, memory.text);
  f.service.memory.change(f.device, { requestId: randomUUID(), epoch: f.store.epoch, id: memory.id, expectedRevision: 1, action: 'remove' });
  const operation = f.service.runQueued(f.device, { requestId: randomUUID(), epoch: f.store.epoch, queueId: queued.id, expectedRevision: queued.revision }); await tick();
  const sent = f.gateway.calls.find(call => call.method === 'chat.send')!;
  assert.ok(sent.params.message.includes('cobalt-kite')); assert.deepEqual(operation.context.memory, queued.context.memory);
  f.gateway.messages = [{ role: 'user', content: sent.params.message, __openclaw: { id: 'memory-input', seq: 1, runId: operation.nativeRunId } }];
  const history = await f.service.history(f.conversation.id); assert.equal(history.messages[0].authoredText, 'Use the selected context.');
  const next = queueDraft(f); assert.deepEqual(next.context.memory!.entries, []);
}));

test('automatic titles follow native naming while a manual rename remains authoritative', async () => fixture(async f => {
  const chat = await f.service.create(f.device, { requestId: randomUUID(), epoch: f.store.epoch, title: 'New chat', autoTitle: true, projectId: null });
  const created = f.gateway.calls.filter(c => c.method === 'sessions.create').at(-1)!;
  assert.match(created.params.key, /^agent:main:dashboard:e3-/); assert.equal(created.params.label, undefined);
  f.gateway.sessionInfo = { displayName: 'Planning a garden' }; await f.service.history(chat.id);
  assert.equal(f.service.conversations().find(c => c.id === chat.id)!.title, 'Planning a garden');
  await f.service.edit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: chat.id, expectedRevision: chat.revision, title: 'My garden' });
  f.gateway.sessionInfo = { displayName: 'A later automatic title' }; await f.service.history(chat.id);
  assert.equal(f.service.conversations().find(c => c.id === chat.id)!.title, 'My garden');
}));

test('Goal uses the native goal-start admission and session effort, while Image requests the real generator', async () => fixture(async f => {
  for (const mode of ['goal', 'image'] as const) {
    const draft = f.store.readEntity('draft', `draft:${f.device}`)!;
    const saved = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId: draft.id, expectedRevision: draft.revision, payload: { ...draft.value, workMode: mode } });
    const op = f.service.submit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: f.conversation.revision, draftId: draft.id, draftRevision: saved.revision, projectRevision: 1 }); await tick();
    const sent = f.gateway.calls.filter(c => c.method === 'chat.send').at(-1)!;
    if (mode === 'goal') { assert.ok(sent.params.message.includes(op.input)); assert.match(sent.params.message, /silver-orbit-41/); assert.deepEqual(sent.params.intent, { kind: 'session-goal-start', version: 1, issuedAtMs: Date.parse(op.createdAt) }); assert.equal(sent.params.thinking, undefined); assert.equal(sent.params.fastMode, undefined); }
    else { assert.equal(sent.params.intent, undefined); assert.match(sent.params.message, /Generate an actual image/); }
    const live = f.service.operations().find(o => o.id === op.id)!;
    f.gateway.emit({ runId: live.nativeRunId, sessionKey: live.nativeKey, seq: 10, stream: 'lifecycle', data: { phase: 'end' } }); await tick();
  }
}));


test('structured plan survives reordered tool events and completion without inventing finished steps', () => fixture(async f => {
  const op = f.service.submit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: f.conversation.revision, draftId: `draft:${f.device}`, draftRevision: f.draftRevision, projectRevision: 1 });
  await tick(); const runId = f.service.state().operations.find(o => o.id === op.id)!.nativeRunId;
  const emit = (seq: number, stream: string, data: unknown) => f.gateway.emit({ runId, seq, stream, sessionKey: f.conversation.nativeKey, data });
  emit(1, 'tool', { name: 'progress_card', phase: 'start', toolCallId: 'plan1', args: { plan: [{ step: 'Read sources', status: 'in_progress' }, { step: 'Compare findings', status: 'pending' }] } });
  emit(5, 'assistant', { text: 'Found the source material.' });
  emit(3, 'plan', { steps: [{ label: 'Read sources', status: 'completed' }, { label: 'Compare findings', status: 'active' }] });
  emit(2, 'tool', { name: 'progress_card', phase: 'result', toolCallId: 'plan1', result: { plan: [{ step: 'Read sources', status: 'pending' }] } });
  emit(6, 'lifecycle', { phase: 'end' }); await tick();
  const saved = f.service.state().operations.find(o => o.id === op.id)!;
  assert.equal(saved.state, 'completed'); assert.equal(saved.plan?.length, 2);
  assert.deepEqual(saved.plan?.map(s => s.status), ['complete', 'active']);
  assert.equal(saved.planSequence, 3);
}));


test('a first-message title remains useful if the naming provider fails, without following later messages', () => fixture(async f => {
  const chat = await f.service.create(f.device, { requestId: randomUUID(), epoch: f.store.epoch, title: 'Voice chat', autoTitle: true, projectId: null });
  f.gateway.messages = [{ role: 'user', content: 'Help me with indoor basil watering and sunlight.', __openclaw: { id: 'first' } }];
  await f.service.history(chat.id);
  assert.equal(f.service.conversations().find(c => c.id === chat.id)!.title, 'Indoor basil watering and sunlight');
  f.gateway.messages = [{ role: 'user', content: 'A different later topic.', __openclaw: { id: 'later' } }];
  await f.service.history(chat.id);
  assert.equal(f.service.conversations().find(c => c.id === chat.id)!.title, 'Indoor basil watering and sunlight');
}));

test('resumed goals recover one exact native run after a lost acknowledgement and expose normal Stop', () => fixture(async f => {
  const draft = f.store.readEntity('draft', `draft:${f.device}`)!;
  const saved = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId: draft.id, expectedRevision: draft.revision, payload: { ...draft.value, workMode: 'goal' } });
  const first = f.service.submit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: f.conversation.revision, draftId: draft.id, draftRevision: saved.revision, projectRevision: 1 }); await tick();
  const source = f.service.operations().find(o => o.id === first.id)!;
  f.gateway.emit({ runId: source.nativeRunId, seq: 1, stream: 'lifecycle', data: { phase: 'end' } }); await tick();
  const goal = { id: randomUUID(), objective: 'Keep the captured project context.', status: 'paused', createdAt: 10000, pausedAt: 30000, updatedAt: 30000 }; let started = 0, lost = true;
  const nativeRequest = f.gateway.request.bind(f.gateway), receipts = new Set<string>();
  f.gateway.request = async <T>(method: string, params: any): Promise<T> => {
    if (method === 'sessions.describe') return { session: { sessionId: f.conversation.nativeId, goal } } as T;
    if (method === 'sessions.goal.update') {
      f.gateway.calls.push({ method, params });
      if (!receipts.has(params.operationId)) { receipts.add(params.operationId); started++; goal.status = 'active'; f.gateway.inFlightRun = { runId: 'exact-resumed-run', text: 'Continuing the goal.' }; }
      if (lost) { lost = false; throw Error('Acknowledgement lost'); }
      return { status: 'started', runId: 'exact-resumed-run' } as T;
    }
    return nativeRequest<T>(method, params);
  };
  const intent = { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, nativeId: f.conversation.nativeId, goalId: goal.id, issuedAtMs: Date.now(), action: 'resume' };
  await assert.rejects(f.service.changeGoal(f.device, intent), /lost/);
  await f.service.changeGoal(f.device, intent); const observedGoal = await f.service.goal(f.conversation.id);
  assert.equal(observedGoal.goal?.createdAt, 10000); assert.equal(observedGoal.goal?.updatedAt, 30000);
  assert.equal(started, 1); const runs = f.service.operations().filter(o => o.nativeRunId === 'exact-resumed-run'); assert.equal(runs.length, 1);
  await f.service.cancel(f.device, { requestId: randomUUID(), epoch: f.store.epoch, operationId: runs[0].id });
  assert.equal(f.gateway.calls.find(c => c.method === 'chat.abort')!.params.runId, 'exact-resumed-run');
  await assert.rejects(f.service.changeGoal(f.device, { ...intent, requestId: randomUUID(), nativeId: randomUUID() }), /original chat/);
  assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 1);
}));


test('Chat and Work keep separate titles, drafts, captured context and native identities', () => fixture(async f => {
  const workProject = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project', entityId: 'project:work', expectedRevision: 0, payload: { name: 'Work Project', purpose: 'Build it', instructions: 'Verify the result', space: 'work' } });
  await assert.rejects(f.service.create(f.device, { requestId: randomUUID(), epoch: f.store.epoch, title: 'Wrong space', space: 'work', projectId: f.projectId }), /Project in this space/);
  const request = { requestId: randomUUID(), epoch: f.store.epoch, title: f.conversation.title, projectId: workProject.id, space: 'work' };
  const work = await f.service.create(f.device, request);
  assert.equal(f.gateway.calls.filter(c => c.method === 'sessions.create').at(-1)!.params.cwd, f.store.readEntity('project', workProject.id)!.value.workspace?.folder);
  assert.equal(work.space, 'work'); assert.equal(work.title, f.conversation.title); assert.notEqual(work.nativeId, f.conversation.nativeId);
  assert.equal((await f.service.create(f.device, request)).id, work.id);
  const workDraft = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId: `draft:${f.device}:work`, expectedRevision: 0, payload: { ...emptyDraft, space: 'work', text: 'Work-only draft', projectId: workProject.id, workMode: 'research' } });
  assert.equal(f.store.readEntity('draft', `draft:${f.device}`)!.value.text, 'Use the selected context.');
  assert.throws(() => f.service.submit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: f.conversation.revision, draftId: workDraft.id, draftRevision: workDraft.revision, projectRevision: 1 }), /own conversation draft/);
  const operation = f.service.submit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: work.id, conversationRevision: work.revision, draftId: workDraft.id, draftRevision: workDraft.revision, projectRevision: 1 });
  await tick();
  assert.equal(operation.context.space, 'work'); assert.equal(operation.context.workMode, 'research'); assert.equal(operation.context.project?.id, workProject.id);
  assert.equal(f.gateway.calls.filter(c => c.method === 'sessions.create').at(-1)!.params.permissionMode, 'read-only');
  assert.equal(f.gateway.calls.filter(c => c.method === 'sessions.create').at(-1)!.params.space, undefined);
  assert.match(f.gateway.calls.find(c => c.method === 'chat.send')!.params.message, /Work space/);
  assert.equal(f.service.conversations().find(c => c.id === f.conversation.id)!.space, 'chat');
}));

test('Work change reviews use the captured native identity and reject a replaced session', () => fixture(async f => {
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project', entityId: 'project:review-work', expectedRevision: 0, payload: { name: 'Review', purpose: '', space: 'work' } });
  const c = await f.service.create(f.device, { requestId: randomUUID(), epoch: f.store.epoch, title: 'Review files', projectId: 'project:review-work', space: 'work' });
  const base = f.gateway.request.bind(f.gateway); let replaced = false;
  f.gateway.request = async <T>(method: string, params: any): Promise<T> => {
    if (method === 'sessions.describe') return { session: { sessionId: replaced ? randomUUID() : c.nativeId } } as T;
    if (method === 'sessions.diff') { assert.equal(params.sessionKey, c.nativeKey); return { sessionKey: c.nativeKey, additions: 1, deletions: 0, files: [{ path: 'proof.txt', status: 'added', additions: 1, deletions: 0, patch: '+verified' }] } as T; }
    return base<T>(method, params);
  };
  assert.equal((await f.service.workChanges(c.id)).files[0].path, 'proof.txt');
  replaced = true; await assert.rejects(f.service.workChanges(c.id), /original working session changed/);
  await assert.rejects(f.service.workChanges(f.conversation.id), /Work Project/);
  await assert.rejects(f.service.edit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: c.id, expectedRevision: c.revision, projectId: null }), /original working folder/);
}));

test('legacy Goal messages keep their original authored text when Goal reporting guidance changes',()=>fixture(async f=>{
 const op=f.service.submit(f.device,{requestId:randomUUID(),epoch:f.store.epoch,conversationId:f.conversation.id,conversationRevision:f.conversation.revision,draftId:`draft:${f.device}`,draftRevision:f.draftRevision,projectRevision:1});await tick();
 const live=f.service.operations().find(value=>value.id===op.id)!;
 f.store.internalWrite(`assistant:operation:${op.id}`,{...live,context:{...live.context,brandVersion:undefined,project:null,space:undefined,planning:undefined,computerControlGuidance:undefined,workMode:'goal',goalReporting:undefined}});
 const original='Edition 3 owner message:\nUse the selected context.';
 f.gateway.messages=[{role:'user',content:original,__openclaw:{id:'legacy-goal-entry'}}];
 const history=await f.service.history(f.conversation.id);assert.equal(history.messages[0].text,original);assert.equal(history.messages[0].authoredText,'Use the selected context.');
}));

for (const retained of [undefined, 'Original captured control instructions']) test(`queued computer-control guidance preserves ${retained ? 'its exact prior revision' : 'legacy absence'} through restart`, () => fixture(async f => {
  const queued = queueDraft(f);
  assert.equal(queued.context.computerControlGuidance, computerControlGuidance);
  const { digest: capturedDigest, ...captured } = queued.context;
  assert.equal(capturedDigest, createHash('sha256').update(canonical(captured)).digest('hex'));
  // A prior release's queue must not acquire the current release's instructions.
  const { computerControlGuidance: _current, ...older } = captured;
  const context = { ...older, ...(retained ? { computerControlGuidance: retained } : {}) };
  const saved = { ...queued, context: { ...context, digest: createHash('sha256').update(canonical(context)).digest('hex') } };
  f.store.internalWrite(`assistant:queue:${queued.id}`, saved);
  f.service.close(); const restarted = new AssistantService(f.store, f.gateway);
  try {
    const input = { requestId: randomUUID(), epoch: f.store.epoch, queueId: queued.id, expectedRevision: 1 };
    const op = restarted.runQueued(f.device, input); await tick();
    assert.deepEqual(op.context, saved.context);
    assert.equal(restarted.runQueued(f.device, input).id, op.id);
    const sends = f.gateway.calls.filter(c => c.method === 'chat.send'); assert.equal(sends.length, 1);
    assert.equal(sends[0].params.message.includes(computerControlGuidance), false);
    if (retained) assert(sends[0].params.message.includes(retained));
    f.gateway.messages = [{ role: 'user', content: sends[0].params.message, __openclaw: { id: 'captured-control-entry' } }];
    assert.equal((await restarted.history(f.conversation.id)).messages[0].authoredText, queued.input);
    assert.equal(restarted.conversations()[0].permissionMode, f.conversation.permissionMode);
  } finally { restarted.close(); }
}));

test('only the trusted team dispatcher captures immutable handoff read authority', () => fixture(async f => {
  const teamId = randomUUID(), original = randomUUID();
  const binding = { epoch: f.store.epoch, teamId, agentId: 'agent:fixture', agentRevision: 1, role: 'research', access: {}, handoffIds: [original] };
  const input = submission(f);
  assert.throws(() => f.service.submit(f.device, input, false, teamId), /saved team context/);
  f.store.internalWrite('team:conversation:' + f.conversation.id, binding);
  const operation = f.service.submit(f.device, input, false, teamId);
  assert.deepEqual(operation.context.teamHandoffs, { teamId, ids: [original] });
  const { digest, ...manifest } = operation.context;
  assert.equal(digest, createHash('sha256').update(canonical(manifest)).digest('hex'));
  f.store.internalWrite('team:conversation:' + f.conversation.id, { ...binding, handoffIds: [randomUUID()] });
  assert.deepEqual(f.service.submit(f.device, input, false, teamId).context.teamHandoffs, { teamId, ids: [original] });
  await tick();
}));

test('ordinary conversation submission cannot inherit team handoff authority from its binding', () => fixture(async f => {
  f.store.internalWrite('team:conversation:' + f.conversation.id, { epoch: f.store.epoch, teamId: randomUUID(), handoffIds: [randomUUID()] });
  assert.equal(f.service.submit(f.device, submission(f)).context.teamHandoffs, undefined);
  await tick();
}));

test('only the exact trusted review dispatch captures report authority and its immutable digest', () => fixture(async f => {
  const teamId = randomUUID(), input = submission(f);
  const review = { teamId, stage: 2, attempt: 1, agentId: 'agent:reviewer', agentRevision: 3, submitRequestId: input.requestId };
  const binding = { epoch: f.store.epoch, teamId, agentId: review.agentId, agentRevision: review.agentRevision, role: 'review', access: {}, handoffIds: [randomUUID()], review };
  for (const invalid of [{ ...binding, role: 'build' }, { ...binding, review: { ...review, submitRequestId: randomUUID() } }, { ...binding, review: { ...review, agentRevision: 4 } }]) {
    f.store.internalWrite('team:conversation:' + f.conversation.id, invalid);
    assert.throws(() => f.service.submit(f.device, input, false, teamId), /review stage no longer matches/);
  }
  f.store.internalWrite('team:conversation:' + f.conversation.id, binding);
  const operation = f.service.submit(f.device, input, false, teamId);
  assert.deepEqual(operation.context.teamReview, review);
  const { digest, ...manifest } = operation.context;
  assert.equal(digest, createHash('sha256').update(canonical(manifest)).digest('hex'));
  f.store.internalWrite('team:conversation:' + f.conversation.id, { ...binding, review: { ...review, attempt: 2 } });
  assert.deepEqual(f.service.submit(f.device, input, false, teamId).context.teamReview, review);
  await tick();
}));

test('a manual message in a reviewer conversation cannot acquire report or handoff authority', () => fixture(async f => {
  const teamId = randomUUID(), input = submission(f);
  f.store.internalWrite('team:conversation:' + f.conversation.id, { epoch: f.store.epoch, teamId, agentId: 'agent:reviewer', agentRevision: 1, role: 'review', access: {}, handoffIds: [randomUUID()], review: { teamId, stage: 2, attempt: 1, agentId: 'agent:reviewer', agentRevision: 1, submitRequestId: input.requestId } });
  const operation = f.service.submit(f.device, input);
  assert.equal(operation.context.teamReview, undefined);
  assert.equal(operation.context.teamHandoffs, undefined);
  await tick();
}));
