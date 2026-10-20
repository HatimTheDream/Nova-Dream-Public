import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, Fault } from '../apps/service/store.js';
import { AssistantService } from '../apps/service/assistant.js';
import { ConversationCleanup } from '../apps/service/conversation-cleanup.js';
import { conversationItemRequestId } from '../apps/service/conversation-organization.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import type { Conversation } from '../packages/domain/assistant.js';
import type { ConversationCleanupBatch, ConversationCleanupScope } from '../packages/domain/conversation-cleanup.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-cleanup-')), store = new Store(directory), device = store.session().deviceId;
  const calls: string[] = [];
  const gateway: AssistantTransport = { status: () => ({ state: 'unconfigured', message: 'Isolated fixture', methods: [], grantedScopes: [], modelAuthReady: false }), subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}), async request<T>(method: string): Promise<T> { calls.push(method); throw Error('Unexpected provider call'); } };
  const assistant = new AssistantService(store, gateway), cleanup = new ConversationCleanup(store, assistant);
  t.after(async () => { await cleanup.close(); assistant.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const chat = (title: string, extra: Partial<Conversation> = {}) => {
    const id = randomUUID(), value: Conversation = { id, revision: 1, title, projectId: null, archived: false, model: null, thinking: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', nativeId: null, nativeKey: 'saved:' + id, connectionGeneration: 'fixture', state: 'ready', ...extra };
    return store.internalWrite('assistant:conversation:' + id, value);
  };
  const scope: ConversationCleanupScope = { space: 'chat', folder: 'active', query: '' };
  const prepare = (extra: Record<string, unknown> = {}) => cleanup.prepare(device, { requestId: randomUUID(), epoch: store.epoch, action: 'trash', scope, ...extra });
  const decision = (batch: ConversationCleanupBatch, kind: 'apply' | 'check' | 'cancel' = 'apply') => ({ requestId: randomUUID(), epoch: store.epoch, batchId: batch.id, expectedRevision: batch.revision, digest: batch.digest, decision: kind });
  return { store, assistant, cleanup, device, calls, chat, scope, prepare, decision };
}

test('frozen title scope uses complete conversation records, excludes drafts/projects and reports newly matching remainder', async t => {
  const f = fixture(t), a = f.chat('Keep One'), b = f.chat('Keep Two', { space: 'work' }); f.chat('Other');
  f.store.internalWrite('assistant:draft:keep', { title: 'Keep unsent draft', text: 'Writing' });
  f.store.internalWrite('project:deleted', { title: 'Keep project', deleted: true });
  const batch = f.prepare({ scope: { ...f.scope, space: 'all', query: 'keep' } });
  assert.deepEqual(new Set(batch.targets.map(c => c.id)), new Set([a.id, b.id]));
  assert.equal(JSON.stringify(batch).includes('nativeKey'), false);
  const later = f.chat('Keep Later'), done = await f.cleanup.decide(f.device, f.decision(batch));
  assert.equal(done.state, 'complete'); assert.equal(done.counts.applied, 2); assert.equal(done.remainder.verified, true);
  assert.equal(done.remainder.matchingCount, 1); assert.equal(done.remainder.newMatchingCount, 1);
  assert.equal(f.assistant.conversations().find(c => c.id === later.id)!.deleted, undefined);
  assert.deepEqual(f.store.internalRead('assistant:draft:keep'), { title: 'Keep unsent draft', text: 'Writing' });
  assert.deepEqual(f.calls, []);
});

test('changed revision and exact native incarnation block only those original items', async t => {
  const f = fixture(t), a = f.chat('Revision'), b = f.chat('Native'), c = f.chat('Unchanged'), batch = f.prepare();
  f.store.internalWrite('assistant:conversation:' + a.id, { ...a, revision: 2, title: 'Later title' });
  f.store.internalWrite('assistant:conversation:' + b.id, { ...b, nativeKey: 'different' });
  const result = await f.cleanup.decide(f.device, f.decision(batch));
  assert.equal(result.state, 'partial'); assert.equal(result.counts.blocked, 2); assert.equal(result.counts.applied, 1);
  assert.equal(f.assistant.conversations().find(x => x.id === c.id)!.deleted, true);
  assert.equal(f.assistant.conversations().find(x => x.id === a.id)!.title, 'Later title');
});

test('busy replies including unknown, pending decisions and queued writing are not hidden', async t => {
  const f = fixture(t), a = f.chat('Unconfirmed'), b = f.chat('Question'), c = f.chat('Queue'), batch = f.prepare();
  f.store.internalWrite('assistant:operation:' + randomUUID(), { conversationId: a.id, state: 'unknown' });
  f.store.internalWrite('assistant:question:' + randomUUID(), { conversationId: b.id, snapshot: { status: 'pending' } });
  f.store.internalWrite('assistant:queue:' + randomUUID(), { id: randomUUID(), conversationId: c.id, state: 'paused', createdAt: '2026-01-01' });
  const result = await f.cleanup.decide(f.device, f.decision(batch));
  assert.deepEqual(new Set(result.outcomes.map(o => o.code)), new Set(['pending_run', 'pending_decision', 'pending_queue']));
  assert.equal(f.assistant.conversations().some(c => c.deleted), false); assert.deepEqual(f.calls, []);
});

test('all pending-work guard families refuse without cancelling or rewriting their records', t => {
  const f = fixture(t), chat = f.chat('Protected');
  const cases: [string, unknown, string][] = [
    ['assistant:output:x', { conversationId: chat.id, state: 'saving' }, 'pending_output'],
    ['assistant:approval:x', { conversationId: chat.id, snapshot: { status: 'approved' }, action: { state: 'unknown' } }, 'pending_decision'],
    ['dictation:x', { draftId: 'draft:device:' + chat.id, state: 'ended', cleanupPending: true }, 'pending_voice'],
    ['voice:attempt:x', { target: { conversation: chat }, state: 'ended', entries: [{ saved: false }], consults: [] }, 'pending_voice'],
    ['assistant:plan:x', { id: 'fixture-plan', epoch: f.store.epoch, version: 1, versions: [], conversationId: chat.id, state: 'ready', autoStartAt: '2026-01-01' }, 'pending_plan'],
  ];
  for (const [key, value, code] of cases) {
    f.store.internalWrite(key, value); assert.throws(() => f.assistant.assertCleanupReady(chat), { code });
    assert.deepEqual(f.store.internalRead(key), value); f.store.internalDelete(key);
  }
  for (const extra of [{ state: 'unknown' as const }, { pendingResume: { requestId: randomUUID() } }, { nativeRestorePending: true }]) assert.throws(() => f.assistant.assertCleanupReady({ ...chat, ...extra }), { code: 'pending_conversation' });
});

test('lost edit response reconciles from the original receipt without executing again or adding targets', async t => {
  const f = fixture(t), chat = f.chat('Original'), batch = f.prepare(), original = f.assistant.edit.bind(f.assistant); let edits = 0;
  f.assistant.edit = async (device, input) => { edits++; await original(device, input); throw Error('Lost response'); };
  const decision = f.decision(batch), uncertain = await f.cleanup.decide(f.device, decision);
  assert.equal(uncertain.state, 'unconfirmed'); assert.equal(edits, 1);
  f.chat('New after uncertainty');
  const secondDevice = f.store.session().deviceId;
  const checked = await f.cleanup.decide(secondDevice, f.decision(uncertain, 'check'));
  assert.equal(checked.state, 'complete'); assert.equal(checked.counts.applied, 1); assert.equal(edits, 1);
  assert.equal(checked.remainder.newMatchingCount, 1);
  await f.cleanup.decide(f.device, decision); assert.equal(edits, 1, 'same original decision cannot replay');
  const saved = f.store.replayAdmission<Conversation>(f.device, { requestId: conversationItemRequestId(batch.id, chat.id), epoch: f.store.epoch }, { type: 'conversation.edit', requestId: conversationItemRequestId(batch.id, chat.id), epoch: f.store.epoch, conversationId: chat.id, expectedRevision: chat.revision, deleted: true });
  assert.equal(saved!.deleted, true);
});

test('reopened controller does not resume unstarted items and held recovery refuses new writes', async t => {
  const f = fixture(t); f.chat('Never started'); const batch = f.prepare(), key = 'assistant:cleanup:' + batch.id;
  f.store.internalWrite(key, { ...f.store.internalRead<Record<string, unknown>>(key), state: 'applying' });
  const reopened = new ConversationCleanup(f.store, f.assistant); t.after(() => reopened.close());
  assert.equal(reopened.get(batch.id).state, 'unconfirmed');
  const before = f.store.internalRead(key);
  f.store.internalWrite('recovery:state', { held: true });
  await assert.rejects(reopened.decide(f.device, f.decision(batch, 'check')), { code: 'recovery_connections_paused' });
  assert.deepEqual(f.store.internalRead(key), before);
  f.store.internalDelete('recovery:state');
  const checked = await reopened.decide(f.device, f.decision(batch, 'check'));
  assert.equal(checked.outcomes[0].code, 'not_applied'); assert.equal(f.assistant.conversations()[0].deleted, undefined);
});

test('original decision has single-flight ownership and service close does not start later items', async t => {
  const f = fixture(t); f.chat('One'); f.chat('Two'); const batch = f.prepare(), original = f.assistant.edit.bind(f.assistant);
  let release!: () => void, edits = 0; const gate = new Promise<void>(ok => { release = ok; });
  f.assistant.edit = async (device, input) => { edits++; await gate; return original(device, input); };
  const command = f.decision(batch), first = f.cleanup.decide(f.device, command), second = f.cleanup.decide(f.device, command);
  assert.equal(f.store.updateEffectsInFlight()['conversation-cleanup'], 1);
  const closing = f.cleanup.close(); release();
  const [one, two] = await Promise.all([first, second]); await closing;
  assert.deepEqual(two, one); assert.equal(edits, 1); assert.equal(one.counts.applied, 1); assert.equal(one.counts.blocked, 1);
  assert.deepEqual(f.store.updateEffectsInFlight(), {});
});

test('unsupported or changed saved inventory fails closed without erasing its record', t => {
  const f = fixture(t); f.chat('Kept'); const batch = f.prepare(), key = 'assistant:cleanup:' + batch.id;
  const invalid = { ...f.store.internalRead<Record<string, unknown>>(key), format: 99 }; f.store.internalWrite(key, invalid);
  assert.throws(() => f.cleanup.get(batch.id), { code: 'cleanup_record_invalid' });
  assert.throws(() => f.cleanup.list(), { code: 'cleanup_record_invalid' }); assert.deepEqual(f.store.internalRead(key), invalid);
});

test('capture is bounded, selected scope is exact, and prepare replay cannot change inventory', t => {
  const f = fixture(t), a = f.chat('Selected'), work = f.chat('Work', { space: 'work' });
  assert.throws(() => f.prepare({ targets: [{ id: work.id, revision: 1 }] }), { code: 'cleanup_scope_changed' });
  assert.throws(() => f.prepare({ targets: [{ id: a.id, revision: 1 }, { id: a.id, revision: 1 }] }));
  const command = { requestId: randomUUID(), epoch: f.store.epoch, action: 'archive', scope: f.scope };
  const batch = f.cleanup.prepare(f.device, command); f.chat('Later');
  assert.deepEqual(f.cleanup.prepare(f.device, command).targets, batch.targets);
  assert.throws(() => f.cleanup.prepare(f.device, { ...command, action: 'trash' }));
  for (let i = 0; i < 500; i++) f.chat('Bounded ' + i);
  assert.throws(() => f.prepare(), { code: 'cleanup_limit' });
  assert.equal(f.cleanup.list().total, 1);
});

test('restore reuses reversible visibility edit and preserves archives, saved messages and native identity', async t => {
  const f = fixture(t), a = f.chat('Deleted', { deleted: true, archived: true }), b = f.chat('Archived', { archived: true });
  f.store.internalWrite('assistant:history:' + a.id, { text: 'Original saved history' });
  const batch = f.prepare({ action: 'restore', scope: { ...f.scope, folder: 'deleted' } });
  const result = await f.cleanup.decide(f.device, f.decision(batch));
  assert.equal(result.counts.applied, 1); const current = f.assistant.conversations().find(c => c.id === a.id)!;
  assert.equal(current.archived, false); assert.equal(current.deleted, false); assert.equal(current.nativeKey, a.nativeKey);
  assert.equal(f.assistant.conversations().find(c => c.id === b.id)!.archived, true);
  assert.deepEqual(f.store.internalRead('assistant:history:' + a.id), { text: 'Original saved history' }); assert.deepEqual(f.calls, []);
});

test('a committed original edit receipt wins over a Fault during final readback', async t => {
  const f = fixture(t); f.chat('Committed'); const batch = f.prepare(), original = f.assistant.edit.bind(f.assistant);
  f.assistant.edit = async (device, input) => { await original(device, input); throw new Fault(409, 'conversation_removed', 'Readback raced'); };
  const result = await f.cleanup.decide(f.device, f.decision(batch));
  assert.equal(result.state, 'complete'); assert.equal(result.counts.applied, 1); assert.equal(result.counts.blocked, 0);
});

test('cancelling a still-unstarted original review fences a late apply without changing any conversation', async t => {
  const f = fixture(t); f.chat('Unstarted'); const batch = f.prepare(), delayed = f.decision(batch);
  const cancelled = await f.cleanup.decide(f.device, f.decision(batch, 'cancel'));
  assert.equal(cancelled.state, 'cancelled');
  await assert.rejects(f.cleanup.decide(f.device, delayed), { code: 'cleanup_changed' });
  assert.equal(f.assistant.conversations()[0].deleted, undefined); assert.deepEqual(f.calls, []);
});

test('a foreign session cannot replay a decision and maintenance or recovery pauses later items after an awaited edit', async t => {
  for (const held of ['maintenance', 'recovery'] as const) {
    const f = fixture(t); f.chat('First'); f.chat('Second'); const batch = f.prepare(), original = f.assistant.edit.bind(f.assistant);
    let release!: () => void; const gate = new Promise<void>(ok => { release = ok; }); let edits = 0;
    f.assistant.edit = async (device, input) => { edits++; const result = await original(device, input); await gate; return result; };
    const command = f.decision(batch), flight = f.cleanup.decide(f.device, command);
    await assert.rejects(f.cleanup.decide(f.store.session().deviceId, command), { code: 'request_reused' });
    if (held === 'maintenance') f.store.setUpdateMaintenanceHeld(true); else f.store.internalWrite('recovery:state', { held: true });
    release(); const result = await flight;
    assert.equal(edits, 1); assert.equal(result.counts.applied, 1); assert.equal(result.counts.blocked, 1);
    assert.ok(result.outcomes.some(o => o.code === (held === 'maintenance' ? 'update_maintenance' : 'recovery_connections_paused')));
  }
});
