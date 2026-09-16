import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GatewayClientRequestError } from '@openclaw/gateway-client';
import type { AssistantConnection, Conversation } from '../packages/domain/assistant.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { Store } from '../apps/service/store.js';
import { ConversationRemovals } from '../apps/service/conversation-removal.js';
import { AssistantService } from '../apps/service/assistant.js';

class NativeFixture implements AssistantTransport {
  generation: string = randomUUID(); native = new Map<string, string>(); deletes: unknown[] = []; lose = false; hold?: Promise<void>;
  status(): AssistantConnection { return { state: 'ready', generation: this.generation, methods: ['sessions.delete', 'sessions.describe'], grantedScopes: ['operator.read', 'operator.write'], message: '', modelAuthReady: true }; }
  async request<T>(method: string, raw: unknown): Promise<T> {
    const p = raw as { key: string; expectedSessionId?: string; archivedOnly?: boolean; deleteTranscript?: boolean };
    if (method === 'sessions.describe') { await this.hold; return (this.native.has(p.key) ? { session: { key: p.key, sessionId: this.native.get(p.key) } } : { session: null }) as T; }
    if (method === 'sessions.delete') {
      assert.equal(p.archivedOnly, true); assert.equal(p.deleteTranscript, true); this.deletes.push(p);
      if (this.native.get(p.key) !== p.expectedSessionId) throw new GatewayClientRequestError({ code: 'INVALID_REQUEST', message: 'Exact session changed' });
      this.native.delete(p.key); if (this.lose) { this.lose = false; throw new Error('Response lost after native deletion'); }
      return { ok: true, key: p.key, deleted: true, archived: [] } as T;
    }
    throw new Error(`Unexpected ${method}`);
  }
  subscribe() { return () => {}; } async models() { return []; } attachmentPolicy() { return {}; }
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'e3-removal-')), store = new Store(dir), gateway = new NativeFixture(), device = store.session().deviceId;
  const id = randomUUID(), nativeId = randomUUID(), chat: Conversation = { id, revision: 2, title: 'Disposable deleted conversation', projectId: null, archived: true, deleted: true, model: null, thinking: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), connectionGeneration: gateway.generation, nativeKey: `agent:main:e3:${id}`, nativeId, state: 'ready' };
  store.internalWrite(`assistant:conversation:${id}`, chat); gateway.native.set(chat.nativeKey, nativeId);
  const input = { requestId: randomUUID(), epoch: store.epoch, conversationId: id, expectedRevision: 2 };
  return { dir, store, gateway, device, chat, input };
}

test('lost native removal acknowledgement recovers after restart without deleting twice; current chat data goes and separately saved records remain', async () => {
  const f = setup(); let store = f.store, removals = new ConversationRemovals(store, f.gateway, () => false);
  try {
    const id = f.chat.id, draftId = `draft:${f.device}:${id}`;
    const file = store.upload(f.device, randomUUID(), store.epoch, 'shared.txt', Buffer.from('Keep this separately saved file').toString('base64'));
    store.mutate(f.device, { requestId: randomUUID(), epoch: store.epoch, kind: 'draft', entityId: draftId, expectedRevision: 0, payload: { conversationId: id, projectId: null, title: 'Kept draft', text: 'Remove only this writing', attachments: [file] } });
    for (const prefix of ['assistant:operation:', 'assistant:queue:', 'assistant:message-pin:', 'assistant:approval:', 'assistant:question:', 'assistant:edit:']) store.internalWrite(prefix + 'owned', { id: 'owned', conversationId: id, state: 'completed', snapshot: { status: 'answered' } });
    store.internalWrite(`assistant:history:${id}`, { conversationId: id, messages: ['original'] });
    store.internalWrite('assistant:memory', { revision: 1, entries: [{ text: 'A separately saved fact', source: { conversationId: id } }] });
    store.internalWrite('assistant:output:saved', { id: 'saved', state: 'ready', conversationId: id, text: 'A separately saved output' });
    store.internalWrite('assistant:operation:other', { id: 'other', conversationId: randomUUID(), state: 'completed', input: 'Preserve other chat' });
    f.gateway.lose = true;
    assert.equal((await removals.remove(f.device, f.input)).state, 'unknown'); assert.ok(store.readEntity('draft', draftId));
    assert.throws(() => removals.assertAvailable(id), { code: 'conversation_removing' });
    assert.throws(() => store.mutate(f.device, { requestId: randomUUID(), epoch: store.epoch, kind: 'draft', entityId: draftId, expectedRevision: 1, payload: { conversationId: id, projectId: null, title: 'Concurrent writing', text: 'Keep in its window', attachments: [] } }), { code: 'conversation_removing' });
    removals.close(); store.close(); store = new Store(f.dir); removals = new ConversationRemovals(store, f.gateway, () => false);
    const result = await removals.remove(f.device, f.input); assert.equal(result.state, 'completed'); assert.equal(f.gateway.deletes.length, 1);
    assert.equal(store.readEntity('draft', draftId), undefined); assert.equal(store.readEntityVersion('draft', draftId, 1), undefined); assert.equal(store.internalRead(`assistant:conversation:${id}`), undefined); assert.equal(store.internalRead(`assistant:history:${id}`), undefined);
    assert.equal(store.internalRead('assistant:operation:owned'), undefined); assert.ok(store.internalRead('assistant:operation:other')); assert.ok(store.internalRead('assistant:memory')); assert.ok(store.internalRead('assistant:output:saved')); assert.equal(store.blobMetadata(file.id).sha256, file.sha256);
    assert.throws(() => removals.assertAvailable(id), { code: 'conversation_removed' });
    assert.equal(JSON.stringify(await removals.remove(f.device, f.input)), JSON.stringify(result)); assert.equal(f.gateway.deletes.length, 1);
    await assert.rejects(removals.remove(store.session().deviceId, f.input), { code: 'request_reused' });
    const assistant = new AssistantService(store, f.gateway);
    try { await assert.rejects(assistant.history(id), { code: 'conversation_removed' }); await assert.rejects(assistant.edit(f.device, { ...f.input, deleted: false }), { code: 'conversation_removed' }); }
    finally { assistant.close(); }
  } finally { removals.close(); store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('removal refuses changed, active and unreconciled chats, and never deletes a replacement native session', async () => {
  const f = setup(); let busy = true; const removals = new ConversationRemovals(f.store, f.gateway, () => busy);
  try {
    await assert.rejects(removals.remove(f.device, f.input), { code: 'removal_busy' }); busy = false;
    await assert.rejects(removals.remove(f.device, { ...f.input, expectedRevision: 1 }), { code: 'removal_changed' });
    f.store.internalWrite(`assistant:conversation:${f.chat.id}`, { ...f.chat, deleted: false });
    await assert.rejects(removals.remove(f.device, f.input), { code: 'removal_changed' });
    f.store.internalWrite(`assistant:conversation:${f.chat.id}`, { ...f.chat, nativeId: null, state: 'unknown' });
    await assert.rejects(removals.remove(f.device, f.input), { code: 'removal_changed' });
    f.store.internalWrite(`assistant:conversation:${f.chat.id}`, f.chat);
    f.store.internalWrite('dictation:pending', { id: 'pending', draftId: `draft:${f.device}:${f.chat.id}`, state: 'ended', cleanupPending: true });
    await assert.rejects(removals.remove(f.device, f.input), { code: 'removal_busy' }); f.store.internalDelete('dictation:pending');
    f.store.internalWrite('voice:attempt:pending', { id: 'pending', target: { conversation: f.chat }, state: 'ended', entries: [{ saved: false }], consults: [] });
    await assert.rejects(removals.remove(f.device, f.input), { code: 'removal_busy' }); f.store.internalDelete('voice:attempt:pending');
    const replacement = randomUUID(); f.gateway.native.set(f.chat.nativeKey, replacement);
    assert.equal((await removals.remove(f.device, f.input)).state, 'rejected'); assert.equal(f.gateway.native.get(f.chat.nativeKey), replacement); assert.ok(f.store.internalRead(`assistant:conversation:${f.chat.id}`)); removals.assertAvailable(f.chat.id);
  } finally { removals.close(); f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('concurrent removal retries join one request and host replacement fences dispatch', async () => {
  const f = setup(), removals = new ConversationRemovals(f.store, f.gateway, () => false); let release!: () => void;
  try {
    f.gateway.hold = new Promise<void>(resolve => { release = resolve; });
    const first = removals.remove(f.device, f.input), second = removals.remove(f.device, f.input);
    f.gateway.generation = randomUUID(); release();
    assert.equal((await first).state, 'unknown'); assert.equal((await second).state, 'unknown'); assert.equal(f.gateway.deletes.length, 0);
    f.gateway.generation = f.chat.connectionGeneration; f.gateway.hold = undefined;
    const fromOtherDevice = await removals.remove(f.store.session().deviceId, { ...f.input, requestId: randomUUID() }); assert.equal(fromOtherDevice.state, 'completed'); assert.equal(fromOtherDevice.requestId, f.input.requestId); assert.equal(f.gateway.deletes.length, 1);
  } finally { removals.close(); f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});
