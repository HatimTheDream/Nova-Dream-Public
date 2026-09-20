import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeHistoryPage } from '../apps/client/src/assistant-history.js';
import type { ConversationHistory } from '../packages/domain/assistant.js';
const page = (first: number, last: number, more = false): ConversationHistory => ({ conversationId: 'chat', nativeId: 'session', hasMore: more, nextOffset: more ? 200 : undefined, activeRunIds: [], messages: Array.from({ length: last - first + 1 }, (_, i) => ({ id: String(first + i), role: 'assistant', sequence: first + i, text: `Message ${first + i}`, textHash: String(first + i), attachments: [] })) });
test('Nova windows keep both bindings without sorting colliding native sequence numbers', () => {
  const transcript = { revision: 1, savedMessages: 2, complete: true, conflicts: 0, unavailableAttachments: 0, bindings: [] };
  const prior = { ...page(1, 1), transcript, messages: [{ ...page(1, 1).messages[0], id: 'old', novaId: 'nova:one', sequence: 100 }] };
  const next = { ...page(1, 2), nativeId: 'other-session', transcript: { ...transcript, revision: 2 }, messages: [prior.messages[0], { ...page(2, 2).messages[0], id: 'new', novaId: 'nova:two', sequence: 1 }] };
  const merged = mergeHistoryPage(prior, next, false);
  assert.deepEqual(merged.messages.map(m => m.id), ['old', 'new']); assert.equal(merged.messages[0], prior.messages[0]);
});
test('older pages stay present through head refreshes without remounting unchanged messages', () => {
  const head = page(101, 200, true), older = page(1, 100), both = mergeHistoryPage(head, older, true);
  assert.equal(both.messages.length, 200); assert.equal(both.messages[100], head.messages[0]);
  const refreshed = mergeHistoryPage(both, page(102, 201, true), false);
  assert.equal(refreshed.messages.length, 201); assert.equal(refreshed.messages[0], older.messages[0]); assert.equal(refreshed.hasMore, false);
  assert.equal(mergeHistoryPage(refreshed, page(102, 201, true), false), refreshed);
  assert.equal(mergeHistoryPage(refreshed, { ...head, nativeId: 'replacement' }, false).messages.length, 100);
});

const windowPage = (first: number, last: number, total = 2000) => ({ ...page(first, last, first > 1), offset: total - last, totalMessages: total, nextOffset: first > 1 ? total - first + 1 : undefined, hasNewer: last < total });
test('head refresh never merges across an unloaded gap and rebases both cursors as history grows', () => {
  const reading = windowPage(1001, 1100), refresh = windowPage(1906, 2005, 2005);
  const kept = mergeHistoryPage(reading, refresh, false);
  assert.deepEqual(kept.messages, reading.messages); assert.equal(kept.hasNewer, true);
  assert.equal(kept.offset, 905); assert.equal(kept.nextOffset, 1005); assert.equal(kept.totalMessages, 2005);
  const next = mergeHistoryPage(kept, windowPage(1051, 1150, 2005), 'newer');
  assert.equal(next.messages.length, 150); assert.equal(next.messages[0].id, '1001'); assert.equal(next.messages.at(-1)?.id, '1150');
  assert.equal(next.offset, 855); assert.equal(next.nextOffset, 1005); assert.equal(next.hasNewer, true);
});
test('older and newer loads retain continuous windows and reach the actual latest message', () => {
  const reading = windowPage(1751, 1850), older = mergeHistoryPage(reading, windowPage(1651, 1750), true);
  assert.equal(older.offset, 150); assert.equal(older.nextOffset, 350); assert.equal(older.messages.length, 200);
  const newer = mergeHistoryPage(older, windowPage(1851, 1950), 'newer');
  assert.equal(newer.messages.length, 300); assert.equal(newer.hasNewer, true); assert.equal(newer.offset, 50);
  const latest = mergeHistoryPage(newer, windowPage(1901, 2000), 'newer');
  assert.equal(latest.messages.length, 350); assert.equal(latest.hasNewer, false); assert.equal(latest.offset, 0); assert.equal(latest.nextOffset, 350);
});
test('a stale older offset cannot silently join a gap after a large append', () => {
  const reading = windowPage(501, 600, 1000), unexpected = windowPage(1001, 1100, 2000);
  const kept = mergeHistoryPage(reading, unexpected, true);
  assert.deepEqual(kept.messages, reading.messages); assert.equal(kept.nextOffset, 1500); assert.equal(kept.offset, 1400);
});
test('an old reading window receives recovery and coverage metadata without jumping across a gap', () => {
  const transcript = { revision: 1, savedMessages: 2000, complete: false, conflicts: 0, unavailableAttachments: 0, bindings: [] };
  const reading = { ...windowPage(501, 600), transcript };
  const incoming = { ...windowPage(1901, 2000), nativeId: 'new-binding', transcript: { ...transcript, revision: 2, bindingUnavailable: true } };
  const merged = mergeHistoryPage(reading, incoming, false);
  assert.deepEqual(merged.messages, reading.messages); assert.equal(merged.transcript?.bindingUnavailable, true); assert.equal(merged.nativeId, 'new-binding');
});
