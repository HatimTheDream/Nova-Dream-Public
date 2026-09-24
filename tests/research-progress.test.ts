import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantOperation } from '../packages/domain/assistant.js';
import type { AssistantPlan } from '../packages/domain/assistant-plan.js';
import type { AssistantQuestion } from '../packages/domain/questions.js';
import { researchProgress, matchingResearchOperation } from '../packages/domain/research-progress.js';
import { readRunPlan } from '../packages/domain/run-plan.js';

const at = '2026-09-23T12:00:00.000Z', now = Date.parse(at) + 1000, digest = 'a'.repeat(64);
const proposal = { title: 'Research seasons', summary: 'Explain seasons with primary sources.', steps: ['Find primary evidence', 'Compare explanations', 'Write the report'], assumptions: [], verification: ['Cite primary sources'] };
function fixture() {
  const context: AssistantOperation['context'] = { researchWorkflow: 'chat-research-v1', workMode: 'research', space: 'chat', approvedPlan: { id: 'research', version: 1, digest, proposal }, project: null, attachments: [], draftId: 'draft', draftRevision: 1, digest };
  const item: AssistantPlan = { id: 'research', kind: 'research', epoch: 'epoch', conversationId: 'chat', revision: 3, version: 1, state: 'implementing', permissionMode: 'read-only', sourceContext: context, createdAt: at, updatedAt: at, approval: { requestId: 'start', version: 1, digest, operationId: 'execution', approvedAt: at }, versions: [{ version: 1, operationId: 'preparation', createdAt: at, digest, proposal }] };
  const operation: AssistantOperation = { id: 'execution', requestId: 'start', epoch: 'epoch', conversationId: 'chat', conversationRevision: 1, deviceId: 'device', connectionGeneration: 'connection', nativeKey: 'agent:main:research', nativeId: 'native-session', nativeRunId: 'native-run', context, state: 'running', input: 'Start research', model: null, thinking: 'high', text: '', lastSequence: 10, createdAt: at, updatedAt: at, planSequence: 3, plan: readRunPlan({ explanation: 'Comparing how the two sources describe axial tilt', plan: [{ step: proposal.steps[0], status: 'completed' }, { step: proposal.steps[1], status: 'in_progress' }, { step: proposal.steps[2], status: 'pending' }] }) };
  const question: AssistantQuestion = { id: 'question', revision: 1, epoch: 'epoch', conversationId: 'chat', connectionGeneration: 'connection', nativeKey: operation.nativeKey, nativeId: operation.nativeId, availability: 'live', fingerprint: 'fingerprint', snapshot: { id: 'native-question', sessionKey: operation.nativeKey, runId: operation.nativeRunId!, questions: [{ questionId: 'scope', header: 'Scope', question: 'How much detail?', options: [] }], status: 'pending', createdAtMs: Date.parse(at), expiresAtMs: now + 60000 } };
  return { item, operation, question };
}

test('approved broad labels and order stay stable through granular, extended and reordered runtime plans', () => {
  const f = fixture(), first = researchProgress({ ...f, connected: true });
  assert.deepEqual(first.steps.map(step => step.label), proposal.steps); assert.deepEqual(first.steps.map(step => step.status), ['complete', 'active', 'waiting']);
  f.operation.plan = readRunPlan({ plan: [{ step: 'Read one newly discovered source', status: 'completed' }, { step: proposal.steps[2], status: 'pending' }, { step: proposal.steps[0], status: 'completed' }, { step: proposal.steps[1], status: 'in_progress' }] });
  const next = researchProgress({ ...f, connected: true });
  assert.deepEqual(next.steps.map(step => step.id), first.steps.map(step => step.id)); assert.deepEqual(next.steps.map(step => step.label), proposal.steps); assert.deepEqual(next.steps.map(step => step.status), first.steps.map(step => step.status));
  assert.equal('percentage' in next, false); assert.equal('completedSteps' in next, false);
});

test('only unique exact normalized labels correspond; no index or fuzzy guesses', () => {
  const f = fixture(); f.operation.plan = readRunPlan({ plan: [{ step: 'Find primary evidence about energy', status: 'completed' }, { step: '  Compare   explanations ', status: 'in_progress' }, { step: 'write the report', status: 'completed' }] });
  const next = researchProgress({ ...f, connected: true });
  assert.deepEqual(next.steps.map(step => step.reported), [false, true, false]); assert.deepEqual(next.steps.map(step => step.status), ['waiting', 'active', 'waiting']);
  f.operation.plan!.push({ ...f.operation.plan![1], id: 'duplicate', status: 'complete' });
  assert.equal(researchProgress({ ...f, connected: true }).steps[1].reported, false);
});

test('optional explicit native IDs disambiguate duplicate approved labels only with the same label', () => {
  const f = fixture(); f.item.versions[0].proposal = { ...proposal, steps: ['Read evidence', 'Read evidence'] }; f.operation.context.approvedPlan!.proposal = f.item.versions[0].proposal;
  f.operation.plan = readRunPlan({ plan: [{ id: 'research-step-2', step: 'Read evidence', status: 'completed' }, { id: 'research-step-1', step: 'An unrelated subtask', status: 'completed' }] });
  const next = researchProgress({ ...f, connected: true }); assert.deepEqual(next.steps.map(step => step.reported), [false, true]); assert.deepEqual(next.steps.map(step => step.status), ['waiting', 'complete']);
});

test('newest actual running tool supplies a specific query, then a safe observed source title', () => {
  const f = fixture(); f.operation.tools = [{ id: 'search', name: 'web_search', input: 'NASA axial tilt explanation', state: 'running', sequence: 5 }, { id: 'fetch', name: 'web_fetch', title: 'Checking NASA’s explanation of axial tilt', input: 'https://science.nasa.gov/earth/seasons', state: 'running', sequence: 7 }];
  const source = researchProgress({ ...f, connected: true }); assert.equal(source.status, 'Checking NASA’s explanation of axial tilt'); assert.equal(source.statusSource, 'tool');
  f.operation.tools[1].state = 'completed'; const searching = researchProgress({ ...f, connected: true }); assert.equal(searching.status, 'Searching for NASA axial tilt explanation');
  f.operation.tools[0].state = 'completed'; const done = researchProgress({ ...f, connected: true }); assert.equal(done.statusSource, 'milestone'); assert.equal(done.status, proposal.steps[1]);
});

test('current safe search query takes precedence over a public tool title', () => {
  const f = fixture(); f.operation.tools = [{ id: 'search', name: 'web_search', title: 'Searching broad sources', input: 'cold climate heat pump field studies', state: 'running', sequence: 10 }];
  assert.equal(researchProgress({ ...f, connected: true }).status, 'Searching for cold climate heat pump field studies');
});

test('generic read titles use the observed domain; sensitive titles and URLs are never exposed', () => {
  const f = fixture(); f.operation.tools = [{ id: 'fetch', name: 'web_fetch', title: 'Reading a page', input: 'https://www.energy.gov/heat-pumps', state: 'running', sequence: 10 }];
  assert.equal(researchProgress({ ...f, connected: true }).status, 'Reading energy.gov…');
  f.operation.tools[0] = { ...f.operation.tools[0], title: 'Using token=do-not-display', input: 'https://energy.gov/report?token=do-not-display', output: 'Private raw output never belongs in status' };
  const next = researchProgress({ ...f, connected: true }); assert.equal(next.status, 'Reading a source…'); assert.doesNotMatch(next.status, /token|Private|output/);
});

test('fresh public plan explanation may describe synthesis but cannot return after a newer tool finished', () => {
  const f = fixture(), fresh = researchProgress({ ...f, connected: true }); assert.equal(fresh.statusSource, 'detail'); assert.match(fresh.status, /axial tilt/);
  f.operation.tools = [{ id: 'read', name: 'web_fetch', state: 'completed', sequence: 9 }];
  assert.equal(researchProgress({ ...f, connected: true }).statusSource, 'milestone');
  f.operation.planSequence = 10; f.operation.plan![1].detail = 'Drafting the comparison section from the reviewed evidence';
  assert.equal(researchProgress({ ...f, connected: true }).status, 'Drafting the comparison section from the reviewed evidence');
});

test('all reported milestones complete never manufactures overall completion, percent or finishing phase', () => {
  const f = fixture(); f.operation.plan = f.operation.plan!.map(step => ({ ...step, status: 'complete' }));
  const next = researchProgress({ ...f, connected: true }); assert.equal(next.state, 'live'); assert.equal(next.live, true); assert.equal(next.status, 'Researching…'); assert.equal(next.steps.every(step => step.status === 'complete'), true); assert.equal('percentage' in next, false);
});

test('terminal, uncertain, stopping and paused states override previously active tool labels', () => {
  const f = fixture(); f.operation.tools = [{ id: 'search', name: 'web_search', input: 'an old query', state: 'running', sequence: 8 }];
  for (const [state, label] of [['completed', 'Research complete'], ['failed', 'Research interrupted'], ['cancelled', 'Research stopped'], ['unknown', 'Progress unconfirmed']] as const) {
    const next = researchProgress({ ...f, operation: { ...f.operation, state }, connected: false }); assert.equal(next.status, label); assert.equal(next.live, false);
  }
  assert.equal(researchProgress({ ...f, operation: { ...f.operation, cancelRequested: true }, connected: false }).status, 'Stopping…');
  const paused = researchProgress({ ...f, connected: false }); assert.equal(paused.status, 'Updates paused'); assert.equal(paused.live, false); assert.equal(paused.steps[0].status, 'complete');
});

test('a pending question must belong to the exact live run, session and connection', () => {
  const f = fixture(), waiting = researchProgress({ ...f, connected: true, questions: [f.question], now }); assert.equal(waiting.status, 'Waiting for your answer'); assert.equal(waiting.live, false);
  const mismatches: AssistantQuestion[] = [
    { ...f.question, epoch: 'other' }, { ...f.question, conversationId: 'other' }, { ...f.question, nativeId: 'other' }, { ...f.question, nativeKey: 'other' }, { ...f.question, connectionGeneration: 'other' }, { ...f.question, availability: 'missing' }, { ...f.question, dismissed: true },
    { ...f.question, snapshot: { ...f.question.snapshot, sessionKey: 'other' } }, { ...f.question, snapshot: { ...f.question.snapshot, runId: 'other' } }, { ...f.question, snapshot: { ...f.question.snapshot, runId: undefined } }, { ...f.question, snapshot: { ...f.question.snapshot, expiresAtMs: now - 1 } },
    { ...f.question, snapshot: { ...f.question.snapshot, status: 'answered', answers: { answers: { scope: ['Answered'] } } } }, { ...f.question, action: { requestId: 'answer', kind: 'answer', state: 'confirmed' } },
  ];
  for (const question of mismatches) assert.notEqual(researchProgress({ ...f, connected: true, questions: [question], now }).statusSource, 'question');
});

test('submitted question answers are being confirmed, not waiting for the owner to answer again', () => {
  const f = fixture();
  for (const [state, expected] of [['sending', 'Confirming your answer…'], ['unknown', 'Checking your answer…']] as const) {
    const next = researchProgress({ ...f, connected: true, questions: [{ ...f.question, action: { requestId: 'answer', kind: 'answer', state } }], now }); assert.equal(next.status, expected); assert.equal(next.live, false);
  }
});

test('wrong operation, epoch, conversation, captured proposal and preparation cannot supply progress', () => {
  const f = fixture(), mismatches: AssistantOperation[] = [
    { ...f.operation, id: 'preparation' }, { ...f.operation, epoch: 'other' }, { ...f.operation, conversationId: 'other' }, { ...f.operation, steerTarget: 'execution' },
    { ...f.operation, context: { ...f.operation.context, space: 'work' } }, { ...f.operation, context: { ...f.operation.context, planReview: { id: f.item.id, version: 1 } } },
    { ...f.operation, context: { ...f.operation.context, approvedPlan: { ...f.operation.context.approvedPlan!, id: 'other' } } }, { ...f.operation, context: { ...f.operation.context, approvedPlan: { ...f.operation.context.approvedPlan!, version: 2 } } }, { ...f.operation, context: { ...f.operation.context, approvedPlan: { ...f.operation.context.approvedPlan!, digest: 'b'.repeat(64) } } },
  ];
  for (const operation of mismatches) { assert.equal(matchingResearchOperation(f.item, operation), undefined); const next = researchProgress({ ...f, operation, connected: true }); assert.equal(next.state, 'unknown'); assert.equal(next.steps.every(step => !step.reported), true); }
  const legacy = { ...f.operation, context: { ...f.operation.context, approvedPlan: undefined } }; assert.equal(matchingResearchOperation(f.item, legacy), legacy);
});

test('an unapproved plan never borrows activity, even if a supplied operation looks active', () => {
  const f = fixture(); const next = researchProgress({ ...f, item: { ...f.item, approval: undefined, state: 'ready' }, connected: true }); assert.equal(next.state, 'idle'); assert.equal(next.status, 'Ready to research'); assert.equal(next.steps.every(step => !step.reported && step.status === 'waiting'), true);
});

test('parser keeps ordinary Work keys and detail, adding bounded explicit IDs and public active explanation only', () => {
  const ordinary = readRunPlan({ plan: [{ step: 'Read source', status: 'in_progress', detail: 'Current detail' }, { step: 'Summarize', status: 'pending' }] });
  assert.deepEqual(ordinary, [{ id: 'plan-0', label: 'Read source', status: 'active', detail: 'Current detail' }, { id: 'plan-1', label: 'Summarize', status: 'waiting', detail: '' }]);
  const extra = readRunPlan({ explanation: 'A public current action', args: { plan: [{ id: 'research-step-1', step: 'Read source', status: 'active' }, { id: '<unsafe>', step: 'Summarize', status: 'pending' }] } })!;
  assert.equal(extra[0].id, 'plan-0'); assert.equal(extra[0].sourceId, 'research-step-1'); assert.equal(extra[0].explanation, 'A public current action'); assert.equal(extra[0].detail, ''); assert.equal(extra[1].sourceId, undefined); assert.equal(extra[1].explanation, undefined);
  assert.equal(readRunPlan({ hideFromChannelProgress: true, explanation: 'Do not expose', plan: [{ step: 'Hidden', status: 'active' }] }), undefined);
});
