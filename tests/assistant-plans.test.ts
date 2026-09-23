import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AssistantPlans } from '../apps/service/assistant-plans.js';
import { Store } from '../apps/service/store.js';
import type { AssistantOperation, Conversation } from '../packages/domain/assistant.js';
import type { AssistantQuestion } from '../packages/domain/questions.js';

const proposal = { title: 'Improve the inbox', summary: 'Keep the list and put actions on the right.', steps: ['Move the controls', 'Check the narrow screen'], assumptions: ['Keep the current design'], verification: ['Delete, flag and pin all work'] };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-plans-')), store = new Store(directory), device = store.session().deviceId, at = new Date().toISOString();
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const conversation: Conversation = { id: randomUUID(), nativeId: randomUUID(), nativeKey: 'agent:main:e3:fixture', revision: 1, connectionGeneration: randomUUID(), state: 'ready', title: 'Planning', projectId: null, permissionMode: 'workspace', archived: false, model: 'openai/test', thinking: 'auto', createdAt: at, updatedAt: at };
  const operations = new Map<string, AssistantOperation>(), dispatched: string[] = [];
  const host = { conversation: () => conversation, operation: (id: string) => operations.get(id)!, operations: () => [...operations.values()], assertReady: () => {}, save: (operation: AssistantOperation) => { operations.set(operation.id, operation); plans.observe(operation); return operation; }, dispatch: (id: string) => { dispatched.push(id); } };
  let plans = new AssistantPlans(store, host);
  const raw: AssistantOperation = { id: randomUUID(), requestId: randomUUID(), deviceId: device, epoch: store.epoch, conversationId: conversation.id, conversationRevision: 1, connectionGeneration: conversation.connectionGeneration, nativeKey: conversation.nativeKey, nativeId: conversation.nativeId!, nativeRunId: randomUUID(), state: 'running', input: 'Plan the inbox changes.', context: { project: null, attachments: [], draftId: 'draft', draftRevision: 1, digest: 'a'.repeat(64), workMode: 'plan' }, model: conversation.model, thinking: conversation.thinking, autoEffort: { policy: 'task-v1', demand: 'high', level: 'high', model: conversation.model, reason: 'task' }, createdAt: at, updatedAt: at, text: '', lastSequence: 0 };
  let operation = plans.capture(raw, conversation); host.save(operation);
  const finish = (op = operation, state: 'completed' | 'failed' | 'cancelled' | 'unknown' = 'completed') => { operation = { ...op, state, settledAt: new Date().toISOString() }; host.save(operation); return operation; };
  const propose = (next = proposal, op = operation) => plans.propose({ epoch: store.epoch, nativeKey: op.nativeKey, nativeId: op.nativeId, runId: op.nativeRunId, toolCallId: randomUUID(), proposal: next });
  const decision = () => { const item = plans.list()[0]; return { requestId: randomUUID(), epoch: store.epoch, id: item.id, expectedRevision: item.revision, version: item.version, digest: item.reviewDigest! }; };
  return { store, device, conversation, operations, dispatched, host, finish, propose, decision, get operation() { return operation; }, get plans() { return plans; }, restart() { plans = new AssistantPlans(store, host); } };
}
test('proposal saving and ordinary completion do not approve; exact approval admits one operation through replay and restart', t => {
  const f = fixture(t); f.propose(); assert.equal(f.plans.list()[0].state, 'drafting'); assert.equal(f.dispatched.length, 0);
  f.finish(); assert.equal(f.plans.list()[0].state, 'ready'); const decision = f.decision();
  const implementation = f.plans.decide(f.device, decision); assert.equal(implementation.context.workMode, 'chat'); assert.deepEqual(implementation.context.approvedPlan?.proposal, proposal);
  assert.equal(implementation.autoEffort, undefined); assert.ok(implementation.effortDemand);
  assert.equal(f.plans.decide(f.device, decision).id, implementation.id); f.restart(); assert.equal(f.plans.decide(f.device, decision).id, implementation.id);
  assert.equal(f.dispatched.length, 1); assert.equal(f.operations.size, 2);
  assert.throws(() => f.plans.decide(f.device, { ...decision, requestId: randomUUID() }), /changed/);
  assert.throws(() => f.plans.decide(f.device, { ...decision, digest: 'b'.repeat(64) }), /different|reused/);
});
test('amendments preserve prior proposals, reject stale approval and require fresh approval', t => {
  const f = fixture(t); f.propose(); f.finish(); const stale = f.decision();
  const revised = f.plans.decide(f.device, { ...stale, text: 'Make the mobile choices compact.' }, true);
  assert.equal(f.plans.list()[0].version, 2); assert.deepEqual(f.plans.list()[0].versions[0].proposal, proposal);
  assert.throws(() => f.plans.decide(f.device, { ...stale, requestId: randomUUID() }), /changed/);
  f.host.save({ ...revised, state: 'running', nativeRunId: randomUUID() }); const live = f.operations.get(revised.id)!;
  f.propose({ ...proposal, summary: 'Compact mobile choices.' }, live); f.finish(live);
  const implemented = f.plans.decide(f.device, f.decision()); assert.equal(implemented.context.approvedPlan?.version, 2); assert.equal(implemented.context.approvedPlan?.proposal.summary, 'Compact mobile choices.');
});
test('context or access changes reject approval but Request changes recaptures the current context', t => {
  const f = fixture(t); f.propose(); f.finish(); const decision = f.decision();
  f.conversation.revision++; f.conversation.permissionMode = 'guarded';
  assert.throws(() => f.plans.decide(f.device, decision), /context|setting/);
  const revised = f.plans.decide(f.device, { ...decision, requestId: randomUUID(), text: 'Review the new access and sources.' }, true);
  assert.equal(revised.conversationRevision, f.conversation.revision); assert.equal(f.plans.list()[0].permissionMode, 'guarded'); assert.equal(f.plans.list()[0].state, 'drafting');
});
test('pending and expired questions without a run id block a saved proposal; answered question identity is retained', t => {
  const f = fixture(t), q = { id: 'c'.repeat(64), epoch: f.store.epoch, conversationId: f.conversation.id, nativeId: f.conversation.nativeId, snapshot: { createdAtMs: Date.parse(f.operation.createdAt), status: 'pending', questions: [] } } as unknown as AssistantQuestion;
  f.store.internalWrite(`assistant:question:${q.id}`, q); assert.throws(() => f.propose(), /questions/);
  q.snapshot.status = 'expired'; f.store.internalWrite(`assistant:question:${q.id}`, q); assert.throws(() => f.propose(), /questions/);
  q.snapshot.status = 'answered'; q.snapshot.answers = { answers: { priority: ['Reliability'] } }; f.store.internalWrite(`assistant:question:${q.id}`, q);
  f.propose(); f.finish(); assert.deepEqual(f.plans.list()[0].versions[0].questionIds, [q.id]); assert.equal(f.plans.list()[0].state, 'ready');
});
test('Plan and Research allow explicit reads and questions but reject commands, edits, browser, delegation and unknown tools', t => {
  const f = fixture(t), input = { epoch: f.store.epoch, nativeKey: f.operation.nativeKey, nativeId: f.operation.nativeId, runId: f.operation.nativeRunId! };
  for (const toolName of ['read', 'web_search', 'web_fetch', 'nova_read', 'request_user_input', 'nova_plan']) assert.equal(f.plans.toolPolicy({ ...input, toolName }).block, false, toolName);
  for (const toolName of ['exec', 'exec_command', 'write', 'edit', 'apply_patch', 'browser', 'sessions_spawn', 'code_mode', 'connector_mutate']) assert.equal(f.plans.toolPolicy({ ...input, toolName }).block, true, toolName);
  f.host.save({ ...f.operation, context: { ...f.operation.context, workMode: 'research' } }); assert.equal(f.plans.toolPolicy({ ...input, toolName: 'nova_write' }).block, true);
  assert.throws(() => f.plans.toolPolicy({ ...input, runId: 'foreign', toolName: 'read' }), /no longer active/);
  f.finish(); assert.throws(() => f.plans.toolPolicy({ ...input, toolName: 'read' }), /no longer active/);
});
test('an uncertain planning run cannot be approved or amended, and completed prose alone is not a proposal', t => {
  const f = fixture(t); f.finish(f.operation, 'unknown'); assert.equal(f.plans.list()[0].state, 'unknown');
  assert.throws(() => f.plans.decide(f.device, f.decision()), /changed/); assert.throws(() => f.plans.decide(f.device, { ...f.decision(), text: 'Retry' }, true), /changed/);
  f.finish(); assert.equal(f.plans.list()[0].state, 'failed'); assert.equal(f.plans.list()[0].approval, undefined);
  const revised = f.plans.decide(f.device, { ...f.decision(), text: 'Prepare a saved proposal.' }, true); assert.equal(revised.context.planReview?.version, 2);
});

test('a plain yes retains the unapproved plan boundary, while unrelated main sessions keep their own policy', t => {
  const f = fixture(t); f.propose(); f.finish();
  const chat = { ...f.operation, id: randomUUID(), nativeRunId: randomUUID(), state: 'running' as const, input: 'yes', context: { ...f.operation.context, workMode: 'chat' as const, planReview: undefined }, createdAt: new Date(Date.now() + 1).toISOString() };
  f.host.save(chat);
  assert.equal(f.plans.toolPolicy({ epoch: f.store.epoch, nativeKey: chat.nativeKey, nativeId: chat.nativeId, runId: chat.nativeRunId, toolName: 'exec' }).block, true);
  assert.equal(f.plans.list()[0].approval, undefined);
  assert.equal(f.plans.toolPolicy({ epoch: f.store.epoch, nativeKey: 'agent:main:unrelated', nativeId: randomUUID(), toolName: 'exec' }).block, false);
});
