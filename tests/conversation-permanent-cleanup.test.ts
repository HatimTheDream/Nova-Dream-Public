import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Store, Fault } from '../apps/service/store.js';
import { AssistantService } from '../apps/service/assistant.js';
import { ConversationCleanup } from '../apps/service/conversation-cleanup.js';
import { phoneRouteAllowed } from '../apps/service/phone-policy.js';
import { conversationItemRequestId } from '../apps/service/conversation-organization.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import type { Conversation } from '../packages/domain/assistant.js';
import type { PermanentConversationCleanupBatch } from '../packages/domain/conversation-cleanup.js';
import type { ConversationRemoval, RemoveConversation } from '../packages/domain/conversation-removal.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'nova-permanent-cleanup-')), store = new Store(directory), device = store.session().deviceId;
  const calls: string[] = [];
  const gateway: AssistantTransport = {
    status: () => ({ state: 'unconfigured', message: 'Isolated application fixture; no native runtime', methods: [], grantedScopes: [], modelAuthReady: false }),
    subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}),
    async request<T>(method: string): Promise<T> { calls.push(method); throw Error('Unexpected native request'); },
  };
  let tick = 0;
  const assistant = new AssistantService(store, gateway), cleanup = new ConversationCleanup(store, assistant, Date.now, () => tick);
  const chat = (title = 'Disposable failed creation', extra: Partial<Conversation> = {}) => {
    const id = randomUUID(), value: Conversation = {
      id, revision: 1, title, projectId: null, archived: false, deleted: true, model: null, thinking: null,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      nativeId: null, nativeKey: 'failed:' + id, connectionGeneration: 'isolated', state: 'failed', ...extra,
    };
    return store.internalWrite('assistant:conversation:' + id, value);
  };
  const prepare = (extra: object = {}) => cleanup.permanent.prepare(device, {
    requestId: randomUUID(), epoch: store.epoch, action: 'remove', scope: { space: 'all', folder: 'deleted', query: '' }, ...extra,
  });
  const command = (batch: PermanentConversationCleanupBatch, decision: 'start' | 'continue_remaining' | 'cancel' = 'start') =>
    ({ requestId: randomUUID(), epoch: store.epoch, batchId: batch.id, expectedRevision: batch.revision, digest: batch.digest, decision });
  const settle = async (id: string) => {
    for (let i = 0; i < 100 && cleanup.permanent.get(id).running; i++) await nextTurn();
    const result = cleanup.permanent.get(id); assert.equal(result.running, false, 'bounded local fixture closes'); return result;
  };
  return { directory, store, device, calls, assistant, cleanup, chat, prepare, command, settle, advance: (ms: number) => { tick += ms; } };
}
type Fixture = ReturnType<typeof fixture>;
function check(name: string, run: (fixture: Fixture) => Promise<void> | void) {
  test(name, async () => {
    const f = fixture(); let passed = false;
    try { await run(f); passed = true; }
    finally {
      await f.cleanup.close(); f.assistant.close(); f.store.close();
      if (passed) {
        assert.equal(dirname(resolve(f.directory)), resolve(tmpdir())); assert.ok(basename(f.directory).startsWith('nova-permanent-cleanup-'));
        rmSync(f.directory, { recursive: true, force: true });
      } else process.stderr.write('Preserved synthetic permanent-cleanup fixture: ' + f.directory + '\n');
    }
  });
}
const noAuthChange = () => {};
const retained = (store: Store) => {
  const { id: _id, createdAt: _time, ...snapshot } = store.captureBackup('permanent-cleanup-test', { status: 'not-configured', notes: [] });
  return snapshot;
};

check('exact permanent Trash capture stays separate from reversible history and rejects unsupported stored formats', f => {
  const a = f.chat(), b = f.chat('Work', { space: 'work' }); f.chat('Active', { deleted: false });
  const batch = f.prepare();
  assert.deepEqual(new Set(batch.targets.map(t => t.id)), new Set([a.id, b.id]));
  assert.equal(JSON.stringify(batch).includes('nativeKey'), false);
  assert.equal(f.cleanup.list().total, 0); assert.equal(f.cleanup.listPermanent().total, 1);
  assert.throws(() => f.cleanup.get(batch.id), { code: 'cleanup_record_invalid' }, 'original format1 reader refuses format2');
  assert.throws(() => f.prepare({ scope: { space: 'all', folder: 'active', query: '' } }));
  const key = 'assistant:cleanup:' + batch.id, original = f.store.internalRead<any>(key);
  for (const corrupt of [{ ...original, format: 99 }, { ...original, outcomes: [] }, { ...original, digest: '0'.repeat(64) }]) {
    f.store.internalWrite(key, corrupt);
    assert.throws(() => f.cleanup.list(), { code: 'cleanup_record_invalid' });
    assert.throws(() => f.cleanup.listPermanent(), { code: 'cleanup_record_invalid' });
    assert.deepEqual(f.store.internalRead(key), corrupt);
  }
});

check('capture uses complete metadata, exact selected revisions and a hard500 limit without truncation', f => {
  const first = f.chat('Selected'), current = f.chat('Other', { deleted: false });
  assert.throws(() => f.prepare({ targets: [{ id: current.id, revision: 1 }] }), { code: 'cleanup_scope_changed' });
  assert.throws(() => f.prepare({ targets: [{ id: first.id, revision: 2 }] }), { code: 'cleanup_scope_changed' });
  assert.throws(() => f.prepare({ targets: [{ id: first.id, revision: 1 }, { id: first.id, revision: 1 }] }));
  for (let i = 0; i < 500; i++) f.chat('Bounded ' + i);
  assert.throws(() => f.prepare(), { code: 'cleanup_limit' });
  assert.equal(f.cleanup.listPermanent().total, 0);
  const selected = f.prepare({ targets: [{ id: first.id, revision: 1 }] });
  assert.equal(selected.targets.length, 1); assert.equal(selected.remainder.matchingCount, 501);
});

check('unchanged local removal produces exact genuine receipt/tombstone while preserving independent saved work and shared bytes', async f => {
  const chat = f.chat(), unrelated = f.chat('Keep this'), file = f.store.upload(f.device, randomUUID(), f.store.epoch, 'shared.txt', Buffer.from('Keep exact shared bytes').toString('base64'));
  const ownedDraft = 'draft:' + f.device + ':' + chat.id;
  for (const [entityId, conversationId] of [[ownedDraft, chat.id], ['draft:' + f.device, null]] as const) f.store.mutate(f.device, {
    requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId, expectedRevision: 0,
    payload: { conversationId, title: 'Writing', projectId: null, text: 'Exact draft writing', attachments: [file] },
  });
  f.store.internalWrite('assistant:history:' + chat.id, { writing: 'Conversation-owned history' });
  f.store.internalWrite('assistant:memory', { text: 'Independent remembered fact', source: { conversationId: chat.id } });
  f.store.internalWrite('assistant:output:kept', { id: 'kept', conversationId: chat.id, state: 'ready', text: 'Saved output' });
  const batch = f.prepare({ targets: [{ id: chat.id, revision: 1 }] }), decision = f.command(batch);
  const accepted = f.cleanup.permanent.decide(f.device, decision, noAuthChange);
  assert.equal(accepted.running, true); assert.equal(accepted.chunks[0].id, decision.requestId);
  const result = await f.settle(batch.id), removalId = conversationItemRequestId(batch.id, chat.id);
  assert.equal(result.counts.applied, 1); assert.equal(result.state, 'complete');
  assert.equal(result.outcomes[0].removalId, removalId);
  assert.equal(f.store.internalRead<ConversationRemoval>('assistant:removal:' + removalId)!.deviceId, f.device);
  assert.equal(f.store.internalRead<any>('assistant:removed:' + chat.id).requestId, removalId);
  assert.equal(f.store.internalRead('assistant:conversation:' + chat.id), undefined);
  assert.equal(f.store.internalRead('assistant:history:' + chat.id), undefined);
  assert.equal(f.store.readEntity('draft', ownedDraft), undefined);
  assert.ok(f.store.readEntity('draft', 'draft:' + f.device));
  assert.ok(f.store.internalRead('assistant:memory')); assert.ok(f.store.internalRead('assistant:output:kept'));
  assert.deepEqual(f.store.internalRead('assistant:conversation:' + unrelated.id), unrelated);
  assert.equal(f.store.download(file.id).metadata.sha256, file.sha256);
  const snapshot = retained(f.store); f.cleanup.permanent.get(batch.id); f.cleanup.listPermanent();
  assert.deepEqual(retained(f.store), snapshot, 'GET projections do not persist or admit effects');
  f.cleanup.permanent.decide(f.device, decision, noAuthChange);
  assert.deepEqual(retained(f.store), snapshot, 'lost accepted response reuses the original decision');
  assert.deepEqual(f.calls, []);
});

check('bounded chunks preserve new matching rows and only another explicit decision starts never-started captured items', async f => {
  for (let i = 0; i < 27; i++) f.chat('Original ' + i);
  const batch = f.prepare(), later = f.chat('New matching Trash');
  const original = f.command(batch); f.cleanup.permanent.decide(f.device, original, noAuthChange);
  let result = await f.settle(batch.id);
  assert.equal(result.counts.applied, 25); assert.equal(result.counts.pending, 2);
  assert.equal(result.chunks[0].itemIds.length, 25); assert.equal(result.chunks[0].stopReason, 'chunk_limit');
  assert.equal(result.remainder.newMatchingCount, 1);
  f.cleanup.permanent.decide(f.device, original, noAuthChange);
  assert.equal(f.cleanup.permanent.get(batch.id).counts.applied, 25);
  assert.throws(() => f.cleanup.permanent.decide(f.store.session().deviceId, original, noAuthChange), { code: 'request_reused' });
  const other = f.store.session().deviceId;
  f.cleanup.permanent.decide(other, f.command(result, 'continue_remaining'), noAuthChange);
  result = await f.settle(batch.id);
  assert.equal(result.counts.applied, 27); assert.equal(result.chunks.length, 2);
  assert.equal(result.remainder.matchingCount, 1); assert.ok(f.store.internalRead('assistant:conversation:' + later.id));
  for (const item of result.outcomes.filter(o => o.chunkId === result.chunks[1].id)) {
    assert.equal(f.store.internalRead<ConversationRemoval>('assistant:removal:' + item.removalId)!.deviceId, other);
  }
});

check('30-second admission window waits the original call and never labels later untouched items attempted', async f => {
  f.chat(); f.chat(); const batch = f.prepare(), remove = f.assistant.removals.remove.bind(f.assistant.removals);
  let release!: () => void, entered = 0; const hold = new Promise<void>(resolve => { release = resolve; });
  f.assistant.removals.remove = async (device, input) => { entered++; await hold; return remove(device, input); };
  f.cleanup.permanent.decide(f.device, f.command(batch), noAuthChange); await nextTurn();
  f.advance(30001);
  assert.equal(f.cleanup.permanent.get(batch.id).running, true);
  assert.equal(f.store.updateEffectsInFlight()['conversation-cleanup'], 1);
  release(); const result = await f.settle(batch.id);
  assert.equal(entered, 1); assert.equal(result.counts.applied, 1); assert.equal(result.counts.pending, 1);
  assert.equal(result.chunks[0].stopReason, 'admission_window'); assert.deepEqual(f.store.updateEffectsInFlight(), {});
});

check('revocation, recovery and maintenance stop new items after an await without retrying or abandoning the original', async f => {
  for (const reason of ['session_revoked', 'recovery_connections_paused', 'update_maintenance'] as const) {
    const chats = [f.chat(), f.chat()], batch = f.prepare({ targets: chats.map(c => ({ id: c.id, revision: 1 })) });
    const remove = f.assistant.removals.remove.bind(f.assistant.removals);
    let release!: () => void, revoked = false; const hold = new Promise<void>(resolve => { release = resolve; });
    f.assistant.removals.remove = async (device, input) => { const result = await remove(device, input); await hold; return result; };
    const authorize = () => { if (revoked) throw new Fault(401, 'session_revoked', 'Revoked fixture session'); };
    f.cleanup.permanent.decide(f.device, f.command(batch), authorize); await nextTurn();
    if (reason === 'session_revoked') revoked = true;
    else if (reason === 'update_maintenance') f.store.setUpdateMaintenanceHeld(true);
    else f.store.internalWrite('recovery:state', { held: true });
    release(); const result = await f.settle(batch.id);
    assert.equal(result.counts.applied, 1); assert.equal(result.counts.pending, 1); assert.equal(result.chunks[0].stopReason, reason);
    f.store.setUpdateMaintenanceHeld(false); f.store.internalDelete('recovery:state'); f.assistant.removals.remove = remove;
  }
});

check('parent close waits permanent and reversible original promises and refuses later new items', async f => {
  f.chat(); f.chat(); const batch = f.prepare(), remove = f.assistant.removals.remove.bind(f.assistant.removals);
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  f.assistant.removals.remove = async (device, input) => { await hold; return remove(device, input); };
  f.cleanup.permanent.decide(f.device, f.command(batch), noAuthChange); await nextTurn();
  let closed = false; const closing = f.cleanup.close().then(() => { closed = true; });
  await nextTurn(); assert.equal(closed, false); assert.equal(f.store.updateEffectsInFlight()['conversation-cleanup'], 1);
  release(); await closing; assert.equal(closed, true);
  const result = f.cleanup.permanent.get(batch.id);
  assert.equal(result.counts.applied, 1); assert.equal(result.counts.pending, 1); assert.equal(result.chunks[0].stopReason, 'service_closed');
  assert.throws(() => f.cleanup.permanent.decide(f.device, f.command(result, 'continue_remaining'), noAuthChange), { code: 'service_closed' });
});

check('exact changed incarnations, pending work and unconfigured native authority keep originals intact', async f => {
  const chats = Array.from({ length: 5 }, (_, i) => f.chat('Protected ' + i));
  const batch = f.prepare();
  f.store.internalWrite('assistant:conversation:' + chats[0].id, { ...chats[0], revision: 2 });
  f.store.internalWrite('assistant:conversation:' + chats[1].id, { ...chats[1], nativeKey: 'replacement' });
  f.store.internalWrite('assistant:conversation:' + chats[2].id, { ...chats[2], connectionGeneration: 'replacement' });
  f.store.internalWrite('assistant:operation:unknown', { conversationId: chats[3].id, state: 'unknown' });
  f.store.internalWrite('assistant:queue:paused', { id: randomUUID(), conversationId: chats[4].id, state: 'paused', createdAt: '2026-01-01' });
  f.cleanup.permanent.decide(f.device, f.command(batch), noAuthChange);
  const result = await f.settle(batch.id); assert.equal(result.counts.blocked, 5); assert.equal(result.counts.applied, 0);
  assert.equal(f.assistant.conversations().length, 5); assert.equal(f.assistant.removals.list().length, 0);
  const native = f.chat('Native-bound', { nativeId: randomUUID(), state: 'ready' });
  const review = f.prepare({ targets: [{ id: native.id, revision: 1 }] });
  f.cleanup.permanent.decide(f.device, f.command(review), noAuthChange);
  const refused = await f.settle(review.id); assert.equal(refused.outcomes[0].code, 'removal_connection');
  assert.deepEqual(f.store.internalRead('assistant:conversation:' + native.id), native); assert.deepEqual(f.calls, []);
});

check('lost result reconciles exact receipt without calling removal again, and absence alone is never applied', async f => {
  const chat = f.chat(), batch = f.prepare(), remove = f.assistant.removals.remove.bind(f.assistant.removals); let calls = 0;
  f.assistant.removals.remove = async (device, input) => { calls++; await remove(device, input); throw Error('Lost genuine completed response'); };
  f.cleanup.permanent.decide(f.device, f.command(batch), noAuthChange);
  const completed = await f.settle(batch.id); assert.equal(completed.counts.applied, 1); assert.equal(calls, 1);
  const tombstone = f.store.internalRead<any>('assistant:removed:' + chat.id);
  f.store.internalWrite('assistant:removed:' + chat.id, { ...tombstone, requestId: randomUUID() });
  const before = retained(f.store), uncertain = f.cleanup.permanent.get(batch.id);
  assert.equal(uncertain.counts.applied, 0); assert.equal(uncertain.counts.unconfirmed, 1); assert.equal(uncertain.remainder.verified, false);
  assert.deepEqual(retained(f.store), before); assert.equal(calls, 1);
});

check('actual adopted removal ID is kept; a foreign adopted owner is never reported applied', async f => {
  const original = f.assistant.removals.remove.bind(f.assistant.removals);
  for (const wrongOwner of [false, true]) {
    const chat = f.chat(), batch = f.prepare({ targets: [{ id: chat.id, revision: 1 }] }), actualId = randomUUID();
    // Deliberate synchronous fault injection at the primitive boundary. Normal
    // callers cannot interleave here: the batch performs no intervening await.
    f.assistant.removals.remove = async (device, raw) => {
      const command = raw as RemoveConversation;
      const prior: ConversationRemoval = { ...command, requestId: actualId, deviceId: wrongOwner ? f.store.session().deviceId : device,
        nativeId: chat.nativeId, nativeKey: chat.nativeKey, connectionGeneration: chat.connectionGeneration, state: 'prepared', updatedAt: new Date().toISOString() };
      f.store.internalWrite('assistant:removal:' + actualId, prior);
      f.store.internalWrite('assistant:removal-current:' + chat.id, actualId);
      return original(device, raw);
    };
    f.cleanup.permanent.decide(f.device, f.command(batch), noAuthChange);
    const result = await f.settle(batch.id);
    assert.equal(result.outcomes[0].removalId, actualId);
    assert.equal(result.counts.applied, wrongOwner ? 0 : 1);
    if (wrongOwner) { assert.equal(result.outcomes[0].code, 'removal_authority'); assert.equal(result.counts.unconfirmed, 1); }
  }
});

check('pre-existing original removal blocks capture and a later pending request blocks apply before invocation', async f => {
  const a = f.chat(), b = f.chat(), batch = f.prepare({ targets: [{ id: b.id, revision: 1 }] });
  for (const chat of [a, b]) {
    const requestId = randomUUID();
    f.store.internalWrite('assistant:removal:' + requestId, { requestId, epoch: f.store.epoch, conversationId: chat.id, expectedRevision: 1,
      deviceId: f.store.session().deviceId, nativeId: null, nativeKey: chat.nativeKey, connectionGeneration: chat.connectionGeneration, state: 'unknown', updatedAt: new Date().toISOString() });
    f.store.internalWrite('assistant:removal-current:' + chat.id, requestId);
  }
  assert.throws(() => f.prepare({ targets: [{ id: a.id, revision: 1 }] }), { code: 'conversation_removing' });
  let calls = 0; f.assistant.removals.remove = async () => { calls++; throw Error('Must not continue unknown original'); };
  f.cleanup.permanent.decide(f.device, f.command(batch), noAuthChange);
  const result = await f.settle(batch.id); assert.equal(result.outcomes[0].code, 'conversation_removing'); assert.equal(calls, 0);
});

check('restart observation preserves original interrupted ownership and only never-started items can enter a new chunk', async f => {
  f.chat(); f.chat(); const batch = f.prepare(), remove = f.assistant.removals.remove.bind(f.assistant.removals);
  f.assistant.removals.remove = async () => { f.advance(30001); throw Error('Unconfirmed original admission'); };
  f.cleanup.permanent.decide(f.device, f.command(batch), noAuthChange);
  const first = await f.settle(batch.id); assert.equal(first.counts.unconfirmed, 1); assert.equal(first.counts.pending, 1);
  const before = retained(f.store), reopened = new ConversationCleanup(f.store, f.assistant);
  try {
    assert.equal(reopened.permanent.get(batch.id).counts.unconfirmed, 1); assert.deepEqual(retained(f.store), before);
    f.assistant.removals.remove = remove;
    reopened.permanent.decide(f.device, f.command(first, 'continue_remaining'), noAuthChange);
    for (let i = 0; i < 100 && reopened.permanent.get(batch.id).running; i++) await nextTurn();
    const result = reopened.permanent.get(batch.id); assert.equal(result.counts.applied, 1); assert.equal(result.counts.unconfirmed, 1);
    assert.equal(result.chunks[1].itemIds[0], first.outcomes.find(o => o.state === 'pending')!.id);
  } finally { await reopened.close(); }
});

check('cancel, digest, epoch and different decision races cannot broaden or restart the captured effect', async f => {
  f.chat(); const batch = f.prepare();
  assert.throws(() => f.cleanup.permanent.decide(f.device, { ...f.command(batch), digest: 'f'.repeat(64) }, noAuthChange), { code: 'cleanup_changed' });
  assert.throws(() => f.cleanup.permanent.decide(f.device, { ...f.command(batch), epoch: randomUUID() }, noAuthChange), { code: 'epoch_changed' });
  f.cleanup.permanent.decide(f.device, f.command(batch, 'cancel'), noAuthChange);
  assert.throws(() => f.cleanup.permanent.decide(f.device, f.command(batch), noAuthChange), { code: 'cleanup_changed' });
  assert.equal(f.assistant.removals.list().length, 0);
  const another = f.prepare(); f.cleanup.permanent.decide(f.device, f.command(another), noAuthChange);
  assert.throws(() => f.cleanup.permanent.decide(f.device, f.command(another), noAuthChange), { code: 'cleanup_changed' });
  await f.settle(another.id);
});

test('phone permanent cleanup exposes only the three exact authenticated method/path pairs', () => {
  const base = '/api/assistant/conversation-cleanup/permanent';
  for (const [path, allowed] of [[base, 'GET'], [base + '/prepare', 'POST'], [base + '/decide', 'POST']]) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(phoneRouteAllowed(path, method), method === allowed);
    for (const suffix of ['/', '/retry', '-all', '?force=true']) assert.equal(phoneRouteAllowed(path + suffix, allowed), false);
  }
});
