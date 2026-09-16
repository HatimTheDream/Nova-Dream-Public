import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Conversation, ConversationHistory } from '../packages/domain/assistant.js';
import { Store } from '../apps/service/store.js';
import { MessagePins } from '../apps/service/message-pins.js';

test('shared message bookmarks bind native identity and exact source, survive restart, and guard conflicting revisions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-pins-')); let store = new Store(directory);
  const device = store.session().deviceId, conversation = { id: randomUUID(), nativeId: randomUUID(), deleted: false } as Conversation;
  const message = { id: 'retained-message', role: 'assistant', text: 'Exact reply '.repeat(100), textHash: 'a'.repeat(64), attachments: [] } as const;
  let history = { conversationId: conversation.id, nativeId: conversation.nativeId, messages: [message] } as unknown as ConversationHistory;
  let pins = new MessagePins(store, () => conversation, () => history);
  const input = { requestId: randomUUID(), epoch: store.epoch, conversationId: conversation.id, nativeId: conversation.nativeId, messageId: message.id, messageHash: message.textHash, role: 'assistant', pinned: true, expectedRevision: 0 };
  try {
    const first = pins.change(device, input); assert.equal(first.revision, 1); assert.equal(first.excerpt.length, 240); assert.deepEqual(pins.change(device, input), first);
    assert.throws(() => pins.change(device, { ...input, pinned: false }), { code: 'request_reused' });
    assert.throws(() => pins.change(device, { ...input, requestId: randomUUID(), pinned: false }), { code: 'pin_changed' });
    assert.throws(() => pins.change(device, { ...input, requestId: randomUUID(), role: 'user' }), { code: 'pin_source_changed' });
    assert.throws(() => pins.change(device, { ...input, requestId: randomUUID(), expectedRevision: 1, messageHash: 'b'.repeat(64) }), { code: 'pin_source_changed' });
    store.close(); store = new Store(directory); pins = new MessagePins(store, () => conversation, () => history); assert.deepEqual(pins.list(), [first]);
    // Removing a bookmark is local even if its old message is no longer in cache.
    history = { ...history, messages: [] }; const removed = pins.change(device, { ...input, requestId: randomUUID(), expectedRevision: 1, pinned: false }); assert.equal(removed.revision, 2); assert.equal(removed.pinned, false);
    assert.deepEqual(pins.change(device, input), first); assert.equal(pins.list()[0].pinned, false, 'replaying an old receipt cannot restore a removed bookmark');
    conversation.nativeId = randomUUID(); assert.throws(() => pins.change(device, { ...input, requestId: randomUUID(), expectedRevision: 2 }), { code: 'pin_source_changed' });
    assert.throws(() => pins.change(device, { ...input, requestId: randomUUID(), epoch: randomUUID(), expectedRevision: 2 }), { code: 'epoch_changed' });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
