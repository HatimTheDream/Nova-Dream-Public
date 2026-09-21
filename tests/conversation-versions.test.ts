import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Conversation } from '../packages/domain/assistant.js';
import { relatedConversations } from '../apps/client/src/conversation-versions.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VersionList } from '../apps/client/src/ConversationVersions';

test('conversation versions preserve stable ancestry and exclude replaced native history or another host', () => {
 const root = { id: 'root', nativeId: 'native-root', connectionGeneration: 'host', createdAt: '2026-09-09T00:00:00Z' } as Conversation;
 const child = { ...root, id: 'child', nativeId: 'native-child', createdAt: '2026-09-09T01:00:00Z', forkSource: { conversationId: root.id, nativeId: root.nativeId!, purpose: 'retry' } } as Conversation;
 const sibling = { ...child, id: 'sibling', nativeId: 'native-sibling', createdAt: '2026-09-09T02:00:00Z', archived: true };
 const unrelated = { ...sibling, id: 'wrong-source', forkSource: { ...sibling.forkSource!, nativeId: 'replaced-source' } };
 const otherHost = { ...sibling, id: 'wrong-host', connectionGeneration: 'another-host' };
 assert.deepEqual(relatedConversations(child, [sibling, otherHost, child, unrelated, root]).map(c => c.id), ['root', 'child', 'sibling']);
 assert.deepEqual(relatedConversations(root, [sibling, child, root]).map(c => c.id), ['root', 'child', 'sibling']);
 assert.deepEqual(relatedConversations(child, [child, { ...root, nativeId: 'replaced' }]).map(c => c.id), ['child']);
});

function conversation(id: string, hour: number, parent?: Conversation): Conversation {
 return { id, title: id, nativeId: `native-${id}`, connectionGeneration: 'host', createdAt: `2026-09-09T${String(hour).padStart(2, '0')}:00:00Z`, state: 'ready', ...(parent ? { forkSource: { conversationId: parent.id, nativeId: parent.nativeId!, purpose: 'edit' } } : {}) } as Conversation;
}
const ids = (current: Conversation, all: Conversation[]) => relatedConversations(current, all).map(item => item.id);

test('every nested revision finds the true root, siblings and descendants in stable order', () => {
 const root = conversation('root', 0), edited = conversation('edited', 1, root), sibling = conversation('sibling', 2, root), retry = conversation('retry', 3, edited), cousin = conversation('cousin', 4, sibling), nested = conversation('nested', 5, retry);
 const all = [nested, cousin, retry, sibling, edited, root];
 for (const current of all) {
  assert.deepEqual(ids(current, all), ['root', 'edited', 'sibling', 'retry', 'cousin', 'nested']);
  assert.deepEqual(ids(current, [...all].reverse()), ['root', 'edited', 'sibling', 'retry', 'cousin', 'nested']);
 }
 assert.equal(relatedConversations(nested, all)[0], root, 'the original is its actual preserved conversation record');
});

test('every ancestry edge checks native identity and generation before connecting families', () => {
 const root = conversation('root', 0), edited = conversation('edited', 1, root), retry = conversation('retry', 2, edited), nested = conversation('nested', 3, retry);
 const replaced = { ...edited, nativeId: 'replacement-native' };
 assert.deepEqual(ids(retry, [root, replaced, retry, nested]), ['retry', 'nested']);
 assert.deepEqual(ids(root, [root, replaced, retry, nested]), ['root', 'edited']);
 const otherHost = { ...edited, connectionGeneration: 'replacement-host' };
 assert.deepEqual(ids(nested, [root, otherHost, retry, nested]), ['retry', 'nested']);
 assert.deepEqual(ids(root, [root, otherHost, retry, nested]), ['root']);
 assert.deepEqual(ids(edited, [root, replaced, retry, nested]), ['edited'], 'a stale current record cannot reconnect a replaced identity');
});

test('orphaned branches retain their verified descendants without guessing a missing common parent', () => {
 const missing = conversation('missing', 0), orphan = conversation('orphan', 1, missing), sibling = conversation('sibling', 2, missing), nested = conversation('nested', 3, orphan), later = conversation('later', 4, nested);
 assert.deepEqual(ids(nested, [later, sibling, nested, orphan]), ['orphan', 'nested', 'later']);
 assert.deepEqual(ids(orphan, [later, sibling, nested]), ['orphan', 'nested', 'later'], 'the current record remains usable when omitted from the list');
 const markup = renderToStaticMarkup(createElement(VersionList, { conversation: nested, conversations: [later, nested, orphan], open() {} }));
 assert.doesNotMatch(markup, />Original</);
 assert.match(markup, /earlier history for this branch is unavailable/);
 assert.match(markup, /aria-current="true"/);
});

test('self and multi-node cycles have no asserted original and do not hang or duplicate results', () => {
 const first = conversation('first', 0), second = conversation('second', 1, first);
 const cyclic = { ...first, forkSource: { ...second.forkSource!, conversationId: second.id, nativeId: second.nativeId! } };
 const descendant = conversation('descendant', 2, second);
 for (const current of [cyclic, second, descendant]) assert.deepEqual(ids(current, [second, descendant, cyclic]), [current.id]);
 const self = { ...first, forkSource: { ...second.forkSource!, conversationId: first.id, nativeId: first.nativeId! } };
 assert.deepEqual(ids(self, [self]), ['first']);
});
