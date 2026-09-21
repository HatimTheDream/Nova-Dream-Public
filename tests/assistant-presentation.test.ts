import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { registerHooks } from 'node:module';
import type { AssistantOperation, ConversationMessage, QueuedMessage } from '../packages/domain/assistant';

const styles = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { SavedMessageText, ReplyText } = await import('../apps/client/src/ReplyText');
const { StepsPill, ToolActivity } = await import('../apps/client/src/ToolActivity');
const { messageQueueSummary } = await import('../apps/client/src/MessageQueue');
styles.deregister();

test('an empty saved user entry is explained without fabricating text or labelling a file-only message empty', () => {
  const message: ConversationMessage = { id: 'kept-id', role: 'user', text: '', textHash: 'kept-hash', attachments: [] };
  const render = (next: ConversationMessage) => renderToStaticMarkup(createElement(SavedMessageText, { message: next }));
  assert.match(render(message), /This saved message has no text or files/);
  assert.doesNotMatch(render({ ...message, attachments: [{ name: 'original.txt', availability: 'unavailable' }] }), /no text or files/);
  assert.doesNotMatch(render({ ...message, text: '  Original Case  ' }), /no text or files/);
  assert.match(render({ ...message, text: '  Original Case  ' }), /  Original Case  /);
  assert.equal(render({ ...message, role: 'tool' }), '');
  assert.doesNotMatch(renderToStaticMarkup(createElement(ReplyText, { text: '', role: 'assistant', streaming: true })), /no text or files/);
  assert.equal(message.id, 'kept-id'); assert.equal(message.text, '');
});

test('an uncertain operation keeps the observed tools and plan without claiming live progress', () => {
  const operation = { id: 'original-operation', state: 'unknown', createdAt: '2026-09-21T00:00:00Z', updatedAt: '2026-09-21T00:00:05Z', tools: [{ id: 'read-1', name: 'read', state: 'running', output: 'Original retained output' }], plan: [{ id: 'first', label: 'Read', status: 'complete' }, { id: 'second', label: 'Review', status: 'active' }] } as AssistantOperation;
  const activity = renderToStaticMarkup(createElement(ToolActivity, { operation }));
  assert.match(activity, /Last reported activity/); assert.match(activity, /Outcome unconfirmed/); assert.match(activity, /Original retained output/);
  const plan = renderToStaticMarkup(createElement(StepsPill, { operation, plan: operation.plan }));
  assert.match(plan, /Last reported/); assert.match(plan, /Step 2 of 2/); assert.doesNotMatch(plan, /class="run-pulse"/);
  const running = renderToStaticMarkup(createElement(StepsPill, { operation: { ...operation, state: 'running' }, plan: operation.plan }));
  assert.match(running, /class="run-pulse"/); assert.doesNotMatch(running, /Last reported/);
  assert.equal(operation.state, 'unknown'); assert.equal(operation.id, 'original-operation');
});

test('queue summary distinguishes automatic work from paused writing and excludes past submissions', () => {
  const items = [{ state: 'paused', automatic: true }, { state: 'paused', automatic: false }, { state: 'paused' }, { state: 'submitted', automatic: true }, { state: 'removed' }] as QueuedMessage[];
  assert.equal(messageQueueSummary(items), '1 queued · 2 paused');
  assert.equal(messageQueueSummary(items.slice(1)), '2 paused');
  assert.equal(messageQueueSummary(items.slice(3)), 'Message queue');
});
