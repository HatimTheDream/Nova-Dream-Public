import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Store } from '../apps/service/store.js';
import { AssistantService } from '../apps/service/assistant.js';
import { createConversationOperations } from '../apps/service/module-conversation-actions.js';
import { ModuleActions, type ModuleServices } from '../apps/service/module-actions.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import type { AssistantConnection, Conversation, ConversationHistory } from '../packages/domain/assistant.js';
import type { ModuleAction } from '../packages/domain/module-actions.js';

class NativeFixture implements AssistantTransport {
  generation = randomUUID();
  sessions = new Map<string, { sessionId: string; label: string; archived: boolean; pinned: boolean }>();
  calls: { method: string; input: any }[] = [];
  losePatch = false;
  loseDelete = false;
  status(): AssistantConnection { return { state: 'ready', generation: this.generation, message: 'Fixture', grantedScopes: ['operator.read', 'operator.write'], methods: ['sessions.delete', 'sessions.describe', 'sessions.search'], modelAuthReady: true }; }
  subscribe() { return () => {}; }
  async models() { return []; }
  attachmentPolicy() { return {}; }
  async request<T>(method: string, input: any): Promise<T> {
    this.calls.push({ method, input });
    if (method === 'sessions.create') {
      const session = { sessionId: randomUUID(), label: input.label, archived: false, pinned: false }; this.sessions.set(input.key, session);
      return { key: input.key, sessionId: session.sessionId, entry: { ...session, permissionMode: input.permissionMode } } as T;
    }
    const session = this.sessions.get(input.key ?? input.sessionKey);
    if (method === 'sessions.patch') {
      assert.ok(session); assert.equal(input.expectedSessionId, session.sessionId);
      if (input.label !== undefined) session.label = input.label;
      if (input.pinned !== undefined) session.pinned = input.pinned;
      if (input.archived !== undefined) session.archived = input.archived;
      if (this.losePatch) { this.losePatch = false; throw new Error('Lost acknowledgement'); }
      return { entry: { ...session } } as T;
    }
    if (method === 'chat.history') return { sessionId: session?.sessionId, messages: [], hasMore: false, sessionInfo: { ...session, title: session?.label, activeRunIds: [], hasActiveRun: false } } as T;
    if (method === 'sessions.describe') return { session: session ? { key: input.key, ...session, activeRunIds: [], hasActiveRun: false } : null } as T;
    if (method === 'sessions.delete') { assert.equal(input.expectedSessionId, session?.sessionId); this.sessions.delete(input.key); if (this.loseDelete) { this.loseDelete = false; throw new Error('Lost deletion acknowledgement'); } return { ok: true, key: input.key, deleted: true } as T; }
    if (method === 'sessions.search') return { results: [], indexing: false } as T;
    throw new Error(`Unexpected fixture method ${method}`);
  }
}
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-conversation-actions-')), store = new Store(directory), device = store.session().deviceId;
  const gateway = new NativeFixture(), assistant = new AssistantService(store, gateway);
  t.after(() => { assistant.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const operations = createConversationOperations({ store, assistant });
  const chat = (title: string, space: 'chat' | 'work' = 'chat') => assistant.create(device, { requestId: randomUUID(), epoch: store.epoch, title, projectId: null, space });
  const origin = await chat('Original request');
  const owner = { conversationId: origin.id, operationId: randomUUID(), deviceId: device };
  const prepare = (name: string, raw: unknown): ModuleAction => {
    const op = operations[name], parsed = op.schema.parse(raw) as Record<string, any>, input = op.capture ? op.capture(parsed, owner) : parsed;
    return { id: randomUUID(), epoch: store.epoch, conversationId: origin.id, operationId: owner.operationId, deviceId: device, operation: name, input, inputHash: 'fixture', title: op.title, revision: 1, createdAt: '', updatedAt: '', state: 'pending', external: false, preview: op.preview?.(input) ?? input };
  };
  const run = (a: ModuleAction) => operations[a.operation].run!(a) as Promise<any>;
  const check = (a: ModuleAction) => operations[a.operation].check!(a, randomUUID()) as Promise<any>;
  const read = (name: string, raw: unknown) => operations[name].read!(device, operations[name].schema.parse(raw), owner) as any;
  const save = (value: Conversation) => store.internalWrite(`assistant:conversation:${value.id}`, value);
  return { directory, store, device, gateway, assistant, operations, origin, owner, chat, prepare, run, check, read, save };
}

test('catalog schemas are discoverable, conversation tools are owner-only, and settings never grant access', async t => {
  const f = await fixture(t);
  for (const op of Object.values(f.operations)) { assert.equal(op.ownerOnly, true); assert.equal(z.toJSONSchema(op.schema).type, 'object'); }
  for (const name of ['conversations.bulk', 'conversations.remove', 'conversations.organize', 'conversations.edit']) assert.equal(f.operations[name].review, true);
  assert.throws(() => f.prepare('conversations.create', { title: 'No escalation', permissionMode: 'full' }));
  assert.throws(() => f.prepare('conversations.edit', { conversationId: f.origin.id, expectedRevision: f.origin.revision, permissionMode: 'full' }));
  assert.throws(() => f.prepare('conversations.edit', { conversationId: f.origin.id, expectedRevision: f.origin.revision }));
});

test('list separates Chat, Work and Deleted, paginates metadata, and never includes unsent drafts or native keys', async t => {
  const f = await fixture(t), chat = await f.chat('Second'), work = await f.chat('Work record', 'work');
  f.save({ ...chat, deleted: true, archived: true });
  f.store.internalWrite('assistant:unrelated-secret', { text: 'unrelated' });
  const active = await f.read('conversations.list', {});
  assert.deepEqual(active.conversations.map((item: any) => item.id), [f.origin.id]);
  assert.equal((await f.read('conversations.list', { space: 'work' })).conversations[0].id, work.id);
  assert.equal((await f.read('conversations.list', { folder: 'deleted' })).conversations[0].id, chat.id);
  const page = await f.read('conversations.list', { space: 'all', folder: 'all', limit: 1 });
  assert.equal(page.total, 3); assert.equal(page.nextOffset, 1);
  assert.equal(JSON.stringify(page).includes('nativeKey'), false); assert.equal(JSON.stringify(page).includes('unrelated'), false);
});

test('search uses the canonical bounded service and defaults to Chat without broadening to Work', async t => {
  const f = await fixture(t), work = await f.chat('Work search', 'work');
  const result = await f.read('conversations.search', { query: 'saved text' });
  assert.deepEqual(result.results, []);
  const search = f.gateway.calls.find(call => call.method === 'sessions.search')!;
  assert.deepEqual(search.input.sessionKeys, [f.origin.nativeKey]); assert.equal(search.input.sessionKeys.includes(work.nativeKey), false);
});

test('message reads preserve history pagination and provide exact Unicode text continuations without draft exposure', async t => {
  const f = await fixture(t), text = '😀'.repeat(2505), messageId = 'saved-message', hash = 'a'.repeat(64);
  const seen: any[] = [];
  f.assistant.browse = async input => { seen.push(input); return { conversationId: f.origin.id, nativeId: f.origin.nativeId!, offset: 0, nextOffset: 100, hasMore: true, activeRunIds: [], messages: [{ id: messageId, role: 'user', text, textHash: hash, attachments: [], source: { nativeKey: 'private-native-key', nativeId: f.origin.nativeId!, bindingId: 'b', connectionGeneration: 'c', kind: 'native', observedAt: '' } }] } as ConversationHistory; };
  const first = await f.read('conversations.read', { conversationId: f.origin.id, nativeId: f.origin.nativeId });
  assert.equal(first.nextOffset, 100); assert.equal([...first.messages[0].text].length, 2000); assert.equal(first.messages[0].nextTextOffset, 2000);
  assert.equal(JSON.stringify(first).includes('private-native-key'), false);
  const second = await f.read('conversations.read', { conversationId: f.origin.id, nativeId: f.origin.nativeId, messageId, messageHash: hash, textOffset: 2000 });
  assert.equal([...second.messages[0].text].length, 505); assert.equal(second.messages[0].nextTextOffset, null);
  assert.equal(seen[1].epoch, f.store.epoch); assert.equal(seen[1].textOffset, undefined);
  assert.throws(() => f.operations['conversations.read'].schema.parse({ conversationId: f.origin.id, nativeId: f.origin.nativeId, textOffset: 100 }));
});

test('bulk review freezes exact scope, excludes new chats, refuses changed revisions and orders the originating chat last', async t => {
  const f = await fixture(t), changed = await f.chat('Changed after review'), work = await f.chat('Unselected Work', 'work');
  const a = f.prepare('conversations.bulk', { action: 'trash' });
  assert.equal((a.input.targets as { id: string }[]).at(-1)!.id, f.origin.id);
  const later = await f.chat('Created after review'); f.save({ ...changed, revision: changed.revision + 1, title: 'Newer title' });
  const result = await f.run(a);
  assert.equal(result.state, 'partial'); assert.deepEqual(result.counts, { applied: 1, blocked: 1, unknown: 0 });
  assert.equal(f.assistant.conversations().find(c => c.id === f.origin.id)?.deleted, true);
  for (const c of [changed, work, later]) assert.equal(!!f.assistant.conversations().find(row => row.id === c.id)?.deleted, false);
  assert.equal((a.input.targets as { id: string }[]).some(item => item.id === later.id), false);
});

test('a current active reply stays visible and is reported blocked while other captured chats move', async t => {
  const f = await fixture(t), other = await f.chat('Other chat');
  f.store.internalWrite('assistant:operation:active', { id: f.owner.operationId, conversationId: f.origin.id, state: 'running' });
  const a = f.prepare('conversations.bulk', { action: 'trash' }), result = await f.run(a);
  assert.equal(result.state, 'partial'); assert.equal(result.outcomes.at(-1).id, f.origin.id); assert.equal(result.outcomes.at(-1).code, 'run_unsettled');
  assert.equal(!!f.assistant.conversations().find(c => c.id === f.origin.id)?.deleted, false);
  assert.equal(f.assistant.conversations().find(c => c.id === other.id)?.deleted, true);
  // Checking a blocked original does not turn a later idle state into new effects.
  f.store.internalWrite('assistant:operation:active', { id: f.owner.operationId, conversationId: f.origin.id, state: 'completed' });
  const checked = await f.check(a); assert.equal(checked.outcomes.at(-1).code, 'not_applied');
  assert.equal(!!f.assistant.conversations().find(c => c.id === f.origin.id)?.deleted, false);
});

test('apply after the original reply settles includes its chat and preserves unsent writing and unknown requests', async t => {
  const f = await fixture(t), draftId = `draft:${f.device}:${f.origin.id}`;
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId: draftId, expectedRevision: 0, payload: { conversationId: f.origin.id, projectId: null, title: 'Saved writing', text: 'Keep these words', attachments: [] } });
  f.store.internalWrite('assistant:operation:unknown', { id: 'unknown', conversationId: f.origin.id, state: 'unknown', input: 'Original uncertain input' });
  const a = f.prepare('conversations.bulk', { action: 'trash' });
  assert.equal((await f.run(a)).state, 'applied');
  assert.equal(f.store.readEntity('draft', draftId)?.value.text, 'Keep these words');
  assert.equal((f.store.internalRead('assistant:operation:unknown') as any).state, 'unknown');
  assert.equal((await f.check(a)).state, 'applied');
  const restore = f.prepare('conversations.organize', { conversationId: f.origin.id, expectedRevision: f.assistant.conversations()[0].revision, action: 'restore' });
  assert.equal((await f.run(restore)).state, 'applied'); assert.equal(f.assistant.conversations()[0].deleted, false);
});

test('lost local acknowledgement reconciles the original receipt without applying again or accepting new targets', async t => {
  const f = await fixture(t), a = f.prepare('conversations.bulk', { action: 'archive' }), edit = f.assistant.edit.bind(f.assistant);
  let calls = 0;
  f.assistant.edit = async (device, input) => { calls++; await edit(device, input); throw new Error('Response lost after saved effect'); };
  assert.equal((await f.run(a)).state, 'unknown');
  const changed = f.assistant.conversations()[0]; f.save({ ...changed, revision: changed.revision + 1, title: 'Later independent change' });
  const result = await f.check(a); assert.equal(result.state, 'applied'); assert.equal(calls, 1);
  assert.equal(f.assistant.conversations()[0].title, 'Later independent change');
  const unstarted = f.prepare('conversations.bulk', { action: 'restore', folder: 'archived' });
  assert.equal((await f.check(unstarted)).outcomes[0].code, 'not_applied'); assert.equal(calls, 1);
});

test('exact target selection rejects foreign scope, duplicates, caller-supplied native identity and changed incarnations', async t => {
  const f = await fixture(t), work = await f.chat('Work', 'work');
  assert.throws(() => f.prepare('conversations.bulk', { action: 'trash', targets: [{ id: work.id, revision: work.revision }] }), { code: 'conversation_scope' });
  const item = { id: f.origin.id, revision: f.origin.revision };
  assert.throws(() => f.prepare('conversations.bulk', { action: 'trash', targets: [item, item] }));
  assert.throws(() => f.prepare('conversations.bulk', { action: 'trash', targets: [{ ...item, nativeId: randomUUID() }] }));
  const a = f.prepare('conversations.organize', { action: 'archive', conversationId: item.id, expectedRevision: item.revision });
  f.save({ ...f.origin, nativeId: randomUUID() });
  assert.equal((await f.run(a)).outcomes[0].code, 'conversation_changed');
});

test('conversation creation is idempotent and uses read-only access without submitting a message', async t => {
  const f = await fixture(t), a = f.prepare('conversations.create', { title: 'Created by Assistant' });
  const before = f.gateway.calls.filter(call => call.method === 'sessions.create').length;
  const first = await f.run(a), second = await f.run(a);
  assert.equal(first.state, 'applied'); assert.equal(second.conversation.id, first.conversation.id);
  assert.equal(f.gateway.calls.filter(call => call.method === 'sessions.create').length - before, 1);
  assert.equal(f.gateway.calls.at(-1)?.input.permissionMode, 'read-only'); assert.equal(f.gateway.calls.some(call => call.method === 'chat.send'), false);
  assert.equal((await f.check(a)).state, 'applied');
});

test('settings use exact canonical revisions and lost native responses are observed without a second patch', async t => {
  const f = await fixture(t), chat = await f.chat('Old title'), a = f.prepare('conversations.edit', { conversationId: chat.id, expectedRevision: chat.revision, title: 'New title', pinned: true });
  f.gateway.losePatch = true;
  assert.equal((await f.run(a)).state, 'unknown');
  const firstPatches = f.gateway.calls.filter(call => call.method === 'sessions.patch').length;
  const checked = await f.check(a);
  assert.equal(checked.state, 'applied'); assert.equal(checked.conversation.title, 'New title'); assert.equal(checked.conversation.pinned, true);
  assert.equal(f.gateway.calls.filter(call => call.method === 'sessions.patch').length, firstPatches);
});

test('permanent removal requires a different already-deleted target and reconciles a lost native delete exactly once', async t => {
  const f = await fixture(t), other = await f.chat('Disposable conversation');
  assert.throws(() => f.prepare('conversations.remove', { conversationId: f.origin.id, expectedRevision: f.origin.revision }), { code: 'conversation_origin' });
  assert.throws(() => f.prepare('conversations.remove', { conversationId: other.id, expectedRevision: other.revision }), { code: 'conversation_not_deleted' });
  const deleted = await f.assistant.edit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: other.id, expectedRevision: other.revision, deleted: true });
  const a = f.prepare('conversations.remove', { conversationId: other.id, expectedRevision: deleted.revision });
  f.gateway.loseDelete = true;
  assert.equal((await f.run(a)).state, 'unknown'); assert.equal((await f.check(a)).state, 'applied');
  assert.equal(f.gateway.calls.filter(call => call.method === 'sessions.delete').length, 1);
  assert.equal(f.assistant.conversations().some(chat => chat.id === other.id), false);
  assert.equal(f.assistant.conversations().some(chat => chat.id === f.origin.id), true);
});

for (const [operation, action] of [['conversations.bulk', 'archive'], ['conversations.organize', 'trash']] as const) {
  test(`registry reconciles a lost ${operation} result after ${action} hides its origin, including restart`, async t => {
    const f = await fixture(t);
    f.save({ ...f.origin, permissionMode: 'workspace' });
    const original = { id: f.owner.operationId, epoch: f.store.epoch, conversationId: f.origin.id, nativeId: f.origin.nativeId, nativeKey: f.origin.nativeKey,
      connectionGeneration: f.gateway.generation, deviceId: f.device, state: 'running', context: { workMode: 'build', attachments: [], project: null } };
    f.store.internalWrite(`assistant:operation:${original.id}`, original);
    const deps = { store: f.store, assistant: f.assistant, gateway: f.gateway } as unknown as ModuleServices;
    let registry = new ModuleActions(deps);
    const input = { operation, input: operation === 'conversations.bulk' ? { action } : { action, conversationId: f.origin.id, expectedRevision: f.origin.revision },
      epoch: f.store.epoch, nativeId: f.origin.nativeId, nativeKey: f.origin.nativeKey, toolCallId: randomUUID(), permissionMode: 'workspace', write: true };
    try {
      const pending = await registry.invoke(input) as ModuleAction;
      assert.equal(pending.state, 'pending');
      f.store.internalWrite(`assistant:operation:${original.id}`, { ...original, state: 'completed' });
      const write = f.store.internalWrite.bind(f.store), edit = f.assistant.edit.bind(f.assistant);
      let lost = false, edits = 0;
      f.assistant.edit = async (device, value) => { edits++; return edit(device, value); };
      f.store.internalWrite = (key, value) => {
        if (!lost && key === `modules:action:${pending.id}` && (value as ModuleAction).state === 'applied') { lost = true; throw Error('Aggregate acknowledgement lost after the chat changed'); }
        return write(key, value);
      };
      const uncertain = await registry.decide(f.device, { requestId: randomUUID(), epoch: f.store.epoch, actionId: pending.id, expectedRevision: pending.revision, decision: 'apply' });
      assert.equal(lost, true); assert.equal(uncertain.state, 'unknown'); assert.equal(uncertain.phase, 'apply');
      const moved = f.assistant.conversations().find(chat => chat.id === f.origin.id)!;
      assert.equal(moved.archived, true); assert.equal(!!moved.deleted, action === 'trash'); assert.equal(edits, 1);
      await registry.close(); registry = new ModuleActions(deps);
      const kept = registry.list(f.origin.id).find(saved => saved.id === pending.id)!;
      assert.equal(kept.state, 'unknown');
      const checked = await registry.decide(f.device, { requestId: randomUUID(), epoch: f.store.epoch, actionId: kept.id, expectedRevision: kept.revision, decision: 'check' });
      assert.equal(checked.state, 'applied'); assert.equal(edits, 1, 'Check reads the original receipt without calling edit again');
      assert.equal(f.assistant.conversations().find(chat => chat.id === f.origin.id)?.revision, moved.revision);
      await assert.rejects(registry.invoke({ ...input, toolCallId: randomUUID() }), /active Nova Dream conversation/);
      await assert.rejects(registry.decide(f.device, { requestId: randomUUID(), epoch: f.store.epoch, actionId: kept.id, expectedRevision: checked.revision, decision: 'apply' }), /Restore the original chat/);
    } finally { await registry.close(); }
  });
}
