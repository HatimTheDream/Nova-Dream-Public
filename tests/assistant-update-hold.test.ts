import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EventFrame } from '@openclaw/gateway-protocol/frame-guards';
import type { AssistantConnection, AssistantOperation, Conversation } from '../packages/domain/assistant.js';
import type { AssistantPlan } from '../packages/domain/assistant-plan.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { AssistantService } from '../apps/service/assistant.js';
import { Store } from '../apps/service/store.js';

class Transport implements AssistantTransport {
  generation = randomUUID(); ready = true; calls: string[] = []; waitForHistory?: Promise<void>;
  sessions = new Map<string, string>(); receipts = new Map<string, unknown>();
  listeners = new Set<(event: EventFrame) => void>();
  status(): AssistantConnection { return { state: this.ready ? 'ready' : 'disconnected', generation: this.generation, message: 'Fixture', grantedScopes: ['operator.read', 'operator.write'], methods: ['agent.wait'], modelAuthReady: true }; }
  attachmentPolicy() { return { maxBytes: 10000, maxPayload: 100000 }; }
  models() { return Promise.resolve([]); }
  subscribe(fn: (event: EventFrame) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  emit(event: string, payload: unknown = {}) { for (const listener of this.listeners) listener({ type: 'event', event, payload }); }
  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push(method);
    if (method === 'chat.history') {
      await this.waitForHistory;
      return { sessionId: this.sessions.get(params.sessionKey), messages: [{ id: 'retained-message', role: 'assistant', content: 'Exact saved answer — café' }], hasMore: false, sessionInfo: { activeRunIds: [], hasActiveRun: false } } as T;
    }
    if (method === 'agent.wait') return (this.receipts.get(params.runId) ?? { status: 'timeout' }) as T;
    throw new Error(`Unexpected mutation or request: ${method}`);
  }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const directory = mkdtempSync(join(tmpdir(), 'nova-assistant-update-hold-'));
  const store = new Store(directory), gateway = new Transport(), at = '2026-01-01T00:00:00.000Z';
  const services: AssistantService[] = [];
  const start = () => { const service = new AssistantService(store, gateway); services.push(service); return service; };
  const rows = () => {
    const db = new DatabaseSync(join(directory, 'workspace.sqlite'), { readOnly: true });
    try { return db.prepare("SELECT id,revision,payload FROM service_records WHERE id LIKE 'assistant:%' ORDER BY id").all(); } finally { db.close(); }
  };
  t.after(() => { for (const service of services) service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const conversation: Conversation = { id: randomUUID(), nativeId: randomUUID(), nativeKey: 'agent:main:held-fixture', revision: 1, connectionGeneration: gateway.generation, state: 'ready', title: 'Saved conversation', projectId: null, archived: false, model: null, thinking: null, createdAt: at, updatedAt: at };
  store.internalWrite(`assistant:conversation:${conversation.id}`, conversation);
  gateway.sessions.set(conversation.nativeKey, conversation.nativeId!);
  const context = { project: null, attachments: [], draftId: 'draft', draftRevision: 1, digest: 'a'.repeat(64) };
  const unknown: AssistantOperation = { id: randomUUID(), requestId: randomUUID(), deviceId: 'fixture', epoch: store.epoch, conversationId: conversation.id, conversationRevision: 1, connectionGeneration: gateway.generation, nativeKey: conversation.nativeKey, nativeId: conversation.nativeId!, nativeRunId: randomUUID(), state: 'unknown', input: 'Keep the original request.', context, model: null, thinking: null, createdAt: at, updatedAt: at, text: 'Original partial answer', lastSequence: 0, error: 'Original outcome remains unconfirmed.' };
  store.internalWrite(`assistant:operation:${unknown.id}`, unknown);
  const original = start(); await original.history(conversation.id); original.close(); gateway.calls.length = 0;
  return { store, gateway, start, rows, conversation, unknown, context, at };
}

test('held startup, reconnects and timers preserve encrypted history, transcript, operation and plan rows; release reconciles without replay', async t => {
  const f = await fixture(t);
  const interrupted = { ...f.unknown, id: randomUUID(), requestId: randomUUID(), nativeRunId: randomUUID(), state: 'running' as const };
  f.store.internalWrite(`assistant:operation:${interrupted.id}`, interrupted);
  const legacyUnknown = { ...f.unknown, id: randomUUID(), requestId: randomUUID(), nativeRunId: null, error: undefined };
  f.store.internalWrite(`assistant:operation:${legacyUnknown.id}`, legacyUnknown);
  const creating = { ...f.conversation, id: randomUUID(), nativeKey: 'agent:main:interrupted-create', nativeId: null, state: 'creating' as const };
  f.store.internalWrite(`assistant:conversation:${creating.id}`, creating);
  const plan: AssistantPlan = { id: randomUUID(), kind: 'research', epoch: f.store.epoch, conversationId: f.conversation.id, revision: 1, version: 1, state: 'ready', versions: [{ version: 1, operationId: interrupted.id, createdAt: f.at }], permissionMode: 'read-only', sourceContext: f.context, createdAt: f.at, updatedAt: f.at, autoStartAt: f.at, autoStartRequestId: randomUUID() };
  f.store.internalWrite(`assistant:plan:${plan.id}`, plan);
  f.store.setUpdateMaintenanceHeld(true); const before = f.rows(), service = f.start();
  f.gateway.emit('e3.connected'); f.gateway.emit('e3.history-gap');
  f.gateway.emit('session.message', { sessionKey: f.conversation.nativeKey, sessionId: f.conversation.nativeId });
  f.gateway.emit('sessions.changed', { reason: 'chat.title', sessionKey: f.conversation.nativeKey });
  await service.captureSavedHistories(); t.mock.timers.tick(1500); await flush();
  f.gateway.ready = false; f.gateway.emit('e3.disconnected'); service.plans.pauseAutomatic(); t.mock.timers.tick(750); await flush();
  assert.deepEqual(f.rows(), before, 'all ciphertext, storage revisions and saved values stay exact while held');
  assert.equal(f.gateway.calls.length, 0);
  f.gateway.ready = true; f.store.setUpdateMaintenanceHeld(false); t.mock.timers.tick(750); await flush(); await flush();
  assert.ok(f.gateway.calls.includes('chat.history'), 'deferred reconnect refresh runs after release');
  assert.equal(service.operations().find(op => op.id === interrupted.id)?.state, 'unknown');
  assert.deepEqual(service.operations().find(op => op.id === f.unknown.id), f.unknown);
  assert.equal(service.operations().find(op => op.id === legacyUnknown.id)?.state, 'unknown');
  assert.match(service.operations().find(op => op.id === legacyUnknown.id)?.error ?? '', /restarted/);
  assert.equal(service.conversations().find(chat => chat.id === creating.id)?.state, 'unknown');
  assert.equal(service.plans.list()[0].autoStartHeld, 'restarted');
  assert.equal(service.plans.list()[0].autoStartAt, undefined, 'overdue research never launches after restart');
  assert.equal(f.gateway.calls.some(method => ['chat.send', 'sessions.create', 'sessions.patch'].includes(method)), false);
});

test('a background history response arriving after the hold cannot reseal transcripts or advance its migration cursor', async t => {
  const f = await fixture(t); const service = f.start();
  // An incomplete binding forces the existing bounded capture timer to read.
  let release!: () => void; f.gateway.waitForHistory = new Promise<void>(resolve => { release = resolve; });
  t.mock.timers.tick(750); await flush();
  assert.ok(f.gateway.calls.includes('chat.history'));
  f.store.setUpdateMaintenanceHeld(true); const before = f.rows();
  release(); await flush(); await flush();
  assert.deepEqual(f.rows(), before);
  assert.equal(service.operations().find(op => op.id === f.unknown.id)?.state, 'unknown');
});

test('accepted live work still settles from its exact native terminal receipt during a hold without dispatching another run', async t => {
  const f = await fixture(t);
  const live = { ...f.unknown, id: randomUUID(), nativeRunId: randomUUID(), state: 'running' as const };
  f.store.internalWrite(`assistant:operation:${live.id}`, live);
  f.gateway.receipts.set(live.nativeRunId, { status: 'ok', runId: live.nativeRunId, terminalReceipt: { runId: live.nativeRunId, sessionId: live.nativeId }, terminalReply: { text: 'Confirmed original answer' } });
  f.store.setUpdateMaintenanceHeld(true);
  const service = f.start();
  f.gateway.emit('chat', { runId: live.nativeRunId, sessionKey: live.nativeKey, state: 'final', message: { role: 'assistant', content: 'Confirmed original answer' } });
  t.mock.timers.tick(750); await flush(); await flush();
  assert.equal(service.operations().find(op => op.id === live.id)?.state, 'completed');
  assert.equal(service.operations().find(op => op.id === live.id)?.text, 'Confirmed original answer');
  assert.deepEqual(service.operations().find(op => op.id === f.unknown.id), f.unknown);
  assert.ok(f.gateway.calls.includes('agent.wait'));
  f.store.setUpdateMaintenanceHeld(false); t.mock.timers.tick(750); await flush(); await flush();
  assert.equal(service.operations().find(op => op.id === live.id)?.state, 'completed', 'deferred startup recovery cannot overwrite a newer terminal receipt');
  assert.equal(f.gateway.calls.includes('chat.send'), false);
});
