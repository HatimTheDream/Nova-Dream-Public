import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { GatewayClientRequestError } from '@openclaw/gateway-client';
import { Store } from '../apps/service/store.js';
import { startServer } from '../apps/service/http.js';
import { conversationItemRequestId } from '../apps/service/conversation-organization.js';
import { canonical } from '../packages/domain/contracts.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import type { Conversation } from '../packages/domain/assistant.js';
import type { PermanentConversationCleanupBatch } from '../packages/domain/conversation-cleanup.js';

const native = { status: 'not-configured' as const, notes: [] };
const capture = (store: Store) => store.captureBackup('permanent-cleanup-qualification', native);
const retained = (snapshot: ReturnType<typeof capture>) => {
  const { id: _id, createdAt: _at, ...rest } = snapshot; return rest;
};
const sha = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const byId = <T extends { id: string }>(a: T, b: T) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const stamp = (value: unknown, start: number, end: number) => {
  assert.equal(typeof value, 'string');
  const time = Date.parse(value as string);
  assert.ok(Number.isFinite(time) && time >= start && time <= end, 'timestamp belongs to this actual application phase');
};

// Actual HTTP/application/encrypted-store lifecycle, with one explicitly
// simulated setup rejection. No provider runtime, native deletion or release
// qualification is claimed. Every subsequent transport request is forbidden.
test('permanent cleanup actual application restart and held restore retain the complete expected workspace', { timeout: 45000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), 'nova-permanent-startup-')), directory = join(parent, 'original');
  let seed: Store | undefined = new Store(directory), service: Awaited<ReturnType<typeof startServer>> | undefined, passed = false;
  let allowRejectedCreation = false;
  const calls: string[] = [], generation = randomUUID();
  const gateway: AssistantTransport = {
    status: () => ({ state: allowRejectedCreation ? 'ready' : 'unconfigured', generation,
      methods: ['sessions.create'], grantedScopes: ['operator.read', 'operator.write'],
      modelAuthReady: false, message: 'Synthetic rejected setup only; no installed native runtime' }),
    subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}),
    async request<T>(method: string): Promise<T> {
      calls.push(method);
      if (allowRejectedCreation && method === 'sessions.create') {
        allowRejectedCreation = false;
        throw new GatewayClientRequestError({ code: 'FORBIDDEN', message: 'Explicit simulated setup rejection' });
      }
      throw Error('Unexpected native request: ' + method);
    },
  };
  try {
    const a = seed.session(), b = seed.session(), epoch = seed.epoch;
    const untouchedId = randomUUID(), untouched: Conversation = {
      id: untouchedId, revision: 1, title: 'Original native-bound saved conversation', projectId: null, archived: true, deleted: true,
      model: null, thinking: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      nativeId: randomUUID(), nativeKey: 'synthetic-original:' + untouchedId, connectionGeneration: generation, state: 'ready',
    };
    seed.internalWrite('assistant:conversation:' + untouchedId, untouched);
    seed.close(); seed = undefined;
    const start = async (path: string) => { service = await startServer({ directory: path, port: 0, gateway }); await delay(3200); };
    const close = async () => {
      const origin = service!.origin; await service!.close(); service = undefined;
      await assert.rejects(fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) }));
    };
    const api = async (session: typeof a, path: string, body?: unknown) => {
      const response = await fetch(service!.origin + '/api/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Cookie: 'e3_session=' + session.token, 'X-Edition3-Client': '1', 'Content-Type': 'application/json', Origin: service!.origin },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, data: await response.json() as any };
    };
    const base = 'assistant/conversation-cleanup/permanent';
    const prepare = async (target: Conversation) => {
      const command = { requestId: randomUUID(), epoch, action: 'remove', scope: { space: 'all', folder: 'deleted', query: '' },
        targets: [{ id: target.id, revision: target.revision }] };
      const response = await api(a, base + '/prepare', command);
      assert.equal(response.status, 200, JSON.stringify(response.data));
      return { command, batch: response.data as PermanentConversationCleanupBatch };
    };
    await start(directory);
    const unauthorized = await fetch(service!.origin + '/api/' + base + '/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Edition3-Client': '1', Origin: service!.origin }, body: '{}',
    }); assert.equal(unauthorized.status, 401);
    const foreign = await fetch(service!.origin + '/api/' + base + '/decide', {
      method: 'POST', headers: { Cookie: 'e3_session=' + a.token, 'Content-Type': 'application/json', 'X-Edition3-Client': '1', Origin: 'http://example.invalid' }, body: '{}',
    }); assert.equal(foreign.status, 403);
    allowRejectedCreation = true;
    const createCommand = { requestId: randomUUID(), epoch, title: 'Rejected application creation', projectId: null };
    const creation = await api(a, 'assistant/conversations', createCommand);
    assert.equal(creation.status, 200); assert.equal(creation.data.state, 'failed'); assert.equal(creation.data.nativeId, null);
    const created = creation.data as Conversation;
    const trashCommand = { requestId: randomUUID(), epoch, conversationId: created.id, expectedRevision: created.revision, deleted: true };
    const trashed = await api(a, 'assistant/conversation/edit', trashCommand); assert.equal(trashed.status, 200);
    const chat = trashed.data as Conversation; assert.equal(chat.deleted, true);
    const store = service!.store, file = store.upload(a.deviceId, randomUUID(), epoch, 'shared-writing.txt', Buffer.from('Exact original file bytes\n').toString('base64'));
    const ownedDraft = 'draft:' + a.deviceId + ':' + chat.id, draftRequest = randomUUID();
    store.mutate(a.deviceId, { requestId: draftRequest, epoch, kind: 'draft', entityId: ownedDraft, expectedRevision: 0,
      payload: { conversationId: chat.id, title: 'Conversation writing', projectId: null, text: 'Owned unsent writing', attachments: [file] } });
    store.mutate(a.deviceId, { requestId: randomUUID(), epoch, kind: 'draft', entityId: 'draft:' + a.deviceId, expectedRevision: 0,
      payload: { title: 'Independent writing', projectId: null, text: 'Keep this independent draft.', attachments: [file] } });
    store.mutate(a.deviceId, { requestId: randomUUID(), epoch, kind: 'content', entityId: 'content:permanent-retained', expectedRevision: 0,
      payload: { ...blankRecord('content', 'UTC'), title: 'Saved independent content', body: 'Keep the original content.' } });
    store.internalWrite('assistant:memory', { revision: 1, entries: [{ text: 'Independent fact', source: { conversationId: chat.id } }] });
    store.internalWrite('assistant:output:retained', { id: 'retained', conversationId: chat.id, state: 'ready', text: 'Separate saved output' });
    store.internalWrite('assistant:history:' + chat.id, { fixture: 'Conversation-owned retained bytes' });
    store.internalWrite('assistant:transcript:' + chat.id + ':fixture', { fixture: 'Conversation-owned transcript bytes' });
    const review = await prepare(chat), batchKey = 'assistant:cleanup:' + review.batch.id;
    const savedReview = store.internalRead<any>(batchKey), before = capture(store), effectStart = Date.now();
    const decision = { requestId: randomUUID(), epoch, batchId: review.batch.id, expectedRevision: review.batch.revision, digest: review.batch.digest, decision: 'start' };
    const accepted = await api(a, base + '/decide', decision); assert.equal(accepted.status, 202);
    let observed = await api(b, base + '?id=' + review.batch.id);
    for (let i = 0; i < 30 && observed.data.running; i++) { await delay(20); observed = await api(b, base + '?id=' + review.batch.id); }
    assert.equal(observed.status, 200); assert.equal(observed.data.running, false); assert.equal(observed.data.counts.applied, 1);
    const after = capture(store), effectEnd = Date.now(), removalId = conversationItemRequestId(review.batch.id, chat.id);
    const removalCommand = { requestId: removalId, epoch, conversationId: chat.id, expectedRevision: chat.revision };
    const row = (id: string) => { const item = after.services.find(s => s.id === id); assert.ok(item, id); return item; };
    const savedResult = row(batchKey).value as any;
    stamp(savedResult.updatedAt, effectStart, effectEnd); stamp(savedResult.chunks[0].startedAt, effectStart, effectEnd); stamp(savedResult.chunks[0].settledAt, effectStart, effectEnd);
    assert.deepEqual(savedResult, { ...savedReview, revision: 5, state: 'complete', updatedAt: savedResult.updatedAt,
      outcomes: [{ id: chat.id, chunkId: decision.requestId, removalId, state: 'applied' }],
      chunks: [{ id: decision.requestId, deviceId: a.deviceId, decision: 'start', startedAt: savedResult.chunks[0].startedAt,
        state: 'closed', itemIds: [chat.id], settledAt: savedResult.chunks[0].settledAt }] });
    assert.equal(row(batchKey).revision, 5);
    const removal = row('assistant:removal:' + removalId); stamp((removal.value as any).updatedAt, effectStart, effectEnd);
    assert.deepEqual(removal, { id: 'assistant:removal:' + removalId, revision: 2, value: { ...removalCommand,
      deviceId: a.deviceId, nativeId: null, nativeKey: chat.nativeKey, connectionGeneration: chat.connectionGeneration,
      state: 'completed', updatedAt: (removal.value as any).updatedAt } });
    const tombstone = row('assistant:removed:' + chat.id); stamp((tombstone.value as any).at, effectStart, effectEnd);
    assert.deepEqual(tombstone, { id: 'assistant:removed:' + chat.id, revision: 1, value: { id: chat.id, requestId: removalId, at: (tombstone.value as any).at } });
    assert.deepEqual(row('assistant:removal-current:' + chat.id), { id: 'assistant:removal-current:' + chat.id, revision: 1, value: removalId });
    assert.deepEqual(row('assistant:draft-removed:' + ownedDraft), { id: 'assistant:draft-removed:' + ownedDraft, revision: 1, value: { draftId: ownedDraft, revision: 2 } });
    const addedServiceIds = ['assistant:removal:' + removalId, 'assistant:removed:' + chat.id, 'assistant:removal-current:' + chat.id, 'assistant:draft-removed:' + ownedDraft];
    const removedServiceIds = new Set(['assistant:conversation:' + chat.id, 'assistant:history:' + chat.id, 'assistant:transcript:' + chat.id + ':fixture']);
    const expectedServices = [...before.services.filter(s => !removedServiceIds.has(s.id)).map(s => s.id === batchKey ? row(batchKey) : s), ...addedServiceIds.map(row)].sort(byId);
    const newReceipts = [
      { requestId: decision.requestId, digest: sha({ type: 'conversation.cleanup.permanent.decision', ...decision }), deviceId: a.deviceId, value: review.batch.id },
      { requestId: removalId, digest: sha({ type: 'conversation.remove', ...removalCommand }), deviceId: a.deviceId, value: { requestId: removalId } },
    ];
    const expectedReceipts = [...before.receipts.map(r => r.requestId === draftRequest ? { ...r, value: { removedWork: 'draft' } }
      : [createCommand.requestId, trashCommand.requestId].some(id => id === r.requestId) ? { ...r, value: { removedWork: 'conversation' } } : r), ...newReceipts]
      .sort((a, b) => a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0);
    assert.deepEqual(retained(after), { ...retained(before), cursor: before.cursor + 2,
      entities: before.entities.filter(e => e.id !== ownedDraft), history: before.history.filter(h => h.entityId !== ownedDraft),
      references: before.references.filter(r => r.entityId !== ownedDraft), receipts: expectedReceipts, services: expectedServices },
    'full retained snapshot equals only the exact maintained conversation/draft removal and genuine batch receipts');
    const stable = capture(store);
    assert.equal((await api(a, base + '/decide', decision)).status, 200, 'original accepted decision is observed, not repeated');
    assert.equal((await api(b, base + '/decide', decision)).status, 409, 'a different session cannot adopt the original decision');
    assert.equal((await api(b, 'assistant/conversation-cleanup?id=' + review.batch.id)).status, 409, 'format1 load refuses permanent work');
    assert.deepEqual(retained(capture(store)), retained(stable));

    // Preserve ordinary reversible review and new permanent reviews together.
    const reversible = service!.conversationCleanup.prepare(a.deviceId, { requestId: randomUUID(), epoch, action: 'restore',
      scope: { space: 'all', folder: 'deleted', query: '' }, targets: [{ id: untouchedId, revision: 1 }] });
    const interrupted = await prepare(untouched), unsupported = await prepare(untouched);
    const nativeRefusal = await prepare(untouched);
    const refuse = await api(a, base + '/decide', { requestId: randomUUID(), epoch, batchId: nativeRefusal.batch.id,
      expectedRevision: nativeRefusal.batch.revision, digest: nativeRefusal.batch.digest, decision: 'start' });
    assert.equal(refuse.status, 202);
    await delay(30);
    assert.equal((await api(a, base + '?id=' + nativeRefusal.batch.id)).data.outcomes[0].code, 'removal_connection');
    assert.deepEqual(store.internalRead('assistant:conversation:' + untouchedId), untouched);
    await service!.conversationCleanup.close();
    // Explicit interruption injection after owner closure: start marker exists,
    // but the original removal has no admission receipt and must remain unknown.
    const interruptedKey = 'assistant:cleanup:' + interrupted.batch.id, prior = store.internalRead<any>(interruptedKey), chunkId = randomUUID();
    store.internalWrite(interruptedKey, { ...prior, revision: 2, state: 'applying',
      outcomes: [{ id: untouchedId, state: 'unconfirmed', chunkId, code: 'removal_unconfirmed' }],
      chunks: [{ id: chunkId, deviceId: a.deviceId, decision: 'start', startedAt: new Date().toISOString(), state: 'running', itemIds: [untouchedId] }] });
    const unsupportedKey = 'assistant:cleanup:' + unsupported.batch.id, bad = { ...store.internalRead<any>(unsupportedKey), format: 99 };
    store.internalWrite(unsupportedKey, bad);
    const retainedBefore = capture(store); await close(); await start(directory);
    assert.deepEqual(retained(capture(service!.store)), retained(retainedBefore), 'actual settled restart preserves complete encrypted retained state');
    for (const id of [review.batch.id, interrupted.batch.id, nativeRefusal.batch.id]) assert.equal((await api(b, base + '?id=' + id)).status, 200);
    assert.equal((await api(b, base + '?id=' + interrupted.batch.id)).data.counts.unconfirmed, 1);
    assert.equal((await api(b, base + '?id=' + unsupported.batch.id)).status, 409);
    assert.equal((await api(b, 'assistant/conversation-cleanup?id=' + reversible.id)).status, 200);
    assert.deepEqual(retained(capture(service!.store)), retained(retainedBefore), 'status observation neither resumes nor repairs original work');
    const corrupt = structuredClone(retainedBefore); corrupt.files[0].base64 = Buffer.from('wrong').toString('base64');
    assert.throws(() => Store.verifyBackup(corrupt), { code: 'backup_file' });
    const missing = structuredClone(retainedBefore); missing.references[0].fileId = randomUUID();
    assert.throws(() => Store.verifyBackup(missing), { code: 'backup_reference' });
    await close();
    const restoreStart = Date.now(), restoredPath = join(parent, 'held'), restored = Store.restoreBackup(restoredPath, retainedBefore), restoreEnd = Date.now(), restoredEpoch = restored.epoch, session = restored.session();
    const restoredBefore = capture(restored), restoreKeys = new Set(['http:session-cookie', 'phone:access', 'recovery:state', 'recovery:retained-archives']);
    assert.notEqual(restoredEpoch, epoch); assert.equal(restored.recoveryHeld, true);
    for (const field of ['entities', 'history', 'receipts', 'files', 'references'] as const) assert.deepEqual(restoredBefore[field], retainedBefore[field]);
    assert.deepEqual(restoredBefore.services.filter(s => !restoreKeys.has(s.id)), retainedBefore.services.filter(s => !restoreKeys.has(s.id)));
    assert.deepEqual(restored.internalRead('phone:access'), { enabled: false });
    assert.equal(restored.internalRead('http:session-cookie'), undefined); assert.deepEqual(restored.internalRead('recovery:retained-archives'), []);
    assert.deepEqual({ ...restored.internalRead<any>('recovery:state'), recoveredAt: '' },
      { held: true, backupId: retainedBefore.id, sourceEpoch: epoch, recoveredAt: '', native: 'not-configured' });
    const recoveredAt = restored.internalRead<any>('recovery:state').recoveredAt;
    stamp(recoveredAt, restoreStart, restoreEnd);
    const restoredRow = (id: string, value: unknown) => ({ id,
      revision: (retainedBefore.services.find(row => row.id === id)?.revision ?? 0) + 1, value });
    const expectedRestoredServices = [
      ...retainedBefore.services.filter(row => !restoreKeys.has(row.id)),
      restoredRow('recovery:state', { held: true, backupId: retainedBefore.id, sourceEpoch: epoch, recoveredAt, native: 'not-configured' }),
      restoredRow('recovery:retained-archives', []), restoredRow('phone:access', { enabled: false }),
    ].sort(byId);
    assert.equal(restoredBefore.cursor, retainedBefore.cursor, 'restore preserves the original workspace cursor');
    assert.deepEqual(retained(restoredBefore), { ...retained(retainedBefore), epoch: restoredEpoch, services: expectedRestoredServices },
      'full original-to-restored transform allows only a fresh epoch and the exact held recovery/cookie/phone rows with derived revisions');
    restored.close(); await start(restoredPath);
    const held = capture(service!.store), cookie = held.services.find(s => s.id === 'http:session-cookie')!;
    assert.match(String(cookie.value), /^e3_session_[a-f0-9]{32}$/); assert.equal(cookie.revision, 1);
    assert.deepEqual({ ...retained(held), services: held.services.filter(s => s.id !== 'http:session-cookie') }, retained(restoredBefore));
    assert.equal((await api(session, base + '?id=' + interrupted.batch.id)).data.remainder.verified, false);
    assert.equal((await api(session, base + '/decide', { ...decision, requestId: randomUUID(), epoch: restoredEpoch })).status, 409);
    assert.deepEqual(retained(capture(service!.store)), retained(held), 'held recovery refuses a new decision without changing original authority');
    assert.deepEqual(calls, ['sessions.create'], 'one explicit simulated creation refusal; zero native removal or replay requests');
    await close(); passed = true;
  } finally {
    await service?.close(); seed?.close();
    if (passed) {
      assert.equal(dirname(resolve(parent)), resolve(tmpdir())); assert.ok(basename(parent).startsWith('nova-permanent-startup-'));
      rmSync(parent, { recursive: true, force: true });
    } else process.stderr.write('Preserved isolated permanent-cleanup startup fixture: ' + parent + '\n');
  }
});
