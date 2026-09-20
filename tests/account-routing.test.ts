import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventFrame } from '@openclaw/gateway-protocol/frame-guards';
import type { AssistantConnection, Conversation } from '../packages/domain/assistant.js';
import { emptyDraft } from '../packages/domain/contracts.js';
import { emptyChatGptUsage } from '../packages/domain/chatgpt-accounts.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { AssistantService } from '../apps/service/assistant.js';
import { ChatGptAccount } from '../apps/service/chatgpt-account.js';
import { Store } from '../apps/service/store.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(done => setTimeout(done, 10));
  assert(predicate(), 'Expected the synthetic dispatch to settle');
}

class Transport implements AssistantTransport {
  generation = randomUUID();
  calls: { method: string; params: any }[] = [];
  sessions = new Map<string, string>();
  nativeModel = 'openai/default-model';
  routing = 'before-selection';
  chosen?: string;
  patchHold?: Promise<void>;
  routeHold?: Promise<void>;
  wrongPatch = false;
  loseSend = false;
  snapshot: any;
  constructor(epoch: string) {
    this.snapshot = { epoch, checkedAt: 1000, order: ['openai:first', 'openai:backup'], accounts: ['first', 'backup'].map((id, index) => ({ profileId: `openai:${id}`, identityKey: String(index + 1).repeat(64), email: `${id}@example.com`, health: 'ready', cooldownUntil: null, expiresAt: 900000, usage: emptyChatGptUsage() })) };
  }
  status(): AssistantConnection { return { state: 'ready', generation: this.generation, url: 'ws://127.0.0.1:49998', message: 'Synthetic routing fixture', grantedScopes: ['operator.read', 'operator.write'], methods: ['e3.accounts.snapshot', 'sessions.create', 'sessions.patch', 'chat.history', 'chat.send'], modelAuthReady: true }; }
  attachmentPolicy() { return { maxBytes: 100000, maxPayload: 1000000 }; }
  models() { return Promise.resolve([]); }
  subscribe(_fn: (event: EventFrame) => void) { return () => {}; }
  async request<T>(method: string, raw: unknown): Promise<T> {
    const params = raw as any; this.calls.push({ method, params });
    if (method === 'sessions.create') { const sessionId = randomUUID(); this.sessions.set(params.key, sessionId); return { key: params.key, sessionId, entry: { sessionId, permissionMode: params.permissionMode } } as T; }
    if (method === 'chat.history') { const [provider, model] = this.nativeModel.split('/'); return { sessionId: this.sessions.get(params.sessionKey), messages: [], hasMore: false, leafEntryId: 'existing-leaf', sessionInfo: { activeRunIds: [], hasActiveRun: false, model, modelProvider: provider, routingContract: this.routing, permissionMode: 'read-only' } } as T; }
    if (method === 'e3.accounts.snapshot') { await this.routeHold; return structuredClone(this.snapshot) as T; }
    if (method === 'sessions.patch') {
      await this.patchHold;
      this.chosen = this.wrongPatch ? 'openai:unexpected' : params.model.slice(params.model.indexOf('@') + 1);
      this.nativeModel = params.model.slice(0, params.model.indexOf('@'));
      this.routing = `selected:${this.chosen}`;
      return { entry: { sessionId: this.sessions.get(params.key), authProfileOverride: this.chosen } } as T;
    }
    if (method === 'chat.send') { if (this.loseSend) throw Error('Response lost after native admission'); return { runId: `run:${params.idempotencyKey}` } as T; }
    throw Error(`Unexpected fixture method: ${method}`);
  }
}

async function fixture(run: (f: { store: Store; service: AssistantService; accounts: ChatGptAccount; gateway: Transport; device: string; conversation: Conversation; input: any; file: any }) => Promise<void>, model: string | null = 'openai/chosen-model') {
  const directory = mkdtempSync(join(tmpdir(), 'nova-routing-')), store = new Store(directory), gateway = new Transport(store.epoch), service = new AssistantService(store, gateway), device = store.session().deviceId;
  const command = { file: process.execPath, args: ['synthetic'], cwd: directory, env: {} };
  const accounts = new ChatGptAccount({ accountCommand: () => command }, async () => JSON.stringify({ agentId: 'main', provider: 'openai', profiles: gateway.snapshot.accounts.map((a: any) => ({ id: a.profileId, email: a.email, provider: 'openai', type: 'oauth' })) }), () => 1000, { store, gateway });
  service.setAccountRouter(async conversation => {
    const selection = await accounts.route({ preferredProfileId: conversation.preferredAccountId ?? undefined, model: conversation.model ?? undefined });
    return selection ? { profileId: selection.profileId, label: selection.label, reason: selection.reason, selectedAt: new Date(selection.checkedAt).toISOString() } : undefined;
  }, id => accounts.validatePreference(id));
  const projectId = `project:${randomUUID()}`;
  store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'project', entityId: projectId, expectedRevision: 0, payload: { name: 'Saved project', purpose: 'Keep the sapphire-account project context.' } });
  service.memory.change(device, { requestId: randomUUID(), epoch: store.epoch, id: randomUUID(), expectedRevision: 0, action: 'save', text: 'Keep the copper-comet memory.', projectId: null });
  const file = store.upload(device, randomUUID(), store.epoch, 'source.txt', Buffer.from('Original attachment bytes').toString('base64'));
  const draft = store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'draft', entityId: `draft:${device}`, expectedRevision: 0, payload: { ...emptyDraft, text: 'Continue the same saved chat.', projectId, attachments: [file] } });
  const conversation = await service.create(device, { requestId: randomUUID(), epoch: store.epoch, title: 'Persistent conversation', projectId, ...(model ? { model } : {}) });
  const input = { requestId: randomUUID(), epoch: store.epoch, conversationId: conversation.id, conversationRevision: conversation.revision, draftId: draft.id, draftRevision: draft.revision, projectRevision: 1 };
  try { await run({ store, service, accounts, gateway, device, conversation, input, file }); }
  finally { service.close(); await accounts.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('routing verifies the exact account before sending in the same chat with saved context, memory and files', () => fixture(async f => {
  const held = deferred(); f.gateway.patchHold = held.promise;
  const operation = f.service.submit(f.device, f.input);
  await until(() => f.gateway.calls.some(c => c.method === 'sessions.patch'));
  assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 0);
  const patch = f.gateway.calls.find(c => c.method === 'sessions.patch')!.params;
  assert.equal(patch.model, 'openai/chosen-model@openai:first'); assert.equal(patch.key, f.conversation.nativeKey); assert.equal(patch.expectedSessionId, f.conversation.nativeId);
  held.resolve(); await until(() => f.service.operations()[0].state === 'accepted');
  const sent = f.gateway.calls.find(c => c.method === 'chat.send')!.params;
  assert.equal(sent.sessionKey, f.conversation.nativeKey); assert.equal(sent.sessionId, f.conversation.nativeId);
  assert.equal(sent.expectedSessionRoutingContract, 'selected:openai:first'); assert.equal(sent.expectedLeafEntryId, 'existing-leaf');
  assert.match(sent.message, /sapphire-account/); assert.match(sent.message, /copper-comet/); assert.match(sent.message, /Continue the same saved chat/);
  assert.equal(Buffer.from(sent.attachments[0].content, 'base64').toString(), 'Original attachment bytes');
  assert.deepEqual(f.service.operations()[0].context.attachments, [f.file]); assert.deepEqual(f.service.operations()[0].context.memory, operation.context.memory);
  assert.equal(f.service.operations()[0].accountSelection?.profileId, 'openai:first');
  assert.equal(f.service.conversations()[0].id, f.conversation.id); assert.equal(f.gateway.calls.filter(c => c.method === 'sessions.create').length, 1);
  assert.equal(f.store.readEntity('draft', f.input.draftId)!.value.text, 'Continue the same saved chat.');
  assert(f.gateway.calls.filter(c => c.method === 'e3.accounts.snapshot').every(c => c.params.includeUsage === false));
}));

test('a native default OpenAI model routes through the available backup before dispatch', () => fixture(async f => {
  f.gateway.snapshot.accounts[0].health = 'cooldown'; f.gateway.snapshot.accounts[0].cooldownUntil = 900000;
  f.service.submit(f.device, f.input); await until(() => f.service.operations()[0].state === 'accepted');
  assert.equal(f.gateway.calls.find(c => c.method === 'sessions.patch')!.params.model, 'openai/default-model@openai:backup');
  assert.equal(f.service.operations()[0].accountSelection?.reason, 'backup');
  assert.equal(f.service.operations()[0].accountSelection?.profileId, 'openai:backup');
}, null));

test('a native default model from another provider does not receive an OpenAI account pin', () => fixture(async f => {
  f.gateway.nativeModel = 'other/native-model';
  f.service.submit(f.device, f.input); await until(() => f.service.operations()[0].state === 'accepted');
  assert.equal(f.gateway.calls.filter(c => ['sessions.patch', 'e3.accounts.snapshot'].includes(c.method)).length, 0);
  assert.equal(f.service.operations()[0].accountSelection, undefined);
}, null));

test('an unconfirmed account patch keeps exact input and files without dispatching dialogue', () => fixture(async f => {
  f.gateway.wrongPatch = true;
  const admitted = f.service.submit(f.device, f.input); await until(() => f.service.operations()[0].state === 'failed');
  const saved = f.service.operations()[0];
  assert.equal(saved.input, admitted.input); assert.deepEqual(saved.context, admitted.context); assert.match(saved.error!, /account switch could not be confirmed/);
  assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 0);
  assert.equal(f.service.conversations()[0].accountSelection, undefined);
  f.service.submit(f.device, f.input); assert.equal(f.gateway.calls.filter(c => c.method === 'sessions.patch').length, 1);
}));

test('an unknown send is never retried against a newly available backup', () => fixture(async f => {
  f.gateway.loseSend = true;
  f.service.submit(f.device, f.input); await until(() => f.service.operations()[0].state === 'unknown');
  const original = f.service.operations()[0], routes = f.gateway.calls.filter(c => c.method === 'e3.accounts.snapshot').length;
  f.gateway.snapshot.accounts[0].health = 'cooldown'; f.gateway.snapshot.accounts[0].cooldownUntil = 900000;
  assert.deepEqual(f.service.submit(f.device, f.input), original);
  assert.throws(() => f.service.submit(f.device, { ...f.input, requestId: randomUUID() }), /existing|current|Settle|settle/);
  assert.equal(f.gateway.calls.filter(c => c.method === 'chat.send').length, 1); assert.equal(f.gateway.calls.filter(c => c.method === 'e3.accounts.snapshot').length, routes);
}));

test('per-chat account changes are blocked during a live voice call', () => fixture(async f => {
  f.service.setVoiceGuard(() => true);
  await assert.rejects(f.service.selectAccount(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.conversation.id, expectedRevision: f.conversation.revision, profileId: 'openai:backup' }), /current reply or call/);
  assert.equal(f.service.conversations()[0].preferredAccountId, undefined);
  assert.equal(f.gateway.calls.filter(c => c.method === 'sessions.patch').length, 0);
}));

test('account preparation does not mutate native settings after its local selection changes in flight', () => fixture(async f => {
  const held = deferred(); f.gateway.routeHold = held.promise;
  const preparing = f.service.prepareAccount(f.conversation.id);
  await until(() => f.gateway.calls.some(c => c.method === 'e3.accounts.snapshot'));
  const current = f.service.conversations()[0];
  f.store.internalWrite(`assistant:conversation:${current.id}`, { ...current, revision: current.revision + 1, preferredAccountId: 'openai:backup' });
  held.resolve(); await assert.rejects(preparing);
  assert.equal(f.gateway.calls.filter(c => c.method === 'sessions.patch').length, 0);
}));
