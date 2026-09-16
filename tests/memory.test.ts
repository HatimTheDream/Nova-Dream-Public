import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Conversation, ConversationHistory } from '../packages/domain/assistant.js';
import { Store } from '../apps/service/store.js';
import { AssistantMemory } from '../apps/service/memory.js';

test('source-linked memories retain edits across restart, isolate Project scope and never resurrect removed notes on receipt replay', () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-memory-')); let store = new Store(directory);
  const device = store.session().deviceId, conversation = { id: randomUUID(), nativeId: randomUUID(), title: 'Original source', deleted: false } as Conversation;
  const message = { id: 'exact-message', role: 'user', text: 'Native envelope', authoredText: 'I prefer brief answers.', textHash: 'a'.repeat(64), attachments: [] } as const;
  const history = { conversationId: conversation.id, nativeId: conversation.nativeId, messages: [message] } as unknown as ConversationHistory;
  let memory = new AssistantMemory(store, () => conversation, () => history);
  const source = { conversationId: conversation.id, nativeId: conversation.nativeId, messageId: message.id, messageHash: message.textHash, role: 'user' };
  const create = { requestId: randomUUID(), epoch: store.epoch, id: randomUUID(), expectedRevision: 0, action: 'save', text: 'Prefer brief answers.', projectId: null, source };
  try {
    assert.equal(memory.capture(null), undefined);
    const first = memory.change(device, create); assert.deepEqual(memory.change(device, create), first);
    assert.equal(memory.state().entries[0].source!.excerpt, message.authoredText);
    assert.throws(() => memory.change(device, { ...create, text: 'Changed intent' }), { code: 'request_reused' });
    const otherDevice = store.session().deviceId;
    assert.throws(() => memory.change(otherDevice, create), { code: 'request_reused' });
    const edit = { requestId: randomUUID(), epoch: store.epoch, id: create.id, expectedRevision: 1, action: 'save', text: 'Prefer concise answers with sources.', projectId: null };
    memory.change(otherDevice, edit);
    assert.throws(() => memory.change(device, { ...edit, requestId: randomUUID(), text: 'Stale change' }), { code: 'memory_changed' });
    const projectId = `project:${randomUUID()}`;
    store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, entityId: projectId, expectedRevision: 0, kind: 'project', payload: { name: 'Private scope', purpose: '' } });
    const projectNote = { ...edit, requestId: randomUUID(), id: randomUUID(), expectedRevision: 0, text: 'Project-only note.', projectId };
    memory.change(device, projectNote);
    assert.deepEqual(memory.capture(null)!.entries.map(e => e.id), [create.id]);
    assert.equal(memory.capture(projectId)!.entries.length, 2);
    const captured = memory.capture(projectId);
    store.close(); store = new Store(directory); memory = new AssistantMemory(store, () => conversation, () => history);
    assert.deepEqual(memory.capture(projectId), captured);
    const remove = { requestId: randomUUID(), epoch: store.epoch, id: create.id, expectedRevision: 2, action: 'remove' };
    memory.change(device, remove); assert.equal(memory.capture(null)!.entries.length, 0);
    assert.deepEqual(memory.change(device, create), first); assert.equal(memory.capture(null)!.entries.length, 0);
    assert.throws(() => memory.change(device, { ...edit, requestId: randomUUID(), expectedRevision: 3 }), { code: 'memory_changed' });
    assert.equal(store.internalRead('assistant:memory-removed:'+create.id) && JSON.stringify(store.internalRead('assistant:memory-removed:'+create.id)).includes('answers'), false);
    assert.equal(captured!.entries.length, 2, 'already captured input remains immutable');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('memory admission rejects changed native sources, invalid scope, stale workspace and excess capacity without partial writes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-memory-')); const store = new Store(directory), device = store.session().deviceId;
  const conversation = { id: randomUUID(), nativeId: randomUUID(), title: 'Source' } as Conversation;
  const memory = new AssistantMemory(store, () => conversation, () => undefined);
  const input = { requestId: randomUUID(), epoch: store.epoch, id: randomUUID(), expectedRevision: 0, action: 'save', text: 'A note.', projectId: null };
  try {
    assert.throws(() => memory.change(device, { ...input, source: { conversationId: conversation.id, nativeId: conversation.nativeId, messageId: 'missing', messageHash: 'b'.repeat(64), role: 'assistant' } }), { code: 'memory_source_changed' });
    assert.throws(() => memory.change(device, { ...input, projectId: 'missing-project' }), { code: 'memory_project_missing' });
    assert.throws(() => memory.change(device, { ...input, epoch: randomUUID() }), { code: 'epoch_changed' });
    assert.deepEqual(memory.state(), { revision: 0, entries: [] });
    for (let i = 0; i < 16; i++) memory.change(device, { ...input, requestId: randomUUID(), id: randomUUID(), text: 'x'.repeat(4000) });
    assert.throws(() => memory.change(device, input), { code: 'memory_capacity' });
    assert.equal(memory.state().revision, 16); assert.equal(memory.state().entries.length, 16);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
