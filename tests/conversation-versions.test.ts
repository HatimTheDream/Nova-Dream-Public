import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Conversation } from '../packages/domain/assistant.js';
import { relatedConversations } from '../apps/client/src/conversation-versions.js';

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
