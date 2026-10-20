import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { prepareDirectAgentRequest, directAgentAcknowledgement } from '../apps/service/direct-agent-dispatch.js';
import { directConfigurationHash, directPluginId, directRuntimePolicy } from '../apps/service/direct-agent-runtime-policy.js';
import { captureDirectAgentBinding, captureDirectAgentTurn, directAgentNativeKey } from '../packages/domain/direct-agent.js';
import { blankRecord, type AgentDesign } from '../packages/domain/workspace-records.js';
import type { AssistantOperation, Conversation } from '../packages/domain/assistant.js';
import type { Entity } from '../packages/domain/contracts.js';

function fixture() {
  const epoch = randomUUID(), deviceId = 'synthetic-device', id = randomUUID(), at = new Date().toISOString();
  const agent: Entity<AgentDesign> = { id: 'agent:aster', revision: 1, updatedAt: at, deviceId,
    value: { ...blankRecord('agent', 'UTC') as AgentDesign, name: 'Aster', position: 'Research partner',
      instructions: 'Explain the sources.', access: { tasks: 'read' } } };
  const conversation: Conversation = {
    id, revision: 1, space: 'chat', title: 'Aster', projectId: null, archived: false, permissionMode: 'read-only',
    nativeKey: directAgentNativeKey(id), nativeId: randomUUID(), connectionGeneration: 'managed-generation', state: 'ready',
    model: 'synthetic/model', thinking: null, accountSelection: { profileId: 'synthetic-account', selectedAt: at }, createdAt: at, updatedAt: at,
    directAgent: captureDirectAgentBinding({ agentId: agent.id, agentRevision: 1 }, agent, { requestId: randomUUID(), deviceId, epoch }),
  };
  const original = { id: randomUUID(), requestId: randomUUID(), deviceId, epoch, capturedAt: at,
    account: { profileId: 'synthetic-account', model: 'synthetic/model' },
    sources: { projectId: null, projectRevision: 0, draftId: 'draft:original', draftRevision: 1, attachments: [], projectAttachments: [] } };
  const capture = captureDirectAgentTurn(conversation, original, agent, undefined);
  const operation: AssistantOperation = {
    ...original, conversationId: id, conversationRevision: 1, connectionGeneration: conversation.connectionGeneration,
    nativeKey: conversation.nativeKey, nativeId: conversation.nativeId!, nativeRunId: null, state: 'prepared',
    input: '/reset is quoted writing, not a command', context: { project: null, attachments: [], draftId: 'draft:original', draftRevision: 1, digest: 'a'.repeat(64), directAgent: capture },
    model: conversation.model, accountSelection: conversation.accountSelection, thinking: null, createdAt: at, updatedAt: at, text: '', lastSequence: 0,
  };
  const configuration = {
    plugins: { enabled: true, allow: [directPluginId], entries: { [directPluginId]: { enabled: true, config: { policySha256: '' } } } },
    cron: { enabled: false }, update: { checkOnStart: false, auto: { enabled: false } }, models: { catalogRefresh: { enabled: false } },
    agents: { defaults: { heartbeat: { every: '0m' } }, entries: { 'edition3-direct': { ...structuredClone(directRuntimePolicy), workspace: '/owned/direct-workspace', agentDir: '/owned/direct-agent' } } },
    gateway: { bind: 'loopback', controlUi: { enabled: false } },
  };
  const policySha256 = directConfigurationHash(configuration);
  configuration.plugins.entries[directPluginId].config.policySha256 = policySha256;
  const input: Parameters<typeof prepareDirectAgentRequest>[0] = {
    conversation, operation, currentAgent: agent, epoch, attachments: [],
    runtime: { version: '2026.9.8', generation: conversation.connectionGeneration, configuration, policySha256 },
    session: { key: conversation.nativeKey, id: conversation.nativeId!, lifecycleRevision: 'original-lifecycle', activeRunIds: [],
      accountId: 'synthetic-account', model: 'synthetic/model', permissionMode: 'read-only', permissionModePending: false },
  };
  return { input, conversation, operation, agent };
}
test('pure direct request binds exact original session, persona and request without a generic command envelope', () => {
  const f = fixture(), before = structuredClone(f.input), request = prepareDirectAgentRequest(f.input);
  assert.deepEqual(f.input, before);
  assert.equal(request.sessionKey, f.operation.nativeKey);
  assert.equal(request.expectedExistingSessionId, f.operation.nativeId);
  assert.equal(request.expectedExistingSessionLifecycleRevision, 'original-lifecycle');
  assert.equal(request.idempotencyKey, f.operation.requestId);
  assert.equal(request.promptMode, 'minimal'); assert.equal(request.bootstrapContextMode, 'lightweight'); assert.equal(request.deliver, false);
  assert.equal(request.message, `Owner message:\n${f.operation.input}`);
  assert.match(request.extraSystemPrompt, /Aster/); assert.match(request.extraSystemPrompt, /Explain the sources/);
  for (const field of ['provider', 'model', 'modelRun', 'runKind', 'cwd', 'agentId']) assert.equal(Object.hasOwn(request, field), false);
});
test('unknown, already sent, cancelled and retargeted operations cannot construct another dispatch', () => {
  for (const patch of [{ state: 'unknown' }, { state: 'dispatching' }, { state: 'completed' }, { nativeRunId: randomUUID() },
    { cancelRequested: true }, { steerTarget: randomUUID() }, { epoch: randomUUID() }, { requestId: randomUUID() }]) {
    const f = fixture(); Object.assign(f.input.operation, patch);
    assert.throws(() => prepareDirectAgentRequest(f.input));
  }
});
test('current recipient, account, project, native incarnation, activity and configuration all remain admission gates', () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.input.currentAgent.revision++; }, f => { f.input.currentAgent.value.instructions = 'new'; },
    f => { f.input.conversation.projectId = 'project:other'; }, f => { f.input.conversation.pendingResume = { requestId: randomUUID() }; },
    f => { f.input.session.accountId = 'other'; }, f => { f.input.session.model = 'other'; },
    f => { f.input.session.id = randomUUID(); }, f => { f.input.session.lifecycleRevision = ''; },
    f => { f.input.session.activeRunIds = ['active']; }, f => { f.input.session.permissionModePending = true; },
    f => { f.input.runtime.generation = 'replacement'; }, f => { (f.input.runtime.configuration as any).plugins.allow.push('unqualified'); },
  ];
  for (const change of changes) { const f = fixture(); change(f); assert.throws(() => prepareDirectAgentRequest(f.input)); }
});
test('only exact captured file bytes can become native attachments; substitutions remain refused', () => {
  const f = fixture(), bytes = Buffer.from('original file\n'), source = { id: 'file:original', name: 'note.txt', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  f.operation.context.attachments = [source]; f.operation.context.directAgent!.sources.attachments = [source];
  f.input.attachments = [{ source, bytes }];
  assert.equal(prepareDirectAgentRequest(f.input).attachments[0].content, bytes.toString('base64'));
  f.input.attachments[0].bytes = Buffer.from('different file');
  assert.throws(() => prepareDirectAgentRequest(f.input), /exact captured attachment/);
  f.input.attachments = []; assert.throws(() => prepareDirectAgentRequest(f.input), /captured attachments/);
});
test('only matching native acceptance is recognized; unknown replies remain original-observation only', () => {
  const f = fixture(), accepted = { runId: f.operation.requestId, status: 'accepted', sessionKey: f.operation.nativeKey, agentId: 'edition3-direct' };
  assert.equal(directAgentAcknowledgement(f.conversation, f.operation, accepted), 'accepted');
  for (const reply of [null, {}, { ...accepted, runId: randomUUID() }, { ...accepted, sessionKey: 'other' },
    { ...accepted, agentId: 'main' }, { ...accepted, status: 'completed' }])
    assert.equal(directAgentAcknowledgement(f.conversation, f.operation, reply), 'unknown');
});
test('native lifecycle guard preserves observed string or explicit null and refuses omitted or numeric shapes', () => {
  const f = fixture();
  f.input.session.lifecycleRevision = null;
  assert.equal(prepareDirectAgentRequest(f.input).expectedExistingSessionLifecycleRevision, null);
  delete (f.input.session as Partial<typeof f.input.session>).lifecycleRevision;
  assert.throws(() => prepareDirectAgentRequest(f.input));
  (f.input.session as any).lifecycleRevision = 3;
  assert.throws(() => prepareDirectAgentRequest(f.input));
});
