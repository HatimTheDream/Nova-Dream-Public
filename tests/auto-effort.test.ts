import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantModel, ContextManifest } from '../packages/domain/assistant.js';
import type { Attachment } from '../packages/domain/contracts.js';
import { nativeThinking, responseEffortLevels, taskEffortDemand, resolveAutoEffort } from '../packages/domain/auto-effort.js';

const context: Pick<ContextManifest, 'attachments' | 'project' | 'workMode'> = { attachments: [], project: null };
const model: AssistantModel = { id: 'test/model', name: 'Test', provider: 'test', available: true, isDefault: true, reasoning: ['low', 'medium', 'high'] };
test('the existing slider adds Auto after Default and never invents effort capabilities', () => {
  assert.deepEqual(responseEffortLevels(model.reasoning), [null, 'auto', 'low', 'medium', 'high']);
  assert.deepEqual(responseEffortLevels(undefined), [null]);
  assert.deepEqual(responseEffortLevels(['experimental']), [null, 'experimental']);
  assert.equal(nativeThinking('auto'), null); assert.equal(nativeThinking('high'), 'high'); assert.equal(nativeThinking(null), null);
});
test('task-aware effort distinguishes straightforward requests, ordinary planning and demanding work', () => {
  assert.equal(taskEffortDemand('Rewrite this sentence more clearly: We will do the thing tomorrow.', context), 'low');
  assert.equal(taskEffortDemand('Help plan a birthday party.', { ...context, workMode: 'plan' }), 'medium');
  assert.equal(taskEffortDemand('Debug intermittent failures and audit the retry behavior.', context), 'high');
  assert.equal(taskEffortDemand('Compare these options.', { ...context, workMode: 'research' }), 'high');
  assert.equal(taskEffortDemand('Update this:\n1. Capture the original\n2. Verify the result\n3. Keep the history', context), 'high');
});
test('short requests with substantial files or project sources are not classified as easy', () => {
  const file = { size: 50_000 } as Attachment;
  assert.equal(taskEffortDemand('Summarize this.', { ...context, attachments: [file] }), 'high');
  assert.equal(taskEffortDemand('Summarize this.', { ...context, attachments: [{ ...file, size: 20 }] }), 'medium');
  assert.equal(taskEffortDemand('Summarize this.', { ...context, project: { id: 'project:a', revision: 1, name: 'A', purpose: 'source '.repeat(250) } }), 'high');
});
test('continuation inherits captured task demand while a new simple request can use lower effort', () => {
  for (const input of ['Continue', 'Okay, go ahead.', 'Please finish it', 'Implement the plan']) assert.equal(taskEffortDemand(input, context, 'high'), 'high');
  assert.equal(taskEffortDemand('Continue', context), 'medium');
  assert.equal(taskEffortDemand('Define a byte.', context, 'high'), 'low');
});
test('Auto selects supported levels for the captured model and never switches models or guesses capabilities', () => {
  assert.equal(resolveAutoEffort('low', model.id, [model]).level, 'low');
  assert.equal(resolveAutoEffort('high', model.id, [{ ...model, reasoning: ['minimal', 'medium'] }]).level, 'medium');
  assert.equal(resolveAutoEffort('medium', model.id, [{ ...model, reasoning: ['low', 'xhigh'] }]).level, 'xhigh');
  assert.equal(resolveAutoEffort('high', null, [model]).model, model.id);
  const unknown = resolveAutoEffort('high', 'missing/model', [model]);
  assert.equal(unknown.level, null); assert.equal(unknown.model, 'missing/model'); assert.equal(unknown.reason, 'capability-unavailable');
  for (const models of [[], [{ ...model, available: false }], [{ ...model, reasoning: undefined }], [{ ...model, reasoning: ['experimental'] }]]) assert.equal(resolveAutoEffort('high', model.id, models).level, null);
  assert.equal(resolveAutoEffort('high', null, [model], 'missing/effective').level, null);
});
