import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantOperation, Conversation } from '../packages/domain/assistant.js';
import type { AssistantPlan } from '../packages/domain/assistant-plan.js';
import { canonical } from '../packages/domain/contracts.js';
import { AssistantResearchProgress } from '../apps/service/assistant-research-progress.js';
import { AssistantPlans } from '../apps/service/assistant-plans.js';
import { Fault, Store } from '../apps/service/store.js';

const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const estimate = { expectedRevision: 0, activity: 'Reading the measured winter field study', basis: 'One field study requires more comparison than two brief specifications.', items: [
  { id: 'study', title: 'Read the winter field study', effort: 8, status: 'active' as const },
  { id: 'specs', title: 'Compare the two specifications', effort: 3, status: 'pending' as const },
  { id: 'report', title: 'Write and check the cited report', effort: 5, status: 'pending' as const },
] };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-research-estimate-')), store = new Store(directory), at = new Date().toISOString();
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const conversation: Conversation = { id: randomUUID(), nativeId: randomUUID(), nativeKey: 'agent:main:e3:research-fixture', space: 'chat', revision: 1, connectionGeneration: randomUUID(), state: 'ready', title: 'Research', projectId: null, permissionMode: 'read-only', archived: false, model: 'openai/test', thinking: 'auto', createdAt: at, updatedAt: at };
  const planId = randomUUID(), operationId = randomUUID(), proposal = { title: 'Heat pump evidence', summary: 'Compare field evidence and specifications.', steps: ['Inspect evidence', 'Produce a cited report'], assumptions: [], verification: ['Citations support the findings'] }, planDigest = hash(proposal);
  const context = { space: 'chat' as const, workMode: 'research' as const, researchWorkflow: 'chat-research-v1' as const, approvedPlan: { id: planId, version: 1, digest: planDigest, proposal }, project: null, attachments: [], draftId: 'draft', draftRevision: 1 };
  const operation: AssistantOperation = { id: operationId, requestId: randomUUID(), deviceId: store.session().deviceId, epoch: store.epoch, conversationId: conversation.id, conversationRevision: 1, connectionGeneration: conversation.connectionGeneration, nativeKey: conversation.nativeKey, nativeId: conversation.nativeId!, nativeRunId: randomUUID(), state: 'running', input: 'Compare heat pumps.', context: { ...context, digest: hash(context) }, model: conversation.model, thinking: 'auto', createdAt: at, updatedAt: at, text: '', lastSequence: 3 };
  const plan: AssistantPlan = { id: planId, kind: 'research', epoch: store.epoch, conversationId: conversation.id, revision: 3, version: 1, state: 'implementing', versions: [{ version: 1, operationId: randomUUID(), createdAt: at, proposal, digest: planDigest }], approval: { requestId: randomUUID(), version: 1, digest: planDigest, operationId, approvedAt: at }, permissionMode: 'read-only', sourceContext: operation.context, createdAt: at, updatedAt: at };
  store.internalWrite(`assistant:plan:${planId}`, plan); store.internalWrite(`assistant:operation:${operationId}`, operation);
  let ready = true;
  const host = { operations: () => store.internalList<AssistantOperation>('assistant:operation:'), conversation: () => conversation, assertReady: () => { if (!ready) throw new Error('Disconnected'); }, save: (op: AssistantOperation) => store.internalWrite(`assistant:operation:${op.id}`, op), operation: (id: string) => store.internalRead<AssistantOperation>(`assistant:operation:${id}`)!, dispatch: () => {} };
  const progress = new AssistantResearchProgress(store, host), plans = new AssistantPlans(store, host);
  const request = () => ({ epoch: store.epoch, nativeKey: operation.nativeKey, nativeId: operation.nativeId, runId: operation.nativeRunId!, toolCallId: randomUUID(), estimate });
  return { store, conversation, operation, plan, progress, plans, request, get: () => host.operation(operationId), save: host.save, disconnect: () => { ready = false; } };
}

test('Research reports persist task effort and exact context; replay does not reapply or overwrite a later revision', t => {
  const f = fixture(t), request = f.request();
  assert.deepEqual(f.progress.report(request), { saved: true, revision: 1 });
  const first = f.get().researchEstimate!;
  assert.deepEqual(first.items.map(item => item.effort), [8, 3, 5]); assert.equal(first.observedSequence, 3);
  assert.deepEqual(first.binding, { operationId: f.operation.id, epoch: f.store.epoch, nativeRunId: f.operation.nativeRunId, planId: f.plan.id, planVersion: 1, planDigest: f.plan.approval!.digest });
  const second = { ...f.request(), estimate: { ...estimate, expectedRevision: 1, items: estimate.items.map(item => item.id === 'study' ? { ...item, status: 'complete' as const } : item) } };
  assert.equal(f.progress.report(second).revision, 2);
  assert.deepEqual(new AssistantResearchProgress(f.store, { operations: () => [f.get()], conversation: () => f.conversation, assertReady: () => {}, save: f.save }).report(request), { saved: true, revision: 1 });
  assert.equal(f.get().researchEstimate!.revision, 2); assert.equal(f.get().researchEstimate!.items[0].status, 'complete');
  assert.throws(() => f.progress.report({ ...request, estimate: { ...estimate, activity: 'Different payload on the same call' } }), /different update/);
  assert.throws(() => f.progress.report(f.request()), (error:unknown) => error instanceof Fault && error.code === 'research_progress_revision' && (error.current as any).revision === 2 && (error.current as any).estimate.items[0].status === 'complete');
  assert.equal(f.get().researchEstimate!.revision, 2);
});

test('Research reports cannot invent delivery, rewrite completed effort, or accept invalid public payloads', t => {
  const f = fixture(t);
  f.progress.report({ ...f.request(), estimate: { ...estimate, items: estimate.items.map(item => item.id === 'study' ? { ...item, status: 'complete' as const } : item) } });
  for (const items of [estimate.items.map(item => ({ ...item, status: 'complete' as const })), estimate.items.map(item => item.id === 'study' ? { ...item, effort: 1, status: 'complete' as const } : item)]) {
    assert.throws(() => f.progress.report({ ...f.request(), estimate: { ...estimate, expectedRevision: 1, items } }));
  }
  assert.throws(() => f.progress.report({ ...f.request(), estimate: { ...estimate, activity: 'x'.repeat(241) } }));
  assert.throws(() => f.progress.report({ ...f.request(), estimate: { ...estimate, percent: 99 } }));
  assert.equal(f.get().researchEstimate!.revision, 1);
});

for (const state of ['prepared', 'dispatching', 'unknown', 'completed', 'failed', 'cancelled'] as const) test(`Research report rejects ${state}, including a replay of an earlier successful call`, t => {
  const f = fixture(t), request = f.request(); f.progress.report(request); f.save({ ...f.get(), state });
  assert.throws(() => f.progress.report(request), /active/); assert.equal(f.get().researchEstimate!.revision, 1);
});

test('Stop, wrong native run/session/epoch, connection change, and altered captured context cannot report progress', t => {
  const f = fixture(t), request = f.request();
  for (const patch of [{ runId: randomUUID() }, { nativeId: randomUUID() }, { nativeKey: 'agent:main:other' }, { epoch: randomUUID() }]) assert.throws(() => f.progress.report({ ...request, ...patch }));
  for (const patch of [{ cancelRequested: true }, { steerTarget: randomUUID() }, { nativeRunId: null }, { connectionGeneration: randomUUID() }, { context: { ...f.operation.context, digest: '0'.repeat(64) } }]) {
    f.save({ ...f.operation, ...patch }); assert.throws(() => f.progress.report(request));
  }
  f.save(f.operation); f.conversation.revision++; assert.throws(() => f.progress.report(request), /conversation changed/);
  f.conversation.revision--; f.disconnect(); assert.throws(() => f.progress.report(request), /Disconnected/);
  assert.equal(f.get().researchEstimate, undefined);
});

test('tool policy permits only the exact active approved Chat Research run, never preparation, Plan, Work, or an unrelated latest run', t => {
  const f = fixture(t), { estimate: _estimate, toolCallId: _call, ...binding } = f.request(), policy = { ...binding, toolName: 'nova_research_progress' };
  assert.equal(f.plans.toolPolicy(policy).block, false);
  assert.equal(f.plans.toolPolicy({ ...policy, runId: undefined }).block, true);
  for (const context of [{ ...f.operation.context, space: 'work' as const }, { ...f.operation.context, workMode: 'plan' as const }, { ...f.operation.context, approvedPlan: undefined }, { ...f.operation.context, planReview: { id: f.plan.id, version: 1 } }]) {
    f.save({ ...f.operation, context }); assert.equal(f.plans.toolPolicy(policy).block, true); assert.throws(() => f.progress.report(f.request()));
  }
  f.save({ ...f.operation, state: 'cancelled' }); f.save({ ...f.operation, id: randomUUID(), nativeRunId: randomUUID(), createdAt: new Date(Date.now() + 1000).toISOString() });
  assert.equal(f.plans.toolPolicy(policy).block, true); assert.throws(() => f.progress.report(f.request()));
});

test('proposal version, approval operation, and digest changes reject saved estimates without mutating the prior value', t => {
  const f = fixture(t); f.progress.report(f.request());
  for (const patch of [{ version: 2 }, { state: 'unknown' as const }, { approval: { ...f.plan.approval!, operationId: randomUUID() } }, { approval: { ...f.plan.approval!, digest: 'b'.repeat(64) } }]) {
    f.store.internalWrite(`assistant:plan:${f.plan.id}`, { ...f.plan, ...patch });
    assert.throws(() => f.progress.report({ ...f.request(), estimate: { ...estimate, expectedRevision: 1 } }), /approved research/);
    assert.equal(f.get().researchEstimate!.revision, 1);
  }
});

test('permanent conversation removal also removes its progress receipts while preserving another conversation', t => {
  const f = fixture(t); f.progress.report(f.request());
  const foreign='assistant:research-progress:foreign:receipt';f.store.internalWrite(foreign,{conversationId:randomUUID(),inputHash:'foreign',result:{saved:true,revision:1}});
  assert.equal(f.store.internalList('assistant:research-progress:').length,2);
  f.store.internalAtomic(()=>f.store.removeConversationData(f.conversation.id));
  assert.equal(f.store.internalList('assistant:research-progress:').length,1);assert.ok(f.store.internalRead(foreign));
});
