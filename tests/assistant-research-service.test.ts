import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventFrame } from '@openclaw/gateway-protocol/frame-guards';
import type { AssistantConnection, AssistantOperation } from '../packages/domain/assistant.js';
import { canonical, emptyDraft } from '../packages/domain/contracts.js';
import { researchProgressGuidance, workModeInstructions } from '../packages/domain/work-mode.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { AssistantService } from '../apps/service/assistant.js';
import { Store } from '../apps/service/store.js';

class Transport implements AssistantTransport {
  generation = randomUUID(); researchWorkflow = true;
  messages: unknown[] = [];
  calls: { method: string; params: any }[] = []; sessions = new Map<string, string>(); listeners = new Set<(event: EventFrame) => void>();
  status(): AssistantConnection { return { state: 'ready', generation: this.generation, message: 'Controlled research runtime', grantedScopes: ['operator.read', 'operator.write'], methods: ['e3.workspace.policy'], modelAuthReady: true }; }
  attachmentPolicy() { return { maxBytes: 10000, maxPayload: 200000 }; }
  models() { return Promise.resolve([]); }
  subscribe(fn: (event: EventFrame) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  emit(operation: AssistantOperation, sequence: number, stream: string, data: unknown) { for (const fn of this.listeners) fn({ type: 'event', event: 'agent', payload: { runId: operation.nativeRunId, sessionKey: operation.nativeKey, seq: sequence, stream, data } }); }
  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'sessions.create') { const sessionId = randomUUID(); this.sessions.set(params.key, sessionId); return { key: params.key, sessionId, entry: { sessionId, permissionMode: params.permissionMode } } as T; }
    if (method === 'chat.history') return { sessionId: params.sessionId ?? this.sessions.get(params.sessionKey), messages: this.messages, hasMore: false, sessionInfo: { activeRunIds: [], hasActiveRun: false } } as T;
    if (method === 'e3.workspace.policy') return { version: 1, protected: true, ...params, ...(this.researchWorkflow ? { researchWorkflow: 'chat-research-v1' } : {}) } as T;
    if (method === 'chat.send') return { runId: `native:${params.idempotencyKey}` } as T;
    return {} as T;
  }
}
const eventually = async (predicate: () => boolean) => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(predicate(), 'the controlled runtime transition settled'); };
async function fixture(t: TestContext, space: 'chat' | 'work' = 'chat') {
  const directory = mkdtempSync(join(tmpdir(), 'nova-research-service-')), store = new Store(directory), device = store.session().deviceId, transport = new Transport(), service = new AssistantService(store, transport);
  t.after(() => { service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const conversation = await service.create(device, { requestId: randomUUID(), epoch: store.epoch, title: 'Heat pump research', space, projectId: null, model: 'openai/test' });
  const draft = store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'draft', entityId: `draft:${device}:${conversation.id}`, expectedRevision: 0, payload: { ...emptyDraft, space, conversationId: conversation.id, text: 'Compare heat pumps using current primary evidence.', workMode: 'research' } });
  const input = () => ({ requestId: randomUUID(), epoch: store.epoch, conversationId: conversation.id, conversationRevision: conversation.revision, draftId: draft.id, draftRevision: draft.revision, projectRevision: 0 });
  const get = (id: string) => service.operations().find(op => op.id === id)!;
  return { store, device, transport, service, conversation, draft, input, get };
}

test('Chat Research captures preparation, approves a distinct read-only native run, and settles from real run events', async t => {
  const f = await fixture(t), captured = f.service.submit(f.device, f.input()); await eventually(() => f.get(captured.id).state === 'accepted');
  const preparation = f.get(captured.id); assert.equal(preparation.context.researchWorkflow, 'chat-research-v1'); assert.ok(preparation.context.planReview); assert.equal(f.service.plans.list()[0].kind, 'research');
  assert.equal(preparation.context.researchProgressGuidance, researchProgressGuidance);
  assert.match(f.transport.calls.find(call => call.method === 'chat.send')!.params.message, /selected Deep research in Chat/);
  assert.equal(f.service.plans.toolPolicy({ epoch: f.store.epoch, nativeKey: preparation.nativeKey, nativeId: preparation.nativeId, runId: preparation.nativeRunId!, toolName: 'web_search' }).block, true);
  const proposal = { title: 'Heat pump evidence', summary: 'Compare real-world performance and total cost.', steps: ['Read primary sources', 'Reconcile assumptions', 'Write a cited report'], assumptions: [], verification: ['Sources support the main conclusions'] };
  f.service.plans.propose({ epoch: f.store.epoch, nativeKey: preparation.nativeKey, nativeId: preparation.nativeId, runId: preparation.nativeRunId, toolCallId: randomUUID(), proposal });
  f.transport.emit(preparation, 10, 'lifecycle', { phase: 'end' }); await eventually(() => f.service.plans.list()[0].state === 'ready');
  const item = f.service.plans.list()[0], decision = { requestId: randomUUID(), epoch: f.store.epoch, id: item.id, expectedRevision: item.revision, version: item.version, digest: item.reviewDigest! };
  const admitted = f.service.plans.decide(f.device, decision); await eventually(() => f.get(admitted.id).state === 'accepted');
  const execution = f.get(admitted.id); assert.equal(execution.context.workMode, 'research'); assert.ok(execution.context.approvedPlan); assert.equal(f.transport.calls.filter(call => call.method === 'chat.send').length, 2);
  const executionPrompt = f.transport.calls.filter(call => call.method === 'chat.send').at(-1)!.params.message; assert.match(executionPrompt, /exact approved research plan/); assert.match(executionPrompt, /Cite only sources actually inspected/); assert.doesNotMatch(executionPrompt, /selected Deep research in Chat/);
  assert.equal(execution.context.researchProgressGuidance, researchProgressGuidance); assert.ok(executionPrompt.includes(researchProgressGuidance));
  const policyInput = { epoch: f.store.epoch, nativeKey: execution.nativeKey, nativeId: execution.nativeId, runId: execution.nativeRunId! };
  assert.equal(f.service.plans.toolPolicy({ ...policyInput, toolName: 'web_search' }).block, false); assert.equal(f.service.plans.toolPolicy({ ...policyInput, toolName: 'exec' }).block, true);
  f.transport.emit(execution, 1, 'tool', { name: 'web_search', phase: 'start', toolCallId: 'search-1', args: { query: 'heat pump field study' } });
  f.transport.emit(execution, 2, 'tool', { name: 'web_search', phase: 'result', toolCallId: 'search-1', isError: false, result: { content: [{ type: 'text', text: 'Controlled source result' }] } });
  f.transport.emit(execution, 3, 'assistant', { text: 'A cited report based on the observed source results.' }); f.transport.emit(execution, 4, 'lifecycle', { phase: 'end' });
  await eventually(() => f.service.plans.list()[0].state === 'completed'); assert.equal(f.get(execution.id).tools?.[0].state, 'completed'); assert.equal(f.get(execution.id).text, 'A cited report based on the observed source results.');
  assert.equal(f.service.plans.decide(f.device, decision).id, execution.id); assert.equal(f.transport.calls.filter(call => call.method === 'chat.send').length, 2);
});

test('Work Research keeps direct sourced instructions and never creates Chat research review', async t => {
  const f = await fixture(t, 'work'); f.transport.researchWorkflow = false;
  const captured = f.service.submit(f.device, f.input()); await eventually(() => f.get(captured.id).state === 'accepted');
  assert.equal(captured.context.space, 'work'); assert.equal(captured.context.researchWorkflow, undefined); assert.equal(captured.context.planReview, undefined); assert.equal(f.service.plans.list().length, 0);
  assert.ok(f.transport.calls.find(call => call.method === 'chat.send')!.params.message.includes(workModeInstructions('research')));
  assert.equal(captured.context.researchProgressGuidance, undefined); assert.equal(f.transport.calls.find(call => call.method === 'chat.send')!.params.message.includes(researchProgressGuidance), false);
});

test('an older bridge refuses new Chat Deep research before send and preserves the request', async t => {
  const f = await fixture(t); f.transport.researchWorkflow = false;
  const captured = f.service.submit(f.device, f.input()); await eventually(() => f.get(captured.id).state === 'failed');
  assert.equal(f.transport.calls.some(call => call.method === 'chat.send'), false); assert.equal(f.get(captured.id).input, (f.draft.value as { text: string }).text); assert.match(f.get(captured.id).error!, /prepare and review Deep research plans/); assert.equal(f.service.plans.list()[0].autoStartAt, undefined);
});

test('a queued Research request captured before this workflow retains its original direct semantics', async t => {
  const f = await fixture(t), queued = f.service.enqueue(f.device, f.input());
  assert.equal(f.service.plans.list().length, 0, 'queue capture is not active preparation');
  const { researchWorkflow: _workflow, researchProgressGuidance: _progress, digest: _digest, ...context } = queued.context;
  f.store.internalWrite(`assistant:queue:${queued.id}`, { ...queued, context: { ...context, digest: createHash('sha256').update(canonical(context)).digest('hex') } });
  f.transport.researchWorkflow = false;
  const captured = f.service.runQueued(f.device, { requestId: randomUUID(), epoch: f.store.epoch, queueId: queued.id, expectedRevision: queued.revision }); await eventually(() => f.get(captured.id).state === 'accepted');
  assert.equal(captured.context.researchWorkflow, undefined); assert.equal(f.service.plans.list().length, 0); assert.ok(f.transport.calls.find(call => call.method === 'chat.send')!.params.message.includes(workModeInstructions('research')));
  assert.equal(captured.context.researchProgressGuidance, undefined); assert.equal(f.transport.calls.find(call => call.method === 'chat.send')!.params.message.includes(researchProgressGuidance), false);
});

for (const retained of [undefined, 'Keep the original public activity wording.']) test(`queued Chat Research preserves ${retained ? 'captured progress guidance' : 'legacy guidance absence'} and exact native history`, async t => {
  const f = await fixture(t), queued = f.service.enqueue(f.device, f.input());
  const { digest: _digest, researchProgressGuidance: _progress, ...older } = queued.context;
  const context = { ...older, ...(retained ? { researchProgressGuidance: retained } : {}) };
  f.store.internalWrite(`assistant:queue:${queued.id}`, { ...queued, context: { ...context, digest: createHash('sha256').update(canonical(context)).digest('hex') } });
  const captured = f.service.runQueued(f.device, { requestId: randomUUID(), epoch: f.store.epoch, queueId: queued.id, expectedRevision: queued.revision }); await eventually(() => f.get(captured.id).state === 'accepted');
  const preparation = f.get(captured.id), sent = f.transport.calls.find(call => call.method === 'chat.send')!.params.message as string;
  assert.equal(preparation.context.researchProgressGuidance, retained); assert.equal(sent.includes(researchProgressGuidance), false); if (retained) assert.ok(sent.includes(retained));
  f.transport.messages = [{ role: 'user', content: sent, __openclaw: { id: 'original-research-request' } }];
  const history = await f.service.history(f.conversation.id); assert.equal(history.messages[0].text, sent, 'the saved native envelope stays byte-for-byte unchanged'); assert.equal(history.messages[0].authoredText, queued.input, 'historical guidance still reconstructs the owner message');
  const proposal = { title: 'Heat pump evidence', summary: 'Compare measured efficiency.', steps: ['Read primary sources', 'Write a report'], assumptions: [], verification: ['Cite inspected evidence'] };
  f.service.plans.propose({ epoch: f.store.epoch, nativeKey: preparation.nativeKey, nativeId: preparation.nativeId, runId: preparation.nativeRunId, toolCallId: randomUUID(), proposal });
  f.transport.emit(preparation, 10, 'lifecycle', { phase: 'end' }); await eventually(() => f.service.plans.list()[0].state === 'ready');
  const item = f.service.plans.list()[0], admitted = f.service.plans.decide(f.device, { requestId: randomUUID(), epoch: f.store.epoch, id: item.id, expectedRevision: item.revision, version: item.version, digest: item.reviewDigest! }); await eventually(() => f.get(admitted.id).state === 'accepted');
  assert.equal(f.get(admitted.id).context.researchProgressGuidance, retained ?? researchProgressGuidance, 'a new execution captures guidance while retaining an existing exact revision');
  assert.equal(f.get(preparation.id).context.researchProgressGuidance, retained, 'approval never rewrites the original preparation');
});

test('a newly queued Chat Research request creates its exact review only at admission', async t => {
  const f = await fixture(t), queued = f.service.enqueue(f.device, f.input()); assert.equal(queued.context.researchWorkflow, 'chat-research-v1'); assert.equal(f.service.plans.list().length, 0);
  const input = { requestId: randomUUID(), epoch: f.store.epoch, queueId: queued.id, expectedRevision: queued.revision }, captured = f.service.runQueued(f.device, input); await eventually(() => f.get(captured.id).state === 'accepted');
  assert.equal(f.service.plans.list().length, 1); assert.equal(f.service.plans.list()[0].kind, 'research'); assert.equal(f.service.runQueued(f.device, input).context.planReview?.id, captured.context.planReview?.id);
});
