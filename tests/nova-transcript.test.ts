import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AssistantOperation, Conversation, ConversationHistory, ConversationMessage } from '../packages/domain/assistant.js';
import { Store } from '../apps/service/store.js';
import { NovaTranscript } from '../apps/service/nova-transcript.js';
import type { VoiceAttempt } from '../packages/domain/voice.js';
import { canonical } from '../packages/domain/contracts.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'nova-transcript-')), store = new Store(root);
  const conversation: Conversation = { id: randomUUID(), revision: 1, title: 'Kept in Nova', projectId: null, archived: false, model: null, thinking: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), connectionGeneration: randomUUID(), nativeKey: 'agent:main:e3:' + randomUUID(), nativeId: randomUUID(), state: 'ready' };
  store.internalWrite('assistant:conversation:' + conversation.id, conversation);
  const messages: ConversationMessage[] = Array.from({ length: 250 }, (_, index) => ({ id: 'entry-' + index, sequence: index, role: index % 2 ? 'assistant' : 'user', text: 'Kept message ' + index, textHash: digest('Kept message ' + index), attachments: [] }));
  const page = (offset = 0): ConversationHistory => { const end = messages.length - offset, start = Math.max(0, end - 100); return { conversationId: conversation.id, nativeId: conversation.nativeId!, messages: messages.slice(start, end), offset, hasMore: start > 0, nextOffset: start > 0 ? offset + end - start : undefined, activeRunIds: [] }; };
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, conversation, messages, page, archive: new NovaTranscript(store) };
}
test('overlapping saved pages accumulate through backup/restore instead of replacing earlier reading', t => {
  const f = fixture(t);
  assert(f.archive.observe(f.conversation, f.page()));
  const revision = f.archive.read(f.conversation)!.transcript!.revision;
  assert.equal(f.archive.observe(f.conversation, f.page()), false);
  assert.equal(f.archive.read(f.conversation)!.transcript!.revision, revision);
  f.archive.observe(f.conversation, f.page(50)); f.archive.observe(f.conversation, f.page(150));
  assert.deepEqual(f.archive.all(f.conversation)!.messages.map(m => m.text), f.messages.map(m => m.text));
  assert.equal(f.archive.read(f.conversation)!.retained!.complete, false);
  const restored = Store.restoreBackup(join(f.root, 'restore'), f.store.captureBackup('1.9.0', { status: 'not-configured', notes: [] }));
  try {
    const archive = new NovaTranscript(restored), first = archive.read(f.conversation)!, older = archive.read(f.conversation, { offset: first.nextOffset })!;
    assert.equal(first.messages.length, 100); assert.equal(older.messages.length, 100);
    assert.equal(archive.all(f.conversation)!.messages.length, 250);
    assert.equal(archive.read(f.conversation, { messageId: 'entry-17' })!.messages.find(m => m.id === 'entry-17')!.text, 'Kept message 17');
  } finally { restored.close(); }
});
test('bounded migration persists its cursor, resumes after interruption, and verifies a stable terminal head', async t => {
  const f = fixture(t), calls: number[] = [];
  let fail = true;
  const reader = async (_: string, offset: number) => { calls.push(offset); if (offset === 100 && fail) { fail = false; throw Error('Lost host'); } return f.page(offset); };
  await f.archive.captureNext([f.conversation], reader, 2);
  assert.deepEqual(calls, [0, 100]); assert.equal(f.archive.read(f.conversation)!.transcript!.bindings[0].nextOffset, 100);
  const restarted = new NovaTranscript(f.store);
  await restarted.captureNext([f.conversation], reader, 2);
  assert.deepEqual(calls, [0, 100, 100, 200]); assert.equal(restarted.read(f.conversation)!.retained!.complete, false);
  await restarted.captureNext([f.conversation], reader, 2);
  assert.deepEqual(calls, [0, 100, 100, 200, 0]); assert(restarted.read(f.conversation)!.retained!.complete);
  await restarted.captureNext([f.conversation], reader, 2); assert.equal(calls.length, 5);
});
test('a changing head cannot certify a migration and its earlier messages remain saved', async t => {
  const f = fixture(t); await f.archive.captureNext([f.conversation], async (_, offset) => f.page(offset), 3);
  f.messages.push({ id: 'newer', text: 'A later message', textHash: digest('A later message'), role: 'user', attachments: [] });
  await f.archive.captureNext([f.conversation], async (_, offset) => f.page(offset), 1);
  assert.equal(f.archive.read(f.conversation)!.retained!.complete, false); assert.equal(f.archive.all(f.conversation)!.messages.length, 251);
  await f.archive.captureNext([f.conversation], async (_, offset) => f.page(offset), 4);
  assert(f.archive.read(f.conversation)!.retained!.complete); assert.equal(f.archive.all(f.conversation)!.messages.length, 251);
});
test('operation admission and transcript writes share one transaction; native receipts reconcile without losing files or Nova identity', t => {
  const f = fixture(t), device = f.store.session().deviceId;
  const file = f.store.upload(device, randomUUID(), f.store.epoch, 'Original.txt', Buffer.from('Required bytes').toString('base64'));
  const operation: AssistantOperation = { id: randomUUID(), requestId: randomUUID(), deviceId: device, epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: 1, connectionGeneration: f.conversation.connectionGeneration, nativeKey: f.conversation.nativeKey, nativeId: f.conversation.nativeId!, nativeRunId: null, state: 'prepared', input: 'The same sentence', text: '', context: { project: null, attachments: [file], draftId: 'draft', draftRevision: 1, digest: digest('context') }, model: null, thinking: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastSequence: 0 };
  const admit = () => f.store.admit(device, { requestId: operation.requestId, epoch: f.store.epoch }, { kind: 'fixture' }, () => { f.store.internalWrite('assistant:operation:' + operation.id, operation); f.archive.observeOperation(f.conversation, operation); return operation; });
  admit(); const saved = f.archive.all(f.conversation)!.messages[0]; assert.equal(saved.delivery, 'prepared');
  assert.equal(saved.attachments[0].availability, 'local');
  operation.nativeRunId = randomUUID(); operation.state = 'accepted'; f.archive.observeOperation(f.conversation, operation);
  const native: ConversationMessage = { id: 'native-owner', operationId: operation.id, role: 'user', text: 'Native context envelope', authoredText: operation.input, textHash: digest('Native context envelope'), runId: operation.nativeRunId, attachments: [] };
  f.archive.observe(f.conversation, { ...f.page(), messages: [native], hasMore: false });
  const reconciled = f.archive.all(f.conversation)!.messages; assert.equal(reconciled.length, 1); assert.equal(reconciled[0].novaId, saved.novaId); assert.equal(reconciled[0].id, native.id);
  assert.equal(reconciled[0].attachments[0].localFile!.id, file.id); assert.equal(f.store.download(file.id).bytes.toString(), 'Required bytes');
  assert.equal(f.archive.read(f.conversation, { messageId: saved.id })!.messages[0].id, native.id);
  f.archive.observeOperation(f.conversation, { ...operation, state: 'completed' }); assert.equal(f.archive.all(f.conversation)!.messages.length, 1);
  f.archive.observe(f.conversation, { ...f.page(), messages: [{ ...native, id: 'another-native-owner', operationId: undefined, runId: undefined }], hasMore: false });
  assert.equal(f.archive.all(f.conversation)!.messages.length, 2, 'identical authored wording is not identity');
  assert.throws(() => f.store.admit(device, { requestId: randomUUID(), epoch: f.store.epoch }, {}, () => { f.archive.observeOperation(f.conversation, { ...operation, id: 'rollback-op' }); throw Error('rollback'); }), /rollback/);
  assert.equal(f.archive.all(f.conversation)!.messages.length, 2);
});
test('conflicting final observations preserve the original and retain the conflicting version for review', t => {
  const f = fixture(t), original = { ...f.page(), messages: f.messages.slice(0, 2), hasMore: false };
  f.archive.observe(f.conversation, original, { complete: true });
  const conflict = { ...original, messages: [{ ...original.messages[1], text: 'Different final', textHash: digest('Different final') }] };
  assert(f.archive.observe(f.conversation, conflict)); assert.equal(f.archive.observe(f.conversation, conflict), false);
  const reading = f.archive.all(f.conversation)!;
  assert.equal(reading.messages[1].text, original.messages[1].text); assert.equal(reading.transcript.conflicts, 1); assert.equal(reading.transcript.complete, false);
  assert.equal(f.store.internalList<{ text: string }>('assistant:transcript:' + f.conversation.id + ':conflict:')[0].text, 'Different final');
});
test('a new runtime binding preserves all previous messages and exact original source routes', t => {
  const f = fixture(t); f.archive.observe(f.conversation, { ...f.page(), messages: f.messages.slice(0, 2) }, { complete: true });
  const next = { ...f.conversation, connectionGeneration: randomUUID(), nativeKey: 'agent:main:e3:next', nativeId: randomUUID() };
  f.archive.observe(next, { ...f.page(), nativeId: next.nativeId, messages: [{ ...f.messages[0], text: 'From another engine', textHash: digest('From another engine') }] });
  const all = f.archive.all(next)!; assert.equal(all.messages.length, 3); assert.equal(new Set(all.messages.map(m => m.novaId)).size, 3);
  assert.equal(f.archive.read(next, { nativeId: f.conversation.nativeId!, messageId: 'entry-0' })!.messages[0].text, 'Kept message 0');
  assert.deepEqual(f.archive.target(next, f.conversation.nativeId!), { nativeId: f.conversation.nativeId, nativeKey: f.conversation.nativeKey, connectionGeneration: f.conversation.connectionGeneration });
});
test('legacy pages stay untouched and missing attachments remain explicit after migration', t => {
  const f = fixture(t), legacy = { ...f.page(), messages: [{ ...f.messages[0], attachments: [{ name: 'Source.pdf', artifactId: 'old-remote-file' }] }] };
  f.store.internalWrite('assistant:history:' + f.conversation.id, legacy);
  const reading = f.archive.read(f.conversation)!;
  assert.equal(reading.retained!.complete, false); assert.equal(reading.transcript!.unavailableAttachments, 1); assert.equal(reading.messages[0].attachments[0].availability, 'native-reference');
  assert.deepEqual(f.store.internalRead('assistant:history:' + f.conversation.id), legacy);
});
test('late native pages cannot resurrect a removed conversation or resume its migration', async t => {
  const f = fixture(t);
  await f.archive.captureNext([f.conversation], async () => { f.store.internalWrite('assistant:removed:' + f.conversation.id, { id: f.conversation.id }); return f.page(); }, 2);
  assert.equal(f.archive.read(f.conversation), undefined); assert.equal(f.archive.observe(f.conversation, f.page()), false);
  assert.equal(f.store.internalList('assistant:transcript:' + f.conversation.id + ':message:').length, 0);
});
test('late voice captions retain causal order and native acknowledgement keeps the same message identity', t => {
  const f = fixture(t), stamp = Date.now(), attempt: VoiceAttempt = { id: randomUUID(), requestId: randomUUID(), epoch: f.store.epoch, deviceId: f.store.session().deviceId, createdAt: new Date(stamp).toISOString(), target: { conversation: { ...f.conversation, nativeId: f.conversation.nativeId! }, project: null }, state: 'active', message: 'Fixture', context: '', contextDigest: digest(''), entries: [{ entryId: 'answer', ordinal: 1, role: 'assistant', text: 'I can hear you', timestamp: stamp + 1000, saved: false }], consults: [] };
  assert(f.archive.observeVoice(f.conversation, attempt)); const answer = f.archive.all(f.conversation)!.messages[0];
  attempt.entries.push({ entryId: 'question', ordinal: 0, role: 'user', text: 'Can you hear me?', timestamp: stamp, saved: false });
  f.archive.observeVoice(f.conversation, attempt);
  assert.deepEqual(f.archive.all(f.conversation)!.messages.map(message => message.role), ['user', 'assistant']);
  const native = { ...answer, novaId: undefined, source: undefined, aliases: undefined, delivery: undefined, textHash: digest(canonical(answer.text)) };
  f.archive.observe(f.conversation, { ...f.page(), messages: [native], hasMore: false });
  attempt.entries = attempt.entries.map(entry => ({ ...entry, saved: true })); f.archive.observeVoice(f.conversation, attempt);
  const messages = f.archive.all(f.conversation)!.messages;
  assert.equal(messages.length, 2); assert.equal(messages[1].novaId, answer.novaId); assert.equal(messages[1].source!.kind, 'native');
  assert.equal(f.archive.observeVoice(f.conversation, attempt), false);
});
test('retained artifact bytes stay attached across native refreshes and stale attachment targets cannot mutate the record', t => {
  const f = fixture(t), device = f.store.session().deviceId, message = { ...f.messages[1], attachments: [{ name: 'Report.txt', artifactId: 'report' }] }, history = { ...f.page(), messages: [message], hasMore: false };
  f.archive.observe(f.conversation, history);
  const file = f.store.upload(device, randomUUID(), f.store.epoch, 'Report.txt', Buffer.from('Actual report bytes').toString('base64'));
  const target = { nativeId: f.conversation.nativeId!, messageId: message.id, messageHash: message.textHash, artifactId: 'report' };
  assert.equal(f.archive.retainAttachment(f.conversation, { ...target, messageHash: 'b'.repeat(64) }, file), false);
  assert(f.archive.retainAttachment(f.conversation, target, file));
  f.archive.observe(f.conversation, history);
  const retained = f.archive.all(f.conversation)!; assert.equal(retained.messages[0].attachments.length, 1); assert.equal(retained.messages[0].attachments[0].localFile!.id, file.id); assert.equal(retained.transcript.unavailableAttachments, 0);
});
test('restored receipts recover admitted input and partial output locally without requiring the former workspace epoch', t => {
  const f = fixture(t), operation: AssistantOperation = { id: randomUUID(), requestId: randomUUID(), deviceId: 'prior-device', epoch: randomUUID(), conversationId: f.conversation.id, conversationRevision: 1, connectionGeneration: f.conversation.connectionGeneration, nativeKey: f.conversation.nativeKey, nativeId: f.conversation.nativeId!, nativeRunId: randomUUID(), state: 'unknown', input: 'Keep this unfinished work', text: 'Partial reply before disconnect', context: { project: null, attachments: [], draftId: 'prior-draft', draftRevision: 1, digest: digest('context') }, model: null, thinking: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastSequence: 3 };
  f.store.internalWrite('assistant:operation:' + operation.id, operation);
  assert.equal(f.archive.observeOperation(f.conversation, operation), false, 'live receipt ingestion remains epoch fenced');
  const saved = f.archive.all(f.conversation)!;
  assert.deepEqual(saved.messages.map(message => message.text), [operation.input, operation.text]);
  assert(saved.messages.every(message => message.delivery === 'unknown')); assert.equal(saved.transcript.complete, false);
  assert.deepEqual(f.store.internalRead('assistant:operation:' + operation.id), operation, 'reading never changes execution state');
});
test('provisional native output can finalize in place, while soft deletion rejects a late source snapshot', t => {
  const f = fixture(t), runId = randomUUID(), partial = { ...f.messages[1], runId, text: 'A beginning', textHash: digest('A beginning') };
  f.archive.observe(f.conversation, { ...f.page(), messages: [partial], hasMore: false, activeRunIds: [runId] });
  const before = f.archive.all(f.conversation)!.messages[0];
  f.archive.observe(f.conversation, { ...f.page(), messages: [{ ...partial, text: 'A beginning and the complete ending', textHash: digest('A beginning and the complete ending') }], hasMore: false, activeRunIds: [] });
  const after = f.archive.all(f.conversation)!;
  assert.equal(after.messages[0].novaId, before.novaId); assert.equal(after.messages[0].text, 'A beginning and the complete ending'); assert.equal(after.transcript.conflicts, 0);
  f.store.internalWrite('assistant:conversation:' + f.conversation.id, { ...f.conversation, deleted: true });
  assert.equal(f.archive.observe(f.conversation, f.page()), false); assert.equal(f.archive.read(f.conversation), undefined);
});
test('streaming operation deltas read their own records rather than decrypting every saved message', t => {
  const f = fixture(t);
  f.archive.observe(f.conversation, { ...f.page(), messages: f.messages, hasMore: false });
  const operation: AssistantOperation = { id: randomUUID(), requestId: randomUUID(), deviceId: f.store.session().deviceId, epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: 1, connectionGeneration: f.conversation.connectionGeneration, nativeKey: f.conversation.nativeKey, nativeId: f.conversation.nativeId!, nativeRunId: randomUUID(), state: 'accepted', input: 'Continue the discussion', text: 'The first part', context: { project: null, attachments: [], draftId: 'draft', draftRevision: 1, digest: digest('context') }, model: null, thinking: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastSequence: 1 };
  f.archive.observeOperation(f.conversation, operation);
  const originalRead = f.store.internalRead.bind(f.store);
  let messageReads = 0;
  f.store.internalRead = ((id: string) => { if (id.startsWith('assistant:transcript:' + f.conversation.id + ':message:')) messageReads++; return originalRead(id); }) as Store['internalRead'];
  const restarted = new NovaTranscript(f.store);
  for (let index = 0; index < 5; index++) restarted.observeOperation(f.conversation, { ...operation, text: 'The growing answer ' + index, lastSequence: index + 2 });
  assert.equal(messageReads, 10, 'each delta reads only its user and assistant record, including after service restart');
  f.store.internalRead = originalRead;
  const messages = restarted.all(f.conversation)!.messages;
  assert.equal(messages.length, 252); assert.equal(messages.at(-1)!.text, 'The growing answer 4');
});
test('distinct native parts of one operation retain separate identities within and across pages', async t => {
  for (const mode of ['same-page', 'across-pages', 'native-first'] as const) await t.test(mode, t => {
    const f = fixture(t), operation: AssistantOperation = { id: randomUUID(), requestId: randomUUID(), deviceId: f.store.session().deviceId, epoch: f.store.epoch, conversationId: f.conversation.id, conversationRevision: 1, connectionGeneration: f.conversation.connectionGeneration, nativeKey: f.conversation.nativeKey, nativeId: f.conversation.nativeId!, nativeRunId: randomUUID(), state: 'running', input: 'Investigate this', text: 'Provisional combined output', context: { project: null, attachments: [], draftId: 'draft', draftRevision: 1, digest: digest('context') }, model: null, thinking: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastSequence: 1 };
    if (mode !== 'native-first') f.archive.observeOperation(f.conversation, operation);
    const placeholder = f.archive.all(f.conversation)?.messages.find(message => message.role === 'assistant');
    const native = (id: string, role: ConversationMessage['role'], text: string): ConversationMessage => ({ id, role, text, textHash: digest(text), operationId: operation.id, runId: operation.nativeRunId!, attachments: [] });
    const messages = [native('owner', 'user', operation.input), native('reply-part-1', 'assistant', 'First native answer'), native('tool-part-1', 'tool', 'First tool result'), native('reply-part-2', 'assistant', mode === 'across-pages' ? 'First native answer' : 'Second native answer'), native('tool-part-2', 'tool', 'Second tool result')];
    if (mode === 'across-pages') {
      f.archive.observe(f.conversation, { ...f.page(), messages: messages.slice(0, 3), hasMore: false });
      f.archive.observe(f.conversation, { ...f.page(), messages: messages.slice(3), hasMore: false });
    } else f.archive.observe(f.conversation, { ...f.page(), messages, hasMore: false });
    const first = f.archive.all(f.conversation)!;
    assert.deepEqual(first.messages.map(message => message.id), messages.map(message => message.id));
    assert.deepEqual(first.messages.map(message => message.text), messages.map(message => message.text));
    assert.equal(new Set(first.messages.map(message => message.novaId)).size, 5); assert.equal(first.transcript.conflicts, 0);
    if (placeholder) {
      assert.equal(first.messages[1].novaId, placeholder.novaId);
      assert(f.archive.read(f.conversation, { messageId: placeholder.id })!.messages.some(message => message.id === 'reply-part-1'));
    }
    const restarted = new NovaTranscript(f.store);
    restarted.observeOperation(f.conversation, { ...operation, state: 'completed', text: 'Receipt combines every answer part' });
    restarted.observe(f.conversation, { ...f.page(), messages, hasMore: false });
    const after = restarted.all(f.conversation)!;
    assert.deepEqual(after.messages.map(message => [message.id, message.novaId, message.text]), first.messages.map(message => [message.id, message.novaId, message.text]));
    assert.equal(after.transcript.conflicts, 0); assert.equal(after.messages.filter(message => message.source?.kind === 'operation').length, 0);
  });
});
