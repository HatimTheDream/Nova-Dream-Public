import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AssistantPlans } from '../apps/service/assistant-plans.js';
import { Fault, Store } from '../apps/service/store.js';
import type { AssistantOperation, Conversation } from '../packages/domain/assistant.js';
import type { AssistantQuestion } from '../packages/domain/questions.js';

const proposal = { title: 'Compare home heat pumps', summary: 'Compare costs, operating conditions and measured efficiency using primary evidence.', steps: ['Read current government and manufacturer sources', 'Compare assumptions and conflicting findings', 'Write a cited report with limitations'], assumptions: ['A residential installation'], verification: ['Cite the source supporting each important claim'] };
function fixture(t: TestContext, mode: 'chat-research' | 'work-research' | 'legacy-research' | 'plan' = 'chat-research') {
  const directory = mkdtempSync(join(tmpdir(), 'nova-research-')), store = new Store(directory), device = store.session().deviceId, at = new Date().toISOString();
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const conversation: Conversation = { id: randomUUID(), nativeId: randomUUID(), nativeKey: 'agent:main:e3:research', revision: 1, connectionGeneration: randomUUID(), state: 'ready', title: 'Research', space: mode === 'work-research' ? 'work' : 'chat', projectId: null, permissionMode: 'full', archived: false, model: 'openai/test', thinking: 'auto', createdAt: at, updatedAt: at };
  const operations = new Map<string, AssistantOperation>(), dispatched: string[] = [];
  let ready = true;
  const host = { conversation: () => conversation, operation: (id: string) => { const op = operations.get(id); if (!op) throw new Fault(404, 'operation_missing', 'The original operation is unavailable.'); return op; }, operations: () => [...operations.values()], assertReady: () => { if (!ready) throw new Fault(409, 'offline', 'Reconnect before starting research.'); }, save: (op: AssistantOperation) => { operations.set(op.id, op); plans.observe(op); return op; }, dispatch: (id: string) => { dispatched.push(id); } };
  let plans = new AssistantPlans(store, host);
  const raw: AssistantOperation = { id: randomUUID(), requestId: randomUUID(), deviceId: device, epoch: store.epoch, conversationId: conversation.id, conversationRevision: 1, connectionGeneration: conversation.connectionGeneration, nativeKey: conversation.nativeKey, nativeId: conversation.nativeId!, nativeRunId: randomUUID(), state: 'running', input: 'Research home heat pumps.', context: { project: null, attachments: [], draftId: 'draft', draftRevision: 1, digest: 'a'.repeat(64), space: conversation.space, workMode: mode === 'plan' ? 'plan' : 'research', ...(mode === 'chat-research' ? { researchWorkflow: 'chat-research-v1' } : {}) }, model: conversation.model, thinking: 'auto', createdAt: at, updatedAt: at, text: '', lastSequence: 0 };
  const operation = plans.capture(raw, conversation); host.save(operation);
  const finish = (op = operation, state: 'completed' | 'failed' | 'cancelled' | 'unknown' = 'completed') => host.save({ ...op, state, settledAt: state === 'unknown' ? undefined : new Date().toISOString() });
  const propose = (op = operation, next = proposal) => plans.propose({ epoch: store.epoch, nativeKey: op.nativeKey, nativeId: op.nativeId, runId: op.nativeRunId, toolCallId: randomUUID(), proposal: next });
  const item = () => plans.list()[0];
  const decision = () => { const p = item(); return { requestId: randomUUID(), epoch: store.epoch, id: p.id, expectedRevision: p.revision, version: p.version, digest: p.reviewDigest! }; };
  const policy = (toolName: string, op = operation) => plans.toolPolicy({ epoch: store.epoch, nativeKey: op.nativeKey, nativeId: op.nativeId, runId: op.nativeRunId!, toolName });
  return { store, device, conversation, operation, operations, host, dispatched, finish, propose, item, decision, policy, setReady: (value: boolean) => { ready = value; }, get plans() { return plans; }, restart: () => { plans = new AssistantPlans(store, host); } };
}

test('only newly captured Chat Research creates a research review; Work, legacy and Plan remain distinct', t => {
  const chat = fixture(t); assert.equal(chat.item().kind, 'research'); assert.equal(chat.item().state, 'drafting'); assert.ok(chat.operation.context.planReview); assert.equal(chat.item().autoStartAt, undefined);
  for (const mode of ['work-research', 'legacy-research'] as const) { const f = fixture(t, mode); assert.equal(f.plans.list().length, 0); assert.equal(f.operation.context.planReview, undefined); assert.equal(f.policy('web_search').block, false); }
  const plan = fixture(t, 'plan'); plan.propose(); plan.finish(); assert.equal(plan.item().kind, undefined); assert.equal(plan.item().autoStartAt, undefined); assert.equal(plan.policy('web_search', plan.host.save({ ...plan.operation, state: 'running' })).block, false);
});

test('preparation permits questions and supplied context but not web investigation, writes or delegation', t => {
  const f = fixture(t);
  for (const name of ['nova_plan', 'request_user_input', 'nova_read', 'read', 'update_plan']) assert.equal(f.policy(name).block, false, name);
  for (const name of ['web_search', 'web_fetch', 'exec', 'browser', 'write', 'nova_write', 'sessions_spawn', 'unrecognized']) assert.equal(f.policy(name).block, true, name);
  f.propose(); assert.equal(f.item().state, 'drafting'); assert.equal(f.item().autoStartAt, undefined); assert.equal(f.dispatched.length, 0);
  f.finish(); assert.equal(f.item().state, 'ready'); assert.ok(Date.parse(f.item().autoStartAt!) > Date.now()); assert.ok(f.item().autoStartRequestId); assert.equal(f.dispatched.length, 0);
});

test('Start research admits the exact proposal once and remains read only even with Full access', t => {
  const f = fixture(t); f.propose(); f.finish(); const decision = f.decision();
  const execution = f.plans.decide(f.device, decision);
  assert.equal(execution.context.workMode, 'research'); assert.equal(execution.context.researchWorkflow, 'chat-research-v1'); assert.equal(execution.context.planReview, undefined); assert.deepEqual(execution.context.approvedPlan?.proposal, proposal); assert.equal(execution.input, `Start research: ${proposal.title}`);
  assert.equal(f.item().state, 'implementing'); assert.equal(f.item().autoStartAt, undefined);
  assert.equal(f.plans.decide(f.device, decision).id, execution.id); f.restart(); assert.equal(f.plans.decide(f.device, decision).id, execution.id); assert.equal(f.dispatched.length, 1);
  const live = f.host.save({ ...execution, nativeRunId: randomUUID(), state: 'running' });
  for (const name of ['web_search', 'web_fetch', 'read', 'nova_read', 'update_plan']) assert.equal(f.policy(name, live).block, false, name);
  for (const name of ['exec', 'write', 'nova_write', 'browser', 'sessions_spawn']) assert.equal(f.policy(name, live).block, true, name);
  f.finish(live); assert.equal(f.item().state, 'completed'); assert.equal(f.item().approval?.operationId, execution.id);
});

test('the persisted 45 second deadline uses one deterministic admission and never a client countdown', t => {
  const f = fixture(t); f.propose(); const before = Date.now(); f.finish(); const saved = f.item(), due = Date.parse(saved.autoStartAt!);
  assert.ok(due >= before + 45000 && due <= Date.now() + 45000);
  f.plans.runAutomatic(due - 1); assert.equal(f.dispatched.length, 0);
  f.plans.runAutomatic(due); f.plans.runAutomatic(due + 10000); assert.equal(f.dispatched.length, 1);
  const execution = f.operations.get(f.dispatched[0])!; assert.equal(execution.requestId, saved.autoStartRequestId); assert.equal(f.item().state, 'implementing'); assert.equal(f.item().autoStartAt, undefined);
  assert.throws(() => f.plans.decide(f.device, { ...f.decision(), requestId: randomUUID() }), /changed/);
});

test('Edit durably holds the countdown, replays safely and invalidates an old Start action', t => {
  const f = fixture(t); f.propose(); f.finish(); const stale = f.decision(), hold = { ...stale, requestId: randomUUID() }, due = Date.parse(f.item().autoStartAt!);
  const held = f.plans.hold(f.device, hold); assert.equal(held.autoStartHeld, 'editing'); assert.equal(held.autoStartAt, undefined); assert.equal(held.revision, stale.expectedRevision + 1);
  assert.equal(f.plans.hold(f.device, hold).revision, held.revision); f.plans.runAutomatic(due + 60000); assert.equal(f.dispatched.length, 0);
  assert.throws(() => f.plans.decide(f.device, stale), /changed/);
  const revised = f.plans.decide(f.device, { ...f.decision(), text: 'Only compare cold-climate options.' }, true);
  assert.equal(revised.context.workMode, 'research'); assert.equal(revised.context.researchWorkflow, 'chat-research-v1'); assert.deepEqual(revised.context.planReview?.previousProposal, proposal); assert.equal(f.item().autoStartHeld, undefined);
  const live = f.host.save({ ...revised, state: 'running', nativeRunId: randomUUID() });
  f.propose(live, { ...proposal, title: 'Cold-climate options' }); f.finish(live); assert.equal(f.item().version, 2); assert.ok(f.item().autoStartAt); assert.equal(f.item().versions[0].proposal?.title, proposal.title);
});

test('Cancel preserves the proposal, clears the deadline and cannot be resurrected by repeated completion', t => {
  const f = fixture(t); f.propose(); const completed = f.finish(), input = f.decision(), due = Date.parse(f.item().autoStartAt!);
  const cancelled = f.plans.hold(f.device, input, true); assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.autoStartAt, undefined); assert.deepEqual(cancelled.versions[0].proposal, proposal);
  assert.equal(f.plans.hold(f.device, input, true).revision, cancelled.revision); f.plans.observe(completed); f.plans.runAutomatic(due + 50000); assert.equal(f.item().state, 'cancelled'); assert.equal(f.dispatched.length, 0);
  assert.throws(() => f.plans.decide(f.device, { ...input, requestId: randomUUID() }), /changed/);
  const next = f.host.save({ ...f.operation, id: randomUUID(), nativeRunId: randomUUID(), createdAt: new Date(Date.now() + 1).toISOString(), context: { ...f.operation.context, workMode: 'chat', researchWorkflow: undefined, planReview: undefined } });
  assert.equal(f.policy('exec', next).block, false, 'cancelled research must not trap unrelated later requests in preparation');
});

test('active or approved research cannot be cancelled through the proposal endpoint', t => {
  const f = fixture(t); assert.throws(() => f.plans.hold(f.device, f.decision(), true), /changed/); f.propose(); f.finish();
  f.plans.decide(f.device, f.decision()); assert.throws(() => f.plans.hold(f.device, f.decision(), true), /changed/); assert.equal(f.item().state, 'implementing');
});

test('restart pauses even an overdue countdown; explicit Start remains possible', t => {
  const f = fixture(t); f.propose(); f.finish(); const stale = f.decision(), original = f.item();
  f.store.internalWrite(`assistant:plan:${original.id}`, { ...original, autoStartAt: new Date(Date.now() - 1000).toISOString() });
  f.restart(); f.plans.runAutomatic(); assert.equal(f.dispatched.length, 0); assert.equal(f.item().autoStartAt, undefined); assert.equal(f.item().autoStartHeld, 'restarted');
  assert.throws(() => f.plans.decide(f.device, stale), /changed/); f.plans.decide(f.device, f.decision()); assert.equal(f.dispatched.length, 1);
});

test('automatic start fails closed on context changes and does not retry itself', t => {
  const f = fixture(t); f.propose(); f.finish(); const due = Date.parse(f.item().autoStartAt!); f.conversation.revision++;
  f.plans.runAutomatic(due); assert.equal(f.dispatched.length, 0); assert.equal(f.item().state, 'ready'); assert.equal(f.item().autoStartHeld, 'needs-review'); assert.match(f.item().autoStartError!, /changed/); assert.equal(f.item().autoStartAt, undefined);
  f.conversation.revision--; f.plans.runAutomatic(due + 60000); assert.equal(f.dispatched.length, 0);
});

test('disconnect holds the deadline and ordinary yes cannot start an unapproved investigation', t => {
  const f = fixture(t); f.propose(); f.finish(); const due = Date.parse(f.item().autoStartAt!); f.plans.pauseAutomatic(); f.plans.runAutomatic(due + 1000); assert.equal(f.dispatched.length, 0); assert.equal(f.item().autoStartHeld, 'needs-review');
  const next = f.host.save({ ...f.operation, id: randomUUID(), nativeRunId: randomUUID(), input: 'yes', createdAt: new Date(Date.now() + 1).toISOString(), context: { ...f.operation.context, workMode: 'chat', researchWorkflow: undefined, planReview: undefined } });
  assert.equal(f.policy('web_search', next).block, true); assert.equal(f.item().approval, undefined);
});

test('unresolved questions, missing saved proposal and uncertain runs never become auto-startable', t => {
  const f = fixture(t), q = { id: 'c'.repeat(64), epoch: f.store.epoch, conversationId: f.conversation.id, nativeId: f.conversation.nativeId, snapshot: { createdAtMs: Date.parse(f.operation.createdAt), runId: f.operation.nativeRunId, status: 'pending', questions: [] } } as unknown as AssistantQuestion;
  f.store.internalWrite(`assistant:question:${q.id}`, q); assert.throws(() => f.propose(), /questions/);
  f.finish(); assert.equal(f.item().state, 'failed'); assert.equal(f.item().autoStartAt, undefined);
  const uncertain = fixture(t); uncertain.propose(); uncertain.finish(uncertain.operation, 'unknown'); assert.equal(uncertain.item().state, 'unknown'); assert.equal(uncertain.item().autoStartAt, undefined);
  assert.throws(() => uncertain.plans.decide(uncertain.device, uncertain.decision()), /changed/); assert.throws(() => uncertain.plans.decide(uncertain.device, { ...uncertain.decision(), text: 'Try again' }, true), /changed/);
  const prose = fixture(t); prose.finish(); assert.equal(prose.item().state, 'failed'); assert.equal(prose.item().approval, undefined);
});

test('foreign epoch, session and run cannot save the research proposal', t => {
  const f = fixture(t), input = { epoch: f.store.epoch, nativeKey: f.operation.nativeKey, nativeId: f.operation.nativeId, runId: f.operation.nativeRunId, toolCallId: randomUUID(), proposal };
  for (const patch of [{ epoch: randomUUID() }, { nativeId: randomUUID() }, { nativeKey: 'agent:main:foreign' }, { runId: randomUUID() }]) assert.throws(() => f.plans.propose({ ...input, ...patch }), /changed|no longer active/);
  assert.equal(f.item().versions[0].proposal, undefined);
});

test('native execution completion, stop and uncertainty remain distinct research outcomes', t => {
  for (const state of ['completed', 'cancelled', 'failed', 'unknown'] as const) {
    const f = fixture(t); f.propose(); f.finish(); const execution = f.plans.decide(f.device, f.decision());
    f.finish(execution, state); assert.equal(f.item().state, state); assert.equal(f.item().autoStartAt, undefined); assert.equal(f.item().approval?.operationId, execution.id);
    f.plans.runAutomatic(Date.now() + 60000); assert.equal(f.dispatched.length, 1);
  }
});

test('a late tool from finished research cannot inherit a later ordinary chat access boundary', t => {
  const f = fixture(t); f.propose(); f.finish(); const execution = f.plans.decide(f.device, f.decision()), native = f.host.save({ ...execution, nativeRunId: randomUUID(), state: 'running' });
  f.finish(native); assert.equal(f.policy('exec', native).block, true); assert.equal(f.policy('web_search', native).block, true);
  const later = f.host.save({ ...f.operation, id: randomUUID(), nativeRunId: randomUUID(), input: 'An unrelated task', createdAt: new Date(Date.now() + 1).toISOString(), context: { ...f.operation.context, workMode: 'chat', researchWorkflow: undefined, planReview: undefined } });
  assert.equal(f.policy('exec', later).block, false); assert.equal(f.policy('exec', native).block, true);
});
