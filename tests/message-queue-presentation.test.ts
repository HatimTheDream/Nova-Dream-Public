import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { registerHooks } from 'node:module';
import type { AssistantOperation, QueuedMessage } from '../packages/domain/assistant';
import type { AssistantController } from '../apps/client/src/useAssistant';

const styles = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { MessageQueue } = await import('../apps/client/src/MessageQueue');
styles.deregister();
const item = (changes: Partial<QueuedMessage> = {}) => ({ id: 'first', revision: 1, conversationId: 'conversation', state: 'paused', automatic: false, input: 'Original writing', createdAt: '2026-09-21T12:00:00Z', context: { attachments: [] }, ...changes }) as QueuedMessage;
const render = (queue: QueuedMessage[], operations: AssistantOperation[] = [], blocked = false, connectionState = 'ready', historyOpen = false) => {
  const controller = { queue, operations, conversation: { id: 'conversation' }, connection: { state: connectionState } } as AssistantController;
  return renderToStaticMarkup(createElement(MessageQueue, { controller, conversationId: 'conversation', epoch: 'epoch', blocked, historyOpen, copy: () => { throw new Error('Rendering must not copy or dispatch writing.'); } }));
};

test('a paused message offers Run next only when the current conversation can run it', () => {
  const queued = item(), before = JSON.stringify(queued);
  assert.match(render([queued]), />Run next</);
  assert.doesNotMatch(render([queued], [], true), />Run next</);
  assert.doesNotMatch(render([queued], [], false, 'disconnected'), />Run next</);
  assert.match(render([queued], [], true), /Original writing/);
  assert.equal(JSON.stringify(queued), before);
});

test('unknown original runs remain visible before earlier items and do not offer dispatch again', () => {
  const original = item({ id: 'original', state: 'submitted', operationId: 'run', input: 'Previously sent writing' });
  const previous = item({ id: 'previous', state: 'removed', input: 'Kept aside writing' });
  const operation = { id: 'run', state: 'unknown' } as AssistantOperation;
  const markup = render([previous, original], [operation], true);
  assert.match(markup, /Outcome unconfirmed/);
  assert.match(markup, />Check original run</);
  assert.doesNotMatch(markup, /Kept aside writing|Earlier queue items/);
  const history = render([previous, original], [operation], true, 'ready', true);
  assert.ok(history.indexOf('Previously sent writing') < history.indexOf('Earlier queue items'));
  assert.match(history, /Kept aside writing/);
  assert.doesNotMatch(markup, />Run next</);
  assert.equal(original.state, 'submitted'); assert.equal(operation.state, 'unknown');
});

test('automatic waiting retains Pause while later automatic items are labelled Queued', () => {
  const first = item({ automatic: true }), second = item({ id: 'second', automatic: true, input: 'Second writing' });
  const markup = render([first, second], [], true);
  assert.equal((markup.match(/>Pause</g) ?? []).length, 2);
  assert.equal((markup.match(/>Up next</g) ?? []).length, 1);
  assert.equal((markup.match(/>Queued</g) ?? []).length, 1);
  assert.match(markup, /aria-haspopup="menu"/);
  assert.equal(first.automatic, true); assert.equal(second.automatic, true);
});

test('admitted queued messages leave the waiting strip while retained history remains explicitly available', () => {
  for (const state of ['accepted', 'running', 'completed', 'failed', 'cancelled'] as const) {
    const queued = item({ state: 'submitted', operationId: 'run' });
    const operation = { id: 'run', state } as AssistantOperation;
    const original = JSON.stringify({ queued, operation });
    assert.equal(render([queued], [operation]), '', state);
    const history = render([queued], [operation], false, 'ready', true);
    assert.match(history, /Original writing/);
    assert.doesNotMatch(history, />Run next<|Remove queued message/);
    assert.equal(JSON.stringify({ queued, operation }), original);
  }
  assert.equal(render([]), '');
});

test('unconfirmed admission stays visible without a new send action even when its operation is missing', () => {
  const queued = item({ state: 'submitted', operationId: 'run' });
  for (const operations of [[], [{ id: 'run', state: 'prepared' }], [{ id: 'run', state: 'dispatching' }]] as AssistantOperation[][]) {
    const markup = render([queued], operations, true);
    assert.match(markup, /Original writing/);
    assert.match(markup, />Check original run</);
    assert.doesNotMatch(markup, />Run next<|Remove queued message/);
  }
});

test('waiting rows remain directly readable with removal available and no disclosure hiding the queue', () => {
  const first = item({ automatic: true }), second = item({ id: 'second', input: 'Second retained message' });
  const markup = render([first, second], [], true);
  assert.match(markup, /Original writing/);
  assert.match(markup, /Second retained message/);
  assert.equal((markup.match(/aria-label="Remove queued message"/g) ?? []).length, 2);
  assert.doesNotMatch(markup, /<details|No messages waiting|Queued messages run in order/);
  assert.ok(markup.indexOf('Original writing') < markup.indexOf('Second retained message'));
});
