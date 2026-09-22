import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyRepairAnchor, mergeHistoryPage } from '../apps/client/src/assistant-history.js';
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

test('metadata-only tool observations replace stale rows while unchanged observations keep their identity', () => {
  const prior = page(1, 1), original = prior.messages[0];
  original.toolInfo = { name: 'read', state: 'called', calls: ['read'] };
  const updated = { ...prior, messages: [{ ...original, runId: 'exact-run', toolInfo: { ...original.toolInfo, entries: [{ id: 'exact-call', name: 'read', input: 'notes.md' }] } }] };
  const merged = mergeHistoryPage(prior, updated, false);
  assert.equal(merged.messages[0].toolInfo?.entries?.[0].id, 'exact-call');
  assert.equal(merged.messages[0].runId, 'exact-run'); assert.notEqual(merged.messages[0], original);
  assert.equal(mergeHistoryPage(merged, updated, false), merged);
  const settled = { ...updated, messages: [{ ...updated.messages[0], toolInfo: { name: 'read', state: 'unknown' as const } }] };
  assert.equal(mergeHistoryPage(merged, settled, false).messages[0].toolInfo?.state, 'unknown');
});

test('an overlapping older page enriches retained tool receipts without changing their order or unrelated rows', () => {
  const current = windowPage(101, 200, 200), older = windowPage(1, 110, 200);
  const original = { ...current.messages[0], role: 'tool' as const, toolInfo: { name: 'exec', state: 'unknown' as const } };
  current.messages[0] = original;
  const receipt = { ...original, runId: 'confirmed-run', toolInfo: { id: 'confirmed-call', name: 'exec', state: 'blocked' as const } };
  older.messages[100] = receipt;
  const merged = mergeHistoryPage(current, older, true);
  assert.equal(merged.messages.length, 200);
  assert.deepEqual(merged.messages.map(message => message.id), Array.from({ length: 200 }, (_, index) => String(index + 1)));
  assert.equal(merged.messages[100], receipt);
  assert.equal(merged.messages[100].toolInfo?.state, 'blocked');
  assert.equal(merged.messages[100].runId, 'confirmed-run');
  assert.equal(merged.messages[199], current.messages[99]);
  assert.equal(original.toolInfo.state, 'unknown');
});

test('a refreshed archive retires only its explicitly reconciled provisional user from the current reading window', () => {
  const source = { bindingId: 'binding', nativeId: 'session', nativeKey: 'session-key', connectionGeneration: 'host', observedAt: '2026-09-22T00:00:00Z' };
  const provisional = { ...page(1, 1).messages[0], id: 'operation:retry:user', novaId: 'nova:pending', role: 'user' as const, text: 'Repeated prompt', operationId: 'retry', runId: 'run', source: { ...source, kind: 'operation' as const } };
  const native = { ...provisional, id: 'native-user', novaId: 'nova:native', source: { ...source, kind: 'native' as const } };
  const original = { ...native, id: 'earlier-user', novaId: 'nova:earlier', operationId: 'earlier-operation', runId: 'earlier-run' };
  const transcript = { revision: 1, savedMessages: 3, complete: true, conflicts: 0, unavailableAttachments: 0, bindings: [] };
  const current = { ...page(1, 1), messages: [original, provisional, native], totalMessages: 3, offset: 0, transcript };
  const confirmed = { ...native, aliases: [provisional.id, provisional.novaId] };
  const incoming = { ...current, totalMessages: 2, messages: [confirmed] };
  assert.equal(historyRepairAnchor(current, incoming), undefined, 'a fully identified in-window retirement can reconcile in place');
  assert.deepEqual(mergeHistoryPage(current, incoming, false).messages.map(message => message.id), [original.id, native.id]);
  const beforeAck = { ...current, messages: [original, { ...provisional, runId: undefined }] };
  assert.deepEqual(mergeHistoryPage(beforeAck, incoming, false).messages.map(message => message.id), [original.id, native.id], 'an early reading window need not have received the run acknowledgement itself');
  for (const changed of [{ aliases: [] }, { operationId: 'other-operation' }, { runId: 'other-run' }, { source: { ...native.source, bindingId: 'other-binding' } }]) {
    assert(mergeHistoryPage(current, { ...incoming, messages: [{ ...confirmed, ...changed }] }, false).messages.some(message => message.id === provisional.id));
  }
  const pendingOnly = { ...current, messages: [provisional], totalMessages: undefined, nextOffset: 1 };
  assert.deepEqual(mergeHistoryPage(pendingOnly, { ...incoming, totalMessages: undefined }, false).messages.map(message => message.id), [native.id], 'the retained alias itself proves continuity before the native identity was displayed');
});

test('a repair outside an old reading window requires its exact anchor before numeric pagination can continue', () => {
  const transcript = { revision: 1, savedMessages: 1000, complete: true, conflicts: 0, unavailableAttachments: 0, bindings: [] };
  const current = { ...windowPage(501, 600, 1000), transcript };
  const repaired = { ...windowPage(901, 999, 999), transcript: { ...transcript, revision: 2, savedMessages: 999 } };
  assert.equal(historyRepairAnchor(current, repaired, '550')?.id, '550');
  assert.equal(historyRepairAnchor(current, repaired)?.id, '501');
  assert.equal(historyRepairAnchor({ ...current, offset: 0, hasNewer: false }, repaired)?.id, '600', 'a following window retains its latest anchor');
  assert.equal(mergeHistoryPage(current, repaired, false), current, 'a disjoint head cannot silently rebase an unknown contraction');
  const staleOlder = { ...windowPage(400, 499, 999), transcript: repaired.transcript };
  assert.equal(mergeHistoryPage(current, staleOlder, true), current, 'the stale cursor must not merge past missing message 500');
  const anchored = { ...windowPage(450, 549, 999), transcript: repaired.transcript };
  const following = { ...windowPage(500, 599, 999), transcript: repaired.transcript };
  const resumed = mergeHistoryPage(anchored, following, 'newer');
  assert(resumed.messages.some(message => message.id === '500')); assert.equal(resumed.messages.length, 150);
});
