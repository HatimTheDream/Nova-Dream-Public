import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { DirectAgentReadAuthority } from '../apps/service/direct-agent-reads.js';
import { directReadInput, directRuntimeAgent } from '../apps/service/direct-agent-tool-calls.js';
import { captureDirectAgentBinding, captureDirectAgentTurn, directAgentNativeKey } from '../packages/domain/direct-agent.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import type { AssistantOperation, Conversation } from '../packages/domain/assistant.js';

/** Real isolated retained entities; all native identities are synthetic. No
 * Gateway, provider, plugin, HTTP listener or native startup is created. */
function fixture(t: TestContext) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'nova-direct-pure-reads-')));
  t.after(() => store.close());
  const deviceId = store.session().deviceId, epoch = store.epoch, at = new Date().toISOString();
  store.mutate(deviceId, {
    requestId: randomUUID(), epoch, kind: 'agent', entityId: 'agent:original', expectedRevision: 0,
    payload: { ...blankRecord('agent', 'UTC'), name: 'Aster', position: 'Research partner', access: { contacts: 'read', profile: 'read', calendar: 'read', inbox: 'read' } },
  });
  const agent = store.readEntity('agent', 'agent:original')!;
  const contact = store.mutate(deviceId, {
    requestId: randomUUID(), epoch, kind: 'contact', entityId: 'contact:original', expectedRevision: 0,
    payload: { ...blankRecord('contact', 'UTC'), name: 'Mina', notes: 'Original saved writing' },
  });
  store.mutate(deviceId, {
    requestId: randomUUID(), epoch, kind: 'profile', entityId: 'profile:owner', expectedRevision: 0,
    payload: { ...blankRecord('profile', 'UTC'), name: 'Synthetic owner' },
  });
  const profile = store.readEntity('profile', 'profile:owner')!;
  const id = randomUUID(), conversation: Conversation = {
    id, revision: 1, space: 'chat', title: 'Aster', projectId: null, archived: false, permissionMode: 'read-only',
    nativeKey: directAgentNativeKey(id), nativeId: randomUUID(), connectionGeneration: 'synthetic-generation',
    state: 'ready', model: 'synthetic/model', thinking: null,
    accountSelection: { profileId: 'synthetic-account', selectedAt: at }, createdAt: at, updatedAt: at,
    directAgent: captureDirectAgentBinding({ agentId: agent.id, agentRevision: agent.revision }, agent, { requestId: randomUUID(), deviceId, epoch }),
  };
  store.internalWrite(`assistant:conversation:${id}`, conversation);
  const original = {
    id: randomUUID(), requestId: randomUUID(), deviceId, epoch, capturedAt: at,
    account: { profileId: 'synthetic-account', model: conversation.model! },
    sources: { projectId: null, projectRevision: 0, draftId: 'draft:original', draftRevision: 1, attachments: [], projectAttachments: [] },
  };
  const operation: AssistantOperation = {
    id: original.id, requestId: original.requestId, deviceId, epoch, conversationId: id, conversationRevision: 1,
    connectionGeneration: conversation.connectionGeneration, nativeKey: conversation.nativeKey, nativeId: conversation.nativeId!,
    nativeRunId: original.requestId, state: 'running', input: 'Synthetic read request',
    context: { project: null, attachments: [], draftId: original.sources.draftId, draftRevision: 1, digest: 'a'.repeat(64),
      directAgent: captureDirectAgentTurn(conversation, original, agent, profile) },
    model: conversation.model, accountSelection: conversation.accountSelection, thinking: null,
    createdAt: at, updatedAt: at, text: '', lastSequence: 0,
  };
  store.internalWrite(`assistant:operation:${operation.id}`, operation);
  let current = true;
  const owner = { epoch, generation: conversation.connectionGeneration, policySha256: 'b'.repeat(64),
    assertCurrent() { if (!current) throw Error('Original owner closed'); } };
  const authority = new DirectAgentReadAuthority(store, owner);
  const request = (operationName = 'records.read', input: Record<string, unknown> = { kind: 'contact', id: contact.id }) => {
    const parsed = directReadInput({ operation: operationName, input });
    return { epoch, policySha256: owner.policySha256, agentId: directRuntimeAgent,
      sessionKey: conversation.nativeKey, sessionId: conversation.nativeId!, runId: operation.requestId,
      toolCallId: randomUUID(), inputSha256: parsed.inputSha256, read: parsed.input };
  };
  const retained = () => {
    const { id: _id, createdAt: _createdAt, ...rows } = store.captureBackup('synthetic-pure-read', { status: 'not-configured', notes: [] });
    return rows;
  };
  return { store, deviceId, agent, contact, profile, conversation, operation, original, authority, request, retained,
    closeOwner() { current = false; } };
}

test('permitted record and Profile reads preserve complete retained rows, cursor, receipts and files', async t => {
  const f = fixture(t), before = f.retained();
  // A tempting convenience snapshot would sweep/materialize. It is never used.
  f.store.snapshot = () => { throw Error('A pure read must not snapshot or materialize'); };
  for (const request of [f.request(), f.request('records.read', { kind: 'profile', id: f.profile.id }),
    f.request('records.list', { kind: 'contact', query: 'Mina', limit: 1 })]) {
    const origin = f.authority.authorize(request);
    const result = await f.authority.read({ origin, read: request.read }) as any;
    if (request.read.operation === 'records.list') {
      assert.equal(result.total, 1); assert.equal(result.records[0].id, f.contact.id); assert.equal(result.more, false);
    } else assert.equal(result.id, request.read.input.id);
  }
  assert.deepEqual(f.retained(), before);
});

test('original request, native acceptance, account and current run must all match before any read', async t => {
  const f = fixture(t), request = f.request();
  for (const patch of [{ runId: randomUUID() }, { sessionId: randomUUID() }, { sessionKey: 'agent:main:other' },
    { epoch: randomUUID() }, { policySha256: 'c'.repeat(64) }, { inputSha256: 'd'.repeat(64) }])
    assert.throws(() => f.authority.authorize({ ...request, ...patch }));
  for (const patch of [{ nativeRunId: null }, { nativeRunId: randomUUID() }, { state: 'unknown' }, { cancelRequested: true }]) {
    f.store.internalWrite(`assistant:operation:${f.operation.id}`, { ...f.operation, ...patch });
    assert.throws(() => f.authority.authorize(request));
  }
  f.store.internalWrite(`assistant:operation:${f.operation.id}`, f.operation);
  f.store.internalWrite(`assistant:conversation:${f.conversation.id}`, { ...f.conversation, accountSelection: { profileId: 'other', selectedAt: f.conversation.updatedAt } });
  assert.throws(() => f.authority.authorize(request));
});

test('ambiguous original request cannot select the first active operation', t => {
  const f = fixture(t), original = { ...f.original, id: randomUUID() };
  f.store.internalWrite(`assistant:operation:${original.id}`, { ...f.operation, id: original.id,
    context: { ...f.operation.context, directAgent: captureDirectAgentTurn(f.conversation, original, f.agent, f.profile) } });
  assert.throws(() => f.authority.authorize(f.request()), /ambiguous/);
});

test('Calendar, Inbox, mutations, uncaptured sources and malformed arguments stay unavailable', t => {
  const f = fixture(t), before = f.retained();
  for (const operation of ['calendar.read', 'inbox.read', 'profile.read'])
    assert.throws(() => f.authority.authorize(f.request(operation, {})), /pure read projection/);
  for (const [operation, input] of [
    ['records.save', { kind: 'contact', id: f.contact.id }], ['sources.read', { fileId: 'file:other' }],
    ['records.read', { kind: 'agent', id: f.agent.id }], ['records.read', { kind: 'contact', id: f.contact.id, write: true }],
    ['records.list', { kind: 'contact', limit: 101 }],
  ] as [string, Record<string, unknown>][]) assert.throws(() => f.authority.authorize(f.request(operation, input)));
  assert.deepEqual(f.retained(), before);
});

test('revocation and owner replacement after the read withhold the result without writing', async t => {
  const f = fixture(t), request = f.request(), origin = f.authority.authorize(request);
  const pending = f.authority.read({ origin, read: request.read });
  f.store.mutate(f.deviceId, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'agent', entityId: f.agent.id,
    expectedRevision: f.agent.revision, payload: { ...f.agent.value, access: { profile: 'read' } } });
  const afterRevocation = f.retained();
  await assert.rejects(pending, /permissions/);
  assert.deepEqual(f.retained(), afterRevocation);
  const profileRequest = f.request('records.read', { kind: 'profile', id: f.profile.id });
  const profileOrigin = f.authority.authorize(profileRequest);
  const pendingOwner = f.authority.read({ origin: profileOrigin, read: profileRequest.read });
  f.closeOwner();
  await assert.rejects(pendingOwner, /owner closed/);
  assert.deepEqual(f.retained(), afterRevocation);
});
