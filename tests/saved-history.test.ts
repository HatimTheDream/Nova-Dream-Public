import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store.js';
import { SavedHistory } from '../apps/service/saved-history.js';
import { AssistantService } from '../apps/service/assistant.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import type { Conversation, ConversationHistory, ConversationMessage } from '../packages/domain/assistant.js';
import { phoneRouteAllowed } from '../apps/service/phone-policy.js';

function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'e3-saved-history-')), store = new Store(root);
  const conversation: Conversation = { id: randomUUID(), revision: 1, title: 'Saved conversation', projectId: null, archived: false, model: null, thinking: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), connectionGeneration: randomUUID(), nativeKey: 'agent:main:e3:fixture', nativeId: randomUUID(), state: 'ready' };
  store.internalWrite('assistant:conversation:' + conversation.id, conversation);
  const messages: ConversationMessage[] = Array.from({ length: 250 }, (_, index) => ({ id: 'message-' + index, role: index % 2 ? 'assistant' : 'user', text: 'Exact text ' + index, textHash: createHash('sha256').update('Exact text ' + index).digest('hex'), attachments: [] }));
  const page = (offset: number): ConversationHistory => { const end = messages.length - offset, start = Math.max(0, end - 100); return { conversationId: conversation.id, nativeId: conversation.nativeId!, messages: messages.slice(start, end), offset, hasMore: start > 0, nextOffset: start > 0 ? offset + end - start : undefined, activeRunIds: [] }; };
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, conversation, messages, page, saved: new SavedHistory(store) };
}
test('a verified reading copy preserves exact paginated messages after backup and independent restore', async t => {
  const f = fixture(t), offsets: number[] = [];
  await f.saved.capture([f.conversation], async (_, offset) => { offsets.push(offset); return f.page(offset); });
  assert.deepEqual(offsets, [0, 100, 200, 0]);
  const snapshot = f.store.captureBackup('0.73.0', { status: 'not-configured', notes: [] });
  const restored = Store.restoreBackup(join(f.root, 'restored'), snapshot);
  try {
    const saved = new SavedHistory(restored);
    const head = saved.read(f.conversation)!; assert(head.retained?.complete); assert.equal(head.totalMessages, 250); assert.equal(head.activeRunIds, null);
    const middle = saved.read(f.conversation, { offset: head.nextOffset })!, tail = saved.read(f.conversation, { offset: middle.nextOffset })!;
    assert.deepEqual([...tail.messages, ...middle.messages, ...head.messages], f.messages); assert.equal(tail.hasMore, false);
    assert(saved.read(f.conversation, { messageId: 'message-17' })!.messages.some(m => m.id === 'message-17'));
    assert.throws(() => saved.read(f.conversation, { messageId: 'missing' }), /not in the saved/);
    assert.equal(saved.read({ ...f.conversation, nativeId: randomUUID() }), undefined);
    assert.equal(saved.read({ ...f.conversation, deleted: true }), undefined);
  } finally { restored.close(); }
});
test('failed or changing native pages keep the previous complete reading copy', async t => {
  const f = fixture(t); await f.saved.capture([f.conversation], async (_, offset) => f.page(offset));
  const original = f.store.internalRead('assistant:retained-history:' + f.conversation.id);
  await f.saved.capture([f.conversation], async (_, offset) => { if (offset) throw new Error('Disconnected'); return f.page(offset); });
  assert.deepEqual(f.store.internalRead('assistant:retained-history:' + f.conversation.id), original);
  let reads = 0;
  await f.saved.capture([f.conversation], async (_, offset) => { const page = f.page(offset); if (++reads === 4) return { ...page, messages: page.messages.slice(1) }; return page; });
  assert.deepEqual(f.store.internalRead('assistant:retained-history:' + f.conversation.id), original);
});
test('a saved reading copy is never accepted by live history, branch or execution checks', async t => {
  const f = fixture(t); await f.saved.capture([f.conversation], async (_, offset) => f.page(offset));
  let calls = 0;
  const gateway: AssistantTransport = { status: () => ({ state: 'unconfigured', message: 'Disconnected', methods: [], grantedScopes: [], modelAuthReady: false }), request: async () => { calls++; throw new Error('No connection'); }, subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}) };
  const service = new AssistantService(f.store, gateway); t.after(() => service.close());
  const reading = await service.historyForReading(f.conversation.id); assert(reading.retained?.complete);
  const target = { epoch: f.store.epoch, conversationId: f.conversation.id, nativeId: f.conversation.nativeId, messageId: f.messages[17].id, messageHash: f.messages[17].textHash, role: f.messages[17].role };
  assert((await service.browse(target)).messages.some(m => m.id === f.messages[17].id));
  await assert.rejects(service.browse({ ...target, nativeId: randomUUID() }), /Connect OpenClaw/);
  await assert.rejects(service.browse({ ...target, messageHash: 'a'.repeat(64) }), /changed/);
  await assert.rejects(service.history(f.conversation.id), /Connect OpenClaw/);
  await assert.rejects(service.fork('owner', { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: 1, nativeId: f.conversation.nativeId, messageId: f.messages[249].id, messageHash: f.messages[249].textHash, purpose: 'branch' }), /Connect OpenClaw/);
  assert.equal(calls, 0);
});
test('older backup pages remain readable but do not invent missing history or a live run', t => {
  const f = fixture(t);
  f.store.internalWrite('assistant:history:' + f.conversation.id, { ...f.page(0), inFlightRun: { runId: 'past-run', text: 'partial reply' } });
  const reading = f.saved.read(f.conversation)!;
  assert.equal(reading.retained?.complete, false); assert.equal(reading.hasMore, false); assert.equal(reading.inFlightRun, undefined);
  assert.deepEqual(reading.messages, f.messages.slice(150));
  assert.throws(() => f.saved.read(f.conversation, { offset: 100 }), /only the saved part/);
});

test('a complete transcript export preserves authored dialogue across pages without replaying tool instructions', async t => {
  const f = fixture(t), device = f.store.session().deviceId;
  f.messages[0].authoredText = 'Original writing — keep every line.\n第二行';
  f.messages[0].attachments = [{ name: 'Required reference.pdf', size: 120 }];
  f.messages[1] = { ...f.messages[1], role: 'tool', text: 'private tool output sentinel' };
  await f.saved.capture([f.conversation], async (_, offset) => f.page(offset));
  const review = f.saved.review(f.conversation), source = f.store.internalRead('assistant:retained-history:' + f.conversation.id);
  assert.equal(review.messageCount, 249); assert.equal(review.attachmentCount, 1); assert(review.complete);
  const input = { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, digest: review.digest };
  const exported = f.saved.export(device, input, () => f.conversation), download = f.store.download(exported.file.id);
  assert.equal(download.bytes.length, review.bytes);
  const text = download.bytes.toString(), dialogue = JSON.parse(text.split('Saved dialogue (JSON; text values preserve the captured wording):\n')[1]);
  assert.equal(dialogue[0].text, f.messages[0].authoredText); assert.equal(dialogue.at(-1).text, 'Exact text 249');
  assert(!text.includes('private tool output sentinel')); assert(text.includes('their file contents and runtime/tool records are not included'));
  assert.deepEqual(f.store.internalRead('assistant:retained-history:' + f.conversation.id), source);
  assert.deepEqual(f.store.internalRead('assistant:conversation:' + f.conversation.id), f.conversation);
  assert.equal(f.store.internalList('assistant:operation:').length, 0);
  assert.deepEqual(f.saved.export(device, input, () => { throw new Error('A retry uses its captured version'); }), exported);
});

test('transcript preparation reconciles a failed upload against the captured version and rejects stale or reused requests', async t => {
  const f = fixture(t), device = f.store.session().deviceId;
  await f.saved.capture([f.conversation], async (_, offset) => f.page(offset));
  const review = f.saved.review(f.conversation);
  const input = { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, digest: review.digest };
  assert.throws(() => f.saved.export(device, { ...input, digest: 'a'.repeat(64) }, () => f.conversation), /changed/);
  const upload = f.store.upload.bind(f.store); f.store.upload = () => { throw new Error('Controlled upload interruption'); };
  assert.throws(() => f.saved.export(device, input, () => f.conversation), /Controlled upload/);
  f.messages[0] = { ...f.messages[0], text: 'Newer saved version', textHash: 'b'.repeat(64) };
  await f.saved.capture([f.conversation], async (_, offset) => f.page(offset));
  f.store.upload = upload;
  const result = f.saved.export(device, input, () => f.conversation);
  assert(f.store.download(result.file.id).bytes.toString().includes('Exact text 0'));
  assert(!f.store.download(result.file.id).bytes.toString().includes('Newer saved version'));
  assert.throws(() => f.saved.export(device, { ...input, digest: f.saved.review(f.conversation).digest }, () => f.conversation), /different|reused/i);
  assert.throws(() => f.saved.export(device, { ...input, requestId: randomUUID() }, () => f.conversation), /changed/);
  assert.throws(() => f.saved.export(device, { ...input, epoch: randomUUID() }, () => f.conversation), /workspace changed/);
  assert.throws(() => f.saved.export('another-device', input, () => f.conversation), /request|device/i);
});

test('partial transcript exports state missing coverage and remain ordinary verified files in a recovered workspace', t => {
  const f = fixture(t), device = f.store.session().deviceId;
  f.store.internalWrite('assistant:history:' + f.conversation.id, f.page(0));
  const review = f.saved.review(f.conversation); assert(!review.complete); assert.equal(review.messageCount, 100);
  const exported = f.saved.export(device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, digest: review.digest }, () => f.conversation);
  assert(f.store.download(exported.file.id).bytes.toString().includes('Coverage: PARTIAL'));
  const restored = Store.restoreBackup(join(f.root, 'export-restored'), f.store.captureBackup('0.74.0', { status: 'not-configured', notes: [] }));
  try { assert.deepEqual(restored.download(exported.file.id), f.store.download(exported.file.id)); } finally { restored.close(); }
  assert(phoneRouteAllowed('/api/assistant/retained/' + f.conversation.id, 'GET'));
  assert(phoneRouteAllowed('/api/assistant/retained/export', 'POST'));
  assert(!phoneRouteAllowed('/api/assistant/retained/' + f.conversation.id, 'POST'));
});
