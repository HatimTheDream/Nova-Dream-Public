import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../apps/service/store.js';
import { startServer } from '../apps/service/http.js';
import { SavedHistory } from '../apps/service/saved-history.js';
import { conversationItemRequestId } from '../apps/service/conversation-organization.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import type { Conversation } from '../packages/domain/assistant.js';
import type { ConversationCleanupBatch } from '../packages/domain/conversation-cleanup.js';
import { emptyDraft } from '../packages/domain/contracts.js';
import { blankRecord } from '../packages/domain/workspace-records.js';

const native = { status: 'not-configured' as const, notes: [] };
const capture = (store: Store) => store.captureBackup('local-cleanup-qualification', native);
const retained = (snapshot: ReturnType<typeof capture>) => { const { id: _id, createdAt: _createdAt, ...data } = snapshot; return data; };

// Real isolated application service, encrypted disk, HTTP sessions, timers and
// held recovery. This is not native/runtime or hosted-release qualification.
test('settled startup, restart and held restore preserve complete retained records/files and never resume cleanup', { timeout: 45000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), 'nova-cleanup-startup-')), directory = join(parent, 'original');
  let seeded: Store | undefined = new Store(directory), service: Awaited<ReturnType<typeof startServer>> | undefined, passed = false;
  const providerCalls: string[] = [];
  const gateway: AssistantTransport = { status: () => ({ state: 'unconfigured', message: 'Isolated cleanup service qualification', methods: [], grantedScopes: [], modelAuthReady: false }), subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}), async request<T>(method: string): Promise<T> { providerCalls.push(method); throw Error('Unexpected provider request: ' + method); } };
  try {
    const store = seeded, epoch = store.epoch, a = store.session(), b = store.session();
    const chats = Array.from({ length: 7 }, (_, i): Conversation => { const id = randomUUID(); return { id, revision: 1, title: 'Retained ' + i, projectId: null, archived: false, model: null, thinking: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', nativeId: randomUUID(), nativeKey: 'fixture:' + id, connectionGeneration: 'isolated', state: i === 6 ? 'unknown' : 'ready' }; });
    for (const chat of chats) store.internalWrite('assistant:conversation:' + chat.id, chat);
    const messageText = 'Exact saved conversation writing with Unicode \u03bb.';
    assert.equal(new SavedHistory(store).observe(chats[0], { conversationId: chats[0].id, nativeId: chats[0].nativeId!, offset: 0, hasMore: false, activeRunIds: [], messages: [{ id: 'original-message', role: 'user', text: messageText, textHash: createHash('sha256').update(messageText).digest('hex'), attachments: [] }] }), true);
    assert.equal(new SavedHistory(store).messages(chats[0])[0].text, messageText);
    const file = store.upload(a.deviceId, randomUUID(), epoch, 'retained-writing.txt', Buffer.from('Exact retained file bytes.\n').toString('base64'));
    store.mutate(a.deviceId, { requestId: randomUUID(), epoch, kind: 'draft', entityId: 'draft:' + a.deviceId, expectedRevision: 0, payload: { ...emptyDraft, title: 'Unsent writing', text: 'Do not send or remove this draft.', attachments: [file] } });
    store.mutate(a.deviceId, { requestId: randomUUID(), epoch, kind: 'task', entityId: 'task:retained-cleanup', expectedRevision: 0, payload: { title: 'Original task', notes: 'Keep original task history', status: 'open', planned: '', due: '' } });
    store.mutate(a.deviceId, { requestId: randomUUID(), epoch, kind: 'content', entityId: 'content:retained-cleanup', expectedRevision: 0, payload: { ...blankRecord('content', 'UTC'), title: 'Saved content', body: 'Exact saved content body.' } });
    store.close(); seeded = undefined;
    const api = async (session: typeof a, path: string, body?: unknown) => {
      const response = await fetch(service!.origin + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: 'e3_session=' + session.token, 'X-Edition3-Client': '1', 'Content-Type': 'application/json', Origin: service!.origin }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      return { status: response.status, data: await response.json() as any };
    };
    const start = async (path: string) => { service = await startServer({ directory: path, port: 0, gateway }); await delay(3200); };
    const close = async () => { const origin = service!.origin; await service!.close(); service = undefined; await assert.rejects(fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) })); };
    await start(directory);
    const unauthorized = await fetch(service!.origin + '/api/assistant/conversation-cleanup/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Edition3-Client': '1', Origin: service!.origin }, body: '{}' }); assert.equal(unauthorized.status, 401);
    const foreignOrigin = await fetch(service!.origin + '/api/assistant/conversation-cleanup/prepare', { method: 'POST', headers: { Cookie: 'e3_session=' + a.token, 'Content-Type': 'application/json', 'X-Edition3-Client': '1', Origin: 'http://example.invalid' }, body: '{}' }); assert.equal(foreignOrigin.status, 403);
    const prepare = async (targets: Conversation[]) => {
      const command = { requestId: randomUUID(), epoch, action: 'trash', scope: { space: 'all', folder: 'active', query: '' }, targets: targets.map(c => ({ id: c.id, revision: c.revision })) };
      const result = await api(a, 'assistant/conversation-cleanup/prepare', command); assert.equal(result.status, 200, JSON.stringify(result.data)); return { command, batch: result.data as ConversationCleanupBatch };
    };
    const apply = async (batch: ConversationCleanupBatch) => {
      const command = { requestId: randomUUID(), epoch, batchId: batch.id, digest: batch.digest, expectedRevision: batch.revision, decision: 'apply' };
      const result = await api(a, 'assistant/conversation-cleanup/decide', command); assert.equal(result.status, 200, JSON.stringify(result.data)); return { command, batch: result.data as ConversationCleanupBatch };
    };
    const complete = await prepare([chats[0]]), completed = await apply(complete.batch); assert.equal(completed.batch.state, 'complete');
    const review = await prepare([chats[1]]), interrupted = await prepare([chats[2], chats[3]]), unsupported = await prepare([chats[4]]);
    const partial = await apply((await prepare([chats[5], chats[6]])).batch); assert.equal(partial.batch.state, 'partial'); assert.equal(partial.batch.counts.blocked, 1);
    // Explicit fault injection after the controller has closed. The first item
    // has a real maintained edit receipt; the second was never invoked.
    await service!.conversationCleanup.close();
    const first = interrupted.batch.targets[0], command = { requestId: conversationItemRequestId(interrupted.batch.id, first.id), epoch, conversationId: first.id, expectedRevision: first.revision, deleted: true };
    await service!.assistant.edit(a.deviceId, command);
    const key = 'assistant:cleanup:' + interrupted.batch.id, original = service!.store.internalRead<any>(key);
    service!.store.internalWrite(key, { ...original, state: 'applying', outcomes: original.outcomes.map((o: any, i: number) => i === 0 ? { ...o, state: 'unconfirmed', code: 'unconfirmed' } : o) });
    const badKey = 'assistant:cleanup:' + unsupported.batch.id, bad = { ...service!.store.internalRead<any>(badKey), format: 99 }; service!.store.internalWrite(badKey, bad);
    const before = capture(service!.store); assert.ok(before.files.length && before.references.length && before.history.length && before.receipts.length);
    await close(); await start(directory);
    assert.deepEqual(retained(capture(service!.store)), retained(before), 'complete retained state is unchanged after actual settled restart');
    for (const id of [completed.batch.id, review.batch.id, interrupted.batch.id, partial.batch.id]) assert.equal((await api(b, 'assistant/conversation-cleanup?id=' + id)).status, 200);
    assert.equal((await api(b, 'assistant/conversation-cleanup?id=' + interrupted.batch.id)).data.state, 'unconfirmed');
    assert.equal((await api(b, 'assistant/conversation-cleanup?id=' + unsupported.batch.id)).status, 409);
    assert.deepEqual(service!.store.internalRead(badKey), bad);
    assert.deepEqual(retained(capture(service!.store)), retained(before), 'reads do not resume or repair saved records');
    assert.equal((await api(b, 'assistant/conversation-cleanup/prepare', complete.command)).status, 409, 'other session cannot adopt original prepare request');
    assert.equal((await api(a, 'assistant/conversation-cleanup/decide', completed.command)).data.state, 'complete', 'original completed decision is observed without another edit');
    const current = (await api(b, 'assistant/conversation-cleanup?id=' + interrupted.batch.id)).data as ConversationCleanupBatch;
    const check = await api(b, 'assistant/conversation-cleanup/decide', { requestId: randomUUID(), epoch, batchId: current.id, expectedRevision: current.revision, digest: current.digest, decision: 'check' });
    assert.equal(check.status, 200); assert.equal(check.data.counts.applied, 1); assert.equal(check.data.outcomes[1].code, 'not_applied');
    const after = capture(service!.store), changes = after.services.filter(row => JSON.stringify(row) !== JSON.stringify(before.services.find(old => old.id === row.id)));
    assert.deepEqual(changes.map(row => row.id), [key]);
    assert.deepEqual({ ...retained(after), services: before.services }, retained(before), 'only the exact interrupted batch reconciliation changes');
    const changed = changes[0].value as any; assert.equal(changed.revision, original.revision + 1); assert.equal(changed.state, 'partial'); assert.deepEqual(changed.targets, original.targets); assert.equal(changed.digest, original.digest);
    assert.deepEqual(new SavedHistory(service!.store).messages(chats[0]), [], 'existing Deleted transcript access stays closed');
    assert.ok(after.services.some(row => (row.value as { message?: { text?: string } }).message?.text === messageText), 'exact saved transcript bytes remain retained despite the read policy');
    const corrupt = structuredClone(after); corrupt.files[0].base64 = Buffer.from('wrong bytes').toString('base64'); assert.throws(() => Store.verifyBackup(corrupt), { code: 'backup_file' });
    const missing = structuredClone(after); missing.references[0].fileId = randomUUID(); assert.throws(() => Store.verifyBackup(missing), { code: 'backup_reference' });
    await close();
    const restoredPath = join(parent, 'held'), restored = Store.restoreBackup(restoredPath, after), restoredEpoch = restored.epoch, recoveredSession = restored.session();
    const recoveredBefore = capture(restored);
    assert.notEqual(restoredEpoch, epoch); assert.equal(restored.recoveryHeld, true);
    assert.deepEqual(recoveredBefore.entities, after.entities); assert.deepEqual(recoveredBefore.history, after.history); assert.deepEqual(recoveredBefore.receipts, after.receipts); assert.deepEqual(recoveredBefore.files, after.files); assert.deepEqual(recoveredBefore.references, after.references);
    const restoreKeys = new Set(['http:session-cookie', 'phone:access', 'recovery:state', 'recovery:retained-archives']);
    assert.deepEqual(recoveredBefore.services.filter(row => !restoreKeys.has(row.id)), after.services.filter(row => !restoreKeys.has(row.id)));
    assert.deepEqual(restored.internalRead('phone:access'), { enabled: false }); assert.equal(restored.internalRead('http:session-cookie'), undefined); assert.deepEqual(restored.internalRead('recovery:retained-archives'), []);
    const recovery = restored.internalRead<any>('recovery:state'); assert.deepEqual({ ...recovery, recoveredAt: '' }, { held: true, backupId: after.id, sourceEpoch: epoch, recoveredAt: '', native: 'not-configured' });
    restored.close(); await start(restoredPath);
    const settledHeld = capture(service!.store), cookieRecord = settledHeld.services.find(row => row.id === 'http:session-cookie')!;
    assert.match(String(cookieRecord.value), /^e3_session_[a-f0-9]{32}$/); assert.equal(cookieRecord.revision, 1);
    assert.deepEqual({ ...retained(settledHeld), services: settledHeld.services.filter(row => row.id !== 'http:session-cookie') }, retained(recoveredBefore), 'held startup only establishes its new local session-cookie identity');
    const read = await api(recoveredSession, 'assistant/conversation-cleanup?id=' + review.batch.id); assert.equal(read.status, 200); assert.equal(read.data.remainder.verified, false);
    assert.equal((await api(recoveredSession, 'assistant/conversation-cleanup/decide', { requestId: randomUUID(), epoch: restoredEpoch, batchId: review.batch.id, expectedRevision: 1, digest: review.batch.digest, decision: 'apply' })).status, 409);
    assert.deepEqual(retained(capture(service!.store)), retained(settledHeld)); assert.deepEqual(providerCalls, []);
    await close(); passed = true;
  } finally {
    await service?.close(); seeded?.close();
    if (passed) { assert.equal(dirname(resolve(parent)), resolve(tmpdir())); assert.ok(basename(parent).startsWith('nova-cleanup-startup-')); rmSync(parent, { recursive: true, force: true }); }
    else process.stderr.write('Preserved isolated startup fixture: ' + parent + '\n');
  }
});
