import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesBrowseSource, retainedBrowseHistory } from '../apps/client/src/conversation-reader-state';
import type { BrowseTarget } from '../packages/domain/search';
import type { ConversationHistory } from '../packages/domain/assistant';

const target: BrowseTarget = { epoch: 'workspace', conversationId: 'chat', nativeId: 'native', messageId: 'message', messageHash: 'original-hash', role: 'assistant' };
const history: ConversationHistory = { conversationId: target.conversationId, nativeId: target.nativeId, activeRunIds: [], hasMore: false, messages: [{ id: 'message', role: 'assistant', text: 'Saved source', textHash: 'original-hash', attachments: [] }] };

test('a saved archive page remains available for the same source before a replacement is received', () => {
  const saved = { target, history };
  assert.equal(retainedBrowseHistory(saved, { ...target }, 'workspace'), history);
});

test('source navigation never reuses a prior conversation, message version, role or reading offset', () => {
  const saved = { target, history };
  for (const changed of [
    { ...target, epoch: 'restored' }, { ...target, conversationId: 'another' },
    { ...target, nativeId: 'replacement' }, { ...target, messageId: 'other-message' },
    { ...target, messageHash: 'new-version' }, { ...target, role: 'user' as const },
    { epoch: target.epoch, conversationId: target.conversationId, nativeId: target.nativeId },
  ]) assert.equal(retainedBrowseHistory(saved, changed, changed.epoch), undefined);
  assert.equal(retainedBrowseHistory(saved, target, 'restored'), undefined);
  const page = { epoch: target.epoch, conversationId: target.conversationId, nativeId: target.nativeId, offset: 100 };
  assert.equal(retainedBrowseHistory({ target: page, history }, { ...page }, 'workspace'), history);
  assert.equal(retainedBrowseHistory({ target: page, history }, { ...page, offset: 200 }, 'workspace'), undefined);
  assert.equal(retainedBrowseHistory({ target: { ...page, offset: 0 }, history }, { epoch: page.epoch, conversationId: page.conversationId, nativeId: page.nativeId }, 'workspace'), undefined);
});

test('an invalid response identity is never displayed under a matching requested source', () => {
  assert.equal(retainedBrowseHistory({ target, history: { ...history, nativeId: 'wrong' } }, target, 'workspace'), undefined);
  assert.equal(retainedBrowseHistory({ target, history: { ...history, conversationId: 'wrong' } }, target, 'workspace'), undefined);
});

test('an exact historical source remains readable in a Nova transcript with a newer current binding', () => {
  const source = { bindingId: 'old-binding', nativeId: target.nativeId, nativeKey: 'old-key', connectionGeneration: 'old-generation', nativeMessageId: 'message', kind: 'native' as const, observedAt: '2026-09-20T00:00:00Z' };
  const combined: ConversationHistory = { ...history, nativeId: 'new-native', messages: [{ ...history.messages[0], id: 'new-alias', novaId: 'nova-message', aliases: ['message'], source }], transcript: { revision: 1, savedMessages: 1, complete: true, conflicts: 0, unavailableAttachments: 0, bindings: [{ id: 'old-binding', nativeId: 'native', complete: true, status: 'complete', observedAt: source.observedAt }] } };
  assert.equal(matchesBrowseSource(combined, target), true);
  assert.equal(retainedBrowseHistory({ target, history: combined }, target, 'workspace'), combined);
  assert.equal(matchesBrowseSource(combined, { ...target, messageHash: 'different-version' }), false);
  assert.equal(matchesBrowseSource(combined, { ...target, role: 'user' }), false);
  assert.equal(matchesBrowseSource({ ...combined, messages: [{ ...combined.messages[0], source: { ...source, nativeId: 'unrelated-native' } }] }, target), false);
  assert.equal(matchesBrowseSource({ ...combined, transcript: undefined }, target), false);
});
