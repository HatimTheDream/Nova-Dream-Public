import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../apps/service/store.js';
import { AssistantService } from '../apps/service/assistant.js';
import { NovaTranscript } from '../apps/service/nova-transcript.js';
import { createConversationSchema, type AssistantConnection, type AssistantOperation, type Conversation } from '../packages/domain/assistant.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { blankRecord, type AgentDesign } from '../packages/domain/workspace-records.js';
import { assertDirectAgentOperation, captureDirectAgentTurn, directAgentMayRead, directAgentMessageAuthor, verifyDirectAgentRecords } from '../packages/domain/direct-agent.js';
import { canonical, emptyDraft } from '../packages/domain/contracts.js';
import { ModuleActions, type ModuleServices } from '../apps/service/module-actions.js';

class Transport implements AssistantTransport {
  calls: string[] = []; generation = randomUUID();
  listeners = new Set<(event: any) => void>();
  status(): AssistantConnection { return { state: 'ready', generation: this.generation, message: 'Synthetic only', methods: ['sessions.create', 'sessions.describe', 'sessions.search', 'chat.history'], grantedScopes: ['operator.read', 'operator.write'], modelAuthReady: true }; }
  subscribe(listener: (event: any) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  models() { return Promise.resolve([]); }
  attachmentPolicy() { return {}; }
  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push(method);
    if (method === 'sessions.create') return { key: params.key, sessionId: randomUUID() } as T;
    throw Error(`Unexpected synthetic native call: ${method}`);
  }
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-direct-authority-')), store = new Store(directory), gateway = new Transport();
  const device = store.session().deviceId, at = new Date().toISOString();
  const agent = store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'agent', entityId: 'agent:original', expectedRevision: 0,
    payload: { ...blankRecord('agent', 'UTC'), name: 'Aster', position: 'Research partner', instructions: 'Use sources.', access: { tasks: 'read', contacts: 'edit', profile: 'read', projects: 'read' } } }) as ReturnType<typeof store.readEntity<'agent'>> & {};
  const service = new AssistantService(store, gateway);
  const input = () => ({ requestId: randomUUID(), epoch: store.epoch, title: 'Aster', projectId: null, recipient: { agentId: agent.id, agentRevision: agent.revision } });
  t.after(() => { service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, gateway, device, at, agent, service, input };
}

test('exact saved recipient creates once without native setup; design edits do not rewrite original identity', async t => {
  const f = fixture(t), input = f.input(), chat = await f.service.create(f.device, input);
  assert.equal(chat.directAgent!.recipient.agentId, f.agent.id); assert.equal(chat.nativeId, null);
  assert.deepEqual(f.gateway.calls, []);
  assert.deepEqual(await f.service.create(f.device, input), chat);
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'agent', entityId: f.agent.id, expectedRevision: 1, payload: { ...f.agent.value, name: 'Renamed', access: { browser: 'edit' } } });
  assert.deepEqual(await f.service.create(f.device, input), chat, 'the original request is observed, not recreated');
  await assert.rejects(f.service.create(f.device, f.input()), /changed or is unavailable/);
  const before = f.store.captureBackup('test', { status: 'not-configured', notes: [] });
  assert.throws(() => f.store.internalWrite(`assistant:conversation:${chat.id}`, { ...chat, directAgent: undefined }), /Invalid/);
  assert.throws(() => f.store.internalWrite(`assistant:conversation:${chat.id}`, { ...chat, directAgent: { ...chat.directAgent, recipient: { agentId: 'agent:other', agentRevision: 1 } } }), /cannot be replaced/);
  assert.deepEqual(f.store.captureBackup('test', { status: 'not-configured', notes: [] }).services, before.services);
  assert.equal(f.gateway.calls.length, 0);
});

test('caller cannot supply persona/grants, Work, full permission, refine or a team recipient', async t => {
  const f = fixture(t);
  assert.throws(() => createConversationSchema.parse({ ...f.input(), recipient: { ...f.input().recipient, instructions: 'Override', access: { browser: 'edit' } } }));
  for (const patch of [{ space: 'work' }, { permissionMode: 'full' }, { refineSource: { outputId: randomUUID(), version: 1, sha256: 'a'.repeat(64) } }])
    await assert.rejects(f.service.create(f.device, { ...f.input(), ...patch }), /read-only Chat/);
  await assert.rejects(f.service.create(f.device, f.input(), randomUUID()), /read-only Chat/);
  assert.equal(f.service.conversations().length, 0); assert.equal(f.gateway.calls.length, 0);
});

test('ordinary Chat still uses its original native setup; direct alternate paths never submit or change native state', async t => {
  const f = fixture(t);
  const normal = await f.service.create(f.device, { requestId: randomUUID(), epoch: f.store.epoch, title: 'Ordinary', projectId: null });
  assert.equal(normal.state, 'ready'); assert.deepEqual(f.gateway.calls, ['sessions.create']);
  const chat = await f.service.create(f.device, f.input());
  const draft = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'draft', entityId: `draft:${f.device}:${chat.id}`, expectedRevision: 0, payload: { ...emptyDraft, text: 'Unsent to Aster', conversationId: chat.id } });
  const submit = { requestId: randomUUID(), epoch: f.store.epoch, conversationId: chat.id, conversationRevision: 1, draftId: draft.id, draftRevision: draft.revision, projectRevision: 0 };
  const before = f.store.captureBackup('test', { status: 'not-configured', notes: [] });
  assert.throws(() => f.service.submit(f.device, submit), /dedicated connection/);
  assert.throws(() => f.service.submit(f.device, { ...submit, targetOperationId: randomUUID() }, true), /dedicated connection/);
  assert.throws(() => f.service.enqueue(f.device, submit), /dedicated connection/);
  assert.throws(() => f.service.captureVoiceTarget(chat.id, 1, 0), /dedicated connection/);
  await assert.rejects(f.service.prepareAccount(chat.id), /dedicated connection/);
  let accountCalls = 0; f.service.setAccountRouter(async () => { accountCalls++; return undefined; }, async () => { accountCalls++; });
  await assert.rejects(f.service.selectAccount(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: chat.id, expectedRevision: 1, profileId: 'synthetic-account' }), /dedicated connection/);
  await assert.rejects(f.service.edit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: chat.id, expectedRevision: 1, permissionMode: 'workspace' }), /dedicated connection/);
  await assert.rejects(f.service.reconcile(chat.id), /dedicated connection/);
  await assert.rejects(f.service.fork(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: chat.id, nativeId: randomUUID(), expectedRevision: 1, messageId: 'synthetic', messageHash: 'a'.repeat(64), purpose: 'branch' }), /dedicated connection/);
  await assert.rejects(f.service.continuations.resume(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: chat.id, expectedRevision: 1, digest: 'a'.repeat(64) }), /dedicated connection/);
  assert.equal(accountCalls, 0);
  assert.deepEqual(f.store.captureBackup('test', { status: 'not-configured', notes: [] }).services, before.services);
  assert.deepEqual(f.gateway.calls, ['sessions.create']);
  assert.equal(f.store.readEntity('draft', draft.id)!.value.text, 'Unsent to Aster');
});

/** A synthetic original session is only a contract fixture. No provider,
 * dispatcher, model or tool is run or qualified by these tests. */
async function captured(t: TestContext) {
  const f = fixture(t), local = await f.service.create(f.device, f.input());
  const chat: Conversation = { ...local, nativeId: randomUUID(), connectionGeneration: f.gateway.generation,
    model: 'synthetic/model', accountSelection: { profileId: 'synthetic-account', selectedAt: f.at } };
  f.store.internalWrite(`assistant:conversation:${chat.id}`, chat);
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'profile', entityId: 'profile:owner', expectedRevision: 0,
    payload: { ...blankRecord('profile', 'UTC'), name: 'Original owner' } });
  const profile = f.store.readEntity('profile', 'profile:owner')!;
  const original = { id: randomUUID(), requestId: randomUUID(), deviceId: f.device, epoch: f.store.epoch, capturedAt: f.at,
    account: { profileId: 'synthetic-account', model: 'synthetic/model' },
    sources: { projectId: null, projectRevision: 0, draftId: `draft:${f.device}:${chat.id}`, draftRevision: 1, attachments: [], projectAttachments: [] } };
  const capture = captureDirectAgentTurn(chat, original, f.agent, profile);
  const operation: AssistantOperation = { id: original.id, requestId: original.requestId, deviceId: f.device, epoch: f.store.epoch,
    conversationId: chat.id, conversationRevision: chat.revision, connectionGeneration: chat.connectionGeneration,
    nativeKey: chat.nativeKey, nativeId: chat.nativeId!, nativeRunId: randomUUID(), state: 'running',
    input: 'Synthetic original input', context: { project: null, attachments: [], draftId: original.sources.draftId, draftRevision: 1, digest: 'a'.repeat(64), directAgent: capture },
    accountSelection: { profileId: original.account.profileId, selectedAt: f.at }, model: original.account.model, thinking: null,
    createdAt: f.at, updatedAt: f.at, text: 'Synthetic original answer', lastSequence: 1 };
  f.store.internalWrite(`assistant:operation:${operation.id}`, operation);
  const origin = { epoch: operation.epoch, operationId: operation.id, requestId: operation.requestId, nativeKey: operation.nativeKey, nativeId: operation.nativeId,
    generation: operation.connectionGeneration, runId: operation.nativeRunId!, accountId: original.account.profileId };
  return { ...f, chat, profile, operation, origin };
}

test('captured/current intersection revokes access immediately and never adds a grant or write', async t => {
  const f = await captured(t), read = (agent = f.agent, origin = f.origin, name = 'records.read', input: Record<string, unknown> = { kind: 'task' }, write = false) =>
    directAgentMayRead(f.chat, f.operation, agent, origin, name, input, write);
  assert.equal(read(), true);
  assert.equal(read({ ...f.agent, revision: 2, value: { ...f.agent.value, access: { browser: 'edit' } } }), false);
  const expanded = { ...f.agent, revision: 2, value: { ...f.agent.value, access: { tasks: 'edit', content: 'read', browser: 'edit' } as AgentDesign['access'] } };
  assert.equal(read(expanded), true); assert.equal(read(expanded, f.origin, 'records.read', { kind: 'content' }), false);
  assert.equal(read(f.agent, f.origin, 'records.save', { kind: 'contact' }, true), false);
  assert.equal(read(f.agent, f.origin, 'records.read', { kind: 'project', id: 'project:not-captured' }), false);
  assert.equal(read(f.agent, f.origin, 'records.list', { kind: 'project' }), false);
  for (const name of ['browser.observe', 'computer.devices', 'catalog', 'accounts.list', 'sources.read', 'team.handoffs.read', 'assignment.start'])
    assert.equal(read(expanded, f.origin, name), false, name);
  for (const key of ['epoch', 'operationId', 'requestId', 'nativeId', 'nativeKey', 'generation', 'runId', 'accountId'] as const)
    assert.equal(read(f.agent, { ...f.origin, [key]: randomUUID() }), false, key);
  assert.equal(read({ ...f.agent, value: { ...f.agent.value, archived: true } }), false);
  assert.equal(directAgentMayRead(f.chat, f.operation, undefined, f.origin, 'records.read', { kind: 'task' }, false), false);
  assert.equal(directAgentMayRead(f.chat, { ...f.operation, cancelRequested: true }, f.agent, f.origin, 'records.read', { kind: 'task' }, false), false);
  assert.equal(directAgentMayRead({ ...f.chat, accountSelection: { profileId: 'different', selectedAt: f.at } }, f.operation, f.agent, f.origin, 'records.read', { kind: 'task' }, false), false);
});

test('turn capture admits only its original conversation Project; moved history survives without granting live access', async t => {
  const f = await captured(t), capture = f.operation.context.directAgent!;
  const original = { id: f.operation.id, requestId: f.operation.requestId, deviceId: f.device, epoch: f.store.epoch,
    account: capture.account, sources: capture.sources, capturedAt: f.at };
  assert.throws(() => captureDirectAgentTurn(f.chat, { ...original, sources: { ...capture.sources, projectId: 'project:other', projectRevision: 1 } }, f.agent, f.profile));
  for (const sources of [
    { ...capture.sources, projectRevision: 1 },
    { ...capture.sources, projectAttachments: [{ id: 'unbound', name: 'not-captured', size: 1, sha256: 'a'.repeat(64) }] },
  ]) assert.throws(() => captureDirectAgentTurn(f.chat, { ...original, sources }, f.agent, f.profile));
  const project = { id: 'project:original', revision: 2, name: 'Original Project', purpose: '', instructions: '', attachments: [] };
  const chat = { ...f.chat, projectId: project.id };
  assert.throws(() => captureDirectAgentTurn(chat, { ...original, sources: { ...capture.sources, projectId: project.id, projectRevision: 0 } }, f.agent, f.profile));
  const directAgent = captureDirectAgentTurn(chat, { ...original, sources: { ...capture.sources, projectId: project.id, projectRevision: project.revision } }, f.agent, f.profile);
  const operation = { ...f.operation, context: { ...f.operation.context, project, directAgent } };
  assert.deepEqual(assertDirectAgentOperation(chat, operation), directAgent);
  assert.equal(directAgentMayRead(chat, operation, f.agent, f.origin, 'records.read', { kind: 'project', id: project.id }, false), true);
  // Joining a forged context to itself cannot authorize a different Project at
  // the same original conversation revision.
  const forged = structuredClone(operation);
  forged.context.project!.id = 'project:other';
  forged.context.directAgent!.sources.projectId = 'project:other';
  assert.throws(() => assertDirectAgentOperation(chat, forged), /original authority/);
  const moved = { ...chat, revision: chat.revision + 1, projectId: 'project:later' };
  assert.deepEqual(assertDirectAgentOperation(moved, operation), directAgent);
  assert.deepEqual(directAgentMessageAuthor(moved, operation, 'assistant'), directAgentMessageAuthor(chat, operation, 'assistant'));
  assert.equal(directAgentMayRead(moved, operation, f.agent, f.origin, 'records.read', { kind: 'project', id: project.id }, false), false);
});

test('even an exact synthetic direct session cannot reach the generic module bridge or native search', async t => {
  // Other module services are intentionally absent: admission must refuse
  // before it can touch any of those providers.
  const f = await captured(t), actions = new ModuleActions({ store: f.store, assistant: f.service, gateway: f.gateway } as unknown as ModuleServices);
  try {
    new NovaTranscript(f.store).observeOperation(f.chat, f.operation);
    const before = f.store.captureBackup('test', { status: 'not-configured', notes: [] });
    for (const [operation, write] of [['records.read', false], ['records.save', true], ['catalog', false], ['browser.observe', false], ['assignments.start', true]] as const)
      await assert.rejects(actions.invoke({ epoch: f.store.epoch, nativeKey: f.chat.nativeKey, nativeId: f.chat.nativeId, toolCallId: randomUUID(),
        operation, write, permissionMode: 'read-only', input: {} }), /separately qualified original route/);
    assert.deepEqual(f.store.captureBackup('test', { status: 'not-configured', notes: [] }).services, before.services);
    // Owner Search may finish the existing local transcript index. It must
    // never contact a native direct session or replace original operation data.
    await f.service.search({ epoch: f.store.epoch, query: 'Synthetic', space: 'chat', scope: 'all' });
    for (const listener of f.gateway.listeners) listener({ type: 'event', event: 'chat', payload: { runId: f.operation.nativeRunId, sessionKey: f.operation.nativeKey, state: 'final', message: { text: 'A generic reply is not Aster' } } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(f.store.internalRead(`assistant:operation:${f.operation.id}`), f.operation);
    assert.deepEqual(f.gateway.calls, []);
  } finally { await actions.close(); }
});

test('maintenance and held recovery refuse new direct authority before a receipt or record is written', async t => {
  const f = fixture(t);
  f.store.internalWrite('recovery:state', { held: true });
  const before = f.store.captureBackup('test', { status: 'not-configured', notes: [] });
  await assert.rejects(f.service.create(f.device, f.input()), /recovered workspace/);
  const after = f.store.captureBackup('test', { status: 'not-configured', notes: [] });
  assert.deepEqual(after.services, before.services); assert.deepEqual(after.receipts, before.receipts); assert.equal(f.gateway.calls.length, 0);
});

test('captured authors survive rename, restart and held restore with exact original run and source fields', async t => {
  const f = await captured(t), transcript = new NovaTranscript(f.store);
  const user = directAgentMessageAuthor(f.chat, f.operation, 'user')!, agent = directAgentMessageAuthor(f.chat, f.operation, 'assistant')!;
  assert.equal(user.name, 'Original owner'); assert.equal(agent.name, 'Aster');
  assert.equal(directAgentMessageAuthor(f.chat, { ...f.operation, nativeRunId: null }, 'assistant'), undefined);
  transcript.observeOperation(f.chat, f.operation);
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'agent', entityId: f.agent.id, expectedRevision: 1, payload: { ...f.agent.value, name: 'Later agent' } });
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'profile', entityId: f.profile.id, expectedRevision: 1, payload: { ...f.profile.value, name: 'Later owner' } });
  const saved = transcript.all(f.chat)!.messages;
  assert.deepEqual(saved.map(message => message.author?.name), ['Original owner', 'Aster']);
  const backup = f.store.captureBackup('test', { status: 'not-configured', notes: [] });
  assert.equal(backup.schema, 56);
  const restored = Store.restoreBackup(join(f.directory, 'restored'), backup);
  try {
    const after = restored.captureBackup('test', { status: 'not-configured', notes: [] });
    for (const record of backup.services.filter(row => row.id.startsWith('assistant:'))) assert.deepEqual(after.services.find(row => row.id === record.id), record);
    assert.throws(() => restored.internalWrite(`assistant:conversation:${f.chat.id}`, { ...f.chat, directAgent: undefined }));
    assert.deepEqual(new NovaTranscript(restored).all(f.chat)!.messages.map(message => message.author), saved.map(message => message.author));
    assert.equal(directAgentMayRead(f.chat, f.operation, f.agent, { ...f.origin, epoch: restored.epoch }, 'records.read', { kind: 'task' }, false), false);
  } finally { restored.close(); }
  assert.throws(() => assertDirectAgentOperation(f.chat, { ...f.operation, requestId: randomUUID() }), /original authority/);
  assert.throws(() => f.store.internalWrite(`assistant:operation:${f.operation.id}`, { ...f.operation, context: { ...f.operation.context, digest: 'b'.repeat(64) } }), /cannot be rewritten/);
  const forged = structuredClone(backup); forged.schema = 55;
  assert.throws(() => Store.verifyBackup(forged), /direct-agent authority/);
  assert.throws(() => verifyDirectAgentRecords(56, [{ id: 'assistant:conversation:wrong', value: f.chat }]), /key does not match/);
  assert.equal(canonical(f.store.internalRead(`assistant:operation:${f.operation.id}`)), canonical(f.operation));
});

test('synthetic header-only schema55 migration keeps ordinary entities; schema57 refuses before schema writes', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-direct-schema-'));
  let store = new Store(directory); const device = store.session().deviceId, snapshot = store.captureBackup('test', { status: 'not-configured', notes: [] }); store.close();
  let db = new DatabaseSync(join(directory, 'workspace.sqlite')); db.exec('PRAGMA user_version=55'); db.close();
  store = new Store(directory);
  assert.deepEqual(store.captureBackup('test', { status: 'not-configured', notes: [] }).entities, snapshot.entities);
  assert.equal(store.snapshot(device).drafts.length, 0); store.close();
  db = new DatabaseSync(join(directory, 'workspace.sqlite')); db.exec('PRAGMA user_version=57'); db.close();
  assert.throws(() => new Store(directory), /newer Nova Dream build/);
  db = new DatabaseSync(join(directory, 'workspace.sqlite')); assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, 57); db.close();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
});
