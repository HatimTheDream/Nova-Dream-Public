import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { registerHooks } from 'node:module';
import type { AssistantOperation, ConversationMessage } from '../packages/domain/assistant';
import type { TranscriptMessage } from '../apps/client/src/voice-transcript';
import { groupWorkMessages, unrepresentedWorkTools } from '../apps/client/src/work-transcript';

const styles = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { WorkTranscript } = await import('../apps/client/src/WorkTranscript');
styles.deregister();
const op = { id: 'op', conversationId: 'chat', nativeId: 'native', nativeRunId: 'run', state: 'completed', createdAt: '2026-09-21T12:00:00Z', updatedAt: '2026-09-21T12:01:00Z', text: 'Final answer', tools: [] } as unknown as AssistantOperation;
const message = (id: string, changes: Partial<TranscriptMessage> = {}): TranscriptMessage => ({ id, role: 'assistant', operationId: 'op', text: '', textHash: id, attachments: [], ...changes });
const renderMessage = (part: ConversationMessage) => createElement('article', { 'data-message': part.id }, part.text, ...part.attachments.map(file => createElement('a', { key: file.name }, file.name)));

test('the final answer stays outside the collapsed work phase and paired actions render once', () => {
  const parts = [message('commentary', { text: 'Looking into it.' }), message('call', { toolInfo: { id: 'read', name: 'read', state: 'called', entries: [{ id: 'read', name: 'read' }] } }), message('result', { role: 'tool', text: 'File contents', toolInfo: { id: 'read', name: 'read', state: 'completed' } }), message('final', { text: op.text })];
  const grouped = groupWorkMessages(parts, { operations: [op], conversationId: 'chat', nativeId: 'native' });
  const html = renderToStaticMarkup(createElement(WorkTranscript, { message: grouped[0], renderMessage }));
  assert.equal((html.match(/<details /g) ?? []).length, 1);
  assert.ok(html.indexOf('data-message="final"') > html.lastIndexOf('</section>'));
  assert.match(html, /class="work-phase-content" hidden=""/);
  assert.match(html, /Looking into it/);
});

test('a role-optional source match opens the paired result and its complete saved output', () => {
  const parts = [message('call', { toolInfo: { id: 'read', name: 'read', state: 'called' } }), message('result', { role: 'tool', text: Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n'), toolInfo: { id: 'read', name: 'read', state: 'completed' } })];
  const html = renderToStaticMarkup(createElement(WorkTranscript, { message: { ...parts[0], workParts: parts }, match: { id: 'result' }, renderMessage }));
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /work-action matched-message/);
  assert.match(html, /line 29/);
  assert.doesNotMatch(html, /class="work-phase-content" hidden/);
});

test('initial runtime activity remains visible, plan bookkeeping stays quiet, and visible stream text is not repeated', () => {
  const active = { ...op, state: 'running', tools: [{ id: 'read', name: 'read', state: 'running', sequence: 1 }, { id: 'plan', name: 'update_plan', state: 'completed', sequence: 2 }] } as AssistantOperation;
  const html = renderToStaticMarkup(createElement(WorkTranscript, { message: { ...message('live'), workParts: [], workOperation: active }, hideStream: true, renderMessage }));
  assert.match(html, /Reading a file/);
  assert.doesNotMatch(html, /Final answer|Update plan/);
  assert.equal((html.match(/<details /g) ?? []).length, 1);
});

test('a steering boundary renders one paired action, preserves the follow-up and shows unseen activity only once', () => {
  const active = { ...op, state: 'running', text: 'Continuing with the follow-up.', tools: [
    { id: 'read', name: 'read', state: 'completed', sequence: 1, output: 'The retained file contents' },
    { id: 'unseen', name: 'exec', state: 'running', sequence: 2 },
  ] } as AssistantOperation;
  const parts = [
    message('call', { toolInfo: { id: 'read', name: 'read', state: 'called' } }),
    message('steer', { role: 'user', operationId: 'steer-operation', text: 'Check the related file too.' }),
    message('result', { role: 'tool', text: 'The retained file contents', toolInfo: { id: 'read', name: 'read', state: 'completed' } }),
  ];
  const rows = groupWorkMessages(parts, { operations: [active], active, conversationId: 'chat', nativeId: 'native' });
  const fallback = { ...message('fallback'), workParts: [], workOperation: { ...active, tools: unrepresentedWorkTools(rows, active) } };
  const html = renderToStaticMarkup(createElement('div', null,
    ...rows.map(row => row.workParts ? createElement(WorkTranscript, { key: row.id, message: row, match: { id: 'result' }, renderMessage }) : renderMessage(row)),
    createElement(WorkTranscript, { message: fallback, renderMessage }),
  ));
  assert.equal((html.match(/The retained file contents/g) ?? []).length, 1);
  assert.equal((html.match(/Check the related file too\./g) ?? []).length, 1);
  assert.equal((html.match(/Continuing with the follow-up\./g) ?? []).length, 1);
  assert.equal((html.match(/class="work-phase-trigger"/g) ?? []).length, 1);
  assert.equal((html.match(/<details /g) ?? []).length, 2);
  assert.match(html, /work-action matched-message/);
  assert.ok(html.indexOf('The retained file contents') < html.indexOf('data-message="steer"'));
});

test('a grouped source match opens its summary and full result while blocked actions stay outside', () => {
  const parts = [
    message('first', { role: 'tool', text: 'Read output', toolInfo: { id: 'first', name: 'read', state: 'completed' } }),
    message('second', { role: 'tool', text: Array.from({ length: 30 }, (_, index) => `result ${index}`).join('\n'), toolInfo: { id: 'second', name: 'exec', state: 'completed' } }),
    message('blocked', { role: 'tool', text: 'Permission needed', toolInfo: { id: 'third', name: 'exec', state: 'blocked' } }),
  ];
  const html = renderToStaticMarkup(createElement(WorkTranscript, { message: { ...parts[0], workParts: parts }, match: { id: 'second' }, renderMessage }));
  assert.match(html, /class="work-action-group" open=""/);
  assert.match(html, /Read a file, ran a command/);
  assert.match(html, /work-action matched-message/);
  assert.match(html, /result 29/);
  assert.match(html, /work-activity-row--blocked/);
  assert.ok(html.indexOf('work-activity-row--blocked') > html.indexOf('result 29'));
});
