import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventFrame } from '@openclaw/gateway-protocol/frame-guards';
import type { AssistantConnection, AssistantOperation, Conversation } from '../packages/domain/assistant.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { AssistantService } from '../apps/service/assistant.js';
import { Store } from '../apps/service/store.js';
import { emptyDraft } from '../packages/domain/contracts.js';
import { updateMaintenanceBlockers } from '../apps/service/update-maintenance.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
class Transport implements AssistantTransport {
  generation = randomUUID(); version = '2026.9.6'; sessionId = randomUUID();
  calls: { method: string; params: any }[] = [];
  receipts: unknown[] = []; waitReceipt: unknown; inFlightRun?: { runId: string; text: string };
  holdReceiptRead?: Promise<void>; receiptReadStarted = deferred();
  listeners = new Set<(event: EventFrame) => void>();
  status(): AssistantConnection { return { state: 'ready', generation: this.generation, message: 'Recovery fixture', grantedScopes: ['operator.read', 'operator.write'], methods: ['chat.history', 'agent.wait'], modelAuthReady: true }; }
  serviceInfo() { return { id: 'openclaw', name: 'OpenClaw', state: 'ready' as const, version: this.version }; }
  attachmentPolicy() { return { maxBytes: 10000, maxPayload: 100000 }; }
  models() { return Promise.resolve([]); }
  subscribe(listener: (event: EventFrame) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'chat.history') {
      if (params.inputRunIds) { this.receiptReadStarted.resolve(); await this.holdReceiptRead; }
      return { sessionId: this.sessionId, messages: [], hasMore: false, sessionInfo: { activeRunIds: this.inFlightRun ? [this.inFlightRun.runId] : [], hasActiveRun: !!this.inFlightRun }, inFlightRun: this.inFlightRun, ...(params.inputRunIds ? { inputReceipts: this.receipts } : {}) } as T;
    }
    if (method === 'chat.send') throw new Error('Acknowledgement lost after original submission');
    if (method === 'agent.wait') return (this.waitReceipt ?? { runId: params.runId, status: 'timeout' }) as T;
    throw new Error(`Unexpected call: ${method}`);
  }
}
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const directory = mkdtempSync(join(tmpdir(), 'nova-request-recovery-'));
  const store = new Store(directory), gateway = new Transport(), services: AssistantService[] = [];
  const at = new Date().toISOString(), device = store.session().deviceId;
  const conversation: Conversation = { id: randomUUID(), nativeId: gateway.sessionId, nativeKey: 'agent:main:request-recovery', revision: 1, connectionGeneration: gateway.generation, state: 'ready', title: 'Original work', projectId: null, archived: false, model: null, thinking: null, createdAt: at, updatedAt: at };
  store.internalWrite(`assistant:conversation:${conversation.id}`, conversation);
  const attachment = store.upload(device, randomUUID(), store.epoch, 'retained.txt', Buffer.from('Original attached bytes').toString('base64'));
  const draft = store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'draft', entityId: `draft:${device}:${conversation.id}`, expectedRevision: 0, payload: { ...emptyDraft, text: 'Retain this exact request.', attachments: [attachment], conversationId: conversation.id } });
  const operation: AssistantOperation = { id: randomUUID(), requestId: randomUUID(), deviceId: device, epoch: store.epoch, conversationId: conversation.id, conversationRevision: 1, connectionGeneration: gateway.generation, nativeKey: conversation.nativeKey, nativeId: conversation.nativeId!, nativeRunId: null, state: 'unknown', input: 'Retain this exact request.', context: { project: null, attachments: [attachment], draftId: draft.id, draftRevision: draft.revision, digest: 'b'.repeat(64) }, model: null, thinking: null, createdAt: at, updatedAt: at, text: '', lastSequence: 0, error: 'Original response uncertain.' };
  const seed = (value = operation) => store.internalWrite(`assistant:operation:${value.id}`, value);
  const start = () => { const service = new AssistantService(store, gateway); services.push(service); return service; };
  t.after(() => { services.forEach(service => service.close()); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, gateway, conversation, operation, draft, device, attachment, seed, start };
}

for(const version of ['2026.9.6','2026.9.8'])test(`${version}: lost acknowledgement survives restart, finds the original durable receipt and never resends`, async t => {
  const f = fixture(t); f.gateway.version=version; const original = f.start();
  const submission = { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: 1, draftId: f.draft.id, draftRevision: f.draft.revision, projectRevision: 0 };
  const submitted = original.submit(f.device, submission);
  for (let n = 0; n < 30 && original.operations().find(op => op.id === submitted.id)?.state !== 'unknown'; n++) await flush();
  const uncertain = original.operations().find(op => op.id === submitted.id)!;
  assert.equal(uncertain.state, 'unknown'); assert.equal(uncertain.nativeRunId, null);
  const drafts = f.store.snapshot(f.device).drafts;
  original.close(); const restored = f.start();
  f.gateway.receipts = [{ runId: submission.requestId, state: 'consumed', consumedByEventId: 'original-input-event' }];
  await restored.reconcile(f.conversation.id);
  const admitted = restored.operations().find(op => op.id === submitted.id)!;
  assert.equal(admitted.nativeRunId, submission.requestId); assert.equal(admitted.state, 'unknown', 'input consumption is not turn completion');
  f.gateway.waitReceipt = { runId: submission.requestId, status: 'ok', terminalReceipt: { runId: submission.requestId, sessionId: f.conversation.nativeId, turnId: 'verified-turn' }, terminalReply: { text: 'Verified original result' } };
  await restored.reconcile(f.conversation.id);
  const complete = restored.operations().find(op => op.id === submitted.id)!;
  assert.equal(complete.state, 'completed'); assert.equal(complete.text, 'Verified original result');
  assert.deepEqual(complete.context, uncertain.context); assert.equal(complete.input, uncertain.input);
  assert.deepEqual(f.store.snapshot(f.device).drafts, drafts);
  assert.equal(f.store.download(f.attachment.id).bytes.toString(), 'Original attached bytes');
  restored.submit(f.device, submission); await restored.reconcile(f.conversation.id);
  assert.equal(f.gateway.calls.filter(call => call.method === 'chat.send').length, 1);
  assert.ok(f.gateway.calls.some(call => call.method === 'chat.history' && call.params.inputRunIds?.includes(submission.requestId)));
  assert.equal(f.gateway.calls.some(call => call.method === 'chat.history' && call.params.sessionId && !call.params.messageId), false);
});

for(const version of ['2026.9.6','2026.9.8'])test(`${version}: queued input receipt establishes identity without claiming execution or completion`, async t => {
  const f = fixture(t); f.gateway.version=version; f.seed(); const service = f.start();
  f.gateway.receipts = [{ runId: f.operation.requestId, state: 'pending', queued:true }];
  await service.reconcile(f.conversation.id);
  const recovered = service.operations()[0];
  assert.equal(recovered.nativeRunId, f.operation.requestId); assert.equal(recovered.state, 'unknown');
  assert.deepEqual(recovered.context, f.operation.context);
  assert.equal(f.gateway.calls.some(call => ['chat.send', 'chat.abort'].includes(call.method)), false);
});

test('unknown without a native identity is never replayed by restart, reconnect, timer or duplicate submission', async t => {
  const f = fixture(t), original = f.start();
  const submission = { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: 1, draftId: f.draft.id, draftRevision: f.draft.revision, projectRevision: 0 };
  const submitted = original.submit(f.device, submission);
  for (let n = 0; n < 30 && original.operations().find(op => op.id === submitted.id)?.state !== 'unknown'; n++) await flush();
  const retained = original.operations().find(op => op.id === submitted.id)!;
  assert.equal(retained.state, 'unknown'); assert.equal(retained.nativeRunId, null);
  original.close(); f.store.setUpdateMaintenanceHeld(true); const restored = f.start();
  const drafts = f.store.snapshot(f.device).drafts;
  assert.equal(updateMaintenanceBlockers(f.store).some(blocker => blocker.kind === 'assistant'), false);
  t.mock.timers.tick(1500); await flush();
  f.store.setUpdateMaintenanceHeld(false);
  for (const listener of f.gateway.listeners) listener({ type: 'event', event: 'e3.connected', payload: { generation: f.gateway.generation } });
  t.mock.timers.tick(1500); await flush(); await restored.reconcile(f.conversation.id);
  assert.equal(restored.submit(f.device, submission).id, retained.id);
  await assert.rejects(async () => restored.submit(f.device, { ...submission, requestId: randomUUID() }), /existing run|reconcile/i);
  assert.deepEqual(restored.operations().find(op => op.id === retained.id), retained);
  assert.deepEqual(f.store.snapshot(f.device).drafts, drafts);
  assert.equal(f.gateway.calls.filter(call => call.method === 'chat.send').length, 1);
  assert.equal(f.gateway.calls.some(call => call.method === 'chat.abort'), false);
});

for (const invalid of ['missing', 'wrong-run', 'malformed-state', 'consumed-without-event', 'duplicate']) {
  test(`receipt recovery rejects ${invalid} proof without inventing an outcome`, async t => {
    const f = fixture(t); f.seed(); const service = f.start();
    const valid = { runId: f.operation.requestId, state: 'consumed', consumedByEventId: 'input-event' };
    f.gateway.receipts = invalid === 'missing' ? [] : invalid === 'wrong-run' ? [{ ...valid, runId: randomUUID() }] : invalid === 'malformed-state' ? [{ ...valid, state: 'complete' }] : invalid === 'consumed-without-event' ? [{ runId: valid.runId, state: 'consumed' }] : [valid, valid];
    await service.reconcile(f.conversation.id);
    assert.deepEqual(service.operations()[0], f.operation);
    assert.equal(updateMaintenanceBlockers(f.store).some(blocker => blocker.kind === 'assistant'), false, 'Retained uncertainty permits separate native qualification, not a terminal outcome.');
    assert.equal(f.gateway.calls.some(call => ['chat.send', 'chat.abort'].includes(call.method)), false);
  });
}

for(const version of ['2026.9.7','2026.9.9'])test(`${version}: unsupported runtime leaves receipt lookup disabled and original work unchanged`, async t => {
  const f = fixture(t); f.seed(); f.gateway.version = version; const service = f.start();
  f.gateway.receipts = [{ runId: f.operation.requestId, state: 'pending' }];
  await service.reconcile(f.conversation.id);
  assert.deepEqual(service.operations()[0], f.operation);
  assert.equal(f.gateway.calls.some(call => call.params.inputRunIds), false);
});

for (const drift of ['session', 'generation', 'conversation', 'operation']) {
  test(`receipt arriving after ${drift} replacement cannot bind original work`, async t => {
    const f = fixture(t); f.seed(); const service = f.start();
    const held = deferred(); f.gateway.holdReceiptRead = held.promise;
    f.gateway.receipts = [{ runId: f.operation.requestId, state: 'pending' }];
    const reading = service.reconcile(f.conversation.id); await f.gateway.receiptReadStarted.promise;
    if (drift === 'session') f.gateway.sessionId = randomUUID();
    if (drift === 'generation') f.gateway.generation = randomUUID();
    if (drift === 'conversation') f.store.internalWrite(`assistant:conversation:${f.conversation.id}`, { ...f.conversation, nativeId: randomUUID(), revision: 2 });
    if (drift === 'operation') f.seed({ ...f.operation, requestId: randomUUID() });
    held.resolve(); await reading.catch(() => undefined);
    assert.equal(service.operations()[0].nativeRunId, null); assert.equal(service.operations()[0].state, 'unknown');
    assert.equal(f.gateway.calls.some(call => ['chat.send', 'chat.abort'].includes(call.method)), false);
  });
}

test('prepared interruption is reported unsent only after the update hold ends', async t => {
  const f = fixture(t); const prepared = { ...f.operation, state: 'prepared' as const, error: undefined }; f.seed(prepared);
  f.store.setUpdateMaintenanceHeld(true); const service = f.start();
  assert.deepEqual(service.operations()[0], JSON.parse(JSON.stringify(prepared)));
  t.mock.timers.tick(1500); await flush(); assert.equal(f.gateway.calls.length, 0);
  f.store.setUpdateMaintenanceHeld(false); t.mock.timers.tick(750); await flush();
  const recovered = service.operations()[0];
  assert.equal(recovered.state, 'failed'); assert.equal(recovered.nativeRunId, null);
  assert.match(recovered.error ?? '', /not sent|never sent|before.*sent/i);
  assert.deepEqual(recovered.context, f.operation.context);
  assert.equal(f.gateway.calls.some(call => ['chat.send', 'chat.abort'].includes(call.method)), false);
});

test('only an exact active run in the original session can recover identity without a custody receipt', async t => {
  const f = fixture(t); f.seed(); const service = f.start();
  f.gateway.inFlightRun = { runId: randomUUID(), text: 'Unrelated progress' };
  await service.reconcile(f.conversation.id); assert.deepEqual(service.operations()[0], f.operation);
  f.gateway.inFlightRun = { runId: f.operation.requestId, text: 'Original progress' };
  await service.reconcile(f.conversation.id);
  assert.equal(service.operations()[0].nativeRunId, f.operation.requestId);
  assert.equal(service.operations()[0].state, 'running'); assert.equal(service.operations()[0].text, 'Original progress');
  assert.equal(f.gateway.calls.some(call => ['chat.send', 'chat.abort'].includes(call.method)), false);
});

for (const ending of ['acknowledged', 'rejected']) {
  test(`late ${ending} send response cannot downgrade a recovered active run`, async t => {
    const f = fixture(t), service = f.start(), entered = deferred();
    let accept!: (value: unknown) => void, reject!: (error: Error) => void;
    const acknowledgement = new Promise<unknown>((yes, no) => { accept = yes; reject = no; });
    const request = f.gateway.request.bind(f.gateway);
    f.gateway.request = async <T>(method: string, params: any): Promise<T> => {
      if (method !== 'chat.send') return request<T>(method, params);
      f.gateway.calls.push({ method, params }); entered.resolve(); return await acknowledgement as T;
    };
    const input = { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: 1, draftId: f.draft.id, draftRevision: f.draft.revision, projectRevision: 0 };
    const submitted = service.submit(f.device, input); await entered.promise;
    f.gateway.inFlightRun = { runId: input.requestId, text: 'Verified live progress' };
    await service.reconcile(f.conversation.id);
    if (ending === 'acknowledged') accept({ runId: input.requestId }); else reject(new Error('Delayed response lost'));
    await flush(); await flush();
    const original = service.operations().find(op => op.id === submitted.id)!;
    assert.equal(original.state, 'running'); assert.equal(original.nativeRunId, input.requestId); assert.equal(original.text, 'Verified live progress');
    assert.equal(f.gateway.calls.filter(call => call.method === 'chat.send').length, 1);
  });
}

test('a receipt response cannot change unknown work after maintenance starts', async t => {
  const f = fixture(t); f.seed(); const service = f.start(), held = deferred();
  f.gateway.holdReceiptRead = held.promise; f.gateway.receipts = [{ runId: f.operation.requestId, state: 'pending' }];
  const reading = service.reconcile(f.conversation.id); await f.gateway.receiptReadStarted.promise;
  f.store.setUpdateMaintenanceHeld(true); held.resolve(); await reading;
  assert.deepEqual(service.operations()[0], f.operation);
  assert.equal(f.gateway.calls.some(call => ['chat.send', 'chat.abort'].includes(call.method)), false);
});

test('lookup remains bounded and does not claim missing receipts for the remaining requests', async t => {
  const f = fixture(t);
  for (let n = 0; n < 53; n++) f.seed({ ...f.operation, id: randomUUID(), requestId: randomUUID() });
  const service = f.start(); await service.reconcile(f.conversation.id);
  const reads = f.gateway.calls.filter(call => call.params.inputRunIds);
  assert.equal(reads.length, 1); assert.equal(reads[0].params.inputRunIds.length, 50);
  assert.ok(service.operations().every(op => op.nativeRunId === null && op.state === 'unknown'));
});

test('revoked read permission rejects a delayed terminal receipt until access is restored', async t => {
  const f = fixture(t), operation = { ...f.operation, nativeRunId: f.operation.requestId }; f.seed(operation);
  const service = f.start(), entered = deferred(), held = deferred();
  const status = f.gateway.status.bind(f.gateway), request = f.gateway.request.bind(f.gateway);
  let readable = true;
  f.gateway.status = () => ({ ...status(), grantedScopes: readable ? ['operator.read', 'operator.write'] : ['operator.write'] });
  f.gateway.request = async <T>(method: string, params: any): Promise<T> => {
    if (method !== 'agent.wait') return request<T>(method, params);
    f.gateway.calls.push({ method, params }); entered.resolve(); await held.promise;
    return { runId: operation.nativeRunId, status: 'ok', terminalReceipt: { runId: operation.nativeRunId, sessionId: operation.nativeId }, terminalReply: { text: 'Original result after access is restored' } } as T;
  };
  const reading = service.reconcile(f.conversation.id); await entered.promise;
  readable = false; held.resolve(); await reading;
  assert.deepEqual(service.operations()[0], operation);
  readable = true; await service.reconcile(f.conversation.id);
  assert.equal(service.operations()[0].state, 'completed');
  assert.equal(service.operations()[0].text, 'Original result after access is restored');
  assert.equal(f.gateway.calls.some(call => ['chat.send', 'chat.abort'].includes(call.method)), false);
});
