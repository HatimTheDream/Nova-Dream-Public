import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantOperation } from '../packages/domain/assistant.js';
import { groupWorkMessages, hasVisibleOperationText, unrepresentedWorkTools, workEntries } from '../apps/client/src/work-transcript.js';
import { transcriptContains, transcriptParts, type TranscriptMessage } from '../apps/client/src/voice-transcript.js';

const source: NonNullable<TranscriptMessage['source']> = { bindingId: 'binding', nativeId: 'native', nativeKey: 'key', connectionGeneration: 'generation', kind: 'native', observedAt: '2026-09-21T12:00:00.000Z' };
const message = (id: string, changes: Partial<TranscriptMessage> = {}): TranscriptMessage => ({ id, novaId: `nova-${id}`, aliases: [`old-${id}`], role: 'assistant', text: '', textHash: `hash-${id}`, attachments: [], source, operationId: 'operation', runId: 'run', ...changes });
const operation = (changes: Partial<AssistantOperation> = {}): AssistantOperation => ({ id: 'operation', conversationId: 'chat', connectionGeneration: 'generation', nativeId: 'native', nativeKey: 'key', nativeRunId: 'run', state: 'completed', text: 'Final answer.', createdAt: '2026-09-21T12:00:00.000Z', updatedAt: '2026-09-21T12:01:32.000Z', tools: [], ...changes } as AssistantOperation);
const call = (id: string, callId = 'call', changes: Partial<TranscriptMessage> = {}) => message(id, { toolInfo: { name: 'read', state: 'called', entries: [{ id: callId, name: 'read', input: 'README.md' }] }, ...changes });
const result = (id: string, callId = 'call', changes: Partial<TranscriptMessage> = {}) => message(id, { role: 'tool', text: 'Read output.', toolInfo: { id: callId, name: 'read', state: 'completed' }, ...changes });
const group = (messages: TranscriptMessage[], op = operation()) => groupWorkMessages(messages, { operations: [op], conversationId: 'chat', nativeId: 'native', ...(op.state === 'running' ? { active: op } : {}) });
const tools = (messages: TranscriptMessage[], op?: AssistantOperation) => workEntries(messages, op).filter(entry => entry.kind === 'tool');

test('a completed work phase retains exact message identities and keeps its proven final answer separate', () => {
  const parts = [message('comment', { text: 'Checking the file.' }), call('start'), result('done'), message('final', { text: 'Final answer.' })];
  const before = structuredClone(parts), rows = group(parts);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, parts[0].id); assert.equal(rows[0].textHash, parts[0].textHash);
  assert.deepEqual(rows[0].workParts, parts); assert.equal(rows[0].workFinal, parts[3]); assert.equal(rows[0].workOperation?.id, 'operation');
  assert.deepEqual(transcriptParts(rows[0]), parts);
  for (const part of parts) for (const id of [part.id, part.novaId!, ...part.aliases!]) assert(transcriptContains(rows[0], id, part.role));
  assert.deepEqual(parts, before);
});

test('unknown or non-unique final text cannot hide ordinary assistant messages', () => {
  const first = message('first', { text: 'Final answer.' }), second = message('second', { text: 'Final answer.' });
  for (const parts of [[first, call('start'), result('done'), second], [message('comment', { text: 'A possible answer.' }), call('start'), result('done')]]) {
    const rows = group(parts);
    assert(rows.every(row => !row.workOperation && !row.workFinal));
    for (const part of parts.filter(item => item.role === 'assistant' && !item.toolInfo)) assert(rows.includes(part));
  }
});

test('an active operation groups narration without claiming a finished answer', () => {
  const op = operation({ state: 'running', text: 'Checking now.' }), parts = [message('comment', { text: 'Checking now.' }), call('start')];
  const rows = group(parts, op);
  assert.equal(rows.length, 1); assert.equal(rows[0].workOperation, op); assert.equal(rows[0].workFinal, undefined);
  assert.deepEqual(rows[0].workParts, parts);
});

test('steering keeps its user message while a trusted call and later result remain one activity', () => {
  const op = operation({ state: 'running', text: 'Applying the follow-up.', tools: [
    { id: 'call', name: 'read', state: 'completed', sequence: 10, output: 'Read output.' },
    { id: 'unseen', name: 'exec', state: 'running', sequence: 11 },
  ] });
  const start = call('start'), steer = message('steer', { role: 'user', operationId: 'steer-operation', text: 'Also check the next file.' });
  const done = result('done'), narration = message('narration', { text: 'Applying the follow-up.' });
  const parts = [start, steer, done, narration], before = structuredClone(parts), rows = group(parts, op);
  const fragments = rows.filter(row => row.workActivityOperation);
  assert.equal(fragments.length, 1);
  assert.deepEqual(fragments[0].workParts, [start, done]);
  assert.equal(rows[1], steer); assert.equal(rows[2], narration);
  assert(rows.every(row => !row.workOperation));
  assert(transcriptContains(fragments[0], done.id, done.role));
  const visible = workEntries(fragments[0].workParts!, fragments[0].workActivityOperation, { includeUnseen: false });
  assert.equal(visible.length, 1); assert.equal(visible[0].kind, 'tool');
  if (visible[0].kind === 'tool') assert.equal(visible[0].tool.state, 'completed');
  assert.deepEqual(unrepresentedWorkTools(rows, op).map(tool => tool.id), ['unseen']);
  assert.deepEqual(parts, before);
});

test('split work fragments reflect current runtime progress and retain conflicting fallback receipts', () => {
  const start = call('start'), steer = message('steer', { role: 'user', operationId: 'steer-operation', text: 'Follow-up' });
  const narration = message('after', { text: 'Continuing.' }), parts = [start, steer, narration];
  for (const state of ['running', 'completed', 'blocked'] as const) {
    const op = operation({ state: 'running', tools: [{ id: 'call', name: 'read', state, sequence: 10, output: `${state} observation` }] });
    const rows = group(parts, op), fragment = rows.find(row => row.workActivityOperation)!;
    const entry = workEntries(fragment.workParts!, fragment.workActivityOperation, { includeUnseen: false })[0];
    assert.equal(entry.kind, 'tool'); if (entry.kind === 'tool') assert.equal(entry.tool.state, state);
    assert.deepEqual(unrepresentedWorkTools(rows, op), []);
  }
  const conflicting = operation({ state: 'running', tools: [{ id: 'call', name: 'read', state: 'failed', sequence: 10, output: 'Runtime failure' }] });
  const rows = group([start, steer, result('done'), narration], conflicting);
  assert.deepEqual(unrepresentedWorkTools(rows, conflicting).map(tool => tool.output), ['Runtime failure']);
});

test('stopped and failed turns retain their partial answer outside a timed work wrapper', () => {
  for (const state of ['cancelled', 'failed'] as const) {
    const op = operation({ state, text: 'Partial reply.', settledAt: '2026-09-21T12:01:32.000Z' });
    const parts = [message('comment', { text: 'Checking now.' }), call('start'), message('partial', { text: op.text })];
    const rows = group(parts, op);
    assert.equal(rows.length, 1); assert.equal(rows[0].workOperation, op); assert.equal(rows[0].workOperation?.state, state);
    assert.equal(rows[0].workFinal, parts[2]); assert.deepEqual(transcriptParts(rows[0]), parts);
  }
});

test('interrupted tool-only turns can show their duration but unproven narration stays visible', () => {
  for (const state of ['cancelled', 'failed'] as const) {
    const op = operation({ state, text: '' }), toolsOnly = [call('start'), result('done')];
    const rows = group(toolsOnly, op);
    assert.equal(rows.length, 1); assert.equal(rows[0].workOperation, op); assert.equal(rows[0].workFinal, undefined);
    const narration = message('comment', { text: 'This reply was retained.' });
    const unproven = group([narration, ...toolsOnly], op);
    assert(unproven.includes(narration)); assert(unproven.every(row => !row.workOperation));
  }
});

test('a confirmed tool-only completion keeps its operation receipt without inventing a final answer', () => {
  const op = operation({ text: '', tools: [{ id: 'call', name: 'read', state: 'completed', sequence: 10, output: 'Confirmed file contents' }] });
  const parts = [call('start')], rows = group(parts, op);
  assert.equal(rows.length, 1); assert.equal(rows[0].workOperation, op); assert.equal(rows[0].workFinal, undefined);
  assert.equal(tools(rows[0].workParts!, rows[0].workOperation)[0].tool.state, 'completed');
  assert.deepEqual(transcriptParts(rows[0]), parts);
  // A missing final outside this window must not be mistaken for an empty one.
  assert.equal(group(parts, operation({ text: 'A final outside the loaded page' }))[0].workOperation, undefined);
});

test('streaming text is suppressed only by the exact visible reply from its trusted operation', () => {
  const op = operation({ state: 'running', text: 'Working reply.' }), exact = message('reply', { text: op.text });
  assert(hasVisibleOperationText([exact], op, 'native'));
  assert(hasVisibleOperationText(group([exact], op), op, 'native'));
  assert(hasVisibleOperationText([{ ...exact, source: undefined }], op, 'native'));
  assert(hasVisibleOperationText([{ ...exact, operationId: undefined }], op, 'native'));
  for (const changes of [
    { role: 'user' as const }, { text: `${op.text} Extra.` }, { authoredText: 'Edited visible reply.' },
    { operationId: 'different' }, { runId: 'different' }, { operationId: undefined, runId: undefined },
    { source: { ...source, nativeId: 'different' } }, { source: { ...source, nativeKey: 'different' } },
    { source: { ...source, connectionGeneration: 'different' } }, { source: { ...source, kind: 'voice' as const } },
  ]) assert.equal(hasVisibleOperationText([{ ...exact, ...changes }], op, 'native'), false);
  assert.equal(hasVisibleOperationText([{ ...exact, source: undefined }], op, 'different'), false);
  assert.equal(hasVisibleOperationText([message('empty')], operation({ text: '' }), 'native'), false);
});

test('user, system, voice and provider binding boundaries prevent a turn from masquerading as one complete phase', () => {
  const first = call('start'), final = message('final', { text: 'Final answer.' });
  for (const boundary of [
    message('user', { role: 'user', text: 'Another request.' }), message('system', { role: 'system', text: 'Boundary.' }),
    message('voice:call:entry', { text: 'Spoken words.', source: { ...source, kind: 'voice' } }),
    message('foreign', { text: 'Another binding.', source: { ...source, bindingId: 'other-binding' } }),
  ]) {
    const rows = group([first, boundary, final]);
    assert(rows.every(row => !row.workOperation));
    assert(rows.includes(final));
  }
});

test('native identity, connection generation, conversation and run must match before an operation is attached', () => {
  const final = message('final', { text: 'Final answer.' });
  for (const changes of [{ nativeId: 'other' }, { nativeKey: 'other' }, { connectionGeneration: 'other' }, { nativeRunId: 'other' }, { conversationId: 'other' }, { steerTarget: 'other' }]) {
    assert.equal(group([final], operation(changes))[0].workOperation, undefined);
  }
  assert.equal(group([message('final', { ...final, operationId: undefined })])[0].workOperation?.id, 'operation');
  assert.equal(group([message('final', { ...final, operationId: undefined, runId: undefined })])[0].workOperation, undefined);
});

test('explicit operation and native run receipts may identify adjacent messages without splitting one proven turn', () => {
  const parts = [call('start', 'call', { runId: undefined }), result('done', 'call', { operationId: undefined }), message('final', { text: 'Final answer.' })];
  const rows = group(parts);
  assert.equal(rows.length, 1); assert.equal(rows[0].workFinal, parts[2]);
  assert.equal(tools(parts.slice(0, 2), operation()).length, 1);
});

test('legacy tool-only groups stop at narration and identity boundaries without inventing a duration', () => {
  const parts = [call('a'), result('b'), message('comment', { text: 'Visible narration.' }), call('c', 'next'), result('d', 'next', { source: { ...source, bindingId: 'other' } })];
  const rows = groupWorkMessages(parts, { operations: [], conversationId: 'chat', nativeId: 'native' });
  assert.equal(rows.length, 4); assert.deepEqual(rows[0].workParts, parts.slice(0, 2)); assert.equal(rows[1], parts[2]);
  assert(rows.every(row => !row.workOperation));
});

test('multiple calls pair by exact call ID even when outcomes arrive in reverse order', () => {
  const start = call('start', 'a', { toolInfo: { name: '2 tools', state: 'called', entries: [{ id: 'a', name: 'read', input: 'a.md' }, { id: 'b', name: 'read', input: 'b.md' }] } });
  const b = result('b', 'b', { text: 'B output' }), a = result('a', 'a', { text: 'A output' });
  const rows = tools([start, b, a]);
  assert.deepEqual(rows.map(row => [row.tool.id, row.tool.input, row.tool.output, row.tool.state]), [['a', 'a.md', 'A output', 'completed'], ['b', 'b.md', 'B output', 'completed']]);
  assert.deepEqual(rows[0].sources, [start, a]); assert.deepEqual(rows[1].sources, [start, b]);
});

test('interleaved narration stays ordered while an action receives one final outcome', () => {
  const start = call('start'), comment = message('comment', { text: 'I found the relevant section.' }), done = result('done');
  const rows = workEntries([start, comment, done]);
  assert.equal(rows.length, 2); assert.equal(rows[0].kind, 'tool'); assert.deepEqual(rows[1], { kind: 'message', message: comment });
  const reversed = tools([done, start]); assert.equal(reversed.length, 1); assert.equal(reversed[0].tool.input, 'README.md'); assert.equal(reversed[0].tool.state, 'completed');
});

test('a matching name or ID across a different source scope never pairs unrelated activity', () => {
  const start = call('start');
  for (const changes of [{ source: { ...source, bindingId: 'other' } }, { source: { ...source, nativeId: 'other' } }, { source: { ...source, connectionGeneration: 'other' } }, { runId: 'other' }, { operationId: 'other' }]) {
    const rows = tools([start, result('done', 'call', changes)]);
    assert.equal(rows.length, 2); assert.equal(rows[0].tool.state, 'unknown');
  }
  assert.equal(tools([start, result('done', 'different')]).length, 2);
  const anonymous = call('anonymous', '', { toolInfo: { name: 'read', state: 'called', calls: ['read'] } });
  assert.equal(tools([anonymous, result('done')]).length, 2);
});

test('duplicate deliveries fold only when their outcomes agree; conflicting outcomes remain inspectable', () => {
  const start = call('start'), first = result('one'), duplicate = result('two');
  assert.equal(tools([start, first, duplicate]).length, 1);
  for (const conflict of [result('conflict', 'call', { text: 'Different output' }), result('conflict', 'call', { toolInfo: { id: 'call', name: 'read', state: 'failed' } })]) {
    const rows = tools([start, first, conflict]);
    assert.equal(rows.length, 3); assert.equal(rows[1].tool.output, first.text); assert.equal(rows[2].tool.output, conflict.text);
  }
});

test('unconfirmed outcomes stay unknown and blocked execution stays distinct from failure', () => {
  for (const state of ['unknown', 'blocked', 'failed'] as const) {
    const rows = tools([call('start'), result('done', 'call', { toolInfo: { id: 'call', name: 'read', state } })]);
    assert.equal(rows.length, 1); assert.equal(rows[0].tool.state, state);
  }
  assert.equal(tools([call('start')])[0].tool.state, 'unknown');
});

test('only confirmed live operation activity can turn a saved call into a running action', () => {
  const runtime = { id: 'call', name: 'read', state: 'running' as const, sequence: 10 }, start = call('start');
  assert.equal(tools([start], operation({ state: 'running', tools: [runtime] }))[0].tool.state, 'running');
  for (const state of ['completed', 'cancelled', 'failed', 'unknown'] as const) assert.equal(tools([start], operation({ state, tools: [runtime] }))[0].tool.state, 'unknown');
  const resultUnknown = result('unknown', 'call', { toolInfo: { id: 'call', name: 'read', state: 'unknown' } });
  assert.equal(tools([start, resultUnknown], operation({ state: 'running', tools: [runtime] }))[0].tool.state, 'unknown');
});

test('trusted runtime tools enrich one saved action and append unseen activity, with foreign scopes excluded', () => {
  const op = operation({ state: 'running', tools: [{ id: 'call', name: 'read', state: 'completed', sequence: 10, output: 'Runtime output' }, { id: 'unseen', name: 'exec', state: 'running', sequence: 11 }] });
  const rows = tools([call('start')], op);
  assert.equal(rows.length, 2); assert.equal(rows[0].tool.output, 'Runtime output'); assert.equal(rows[1].tool.id, 'unseen');
  assert.equal(workEntries([], op).length, 2);
  const foreign = tools([call('start', 'call', { source: { ...source, nativeId: 'different' } })], op);
  assert.equal(foreign.length, 1); assert.equal(foreign[0].tool.state, 'unknown');
});

test('conflicting runtime and saved terminal results are retained separately', () => {
  const op = operation({ tools: [{ id: 'call', name: 'read', state: 'failed', sequence: 10, output: 'Runtime failure' }] });
  assert.deepEqual(tools([call('start'), result('done')], op).map(row => row.tool.state), ['completed', 'failed']);
});

test('a truncated runtime receipt and its full saved result render once with all retained text', () => {
  const output = 'Retained result '.repeat(1200), prefix = output.slice(0, 16000);
  for (const state of ['completed', 'failed', 'blocked'] as const) {
    const saved = result('saved', 'call', { text: output, toolInfo: { id: 'call', name: 'read', state } });
    const op = operation({ tools: [{ id: 'call', name: 'read', state, sequence: 10, output: prefix, truncated: true }] });
    const rows = tools([call('start'), saved], op);
    assert.equal(rows.length, 1); assert.equal(rows[0].tool.output, output); assert.equal(rows[0].tool.state, state);
    assert.equal(rows[0].tool.truncated, undefined); assert.deepEqual(rows[0].sources, [call('start'), saved]);
  }
  const unknown = result('saved', 'call', { text: output, toolInfo: { id: 'call', name: 'read', state: 'unknown' } });
  const confirmed = operation({ tools: [{ id: 'call', name: 'read', state: 'completed', sequence: 10, output: prefix, truncated: true }] });
  assert.equal(tools([unknown], confirmed).length, 1);
  assert.equal(tools([unknown], confirmed)[0].tool.state, 'completed');
  // An ordinary short result is not evidence of truncation.
  assert.equal(tools([unknown], { ...confirmed, tools: [{ ...confirmed.tools![0], truncated: false }] }).length, 2);
});

test('a confirmed empty runtime output does not erase a different saved receipt', () => {
  for (const truncated of [false, true]) {
    const op = operation({ tools: [{ id: 'call', name: 'read', state: 'completed', sequence: 10, output: '', truncated }] });
    assert.deepEqual(tools([result('saved')], op).map(row => row.tool.output), ['Read output.', '']);
  }
});

test('different unconfirmed text cannot replace a confirmed receipt or borrow its outcome', () => {
  const saved = result('unconfirmed', 'call', { text: 'Unconfirmed observation', toolInfo: { id: 'call', name: 'read', state: 'unknown' } });
  for (const state of ['completed', 'failed', 'blocked'] as const) {
    const op = operation({ tools: [{ id: 'call', name: 'read', state, sequence: 10, output: 'Confirmed receipt' }] });
    const rows = tools([call('start'), saved], op);
    assert.deepEqual(rows.map(row => [row.tool.state, row.tool.output]), [['unknown', 'Unconfirmed observation'], [state, 'Confirmed receipt']]);
    assert.deepEqual(rows[0].sources, [call('start'), saved]);
  }
  const noOutput = operation({ tools: [{ id: 'call', name: 'read', state: 'completed', sequence: 10 }] });
  assert.deepEqual(tools([saved], noOutput).map(row => [row.tool.state, row.tool.output]), [['unknown', 'Unconfirmed observation'], ['completed', undefined]]);
});

test('identical unconfirmed text can use its exact confirmed receipt without duplicate activity', () => {
  const saved = result('unconfirmed', 'call', { text: 'Same receipt', toolInfo: { id: 'call', name: 'read', state: 'unknown' } });
  const op = operation({ tools: [{ id: 'call', name: 'read', state: 'completed', sequence: 10, output: 'Same receipt' }] });
  const rows = tools([saved], op);
  assert.equal(rows.length, 1); assert.equal(rows[0].tool.state, 'completed'); assert.equal(rows[0].tool.output, 'Same receipt');
});

test('a confirmed saved result also preserves different unconfirmed runtime text separately', () => {
  const op = operation({ tools: [{ id: 'call', name: 'read', state: 'unknown', sequence: 10, output: 'Runtime observation' }] });
  assert.deepEqual(tools([result('saved')], op).map(row => [row.tool.state, row.tool.output]), [['completed', 'Read output.'], ['unknown', 'Runtime observation']]);
});

test('a reused call ID cannot erase contradictory tool identities', () => {
  const start = call('start'), other = result('done', 'call', { toolInfo: { id: 'call', name: 'exec', state: 'completed' } });
  assert.deepEqual(tools([start, other]).map(row => row.tool.name), ['read', 'exec']);
  const op = operation({ tools: [{ id: 'call', name: 'exec', state: 'completed', sequence: 10 }] });
  assert.deepEqual(tools([start], op).map(row => row.tool.name), ['read', 'exec']);
});

test('folded actions retain file sources and a mixed narration/call keeps its readable message', () => {
  const start = call('start', 'call', { text: 'Reading the file.', attachments: [{ artifactId: 'input', name: 'input.txt' }] });
  const done = result('done', 'call', { attachments: [{ artifactId: 'output', name: 'output.txt' }] });
  const before = structuredClone([start, done]), rows = workEntries([start, done]);
  assert.equal(rows.length, 2); assert.equal(rows[0].kind, 'message'); assert.equal(rows[1].kind, 'tool');
  if (rows[0].kind === 'message') { assert.equal(rows[0].message.text, start.text); assert.equal(rows[0].message.toolInfo, undefined); assert.deepEqual(rows[0].message.attachments, start.attachments); }
  if (rows[1].kind === 'tool') assert.deepEqual(rows[1].sources, [start, done]);
  assert.deepEqual([start, done], before);
});
