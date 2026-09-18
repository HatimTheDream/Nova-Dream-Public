import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { ModuleActions, type ModuleServices } from '../apps/service/module-actions.js';
import { captureTeamHandoff } from '../apps/service/team-handoffs.js';
import { blankRecord, type AgentDesign } from '../packages/domain/workspace-records.js';
import type { Entity } from '../packages/domain/contracts.js';
import type { AssistantOperation, Conversation } from '../packages/domain/assistant.js';
import type { TeamConversationAccess } from '../packages/domain/team-work.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-module-handoff-')), store = new Store(directory), device = store.session().deviceId, generation = randomUUID(), teamId = randomUUID();
  const agent = store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'agent', entityId: 'agent:' + randomUUID(), expectedRevision: 0, payload: { ...blankRecord('agent', 'UTC'), name: 'Reviewer', position: 'Reviewer', access: {} } }) as Entity<AgentDesign>;
  const conversation: Conversation = { id: randomUUID(), revision: 1, title: 'Review', projectId: null, archived: false, permissionMode: 'read-only', model: null, thinking: null, createdAt: '', updatedAt: '', connectionGeneration: generation, nativeKey: 'agent:main:e3:' + randomUUID(), nativeId: randomUUID(), state: 'ready' };
  const operation: AssistantOperation = { id: randomUUID(), requestId: randomUUID(), deviceId: device, epoch: store.epoch, conversationId: conversation.id, conversationRevision: 1, connectionGeneration: generation, nativeKey: conversation.nativeKey, nativeId: conversation.nativeId!, nativeRunId: randomUUID(), state: 'running', input: 'Review prior work', context: { project: null, attachments: [], draftId: 'fixture', draftRevision: 1, digest: 'a'.repeat(64) }, model: null, thinking: null, createdAt: '', updatedAt: '', text: '', lastSequence: 0 };
  const prior = { ...operation, id: randomUUID(), requestId: randomUUID(), conversationId: randomUUID(), nativeId: randomUUID(), nativeKey: 'agent:main:e3:' + randomUUID(), state: 'completed' as const, text: 'a'.repeat(30000) + 'Important final evidence 🧭' };
  const handoff = captureTeamHandoff(store, { epoch: store.epoch, teamId, stage: 0, attempt: 1, operation: prior });
  operation.context.teamHandoffs = { teamId, ids: [handoff.id] };
  const binding: TeamConversationAccess = { epoch: store.epoch, teamId, agentId: agent.id, agentRevision: agent.revision, access: {}, role: 'review', handoffIds: [handoff.id] };
  store.internalWrite('team:conversation:' + conversation.id, binding);
  let assignedCalls = 0;
  const deps = { store, assistant: { conversations: () => [conversation], operations: () => [operation] }, gateway: { status: () => ({ generation }) }, assignments: { authorizeModule: () => { assignedCalls++; throw Error('Assignment authorization should not run'); } } } as unknown as ModuleServices;
  let service = new ModuleActions(deps);
  const input = (name: string, value: Record<string, unknown> = {}, write = false) => ({ operation: name, input: value, epoch: store.epoch, nativeKey: conversation.nativeKey, nativeId: conversation.nativeId, toolCallId: randomUUID(), permissionMode: conversation.permissionMode, write });
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, device, conversation, operation, prior, teamId, agent, binding, handoff, input, get service() { return service; }, get assignedCalls() { return assignedCalls; }, async restart() { await service.close(); service = new ModuleActions(deps); } };
}

test('team tools retrieve only captured complete input without granting other module access', async t => {
  const f = fixture(t);
  const listed = await f.service.invoke(f.input('team.handoffs.list')) as { handoffs: { id: string }[] };
  assert.deepEqual(listed.handoffs.map(h => h.id), [f.handoff.id]);
  const page = await f.service.invoke(f.input('team.handoffs.read', { id: f.handoff.id, offset: 29999, limit: 100 })) as { text: string; nextOffset: null };
  assert.equal(page.text, f.prior.text.slice(29999)); assert.equal(page.nextOffset, null);
  await assert.rejects(f.service.invoke(f.input('records.list', { kind: 'project' })), /capability/);
  await assert.rejects(f.service.invoke(f.input('team.handoffs.read', { id: f.handoff.id }, true)), /capability/);
  await f.restart();
  assert.deepEqual(await f.service.invoke(f.input('team.handoffs.list')), listed);
});

test('team tools reject foreign, future, uncaptured and revoked handoff references', async t => {
  const f = fixture(t), foreign = captureTeamHandoff(f.store, { epoch: f.store.epoch, teamId: randomUUID(), stage: 0, attempt: 1, operation: { ...f.prior, id: randomUUID() } });
  const future = captureTeamHandoff(f.store, { epoch: f.store.epoch, teamId: f.teamId, stage: 4, attempt: 1, operation: { ...f.prior, id: randomUUID() } });
  f.binding.handoffIds!.push(foreign.id, future.id);
  f.store.internalWrite('team:conversation:' + f.conversation.id, f.binding);
  for (const id of [foreign.id, future.id, randomUUID()]) await assert.rejects(f.service.invoke(f.input('team.handoffs.read', { id })), /not captured/);
  f.binding.handoffIds = []; f.store.internalWrite('team:conversation:' + f.conversation.id, f.binding);
  await assert.rejects(f.service.invoke(f.input('team.handoffs.read', { id: f.handoff.id })), /not captured/);
});

test('team tool reads require an active original native execution and current agent', async t => {
  const f = fixture(t), read = () => f.service.invoke(f.input('team.handoffs.read', { id: f.handoff.id }));
  f.operation.cancelRequested = true; await assert.rejects(read(), /no longer running/); delete f.operation.cancelRequested;
  f.operation.state = 'unknown'; await assert.rejects(read(), /no longer running/); f.operation.state = 'running';
  f.operation.nativeKey += '-changed'; await assert.rejects(read(), /original team stage/); f.operation.nativeKey = f.conversation.nativeKey;
  f.operation.connectionGeneration = randomUUID(); await assert.rejects(read(), /original team stage/); f.operation.connectionGeneration = f.conversation.connectionGeneration;
  f.conversation.pendingSettings = { requestId: randomUUID() }; await assert.rejects(read(), /active Nova Dream/); delete f.conversation.pendingSettings;
  await assert.rejects(f.service.invoke({ ...f.input('team.handoffs.list'), epoch: randomUUID() }), /Reconnect/);
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'agent', entityId: f.agent.id, expectedRevision: f.agent.revision, payload: { ...f.agent.value, archived: true } });
  await assert.rejects(read(), /capability/);
});

test('unbound conversations and assignments cannot obtain team handoffs', async t => {
  const f = fixture(t);
  f.store.internalDelete('team:conversation:' + f.conversation.id);
  await assert.rejects(f.service.invoke(f.input('team.handoffs.list')), /original team stage/);
  const nativeKey = 'agent:edition3-assignment:e3-assignment-' + randomUUID();
  await assert.rejects(f.service.invoke({ ...f.input('team.handoffs.list'), nativeKey }), /original team stage/);
  assert.equal(f.assignedCalls, 0);
});

test('read completion suppresses results after binding access changes', async t => {
  const f = fixture(t);
  const pending = f.service.invoke(f.input('team.handoffs.read', { id: f.handoff.id }));
  f.binding.handoffIds = []; f.store.internalWrite('team:conversation:' + f.conversation.id, f.binding);
  await assert.rejects(pending, /changed before reading/);
});
