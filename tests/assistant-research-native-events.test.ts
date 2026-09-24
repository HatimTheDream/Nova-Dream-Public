import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventFrame } from '@openclaw/gateway-protocol/frame-guards';
import type { AssistantConnection, AssistantOperation } from '../packages/domain/assistant.js';
import { emptyDraft } from '../packages/domain/contracts.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { AssistantService } from '../apps/service/assistant.js';
import { Store } from '../apps/service/store.js';

// This fixture deliberately enters through the subscribed Gateway event route,
// not AssistantResearchProgress.observeNativeTool or a hand-written admission.
class Transport implements AssistantTransport {
  generation = randomUUID();
  ready = true;
  holdNextSend = false;
  pendingSend?: { runId: string; release(): void };
  sessions = new Map<string, string>();
  listeners = new Set<(event: EventFrame) => void>();
  status(): AssistantConnection { return { state: this.ready ? 'ready' : 'disconnected', generation: this.generation, message: 'Controlled native-event runtime', grantedScopes: ['operator.read', 'operator.write'], methods: ['e3.workspace.policy'], modelAuthReady: true }; }
  attachmentPolicy() { return { maxBytes: 10000, maxPayload: 200000 }; }
  models() { return Promise.resolve([]); }
  subscribe(fn: (event: EventFrame) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  publish(event: string, payload: Record<string, unknown>) { for (const fn of this.listeners) fn({ type: 'event', event, payload }); }
  emit(operation: AssistantOperation, seq: number, stream: string, data: unknown, patch: Record<string, unknown> = {}) {
    this.publish('agent', { runId: operation.nativeRunId, sessionKey: operation.nativeKey, seq, stream, data, ...patch });
  }
  async request<T>(method: string, params: any): Promise<T> {
    if (method === 'sessions.create') { const sessionId = randomUUID(); this.sessions.set(params.key, sessionId); return { key: params.key, sessionId, entry: { sessionId, permissionMode: params.permissionMode } } as T; }
    if (method === 'chat.history') return { sessionId: params.sessionId ?? this.sessions.get(params.sessionKey), messages: [], hasMore: false, sessionInfo: { activeRunIds: [], hasActiveRun: false } } as T;
    if (method === 'e3.workspace.policy') return { version: 1, protected: true, ...params, researchWorkflow: 'chat-research-v1' } as T;
    if (method === 'chat.send') {
      const runId = `native:${params.idempotencyKey}`;
      if (this.holdNextSend) { this.holdNextSend = false; await new Promise<void>(resolve => { this.pendingSend = { runId, release: resolve }; }); }
      return { runId } as T;
    }
    return {} as T;
  }
}
const eventually = async (predicate: () => boolean) => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(predicate(), 'the native-event transition settled'); };
const estimate = { expectedRevision: 0, activity: 'Reading the NASA explanation of axial tilt', basis: 'Reading two sources precedes comparing and verifying the report.', items: [
  { id: 'nasa', title: 'Read NASA', effort: 2, status: 'active' as const },
  { id: 'noaa', title: 'Read NOAA', effort: 2, status: 'pending' as const },
  { id: 'report', title: 'Compare and verify the report', effort: 3, status: 'pending' as const },
] };

async function fixture(t: TestContext, holdExecutionReceipt = false) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-research-native-events-'));
  const store = new Store(directory), device = store.session().deviceId, transport = new Transport(), service = new AssistantService(store, transport);
  t.after(() => { service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const conversation = await service.create(device, { requestId: randomUUID(), epoch: store.epoch, title: 'Seasons research', space: 'chat', projectId: null, model: 'openai/test' });
  const draft = store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'draft', entityId: `draft:${device}:${conversation.id}`, expectedRevision: 0, payload: { ...emptyDraft, space: 'chat', conversationId: conversation.id, text: 'Compare NASA and NOAA explanations of seasons.', workMode: 'research' } });
  const captured = service.submit(device, { requestId: randomUUID(), epoch: store.epoch, conversationId: conversation.id, conversationRevision: conversation.revision, draftId: draft.id, draftRevision: draft.revision, projectRevision: 0 });
  const get = (id: string) => service.operations().find(operation => operation.id === id)!;
  await eventually(() => get(captured.id).state === 'accepted');
  const preparation = get(captured.id);
  service.plans.propose({ epoch: store.epoch, nativeKey: preparation.nativeKey, nativeId: preparation.nativeId, runId: preparation.nativeRunId, toolCallId: randomUUID(), proposal: { title: 'Why Earth has seasons', summary: 'Compare two official explanations.', steps: ['Read NASA and NOAA', 'Compare and verify the report'], assumptions: [], verification: ['Cite both inspected sources'] } });
  transport.emit(preparation, 1, 'lifecycle', { phase: 'end' });
  await eventually(() => service.plans.list()[0].state === 'ready');
  transport.holdNextSend = holdExecutionReceipt;
  const plan = service.plans.list()[0], execution = service.plans.decide(device, { requestId: randomUUID(), epoch: store.epoch, id: plan.id, expectedRevision: plan.revision, version: plan.version, digest: plan.reviewDigest! });
  await eventually(() => holdExecutionReceipt ? Boolean(transport.pendingSend) : get(execution.id).state === 'accepted');
  const operation = get(execution.id);
  const request = (toolCallId: string, revision = 0) => ({ epoch: store.epoch, nativeKey: operation.nativeKey, nativeId: operation.nativeId, toolCallId, estimate: { ...estimate, expectedRevision: revision } });
  const start = (toolCallId: string, seq: number, patch: Record<string, unknown> = {}) => transport.emit(operation, seq, 'tool', { name: 'nova_research_progress', phase: 'start', toolCallId, hideFromChannelProgress: true }, patch);
  return { store, device, transport, service, conversation, preparation, operation, request, start, get: () => get(operation.id) };
}

test('early native event and report wait for the exact chat.send receipt before saving', async t => {
  const f = await fixture(t, true), receipt = f.transport.pendingSend!;
  assert.equal(f.get().state, 'dispatching'); assert.equal(f.get().nativeRunId, null);
  const pending = f.service.researchProgress.reportTool(f.request('before-receipt'));
  f.start('before-receipt', 1, { runId: receipt.runId });
  assert.equal(f.get().researchEstimate, undefined, 'an early event cannot authorize an unconfirmed dispatch');
  receipt.release();
  assert.deepEqual(await pending, { saved: true, revision: 1 });
  assert.equal(f.get().researchEstimate!.binding.nativeRunId, receipt.runId);
  assert.equal(f.get().researchEstimate!.observedSequence, 1);
});

test('authenticated native start admits a hidden progress tool before or after its HTTP report arrives', async t => {
  const f = await fixture(t);
  f.start('event-first', 1);
  assert.deepEqual(await f.service.researchProgress.reportTool(f.request('event-first')), { saved: true, revision: 1 });
  assert.equal(f.get().researchEstimate!.binding.nativeRunId, f.operation.nativeRunId);
  assert.equal(f.get().tools?.some(tool => tool.name === 'nova_research_progress') ?? false, false, 'hidden display rows are not the authorization source');
  const waiting = f.service.researchProgress.reportTool(f.request('http-first', 1));
  f.start('http-first', 2);
  assert.deepEqual(await waiting, { saved: true, revision: 2 });
  assert.equal(f.get().researchEstimate!.observedSequence, 2);
  assert.deepEqual(await f.service.researchProgress.reportTool(f.request('event-first')), { saved: true, revision: 1 });
  assert.equal(f.get().researchEstimate!.revision, 2, 'an exact transport retry cannot overwrite a later estimate');
  f.start('event-first', 3);
  await assert.rejects(f.service.researchProgress.reportTool({ ...f.request('event-first'), estimate: { ...estimate, activity: 'A changed payload on the old native call' } }));
  assert.equal(f.get().researchEstimate!.revision, 2);
});

test('history notifications, foreign sessions, foreign runs and wrong tool names cannot admit a report', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let settled = false;
  const pending = f.service.researchProgress.reportTool(f.request('untrusted'), controller.signal);
  void pending.then(() => { settled = true; }, () => { settled = true; });
  f.transport.publish('session.message', { runId: f.operation.nativeRunId, sessionKey: f.operation.nativeKey, sessionId: f.operation.nativeId, seq: 1, stream: 'tool', data: { name: 'nova_research_progress', phase: 'start', toolCallId: 'untrusted' } });
  f.start('untrusted', 2, { runId: randomUUID() });
  f.start('untrusted', 3, { sessionKey: 'agent:main:another-chat' });
  f.start('untrusted', 4, { sessionId: randomUUID() });
  f.transport.emit(f.operation, 5, 'tool', { name: 'web_search', phase: 'start', toolCallId: 'untrusted' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(settled, false, 'no non-matching event admitted the report');
  controller.abort(); await assert.rejects(pending);
  assert.equal(f.get().researchEstimate, undefined);
});

test('a native result observed before a delayed start cannot resurrect the call', async t => {
  const f = await fixture(t);
  f.transport.emit(f.operation, 2, 'tool', { name: 'nova_research_progress', phase: 'result', toolCallId: 'already-finished', isError: true });
  f.start('already-finished', 1);
  await assert.rejects(f.service.researchProgress.reportTool(f.request('already-finished')));
  assert.equal(f.get().researchEstimate, undefined);
});

for (const reason of ['stop', 'end', 'disconnect', 'close'] as const) test(`waiting native research reports settle without writes when ${reason} occurs`, async t => {
  const f = await fixture(t), started = Date.now();
  const waiting = f.service.researchProgress.reportTool(f.request(`waiting-${reason}`));
  const rejected = assert.rejects(waiting);
  if (reason === 'stop') await f.service.cancel(f.device, { requestId: randomUUID(), epoch: f.store.epoch, operationId: f.operation.id });
  else if (reason === 'end') f.transport.emit(f.operation, 1, 'lifecycle', { phase: 'end' });
  else if (reason === 'disconnect') { f.transport.ready = false; f.transport.generation = randomUUID(); f.transport.publish('e3.disconnected', {}); }
  else f.service.close();
  await rejected;
  assert.ok(Date.now() - started < 1000, 'run termination releases the waiter without waiting for the admission deadline');
  f.start(`waiting-${reason}`, 2);
  assert.equal(f.get().researchEstimate, undefined);
});
