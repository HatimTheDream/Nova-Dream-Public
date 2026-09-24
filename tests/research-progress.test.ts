import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantOperation } from '../packages/domain/assistant.js';
import type { AssistantPlan } from '../packages/domain/assistant-plan.js';
import type { AssistantQuestion } from '../packages/domain/questions.js';
import { researchProgress, matchingResearchOperation, retainResearchMilestones, researchStepTitle } from '../packages/domain/research-progress.js';
import { readRunPlan } from '../packages/domain/run-plan.js';
import { planProposalSchema } from '../packages/domain/assistant-plan.js';
import { reconcileResearchEstimate } from '../packages/domain/research-estimate.js';

const at = '2026-09-23T12:00:00.000Z', now = Date.parse(at) + 1000, digest = 'a'.repeat(64);
const proposal = { title: 'Research seasons', summary: 'Explain seasons with primary sources.', steps: ['Find primary evidence', 'Compare explanations', 'Write the report'], assumptions: [], verification: ['Cite primary sources'] };
function fixture() {
  const context: AssistantOperation['context'] = { researchWorkflow: 'chat-research-v1', workMode: 'research', space: 'chat', approvedPlan: { id: 'research', version: 1, digest, proposal }, project: null, attachments: [], draftId: 'draft', draftRevision: 1, digest };
  const item: AssistantPlan = { id: 'research', kind: 'research', epoch: 'epoch', conversationId: 'chat', revision: 3, version: 1, state: 'implementing', permissionMode: 'read-only', sourceContext: context, createdAt: at, updatedAt: at, approval: { requestId: 'start', version: 1, digest, operationId: 'execution', approvedAt: at }, versions: [{ version: 1, operationId: 'preparation', createdAt: at, digest, proposal }] };
  const operation: AssistantOperation = { id: 'execution', requestId: 'start', epoch: 'epoch', conversationId: 'chat', conversationRevision: 1, deviceId: 'device', connectionGeneration: 'connection', nativeKey: 'agent:main:research', nativeId: 'native-session', nativeRunId: 'native-run', context, state: 'running', input: 'Start research', model: null, thinking: 'high', text: '', lastSequence: 10, createdAt: at, updatedAt: at, planSequence: 3, plan: readRunPlan({ explanation: 'Comparing how the two sources describe axial tilt', plan: [{ step: proposal.steps[0], status: 'completed' }, { step: proposal.steps[1], status: 'in_progress' }, { step: proposal.steps[2], status: 'pending' }] }) };
  const question: AssistantQuestion = { id: 'question', revision: 1, epoch: 'epoch', conversationId: 'chat', connectionGeneration: 'connection', nativeKey: operation.nativeKey, nativeId: operation.nativeId, availability: 'live', fingerprint: 'fingerprint', snapshot: { id: 'native-question', sessionKey: operation.nativeKey, runId: operation.nativeRunId!, questions: [{ questionId: 'scope', header: 'Scope', question: 'How much detail?', options: [] }], status: 'pending', createdAtMs: Date.parse(at), expiresAtMs: now + 60000 } };
  return { item, operation, question };
}
function withEstimate(f = fixture()) {
  const ref = f.operation.context.approvedPlan!;
  f.operation.researchEstimate = reconcileResearchEstimate(undefined, { expectedRevision: 0, activity: 'Checking the seasonal comparison against the first source.', basis: 'Reading the longer source and drafting the report require more work than the first check.', items: [{ id: 'first-check', title: 'Check the first source claim', effort: 2, status: 'complete' }, { id: 'long-source', title: 'Read the longer source', effort: 8, status: 'active' }, { id: 'report', title: 'Write and verify the report', effort: 5, status: 'pending' }] }, at, 2, { operationId: f.operation.id, epoch: f.operation.epoch, nativeRunId: f.operation.nativeRunId!, planId: ref.id, planVersion: ref.version, planDigest: ref.digest });
  return f;
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

test('all reported milestones complete still waits for confirmed report delivery', () => {
  const f = fixture(); f.operation.plan = f.operation.plan!.map(step => ({ ...step, status: 'complete' }));
  const next = researchProgress({ ...f, connected: true }); assert.equal(next.state, 'live'); assert.equal(next.live, true); assert.equal(next.status, 'Waiting for the finished report…'); assert.equal(next.steps.every(step => step.status === 'complete'), true); assert.equal(next.fraction, null);
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

test('short action titles preserve complete proposal detail and map exact runtime title updates', () => {
  const f = fixture(), detailed = { ...proposal, steps: ['Find primary evidence including NASA source pages, recent measurements, and any caveats about seasonal variation.', 'Compare explanations from NASA and NOAA and reconcile any differences in their presentation of axial tilt.', 'Write the report with citations beside every supported claim and discuss unresolved limitations.'], stepTitles: ['Find primary evidence', 'Compare explanations', 'Write the report'] };
  f.item.versions[0].proposal = detailed; f.operation.context.approvedPlan!.proposal = detailed;
  const next = researchProgress({ ...f, connected: true });
  assert.deepEqual(next.steps.map(step => step.label), detailed.stepTitles);
  assert.deepEqual(next.steps.map(step => step.detail), detailed.steps);
  assert.deepEqual(next.steps.map(step => step.status), ['complete', 'active', 'waiting']);
  assert.equal(next.fraction, null, 'Broad milestone completion is not an effort estimate');
  assert.deepEqual(planProposalSchema.parse(detailed), detailed);
  assert.equal(planProposalSchema.safeParse({ ...detailed, stepTitles: ['One mismatched title'] }).success, false);
  assert.equal(planProposalSchema.safeParse({ ...detailed, stepTitles: detailed.stepTitles.map(() => 'x'.repeat(81)) }).success, false);
  assert.deepEqual(planProposalSchema.parse(proposal), proposal, 'Legacy proposal digests do not gain absent fields');
});

test('legacy titles stay bounded and prefer complete action phrases without changing original detail', () => {
  const detail = 'Find primary sources including official measurements, current reports, applicable caveats and independent verification.';
  assert.equal(researchStepTitle(detail), 'Find primary sources');
  assert.ok(researchStepTitle('Review '.repeat(300)).length <= 80);
  assert.equal(researchStepTitle(detail, 'Check primary evidence'), 'Check primary evidence');
});

test('milestones and elapsed time cannot invent an estimate before confirmed final report delivery', () => {
  const f = fixture(); f.operation.plan = undefined;
  assert.equal(researchProgress({ ...f, connected: true, now }).fraction, null);
  assert.equal(researchProgress({ ...f, connected: true, now: now + 3600000 }).fraction, null, 'Elapsed time cannot create progress');
  for (let count = 0; count <= 3; count++) {
    f.operation.plan = proposal.steps.map((label, index) => ({ id: String(index), label, detail: '', status: index < count ? 'complete' : index === count ? 'active' : 'waiting' }));
    const result = researchProgress({ ...f, connected: true }); assert.equal(result.fraction, null); assert.equal(result.state, 'live');
  }
  assert.equal(researchProgress({ ...f, connected: false }).fraction, null);
  assert.equal(researchProgress({ ...f, operation: { ...f.operation, state: 'unknown' }, connected: false }).fraction, null);
  assert.equal(researchProgress({ ...f, operation: { ...f.operation, cancelRequested: true }, connected: true }).fraction, null);
  assert.equal(researchProgress({ ...f, operation: { ...f.operation, state: 'failed' }, connected: true }).fraction, null);
  assert.equal(researchProgress({ ...f, operation: { ...f.operation, state: 'completed' }, connected: true }).fraction, 1);
});

test('granular runtime rewrites retain completed approved milestones through saved plan updates', () => {
  const f = fixture(), granular = readRunPlan({ plan: [{ step: 'Read another source', status: 'active' }] })!;
  f.operation.plan = retainResearchMilestones(f.operation, granular);
  assert.equal(new Set(f.operation.plan.map(step => step.id)).size, f.operation.plan.length, 'Retained observations have unique row identities');
  assert.equal(researchProgress({ ...f, connected: true }).completedMilestones, 1);
  assert.deepEqual(researchProgress({ ...f, connected: true }).steps.map(step => step.status), ['complete', 'waiting', 'waiting']);
  f.operation = JSON.parse(JSON.stringify(f.operation));
  f.operation.plan = retainResearchMilestones(f.operation, [{ ...granular[0], status: 'complete' }]);
  assert.equal(researchProgress({ ...f, connected: true }).completedMilestones, 1, 'Unmapped tool steps cannot create or erase approved milestones');
  const reopened = readRunPlan({ plan: [{ step: proposal.steps[0], status: 'pending' }] })!;
  f.operation.plan = retainResearchMilestones(f.operation, reopened);
  assert.equal(researchProgress({ ...f, connected: true }).completedMilestones, 0, 'An explicit correction is not hidden by a misleading high-water mark');
  assert.equal(retainResearchMilestones({ ...f.operation, context: { ...f.operation.context, space: 'work' } }, granular), granular);
  assert.equal(retainResearchMilestones({ ...f.operation, context: { ...f.operation.context, approvedPlan: undefined } }, granular), granular);
});

test('a current granular public detail remains readable while approved milestone progress is retained', () => {
  const f = withEstimate(), detail = 'Comparing NOAA’s explanation of winter near perihelion with NASA’s account.';
  const granular = readRunPlan({ explanation: 'Checking the two seasonal explanations.', plan: [{ step: 'Verify the specific perihelion claim', status: 'in_progress', detail }] })!;
  f.operation.plan = retainResearchMilestones(f.operation, granular);
  f.operation = JSON.parse(JSON.stringify(f.operation));
  const current = researchProgress({ ...f, connected: true });
  assert.equal(current.status, detail);
  assert.equal(current.statusSource, 'detail');
  assert.equal(current.fraction, 2 / 15);
  assert.deepEqual(current.steps.map(step => step.status), ['complete', 'waiting', 'waiting']);

  f.operation.tools = [{ id: 'newer-read', name: 'web_fetch', state: 'completed', sequence: 4 }];
  assert.equal(researchProgress({ ...f, connected: true }).status, 'Researching…', 'A newer completed tool makes the old granular detail stale');
  f.operation.planSequence = 5;
  assert.equal(researchProgress({ ...f, connected: true }).status, detail, 'A fresh public update restores the specific activity');

  f.operation.plan![0] = { ...f.operation.plan![0], detail: 'Using token=do-not-display', explanation: undefined };
  assert.equal(researchProgress({ ...f, connected: true }).status, 'Researching…', 'Sensitive detail does not become the live label');
  f.operation.plan![0].detail = detail;
  f.operation.plan!.push({ id: 'another-active', label: 'Another granular task', detail: 'Reading a different source', status: 'active' });
  assert.equal(researchProgress({ ...f, connected: true }).status, 'Researching…', 'Multiple active details do not invent a unique current activity');
});

test('bound work estimates advance independently of broad headings and retain their observed value across lifecycle interruptions', () => {
  const f = withEstimate();
  f.operation.plan = proposal.steps.map((label, index) => ({ id: String(index), label, detail: '', status: index === 0 ? 'active' : 'waiting' }));
  const first = researchProgress({ ...f, connected: true });
  assert.equal(first.fraction, 2 / 15); assert.equal(first.completedMilestones, 0);
  assert.equal(researchProgress({ ...f, connected: true, now: now + 3600000 }).fraction, first.fraction);
  f.operation.plan = f.operation.plan.map(step => ({ ...step, status: 'complete' }));
  assert.equal(researchProgress({ ...f, connected: true }).fraction, first.fraction, 'Heading checkmarks cannot manufacture estimated work');
  for (const state of ['unknown', 'failed', 'cancelled'] as const) assert.equal(researchProgress({ ...f, operation: { ...f.operation, state }, connected: false }).fraction, first.fraction);
  assert.equal(researchProgress({ ...f, connected: false }).fraction, first.fraction);
  assert.equal(researchProgress({ ...f, operation: { ...f.operation, cancelRequested: true }, connected: true }).fraction, first.fraction);
  assert.equal(researchProgress({ ...f, connected: true, questions: [f.question], now }).fraction, first.fraction);
  assert.equal(researchProgress({ ...f, operation: { ...f.operation, state: 'completed' }, connected: true }).fraction, 1);
});

test('missing, malformed and cross-run estimate bindings cannot supply a fraction or current activity', () => {
  const f = withEstimate(), original = f.operation.researchEstimate!;
  for (const changed of [{ operationId: 'other' }, { epoch: 'other' }, { nativeRunId: 'other' }, { planId: 'other' }, { planVersion: 2 }, { planDigest: 'b'.repeat(64) }]) {
    f.operation.researchEstimate = { ...original, binding: { ...original.binding, ...changed } };
    const result = researchProgress({ ...f, connected: true }); assert.equal(result.fraction, null); assert.equal(result.estimateBasis, undefined); assert.notEqual(result.statusSource, 'estimate');
  }
  f.operation.researchEstimate = { ...original, binding: undefined } as any;
  assert.equal(researchProgress({ ...f, connected: true }).fraction, null);
  f.operation.researchEstimate = { ...original, items: original.items.map(item => ({ ...item, status: 'complete' })) };
  assert.equal(researchProgress({ ...f, connected: true }).fraction, null);
});

test('estimate activity is public, current and subordinate to actual running tools', () => {
  const f = withEstimate(), estimate = f.operation.researchEstimate!;
  estimate.observedSequence = 10;
  assert.equal(researchProgress({ ...f, connected: true }).status, estimate.activity);
  assert.equal(researchProgress({ ...f, connected: true }).estimateBasis, estimate.basis);
  f.operation.tools = [{ id: 'search', name: 'web_search', input: 'new primary evidence', state: 'running', sequence: 11 }];
  assert.equal(researchProgress({ ...f, connected: true }).status, 'Searching for new primary evidence');
  f.operation.tools[0].state = 'completed';
  assert.notEqual(researchProgress({ ...f, connected: true }).statusSource, 'estimate', 'A finished newer tool still makes older estimate activity stale');
  estimate.observedSequence = 12;
  assert.equal(researchProgress({ ...f, connected: true }).statusSource, 'estimate');
  f.operation.planSequence = 13;
  assert.equal(researchProgress({ ...f, connected: true }).statusSource, 'detail', 'A newer public plan detail takes precedence');
  estimate.observedSequence = 14; estimate.activity = 'Using token=do-not-display'; estimate.basis = 'Using password=do-not-display';
  const safe = researchProgress({ ...f, connected: true }); assert.notEqual(safe.statusSource, 'estimate'); assert.equal(safe.estimateBasis, undefined); assert.doesNotMatch(safe.status, /do-not-display/); assert.equal(safe.fraction, 2 / 15);
});
