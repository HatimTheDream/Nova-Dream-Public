import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store, Fault } from '../apps/service/store.js';
import { AssistantGroups } from '../apps/service/assistant-groups.js';
import { AssistantGroupPreparations } from '../apps/service/assistant-group-turns.js';
import { AssistantGroupExecutions, groupExecutionQuery } from '../apps/service/assistant-group-execution.js';
import { GroupExecutionOwner, type GroupRuntimeIdentity } from '../apps/service/group-execution-owner.js';
import { directRuntimePolicy, directConfigurationHash, directPluginId } from '../apps/service/direct-agent-runtime-policy.js';
import { groupRuntimePolicy } from '../apps/service/group-runtime-policy.js';
import { groupExecutionPrefix, groupExecutionCommandSchema, groupExecutionViewSchema,
  groupExecutionRejectionSchema, type GroupExecution } from '../packages/domain/assistant-group-execution.js';
import { GroupReplyJournal, groupReplyKey } from '../apps/client/src/group-reply-journal.js';
import { ApiError } from '../apps/client/src/api.js';
import { groupDraftScopeSchema, parseGroupDraft, groupContextMessage, type GroupResponseRef,
  type GroupDraftScope, type PreparedGroupRound } from '../packages/domain/assistant-group-turns.js';
import { canonical } from '../packages/domain/contracts.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { groupAgentGatewaySchema, assertGroupGatewayRequest } from '../apps/service/group-execution-gateway.js';
import { phoneRouteAllowed } from '../apps/service/phone-policy.js';
import { inspectGroupContext, groupDigest } from '../apps/client/src/group-message-reader';
import { groupPreparationQuery } from '../apps/service/assistant-group-turns';
import { updateMaintenanceBlockers } from '../apps/service/update-maintenance.js';

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 50 && !predicate(); i++) await tick();
  assert(predicate(), 'the bounded original synthetic transition was reached');
}
/** Disposable encrypted Store and actual authority/controller; every Gateway
 * reply is synthetic. No listener, native process or provider is started. */
function fixture(t: TestContext, members = 1, privateOwner = false) {
  const parent = resolve('.tmp-qa/group-execution'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'case-')), store = new Store(directory);
  const device = store.session().deviceId, epoch = store.epoch, groupId = randomUUID(), generation = randomUUID();
  if (privateOwner) store.mutate(device, { requestId: randomUUID(), epoch, kind: 'profile', entityId: 'profile:owner',
    expectedRevision: 0, payload: { ...blankRecord('profile', 'UTC'), name: 'Private Owner Name',
      about: 'Private biography must not become historical model context.' } });
  const agents = Array.from({ length: members }, (_, i) => store.mutate(device, {
    requestId: randomUUID(), epoch, kind: 'agent', entityId: `agent:member-${i}`, expectedRevision: 0,
    payload: { ...blankRecord('agent', 'UTC'), name: `Member ${i}`, position: 'Research Partner', access: { content: 'read' } },
  }));
  new AssistantGroups(store).save(device, { requestId: randomUUID(), epoch, groupId, expectedRevision: 0,
    action: 'create', title: 'Original Group', projectId: null,
    members: agents.map(agent => ({ agentId: agent.id, agentRevision: 1 })), defaultAgentId: agents[0].id });
  const group = store.readAssistantGroup(groupId);
  const scope = groupDraftScopeSchema.parse({ format: 1, epoch, deviceId: device, windowId: randomUUID(), groupId,
    groupRevision: 1, membershipRevision: 1, defaultRevision: 1, mode: 'everyone', project: null,
    recipients: group.group!.activeMembershipIds.map(membershipId => ({ membershipId, agentRevision: 1 })) });
  const preparations = new AssistantGroupPreparations(store);
  const draft = preparations.save(device, { requestId: randomUUID(), epoch, groupId, action: 'save-draft',
    scope, expectedRaw: null, text: 'Use this exact shared owner input.', sources: [], history: [] });
  const prepared = preparations.save(device, { requestId: randomUUID(), epoch, groupId, action: 'prepare',
    draftId: parseGroupDraft(draft.draftRaw!).id, expectedRaw: draft.draftRaw, expectedSequence: 1 });
  const round = store.readGroupPreparation(groupId).preparation.rounds.get(prepared.roundId!)!;
  const configuration = {
    cron: { enabled: false }, update: { checkOnStart: false, auto: { enabled: false } },
    models: { catalogRefresh: { enabled: false } },
    plugins: { enabled: true, allow: [directPluginId], entries: { [directPluginId]: { enabled: true, config: { policySha256: '' } } } },
    agents: { defaults: { skipBootstrap: true, heartbeat: { every: '0m' } }, entries: {
      'edition3-direct': { ...structuredClone(directRuntimePolicy), workspace: '/fixture/direct', agentDir: '/fixture/direct-agent' },
      'edition3-group': { ...structuredClone(groupRuntimePolicy), workspace: '/fixture/group', agentDir: '/fixture/group-agent' },
    } }, gateway: { bind: 'loopback', controlUi: { enabled: false } },
  };
  const sourcePolicySha256 = directConfigurationHash(configuration);
  configuration.plugins.entries[directPluginId].config.policySha256 = sourcePolicySha256;
  let runtime: GroupRuntimeIdentity | undefined = { epoch, pid: 1001, startedAt: Date.now(), generation, version: '2026.9.8',
    url: 'ws://127.0.0.1:49111', sourcePolicySha256, pluginSha256: 'b'.repeat(64), configuration };
  let registrationId = randomUUID(), policyFailure = false, lostCreate = false, lostSend = false, policySha256 = sourcePolicySha256;
  let accountIdentity = 'a'.repeat(64), accountUnavailable = false, lostAbort = false,
    onAccount = () => {}, holdAccount: Promise<void> | undefined;
  let terminalReply: Record<string, unknown> | undefined;
  let onAgent = (_input: any) => {};
  const sessions = new Map<string, string>(), calls: { method: string; input: any }[] = [], listeners = new Set<(event: any) => void>();
  const gateway: AssistantTransport = {
    status: () => ({ state: 'ready', generation, url: 'ws://127.0.0.1:49111', message: 'Synthetic only',
      modelAuthReady: true, grantedScopes: ['operator.read', 'operator.write'],
      methods: ['e3.group.policy', 'e3.accounts.group-profile', 'e3.accounts.group-identity', 'sessions.create', 'agent', 'chat.history', 'agent.wait', 'chat.abort'] }),
    models: async () => [], attachmentPolicy: () => ({}),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async request<T>(method: string, input: any): Promise<T> {
      calls.push({ method, input });
      if (method === 'e3.group.policy') {
        if (policyFailure) throw Error('Synthetic pre-send policy refusal');
        const id = sessions.get(input.nativeKey);
        return { format: 1, epoch, agentId: 'edition3-group', registrationId, sourcePolicySha256,
          policySha256, nativeKey: input.nativeKey, session: id ? {
            id, key: input.nativeKey, lifecycleRevision: 'fixture-revision', permissionMode: 'read-only',
            permissionModePending: false, accountId: 'openai:fixture', model: 'openai/synthetic',
          } : null } as T;
      }
      if (method === 'e3.accounts.group-profile' || method === 'e3.accounts.group-identity') {
        await holdAccount; onAccount();
        if (method === 'e3.accounts.group-profile' && accountUnavailable) throw Error('Synthetic account not ready');
        return { format: 1, epoch, agentId: 'edition3-group', profileId: input.profileId, identityKey: accountIdentity,
          ...(method === 'e3.accounts.group-profile' ? { expiresAt: Date.now() + 600000, ready: true } : {}) } as T;
      }
      if (method === 'sessions.create') {
        assert.equal(input.emitCommandHooks, false); assert.equal(input.permissionMode, 'read-only');
        assert.equal(input.model, 'openai/synthetic@openai:fixture');
        const id = randomUUID(); sessions.set(input.key, id);
        if (lostCreate) throw Error('Synthetic lost creation response after acceptance');
        return { key: input.key, sessionId: id, runStarted: false,
          entry: { sessionId: id, permissionMode: 'read-only', permissionModePending: false } } as T;
      }
      if (method === 'chat.history') return { sessionId: sessions.get(input.sessionKey), messages: [],
        sessionInfo: { activeRunIds: [], hasActiveRun: false } } as T;
      if (method === 'agent') {
        groupAgentGatewaySchema.parse(input); onAgent(input);
        if (lostSend) throw Error('Synthetic lost acceptance response');
        return { runId: input.idempotencyKey, sessionKey: input.sessionKey, agentId: 'edition3-group', status: 'accepted' } as T;
      }
      if (method === 'agent.wait') return (terminalReply ?? { runId: input.runId, status: 'running' }) as T;
      if (method === 'chat.abort') { if (lostAbort) throw Error('Synthetic lost abort acknowledgement'); return { ok: true } as T; }
      throw Error('Unexpected synthetic request: ' + method);
    },
  };
  const owner = new GroupExecutionOwner(store, gateway, () => runtime);
  let service = new AssistantGroupExecutions(store, gateway, owner);
  t.after(async () => { await service.close(); store.close(); });
  const child = (i = 0) => store.readGroupExecution(groupId, round.recipients[i].attempt.id)?.value;
  const input = (action: string, extra: object = {}, i = 0) => groupExecutionCommandSchema.parse({
    requestId: randomUUID(), epoch, groupId, roundId: round.id, roundSha256: digest(round),
    attemptId: round.recipients[i].attempt.id, expectedRevision: child(i)?.revision ?? 0, action, ...extra,
  });
  const setup = (i = 0) => service.command(device, input('setup', { account: { profileId: 'openai:fixture', model: 'openai/synthetic' } }, i));
  const observe = (i = 0) => service.observe(device, { epoch, groupId, attemptId: round.recipients[i].attempt.id,
    expectedRevision: child(i)!.revision });
  const capture = () => { const { id: _id, createdAt: _at, ...value } = store.captureBackup('synthetic-group', { status: 'not-configured', notes: [] }); return value; };
  return { store, device, epoch, directory, groupId, agents, round, preparations, scope, calls, sessions, owner, gateway, child, input, setup, observe, capture,
    get service() { return service; }, count: (method: string) => calls.filter(call => call.method === method).length,
    failPolicy(value: boolean) { policyFailure = value; }, loseCreate() { lostCreate = true; }, loseSend() { lostSend = true; },
    onAccount(fn: () => void) { onAccount = fn; }, holdAccount(value: Promise<void> | undefined) { holdAccount = value; },
    replaceAccount() { accountIdentity = 'c'.repeat(64); }, replaceRuntime() { runtime = runtime && { ...runtime, pid: 1002 }; },
    accountUnavailable(value: boolean) { accountUnavailable = value; }, loseAbort() { lostAbort = true; },
    replaceRuntimeStart() { runtime = runtime && { ...runtime, startedAt: runtime.startedAt + 1 }; },
    replacePolicy() { policySha256 = 'd'.repeat(64); },
    replaceRegistration() { registrationId = randomUUID(); },
    terminal(value: Record<string, unknown>) { terminalReply = value; },
    onAgent(fn: (input: any) => void) { onAgent = fn; },
    emit(event: any) { for (const listener of listeners) listener(event); },
    async restartController() { await service.close(); service = new AssistantGroupExecutions(store, gateway, new GroupExecutionOwner(store, gateway, () => runtime)); },
  };
}

async function completedContribution(f: ReturnType<typeof fixture>, round = f.round, i = 0, text = 'Selected original contribution.') {
  const attemptId = round.recipients[i].attempt.id;
  const original = () => f.store.readGroupExecution(f.groupId, attemptId)!.value;
  const base = { epoch: f.epoch, groupId: f.groupId, roundId: round.id, roundSha256: digest(round), attemptId };
  await f.service.command(f.device, { ...base, action: 'setup', requestId: randomUUID(), expectedRevision: 0,
    account: { profileId: 'openai:fixture', model: 'openai/synthetic' } });
  const requestId = randomUUID();
  await f.service.command(f.device, { ...base, action: 'send', requestId, expectedRevision: original().revision });
  f.terminal({ runId: requestId, status: 'ok',
    terminalReceipt: { runId: requestId, sessionId: original().nativeId, turnId: 'turn-' + attemptId,
      effective: { provider: 'openai', model: 'synthetic' } }, terminalReply: { text } });
  await f.service.observe(f.device, { epoch: f.epoch, groupId: f.groupId, attemptId, expectedRevision: original().revision });
  const view = f.preparations.read(f.device, { view: 'responses', groupId: f.groupId, roundId: round.id, roundSha256: digest(round) });
  assert('responses' in view);
  const result = view.responses[i]; assert(result.selectable && result.ref);
  return result.ref;
}

test('context inspection and history preview bind the exact completed author and inherited replies without native calls', async t => {
  const f = fixture(t), ref = await completedContribution(f);
  const next = prepareResponseDraft(f, responseDraft(f, [ref]).draftRaw!);
  const selected = await completedContribution(f, next, 0, 'Later contribution with earlier context.');
  const before = f.capture(), calls = f.calls.length;
  const get = async (path: string) => f.preparations.read(f.device, groupPreparationQuery(new URL(path, 'http://fixture').searchParams));
  const inspected = await inspectGroupContext(f.epoch, f.groupId, selected, get);
  assert.equal(inspected.reply!.text, 'Later contribution with earlier context.');
  assert('responses' in inspected.round.context);
  assert.equal(inspected.round.context.responses[0].attemptId, ref.attemptId);
  const preparation = f.store.readGroupPreparation(f.groupId).preparation;
  const command = { action: 'grant-history-v2', requestId: randomUUID(), epoch: f.epoch, groupId: f.groupId,
    expectedGroupRevision: next.scope.groupRevision, expectedSequence: preparation.events.length,
    throughSequence: preparation.events.length, membershipId: next.recipients[0].membership.id,
    history: [], responses: [selected] };
  const preview = f.preparations.preview(f.device, command);
  assert('includedResponses' in preview);
  assert.deepEqual(preview.includedResponses.map(r => r.attemptId), [ref.attemptId, selected.attemptId]);
  assert.deepEqual(preview.includedHistory.map(r => r.roundId), [f.round.id, next.id]);
  assert.deepEqual(f.capture(), before); assert.equal(f.calls.length, calls);
  assert(phoneRouteAllowed('/api/assistant/group-preparations/preview', 'POST'));
  for (const method of ['GET', 'DELETE', 'PUT']) assert.equal(phoneRouteAllowed('/api/assistant/group-preparations/preview', method), false);
});

test('reply context inspection rejects mismatched terminal references, authors and contradictory eligibility', async t => {
  const f = fixture(t), ref = await completedContribution(f);
  const get = async (path: string) => f.preparations.read(f.device, groupPreparationQuery(new URL(path, 'http://fixture').searchParams));
  await assert.rejects(inspectGroupContext(f.epoch, f.groupId, { ...ref, terminalSha256: 'f'.repeat(64) }, get), /completed reply/);
  for (const patch of [{ author: { agentId: 'agent:wrong', agentRevision: 1, membershipId: randomUUID(), name: 'Wrong', position: '' } },
    { reason: 'not-completed' }, { state: 'unknown' }]) {
    await assert.rejects(inspectGroupContext(f.epoch, f.groupId, ref, async path => {
      const result = await get(path);
      if (!('responses' in result)) return result;
      const responses = result.responses.map((row, i) => i ? row : { ...row, ...patch });
      return { ...result, responses, sha256: await groupDigest(responses) };
    }), /completed reply/);
  }
});
function responseDraft(f: ReturnType<typeof fixture>, responses: GroupResponseRef[], scope: GroupDraftScope = { ...f.scope, windowId: randomUUID() }) {
  return f.preparations.save(f.device, { requestId: randomUUID(), epoch: f.epoch, groupId: f.groupId,
    action: 'save-draft-v2', scope, expectedRaw: null, text: 'Use only these selected completed contributions.',
    sources: [], history: [], responses });
}
function prepareResponseDraft(f: ReturnType<typeof fixture>, raw: string) {
  const preparation = f.store.readGroupPreparation(f.groupId).preparation;
  const receipt = f.preparations.save(f.device, { requestId: randomUUID(), epoch: f.epoch, groupId: f.groupId,
    action: 'prepare', draftId: parseGroupDraft(raw).id, expectedRaw: raw, expectedSequence: preparation.events.length });
  return f.store.readGroupPreparation(f.groupId).preparation.rounds.get(receipt.roundId!)!;
}

test('completed contributions have exact readonly references and explicit transitive common context', async t => {
  const f = fixture(t, 2, true), ref = await completedContribution(f);
  const before = f.capture(), calls = f.calls.length;
  const view = f.preparations.read(randomUUID(), { view: 'responses', groupId: f.groupId,
    roundId: f.round.id, roundSha256: digest(f.round) });
  assert('responses' in view); assert.equal(view.responses[0].selectable, true);
  assert.equal(view.responses[1].selectable, false); assert.equal(view.responses[1].ref, null);
  assert.deepEqual(f.capture(), before); assert.equal(f.calls.length, calls);
  assert.doesNotMatch(JSON.stringify(view), /Private biography|accountIdentity|sourcePolicy|instructions|knowledge/);
  const next = prepareResponseDraft(f, responseDraft(f, [ref]).draftRaw!);
  assert.equal(next.format, 2); assert('responses' in next.context);
  assert.equal(next.context.responses.length, 1);
  assert.deepEqual(next.context.responses[0].author, view.responses[0].author);
  const message = groupContextMessage(next.text, next.context, f.store.readGroupPreparation(f.groupId).preparation.rounds);
  assert.match(message, /Selected original contribution/); assert.doesNotMatch(message, /Private Owner|Private biography/);
  const second = await completedContribution(f, next, 0, 'A response using the first response.');
  const third = prepareResponseDraft(f, responseDraft(f, [second]).draftRaw!);
  assert('responses' in third.context);
  assert.deepEqual(third.context.responses.map(row => row.attemptId), [ref.attemptId, second.attemptId]);
  assert.equal(third.context.history.length, 2);
  // Completing an unselected sibling later cannot rewrite either prepared input.
  await completedContribution(f, f.round, 1, 'A late sibling is never selected automatically.');
  assert.deepEqual(f.store.readGroupPreparation(f.groupId).preparation.rounds.get(third.id), third);
  assert.doesNotMatch(groupContextMessage(third.text, third.context,
    f.store.readGroupPreparation(f.groupId).preparation.rounds), /late sibling/);
  f.capture();
});

test('changed completed references refuse preparation and preserve exact saved writing with no native calls', async t => {
  const f = fixture(t), ref = await completedContribution(f);
  for (const changed of [{ ...ref, roundId: randomUUID() }, { ...ref, attemptId: randomUUID() },
    { ...ref, terminalSequence: ref.terminalSequence - 1 }, { ...ref, terminalSha256: 'f'.repeat(64) }]) {
    const draft = responseDraft(f, [changed]), before = f.capture(), calls = f.calls.length;
    assert.throws(() => prepareResponseDraft(f, draft.draftRaw!), /unavailable|does not match|future or current/);
    assert.deepEqual(f.capture(), before); assert.equal(f.calls.length, calls);
  }
  assert.throws(() => f.preparations.read(f.device, { view: 'responses', groupId: f.groupId,
    roundId: f.round.id, roundSha256: 'f'.repeat(64) }), /exact original/);
});

test('partial, failed, cancelled and unidentified terminal replies remain unselectable', async t => {
  for (const state of ['accepted', 'failed', 'cancelled', 'completed'] as const) {
    const f = fixture(t); await f.setup(); await f.service.command(f.device, f.input('send'));
    const child = f.child()!;
    if (state !== 'accepted') f.store.recordGroupExecutionObservation(f.groupId, child.binding.attemptId,
      digest(child), { kind: 'terminal', runId: child.send!.requestId, nativeId: child.nativeId!,
        proof: child.send!.proof!, state, text: 'Preserved output without eligible completion.',
        nativeTurnId: state === 'completed' ? null : 'original-turn', effectiveModel: 'synthetic' });
    const before = f.capture(), calls = f.calls.length;
    const view = f.preparations.read(f.device, { view: 'responses', groupId: f.groupId,
      roundId: f.round.id, roundSha256: digest(f.round) });
    assert('responses' in view); assert.equal(view.responses[0].selectable, false);
    assert.equal(view.responses[0].ref, null); assert.equal(view.responses[0].state, state);
    assert.equal(f.calls.length, calls); assert.deepEqual(f.capture(), before);
  }
});

test('the stricter native message bound is enforced before a response-aware round is prepared', async t => {
  const f = fixture(t), ref = await completedContribution(f, f.round, 0, 'x'.repeat(250000));
  const draft = responseDraft(f, [ref]), before = f.capture(), calls = f.calls.length;
  assert.throws(() => prepareResponseDraft(f, draft.draftRaw!), /native message byte bound/);
  assert.deepEqual(f.capture(), before); assert.equal(f.calls.length, calls);
});

test('response-aware upgrade uses exact old draft bytes and cannot downgrade or reinterpret old receipts', t => {
  const f = fixture(t), bundle = f.store.readGroupPreparation(f.groupId).preparation;
  const original = bundle.events[0], oldRaw = bundle.drafts.get(f.round.draftId)!;
  const command = { requestId: randomUUID(), epoch: f.epoch, groupId: f.groupId, action: 'save-draft-v2',
    scope: f.scope, expectedRaw: oldRaw, text: 'Explicit upgrade', sources: [], history: [], responses: [] };
  assert.throws(() => f.preparations.save(f.device, { ...command, expectedRaw: oldRaw + ' ' }), /original draft changed/);
  const saved = f.preparations.save(f.device, command); assert.equal(parseGroupDraft(saved.draftRaw!).format, 2);
  const before = f.capture();
  assert.throws(() => f.preparations.save(f.device, { requestId: randomUUID(), epoch: f.epoch, groupId: f.groupId,
    action: 'save-draft', scope: f.scope, expectedRaw: saved.draftRaw, text: 'Older client', sources: [], history: [] }), /downgraded/);
  assert.deepEqual(f.capture(), before);
  assert.deepEqual(f.store.readGroupPreparation(f.groupId).preparation.events[0], original);
  assert.equal('responses' in original.command, false);
  assert.deepEqual(f.preparations.save(f.device, command), saved);
});

test('new memberships need explicit reply closure grants; an old input grant or removed membership cannot authorize reuse', async t => {
  const f = fixture(t), ref = await completedContribution(f), groups = new AssistantGroups(f.store);
  const b = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.epoch, kind: 'agent',
    entityId: 'agent:late-member', expectedRevision: 0,
    payload: { ...blankRecord('agent', 'UTC'), name: 'Late Member', position: 'Reviewer', access: { content: 'read' } } });
  const metadata = (action: object) => groups.save(f.device, { requestId: randomUUID(), epoch: f.epoch,
    groupId: f.groupId, expectedRevision: f.store.readAssistantGroup(f.groupId).group!.revision, ...action });
  const add = () => metadata({ action: 'add-members', members: [{ agentId: b.id, agentRevision: 1 }], defaultAgentId: null });
  const scope = () => {
    const group = f.store.readAssistantGroup(f.groupId).group!;
    return { ...f.scope, windowId: randomUUID(), groupRevision: group.revision,
      membershipRevision: group.membershipRevision, defaultRevision: group.defaultRevision,
      recipients: group.activeMembershipIds.map(membershipId => ({ membershipId, agentRevision: 1 })) };
  };
  add();
  const member = f.store.readAssistantGroup(f.groupId).group!.activeMembershipIds[1];
  const grant = (action: 'grant-history' | 'grant-history-v2') => f.preparations.save(f.device, {
    requestId: randomUUID(), epoch: f.epoch, groupId: f.groupId, action,
    expectedGroupRevision: f.store.readAssistantGroup(f.groupId).group!.revision,
    expectedSequence: f.store.readGroupPreparation(f.groupId).preparation.events.length,
    membershipId: member, throughSequence: f.round.sequence,
    history: [{ roundId: f.round.id, sha256: digest(f.round) }], ...(action === 'grant-history-v2' ? { responses: [ref] } : {}),
  });
  const blocked = responseDraft(f, [ref], scope());
  assert.throws(() => prepareResponseDraft(f, blocked.draftRaw!), /history has not been explicitly shared/);
  grant('grant-history');
  assert.throws(() => prepareResponseDraft(f, blocked.draftRaw!), /completed replies have not been explicitly shared/);
  grant('grant-history-v2');
  const accepted = prepareResponseDraft(f, blocked.draftRaw!); assert.equal(accepted.recipients.length, 2);
  metadata({ action: 'remove-member', membershipId: member, replacementMembershipId: null }); add();
  assert.notEqual(f.store.readAssistantGroup(f.groupId).group!.activeMembershipIds[1], member);
  const readded = responseDraft(f, [ref], scope());
  assert.throws(() => prepareResponseDraft(f, readded.draftRaw!), /history has not been explicitly shared/);
  f.capture();
});

test('complete joined backup refuses response graph corruption, orphaned children and missing original receipts', async t => {
  const f = fixture(t), ref = await completedContribution(f);
  prepareResponseDraft(f, responseDraft(f, [ref]).draftRaw!);
  const original = f.store.captureBackup('synthetic-only', { status: 'not-configured', notes: [] });
  const mutations: ((copy: typeof original) => void)[] = [
    copy => { copy.services = copy.services.filter(row => !row.id.startsWith(groupExecutionPrefix)); },
    copy => { copy.receipts = copy.receipts.filter(row => (row.value as any)?.kind !== 'assistant-group-execution-receipt'); },
    copy => { copy.services = copy.services.filter(row => !row.id.includes(':event:002')); },
    copy => { const child = copy.services.find(row => row.id.startsWith(groupExecutionPrefix) && row.id.endsWith(':current'))!;
      (child.value as any).text = 'Changed text'; },
    copy => { copy.services.push(structuredClone(copy.services.find(row => row.id.startsWith(groupExecutionPrefix))!)); },
    copy => { copy.schema = 58; },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(original); mutate(copy); assert.throws(() => Store.verifyBackup(copy));
  }
  Store.verifyBackup(original);
});

test('a completion after joining still carries the original pre-membership input boundary', async t => {
  const f = fixture(t); await f.setup(); await f.service.command(f.device, f.input('send'));
  const original = f.child()!, agent = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.epoch,
    kind: 'agent', entityId: 'agent:joining-during-send', expectedRevision: 0,
    payload: { ...blankRecord('agent', 'UTC'), name: 'New Member', position: 'Reviewer' } });
  new AssistantGroups(f.store).save(f.device, { requestId: randomUUID(), epoch: f.epoch, groupId: f.groupId,
    expectedRevision: 1, action: 'add-members', members: [{ agentId: agent.id, agentRevision: 1 }], defaultAgentId: null });
  f.terminal({ runId: original.send!.requestId, status: 'ok',
    terminalReceipt: { runId: original.send!.requestId, sessionId: original.nativeId, turnId: 'completed-after-join',
      effective: { provider: 'openai', model: 'synthetic' } }, terminalReply: { text: 'Reply to earlier private Group input.' } });
  await f.observe();
  const view = f.preparations.read(f.device, { view: 'responses', groupId: f.groupId,
    roundId: f.round.id, roundSha256: digest(f.round) }); assert('responses' in view);
  const group = f.store.readAssistantGroup(f.groupId).group!;
  const scope = { ...f.scope, windowId: randomUUID(), groupRevision: group.revision,
    membershipRevision: group.membershipRevision, defaultRevision: group.defaultRevision,
    recipients: group.activeMembershipIds.map(membershipId => ({ membershipId, agentRevision: 1 })) };
  const draft = responseDraft(f, [view.responses[0].ref!], scope), before = f.capture();
  assert.throws(() => prepareResponseDraft(f, draft.draftRaw!), /history has not been explicitly shared/);
  assert.deepEqual(f.capture(), before);
});

test('a selected reply carries exact inherited source versions and refuses later source changes', async t => {
  const f = fixture(t), source = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.epoch,
    kind: 'content', entityId: 'content:reply-source', expectedRevision: 0,
    payload: { ...blankRecord('content', 'UTC'), title: 'Provided Source', body: 'Original shared version' } });
  const draft = f.preparations.save(f.device, { requestId: randomUUID(), epoch: f.epoch, groupId: f.groupId,
    action: 'save-draft-v2', scope: { ...f.scope, windowId: randomUUID() }, expectedRaw: null,
    text: 'Use the original source.', sources: [{ kind: 'content', id: source.id, revision: 1, sha256: digest(source.value) }],
    history: [], responses: [] });
  const round = prepareResponseDraft(f, draft.draftRaw!), ref = await completedContribution(f, round);
  const selected = responseDraft(f, [ref]), accepted = prepareResponseDraft(f, selected.draftRaw!);
  assert.deepEqual(accepted.context.sources, round.context.sources);
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.epoch, kind: 'content', entityId: source.id,
    expectedRevision: 1, payload: { ...(source.value as Record<string, unknown>), body: 'A later source version' } });
  const next = responseDraft(f, [ref]), before = f.capture(), calls = f.calls.length;
  assert.throws(() => prepareResponseDraft(f, next.draftRaw!), /exact provided source changed/);
  assert.deepEqual(f.capture(), before); assert.equal(f.calls.length, calls);
});

test('setup availability is exact-device read-only local admission, never account or send readiness', async t => {
  const f = fixture(t), before = f.capture();
  const query = { view: 'availability', groupId: f.groupId, roundId: f.round.id,
    roundSha256: digest(f.round), attemptId: f.round.recipients[0].attempt.id };
  const parsed = groupExecutionQuery(new URLSearchParams(query));
  const value = f.service.readQuery(f.device, parsed) as ReturnType<AssistantGroupExecutions['setupAvailability']>;
  assert.equal(value.availableForExplicitSetup, true);
  assert.equal(value.accountReadiness, 'not-observed'); assert.equal(value.sendReadiness, 'not-admitted');
  assert.equal(f.store.groupPreparationAvailability(f.round).execution, 'unavailable');
  assert.throws(() => f.service.readQuery(randomUUID(), parsed));
  assert.throws(() => f.service.readQuery(f.device, { ...query, roundSha256: 'f'.repeat(64) }));
  assert.throws(() => f.service.readQuery(f.device, { ...query, attemptId: randomUUID() }));
  assert.throws(() => groupExecutionQuery(new URLSearchParams({ ...query, refresh: 'true' })));
  assert.equal(f.calls.length, 0); assert.deepEqual(f.capture(), before);
  const status = f.gateway.status();
  const mocked = t.mock.method(f.gateway, 'status', () => ({ ...status, methods: [] }));
  assert.equal(f.service.setupAvailability(f.device, query).reason, 'group_runtime_unavailable');
  assert.equal(f.calls.length, 0); assert.deepEqual(f.capture(), before); mocked.mock.restore();
  await f.setup();
  const saved = f.capture(), calls = f.calls.length;
  assert.equal(f.service.setupAvailability(f.device, query).reason, 'group_original_exists');
  assert.equal(f.calls.length, calls); assert.deepEqual(f.capture(), saved);
});

test('setup availability rechecks current permission without mutating the prepared input', t => {
  const f = fixture(t);
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.epoch, kind: 'agent', entityId: f.agents[0].id,
    expectedRevision: 1, payload: { ...(f.agents[0].value as Record<string, unknown>), access: {} } });
  const before = f.capture();
  const value = f.service.setupAvailability(f.device, { view: 'availability', groupId: f.groupId,
    roundId: f.round.id, roundSha256: digest(f.round), attemptId: f.round.recipients[0].attempt.id });
  assert.equal(value.availableForExplicitSetup, false); assert.equal(value.reason, 'group_recipient_changed');
  assert.equal(f.calls.length, 0); assert.deepEqual(f.capture(), before);
});

test('one original child setup/send and saved authenticated reply, with independent sibling context and no replay', async t => {
  const f = fixture(t, 2), first = await f.setup(), setupCalls = f.count('sessions.create');
  const command = f.input('send'); await f.service.command(f.device, command);
  const sent = f.child()!, params = f.calls.find(row => row.method === 'agent')!.input;
  assert.match(params.extraSystemPrompt, /Member 0/); assert.doesNotMatch(params.extraSystemPrompt, /Member 1/);
  assert.equal(params.message.includes('Use this exact shared owner input.'), true);
  assert.equal(params.deliver, false); assert.deepEqual(params.attachments, []);
  await f.service.command(f.device, command); assert.equal(f.count('agent'), 1);
  await f.setup(1); assert.equal(f.count('sessions.create'), setupCalls + 1);
  assert.notEqual(f.child(1)!.binding.nativeKey, sent.binding.nativeKey);
  f.terminal({ runId: command.requestId, status: 'ok',
    terminalReceipt: { runId: command.requestId, sessionId: sent.nativeId, turnId: 'original-turn',
      effective: { provider: 'openai', model: 'synthetic' } }, terminalReply: { text: 'Genuine synthetic original reply.' } });
  await f.observe(); assert.equal(f.child()!.send!.state, 'completed');
  assert.equal(f.child()!.text, 'Genuine synthetic original reply.');
  assert.equal(f.child(1)!.send, null); assert.equal(first.receipt.attemptId, sent.binding.attemptId);
  f.capture();
});
test('lost setup response survives controller restart and observes only its original native key', async t => {
  const f = fixture(t); f.loseCreate(); await f.setup();
  assert.equal(f.child()!.setup.state, 'unknown'); assert.equal(f.child()!.setup.dispatchStarted, true);
  await f.restartController(); await f.observe();
  assert.equal(f.child()!.setup.state, 'ready'); assert.equal(f.count('sessions.create'), 1);
  assert.equal(f.count('agent'), 0);
});
test('confirmed no-dispatch continuation binds exact failed snapshot and preserves original native request', async t => {
  const f = fixture(t); f.failPolicy(true); await f.setup();
  const failed = f.child()!; assert.equal(failed.setup.state, 'failed'); assert.equal(f.count('sessions.create'), 0);
  const continuation = f.input('continue-unsent', { phase: 'setup', originalRequestId: failed.setup.requestId, expectedSha256: digest(failed) });
  await assert.rejects(f.service.command(f.device, { ...continuation, expectedSha256: '0'.repeat(64) }), /confirmed unsent/);
  await assert.rejects(f.service.command(randomUUID(), continuation), /scope changed/);
  f.failPolicy(false); await f.service.command(f.device, continuation); await f.service.command(f.device, continuation);
  assert.equal(f.count('sessions.create'), 1);
  assert.equal(f.calls.find(row => row.method === 'sessions.create')!.input.idempotencyKey, failed.setup.requestId);
  assert.equal(f.child()!.setup.requestId, failed.setup.requestId);
  const originalView = f.service.read(f.device, { groupId: f.groupId, attemptId: failed.binding.attemptId,
    requestId: failed.setup.requestId });
  assert.equal(originalView.originalReceipt!.requestId, failed.setup.requestId);
  assert.notEqual(originalView.originalReceipt!.requestId, continuation.requestId);
  assert.throws(() => f.service.read(f.device, { groupId: f.groupId, attemptId: failed.binding.attemptId, requestId: randomUUID() }), /no admitted command/);
  assert(f.store.readGroupExecution(f.groupId, failed.binding.attemptId)!.events.some(event => canonical(event.value) === canonical(failed)));
});
test('failure after dispatch marker can never be continued, and mismatched terminal proof cannot settle it', async t => {
  const f = fixture(t); await f.setup(); f.loseSend();
  const command = f.input('send'); await f.service.command(f.device, command);
  const original = f.child()!; assert.equal(original.send!.state, 'unknown');
  await assert.rejects(f.service.command(f.device, f.input('continue-unsent', {
    phase: 'send', originalRequestId: command.requestId, expectedSha256: digest(original),
  })), /confirmed unsent/);
  f.terminal({ runId: command.requestId, status: 'ok', terminalReceipt: { runId: command.requestId, sessionId: randomUUID() },
    terminalReply: { text: 'Wrong session' } });
  await f.observe(); assert.equal(f.child()!.send!.state, 'unknown'); assert.equal(f.count('agent'), 1);
});
test('revocation during the final account await prevents any provider send without losing the original preparation', async t => {
  const f = fixture(t); await f.setup();
  f.onAccount(() => {
    const a = f.store.readEntity('agent', f.agents[0].id)!;
    f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.epoch, kind: 'agent', entityId: a.id,
      expectedRevision: a.revision, payload: { ...a.value, access: {} } });
  });
  await f.service.command(f.device, f.input('send'));
  assert.equal(f.count('agent'), 0); assert.equal(f.child()!.send!.state, 'failed');
  assert.equal(f.child()!.send!.dispatchStarted, false);
  assert.deepEqual(f.store.readGroupPreparation(f.groupId).preparation.rounds.get(f.round.id), f.round);
});
test('account or registration replacement refuses new work under the old original session', async t => {
  const f = fixture(t); await f.setup(); f.replaceAccount();
  await f.service.command(f.device, f.input('send'));
  assert.equal(f.count('agent'), 0); assert.equal(f.child()!.send!.state, 'failed');
  f.replaceRegistration(); await assert.rejects(f.observe(), /registration/);
});
test('close awaits the exact pending read and cannot turn its interrupted preparing state into no-send proof', async t => {
  const f = fixture(t); let release!: () => void;
  f.holdAccount(new Promise<void>(resolve => { release = resolve; }));
  const pending = f.setup(); await until(() => f.count('e3.accounts.group-profile') === 1);
  let closed = false; const closing = f.service.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  release(); await Promise.allSettled([pending, closing]);
  assert.equal(closed, true); assert.equal(f.count('sessions.create'), 0);
  assert.equal(f.child()!.setup.state, 'preparing');
  await f.restartController();
  const original = f.child()!;
  await assert.rejects(f.service.command(f.device, f.input('continue-unsent', {
    phase: 'setup', originalRequestId: original.setup.requestId, expectedSha256: digest(original),
  })), /confirmed unsent/);
});
test('stop acknowledgement stays unconfirmed and cannot be repeated as a new original command', async t => {
  const f = fixture(t); await f.setup(); await f.service.command(f.device, f.input('send'));
  const stop = f.input('stop'); await f.service.command(f.device, stop); await f.service.command(f.device, stop);
  assert.equal(f.count('chat.abort'), 1); assert.equal(f.child()!.stop!.state, 'unconfirmed');
  await assert.rejects(f.service.command(f.device, f.input('stop')), /no new stop/);
});
test('cached read is pure; protected writes and orphan receipts fail complete backup verification', async t => {
  const f = fixture(t); await f.setup();
  const original = f.child()!, before = f.capture(), calls = f.calls.length;
  f.service.read(f.device, { groupId: f.groupId, attemptId: original.binding.attemptId });
  assert.equal(f.calls.length, calls); assert.deepEqual(f.capture(), before);
  await assert.rejects(f.service.command(f.device, { ...f.input('send'), roundSha256: '0'.repeat(64) }), /scope changed/);
  assert.throws(() => f.store.internalWrite(`${groupExecutionPrefix}${f.groupId}:${original.binding.attemptId}:current`, original), /original child/);
  const complete = f.store.captureBackup('synthetic-group', { status: 'not-configured', notes: [] });
  assert.throws(() => Store.verifyBackup({ ...complete, services: complete.services.filter(row => !row.id.startsWith(groupExecutionPrefix)) }),
    /Group membership/);
  const future = { ...complete, schema: 58 };
  assert.throws(() => Store.verifyBackup(future), /Group membership/);
});
test('early exact cancellation event settles only its original child, before a later accepted response', async t => {
  const f = fixture(t); await f.setup();
  f.onAgent(input => {
    f.emit({ event: 'agent', payload: { runId: input.idempotencyKey, sessionKey: input.sessionKey,
      sessionId: f.child()!.nativeId, agentId: 'edition3-direct', seq: 1, stream: 'lifecycle',
      data: { phase: 'end', aborted: true, stopReason: 'aborted' } } });
    assert.equal(f.child()!.send!.state, 'dispatching');
    f.emit({ event: 'agent', payload: { runId: input.idempotencyKey, sessionKey: input.sessionKey,
      agentId: 'edition3-group', seq: 1, stream: 'assistant', data: { text: 'Unbound writing.' } } });
    assert.equal(f.service.read(f.device, { groupId: f.groupId, attemptId: f.child()!.binding.attemptId }).activity!.text, '');
    f.emit({ event: 'agent', payload: { runId: input.idempotencyKey, sessionKey: input.sessionKey,
      sessionId: f.child()!.nativeId, agentId: 'edition3-group', seq: 2, stream: 'lifecycle',
      data: { phase: 'start', startedAt: Date.now() } } });
    f.emit({ event: 'agent', payload: { runId: input.idempotencyKey, sessionKey: input.sessionKey,
      agentId: 'edition3-group', seq: 3, stream: 'assistant', data: { text: 'Kept partial writing.' } } });
    f.emit({ event: 'agent', payload: { runId: input.idempotencyKey, sessionKey: input.sessionKey,
      sessionId: randomUUID(), agentId: 'edition3-group', seq: 4, stream: 'assistant', data: { text: 'Wrong session.' } } });
    f.emit({ event: 'agent', payload: { runId: input.idempotencyKey, sessionKey: input.sessionKey,
      sessionId: f.child()!.nativeId, agentId: 'edition3-group', seq: 5, stream: 'lifecycle',
      data: { phase: 'end', aborted: true, stopReason: 'aborted' } } });
  });
  await f.service.command(f.device, f.input('send'));
  assert.equal(f.child()!.send!.state, 'cancelled'); assert.equal(f.child()!.text, 'Kept partial writing.');
  assert.equal(f.count('agent'), 1);
});

test('historical owner text excludes private Profile capture when Profile is not a common readable source', async t => {
  const f = fixture(t, 1, true);
  assert.equal(f.round.owner!.value.name, 'Private Owner Name');
  assert.equal(f.round.recipients[0].readModules.includes('profile'), false);
  const saved = f.preparations.save(f.device, { requestId: randomUUID(), epoch: f.epoch, groupId: f.groupId,
    action: 'save-draft', scope: { ...f.scope, windowId: randomUUID() }, expectedRaw: null, text: 'A later shared input.',
    sources: [], history: [{ roundId: f.round.id, sha256: digest(f.round) }] });
  const prepared = f.preparations.save(f.device, { requestId: randomUUID(), epoch: f.epoch, groupId: f.groupId,
    action: 'prepare', draftId: parseGroupDraft(saved.draftRaw!).id, expectedRaw: saved.draftRaw, expectedSequence: saved.sequence });
  const round = f.store.readGroupPreparation(f.groupId).preparation.rounds.get(prepared.roundId!)!;
  const base = { epoch: f.epoch, groupId: f.groupId, roundId: round.id, roundSha256: digest(round),
    attemptId: round.recipients[0].attempt.id };
  await f.service.command(f.device, { ...base, requestId: randomUUID(), action: 'setup', expectedRevision: 0,
    account: { profileId: 'openai:fixture', model: 'openai/synthetic' } });
  const child = f.store.readGroupExecution(f.groupId, base.attemptId)!.value;
  await f.service.command(f.device, { ...base, requestId: randomUUID(), action: 'send', expectedRevision: child.revision });
  const sent = f.calls.find(row => row.method === 'agent')!.input;
  assert.match(sent.message, /Use this exact shared owner input/);
  assert.doesNotMatch(JSON.stringify(sent), /Private Owner Name|Private biography|profile:owner/);
  assert.deepEqual(f.store.readGroupPreparation(f.groupId).preparation.rounds.get(f.round.id), f.round);
});

for (const replacement of ['replaceRegistration', 'replaceRuntime', 'replaceRuntimeStart', 'replacePolicy'] as const) {
  test(`controller reopen refuses changed original lifetime before send, stop and observation: ${replacement}`, async t => {
    const beforeSend = fixture(t); await beforeSend.setup();
    beforeSend[replacement](); await beforeSend.restartController();
    await beforeSend.service.command(beforeSend.device, beforeSend.input('send'));
    assert.equal(beforeSend.count('agent'), 0);
    assert.equal(beforeSend.child()!.send!.dispatchStarted, false);
    const active = fixture(t); await active.setup(); await active.service.command(active.device, active.input('send'));
    active[replacement](); await active.restartController();
    await assert.rejects(active.service.command(active.device, active.input('stop')), /original Group runtime/);
    assert.equal(active.count('chat.abort'), 0);
    await assert.rejects(active.observe(), /original Group runtime/);
    assert.equal(active.count('agent.wait'), 0);
    assert.equal(active.child()!.send!.state, 'accepted');
  });
}

test('same original lifetime supports controller reopen, while timeout or missing terminal identity never confirms stop', async t => {
  const f = fixture(t); await f.setup(); await f.restartController();
  await f.service.command(f.device, f.input('send'));
  await f.service.command(f.device, f.input('stop'));
  const child = f.child()!;
  const event = { runId: child.send!.requestId, sessionKey: child.binding.nativeKey, agentId: 'edition3-group',
    sessionId: child.nativeId, seq: 1, stream: 'lifecycle' };
  f.emit({ event: 'agent', payload: { ...event, sessionId: undefined,
    data: { phase: 'end', aborted: true, stopReason: 'aborted' } } });
  assert.equal(f.child()!.stop!.state, 'unconfirmed');
  f.emit({ event: 'agent', payload: { ...event, data: { phase: 'error', aborted: true, stopReason: 'timeout' } } });
  await until(() => f.count('agent.wait') === 1);
  assert.equal(f.child()!.send!.state, 'accepted'); assert.equal(f.child()!.stop!.state, 'unconfirmed');
  f.emit({ event: 'agent', payload: { ...event, seq: 2, data: { phase: 'error', aborted: true, stopReason: 'aborted' } } });
  assert.equal(f.child()!.send!.state, 'cancelled'); assert.equal(f.child()!.stop!.state, 'confirmed');
  assert.equal(f.count('agent'), 1); assert.equal(f.count('chat.abort'), 1);
});
test('authorization revoked during an awaited account read withholds the original native creation', async t => {
  const f = fixture(t); let authorized = true;
  f.onAccount(() => { authorized = false; });
  const command = f.input('setup', { account: { profileId: 'openai:fixture', model: 'openai/synthetic' } });
  await assert.rejects(f.service.command(f.device, command, () => { if (!authorized) throw Error('Synthetic session revoked'); }), /revoked/);
  assert.equal(f.count('sessions.create'), 0); assert.equal(f.child()!.setup.state, 'failed');
  assert.equal(f.child()!.setup.dispatchStarted, false);
});
test('held and activated-paused copies retain complete records with no automatic or explicit dispatch', async t => {
  const f = fixture(t); f.failPolicy(true); await f.setup(); f.failPolicy(false);
  for (const recovery of [{ held: true }, { held: false, effectsPaused: true }]) {
    f.store.internalWrite('recovery:state', recovery);
    const before = f.capture(), calls = f.calls.length, current = f.child()!;
    await f.restartController();
    const view = f.service.read(f.device, { groupId: f.groupId, attemptId: current.binding.attemptId });
    assert.equal(view.setup!.canContinueUnsent, false);
    await assert.rejects(f.service.command(f.device, f.input('continue-unsent', {
      phase: 'setup', originalRequestId: current.setup.requestId, expectedSha256: digest(current),
    })), /paused/);
    assert.equal(f.calls.length, calls); assert.deepEqual(f.capture(), before);
  }
});
test('unknown Group work blocks update admission and restored cached status does not manufacture native idleness', async t => {
  const f = fixture(t); await f.setup(); f.loseSend(); await f.service.command(f.device, f.input('send'));
  assert(updateMaintenanceBlockers(f.store).some(row => row.kind === 'assistant-group'));
  const original = f.child()!, before = f.capture();
  f.store.setUpdateMaintenanceHeld(true);
  await assert.rejects(f.observe(), /unavailable/);
  assert.deepEqual(f.capture(), before); assert.equal(f.child()!.send!.state, 'unknown');
  f.store.setUpdateMaintenanceHeld(false);
  await assert.rejects(f.service.command(f.device, { ...f.input('stop'), expectedRevision: original.revision - 1 }), /revision/);
  assert.equal(f.count('chat.abort'), 0);
});
test('literal Group wire and phone routes reject personal keys, generic sends, tool additions and extra routes', () => {
  const key = `agent:edition3-group:e3:${randomUUID()}`;
  assertGroupGatewayRequest('sessions.create', { key, idempotencyKey: randomUUID(), model: 'openai/synthetic@openai:fixture',
    permissionMode: 'read-only', emitCommandHooks: false });
  assert.throws(() => assertGroupGatewayRequest('chat.send', { sessionKey: key, message: 'Do not reroute me.' }));
  assert.throws(() => assertGroupGatewayRequest('sessions.patch', { key, permissionMode: 'full' }));
  assert.throws(() => assertGroupGatewayRequest('e3.group.policy', { epoch: randomUUID(), nativeKey: key.replace('edition3-group', 'edition3-direct'), nativeId: null }));
  assert.throws(() => assertGroupGatewayRequest('e3.accounts.group-profile', { epoch: randomUUID(), agentId: 'main', profileId: 'openai:fixture' }));
  assert.equal(phoneRouteAllowed('/api/assistant/group-execution', 'GET'), true);
  assert.equal(phoneRouteAllowed('/api/assistant/group-execution/observe', 'POST'), true);
  assert.equal(phoneRouteAllowed('/api/assistant/group-execution/retry', 'POST'), false);
  assert.equal(phoneRouteAllowed('/api/assistant/group-execution/observe', 'GET'), false);
});

function replyClient(f: ReturnType<typeof fixture>, index = 0) {
  const recipient = f.round.recipients[index], bytes = new Map<string, string>();
  let alive = true, failWrite = false, afterWrite = false, failReadback = false;
  const storage = {
    getItem(key: string) {
      if (failReadback && afterWrite) { afterWrite = false; throw Error('Synthetic readback unavailable'); }
      return bytes.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (failWrite) throw Error('Synthetic device storage full');
      bytes.set(key, value); afterWrite = true;
    },
  };
  const binding = { epoch: f.epoch, deviceId: f.device, groupId: f.groupId, roundId: f.round.id,
    roundSha256: digest(f.round), attemptId: recipient.attempt.id, author: { agentId: recipient.captured.id,
      agentRevision: recipient.captured.revision, membershipId: recipient.membership.id, roundId: f.round.id } };
  const convert = (e: unknown): never => { if (e instanceof Fault) throw new ApiError(e.code, e.message, e.current as any, e.status); throw e; };
  const get = async (path: string) => {
    assert(path.startsWith('assistant/group-execution?'));
    try { return f.service.readQuery(f.device, groupExecutionQuery(new URLSearchParams(path.split('?')[1]))); }
    catch (e) { return convert(e); }
  };
  const posts: { path: string; body: any }[] = [];
  const post = async (path: string, body: any) => {
    posts.push({ path, body });
    try { return path.endsWith('/observe') ? await f.service.observe(f.device, body) : await f.service.command(f.device, body); }
    catch (e) { return convert(e); }
  };
  const create = () => new GroupReplyJournal(storage, binding, () => alive);
  return { binding, storage, bytes, get, post, posts, create,
    close() { alive = false; }, failWrite(value: boolean) { failWrite = value; },
    failReadback(value: boolean) { afterWrite = false; failReadback = value; } };
}
const replyAccount = { account: { profileId: 'openai:fixture', model: 'openai/synthetic' } };

test('reply controls require explicit setup then send, retain per-person identity and recover saved completion', async t => {
  const f = fixture(t, 2), c = replyClient(f), j = c.create();
  assert.equal(await j.start('setup', c.post, replyAccount), false);
  assert.equal(await j.read(c.get), true); assert.equal(f.calls.length, 0);
  assert.equal(await j.start('setup', c.post, replyAccount), true);
  assert.equal(f.count('sessions.create'), 1); assert.equal(f.count('agent'), 0);
  assert.equal(j.value.last!.setup.state, 'ready'); assert.equal(f.child(1), undefined);
  groupExecutionViewSchema.parse(j.value.last);
  assert.doesNotMatch(JSON.stringify(j.value.last), /accountIdentitySha256|sourcePolicySha256|nativeKey/);
  assert.equal(await j.start('send', c.post), true, j.error); assert.equal(f.count('agent'), 1);
  const requestId = f.child()!.send!.requestId;
  f.terminal({ runId: requestId, status: 'ok', terminalReceipt: { runId: requestId,
    sessionId: f.child()!.nativeId, turnId: 'actual-synthetic-turn', effective: { provider: 'openai', model: 'synthetic' } },
  terminalReply: { text: 'Saved synthetic Group reply' } });
  assert.equal(await j.observe(c.post), true); assert.equal(j.value.last!.send!.state, 'completed');
  assert.equal(j.value.last!.text, 'Saved synthetic Group reply'); assert.equal(f.count('agent'), 1);
  const reloaded = c.create(); assert.equal(reloaded.invalid, false); assert.equal(reloaded.canAct, false);
  assert.equal(await reloaded.read(c.get), true); assert.equal(reloaded.value.last!.text, 'Saved synthetic Group reply');
  assert.equal(await reloaded.start('send', c.post), false); assert.equal(f.count('agent'), 1);
});

test('lost setup acknowledgement survives reload and reconciles only the exact original GET', async t => {
  const f = fixture(t), c = replyClient(f), j = c.create(); await j.read(c.get);
  await j.start('setup', async (path, body) => { await c.post(path, body); throw Error('Synthetic lost response'); }, replyAccount);
  assert(j.unresolved); const original = j.value.pending!.command;
  const reloaded = c.create(); assert.equal(reloaded.canContinueOriginal, false);
  assert.equal(await reloaded.continueOriginal(c.post), false);
  assert.equal(await reloaded.read(c.get), true); assert.equal(reloaded.unresolved, false);
  assert.equal(reloaded.value.pending!.receipt!.requestId, original.requestId);
  assert.equal(c.posts.length, 1); assert.equal(f.count('sessions.create'), 1);
});

test('unknown native send is never repeated and stop stays tied to its original run', async t => {
  const f = fixture(t), c = replyClient(f), j = c.create(); await j.read(c.get);
  await j.start('setup', c.post, replyAccount); f.loseSend();
  await j.start('send', c.post); assert.equal(j.value.last!.send!.state, 'unknown');
  assert.equal(await j.start('send', c.post), false);
  assert.equal(await j.start('continue-unsent', c.post, { phase: 'send' }), false);
  assert.equal(await j.start('stop', c.post), true); assert(j.value.last!.stop);
  assert.equal(f.count('agent'), 1); assert.equal(f.count('chat.abort'), 1);
  assert.equal(await j.start('stop', c.post), false);
});

test('request retention failure prevents all POST calls and keeps the original identity for explicit continuation', async t => {
  const f = fixture(t), c = replyClient(f), j = c.create(); await j.read(c.get);
  c.failWrite(true); assert.equal(await j.start('setup', c.post, replyAccount), false);
  const original = j.value.pending!.command.requestId;
  assert.equal(c.posts.length, 0); assert(j.retentionError);
  c.failWrite(false); assert.equal(await j.continueOriginal(c.post), true);
  assert.equal(c.posts[0].body.requestId, original); assert.equal(c.posts.length, 1);
});

test('a persisted dispatch marker with failed readback is uncertain after reload and GET absence never licenses replay', async t => {
  const f = fixture(t), c = replyClient(f), j = c.create(); await j.read(c.get);
  // Fail only the dispatch-marker readback, after the undispatched envelope was retained.
  let writes = 0;
  const storage = { getItem: c.storage.getItem, setItem(key: string, value: string) {
    c.storage.setItem(key, value); if (++writes === 2) c.failReadback(true);
    if (writes === 2) c.storage.setItem(key, value);
  } };
  const source = new GroupReplyJournal(storage, c.binding, () => true); await source.read(c.get);
  assert.equal(await source.start('setup', c.post, replyAccount), false);
  assert.equal(c.posts.length, 0); c.failReadback(false);
  const reloaded = c.create(); assert.equal(reloaded.canContinueOriginal, false);
  assert.equal(await reloaded.read(c.get), false);
  assert.equal(await reloaded.continueOriginal(c.post), false); assert.equal(c.posts.length, 0);
});

test('exact synchronous admission rejection can be reviewed without turning missing receipts into success', async t => {
  const f = fixture(t), c = replyClient(f), j = c.create(); await j.read(c.get);
  f.store.setUpdateMaintenanceHeld(true);
  assert.equal(await j.start('setup', c.post, replyAccount), false);
  assert(j.value.pending!.rejection); groupExecutionRejectionSchema.parse(j.value.pending!.rejection);
  const original = j.value.pending!.command.requestId;
  assert.equal(j.checked, false); assert.equal(f.count('sessions.create'), 0);
  f.store.setUpdateMaintenanceHeld(false); assert.equal(await j.read(c.get), true);
  assert.equal(await j.start('setup', c.post, replyAccount), true);
  assert.notEqual(j.value.pending!.command.requestId, original);
  assert(c.bytes.has(`${j.key}:request:${original}`)); assert.equal(f.count('sessions.create'), 1);
});

test('a forged rejection or wrong receipt cannot clear an uncertain original request', async t => {
  const f = fixture(t), c = replyClient(f), j = c.create(); await j.read(c.get);
  await j.start('setup', async (_path, body: any) => { throw new ApiError('changed', 'Synthetic wrong proof',
    { kind: 'assistant-group-execution-rejection', command: { ...body, requestId: randomUUID() } } as any, 409); }, replyAccount);
  assert(j.unresolved); assert.equal(j.value.pending!.rejection, undefined);
  assert.equal(await j.read(c.get), false); assert(j.unresolved);
  assert.equal(f.calls.length, 0);
});

test('mismatched acknowledged account, author, round or command keeps the operation unconfirmed', async t => {
  for (const change of [
    (v: any) => { v.account.profileId = 'openai:different'; },
    (v: any) => { v.author.membershipId = randomUUID(); },
    (v: any) => { v.roundSha256 = 'f'.repeat(64); },
    (v: any) => { v.originalCommand.account.model = 'openai/different'; },
  ]) {
    const f = fixture(t), c = replyClient(f), j = c.create(); await j.read(c.get);
    await j.start('setup', async (path, body) => {
      const result = structuredClone(await c.post(path, body)) as any; change(result.current); return result;
    }, replyAccount);
    assert(j.unresolved); assert.equal(j.value.last, null); assert.equal(f.count('sessions.create'), 1);
    assert.equal(await j.read(c.get), true); assert.equal(f.count('sessions.create'), 1);
  }
});

test('another window cannot replace a retained request and malformed originals remain untouched', async t => {
  const f = fixture(t), c = replyClient(f), first = c.create(), second = c.create();
  await first.read(c.get); await second.read(c.get);
  await first.start('setup', c.post, replyAccount);
  const kept = c.bytes.get(first.key);
  assert.equal(await second.start('setup', c.post, replyAccount), false);
  assert.equal(c.bytes.get(first.key), kept); assert.equal(f.count('sessions.create'), 1);
  c.bytes.set(first.key, '{ malformed original');
  const invalid = c.create(); assert(invalid.invalid); assert.equal(await invalid.read(c.get), false);
  assert.equal(invalid.retain(), false); assert.equal(c.bytes.get(first.key), '{ malformed original');
});

test('a late response cannot update a closed view and reload reads the original operation', async t => {
  const f = fixture(t), c = replyClient(f), j = c.create(); await j.read(c.get);
  await j.start('setup', async (path, body) => { const reply = await c.post(path, body); c.close(); return reply; }, replyAccount);
  assert(j.unresolved); assert.equal(j.value.last, null);
  const next = new GroupReplyJournal(c.storage, c.binding, () => true);
  assert.equal(await next.read(c.get), true); assert.equal(next.value.last!.setup.state, 'ready');
  assert.equal(c.posts.length, 1);
});

test('timed out observation waits for the existing owner to close and never repeats the native check', async t => {
  const f = fixture(t), c = replyClient(f), j = c.create(); await j.read(c.get);
  await j.start('setup', c.post, replyAccount); await j.start('send', c.post);
  let release!: () => void; f.holdAccount(new Promise<void>(resolve => { release = resolve; }));
  let original: Promise<unknown> | undefined;
  await j.observe(async (path, body) => {
    original = c.post(path, body); await tick(); throw Error('Synthetic progress response timeout');
  });
  assert(j.value.observation); assert.equal(await j.read(c.get), true);
  assert.equal(j.value.last!.observationInFlight, true); assert.equal(j.canAct, false);
  assert.equal(await j.observe(c.post), false);
  const requestId = f.child()!.send!.requestId;
  f.terminal({ runId: requestId, status: 'ok', terminalReceipt: { runId: requestId,
    sessionId: f.child()!.nativeId, turnId: 'observed-original', effective: { provider: 'openai', model: 'synthetic' } },
  terminalReply: { text: 'Original observation completed' } });
  release(); f.holdAccount(undefined); await original;
  assert.equal(await j.read(c.get), true); assert.equal(j.value.observation, undefined);
  assert.equal(c.posts.filter(p => p.path.endsWith('/observe')).length, 1);
});

test('eligible failed unsent phase continues its original request rather than creating a new child', async t => {
  const f = fixture(t), c = replyClient(f), j = c.create(); await j.read(c.get);
  f.failPolicy(true); await j.start('setup', c.post, replyAccount);
  assert.equal(j.value.last!.setup.state, 'failed'); assert.equal(j.value.last!.setup.dispatchStarted, false);
  const requestId = j.value.last!.setup.requestId; f.failPolicy(false);
  assert.equal(await j.start('continue-unsent', c.post, { phase: 'setup' }), true);
  assert.equal(j.value.last!.setup.requestId, requestId); assert.equal(j.value.last!.setup.state, 'ready');
  assert.equal(f.count('sessions.create'), 1);
});

test('an uncertain read-only progress check does not prevent stopping the freshly read original run', async t => {
  const f = fixture(t), c = replyClient(f), j = c.create(); await j.read(c.get);
  await j.start('setup', c.post, replyAccount); await j.start('send', c.post);
  const runId = f.child()!.send!.requestId;
  await j.observe(async () => { throw Error('Synthetic progress request transport outcome unknown'); });
  assert(j.value.observation); assert.equal(j.canStop, false);
  assert.equal(await j.read(c.get), true);
  assert(j.value.observation, 'an unchanged inactive view does not prove the request could not arrive late');
  assert.equal(j.canAct, false); assert.equal(j.canStop, true);
  assert.equal(await j.start('send', c.post), false);
  assert.equal(await j.start('stop', c.post), true);
  assert.equal(f.child()!.send!.requestId, runId); assert.equal(f.count('agent'), 1);
  assert.equal(f.count('chat.abort'), 1); assert(j.value.observation);
  assert.equal(await j.read(c.get), true); assert.equal(j.value.observation, undefined);
});

test('an unavailable account cannot start new work but its exact admitted Group result remains readable', async t => {
  const f = fixture(t, 2); await f.setup(); await f.service.command(f.device, f.input('send'));
  const original = f.child()!; f.accountUnavailable(true);
  f.terminal({ runId: original.send!.requestId, status: 'error', terminalReceipt: {
    runId: original.send!.requestId, sessionId: original.nativeId, turnId: 'original-limited-turn' },
    terminalReply: { text: 'Original provider limit result.' } });
  const readinessReads = f.count('e3.accounts.group-profile');
  await f.observe(); assert.equal(f.child()!.send!.state, 'failed');
  assert.equal(f.child()!.text, 'Original provider limit result.');
  assert.equal(f.count('e3.accounts.group-profile'), readinessReads);
  await f.setup(1); assert.equal(f.child(1)!.setup.state, 'failed');
  assert.equal(f.child(1)!.setup.dispatchStarted, false); assert.equal(f.count('sessions.create'), 1);
  assert.equal(f.count('agent'), 1); f.capture();
});

test('an unavailable account still permits exact-original abort without new send or account fallback', async t => {
  const f = fixture(t); await f.setup(); await f.service.command(f.device, f.input('send'));
  f.accountUnavailable(true); const stop = f.input('stop', { stopTracking: 1 });
  await f.service.command(f.device, stop); await f.service.command(f.device, stop);
  const saved = f.child()!.stop!; assert('format' in saved && saved.dispatchStarted);
  assert.equal(saved.state, 'unconfirmed'); assert.equal(f.count('chat.abort'), 1); assert.equal(f.count('agent'), 1);
  f.capture();
});

test('changed Group account identity still refuses original observation and abort', async t => {
  const f = fixture(t); await f.setup(); await f.service.command(f.device, f.input('send'));
  f.replaceAccount(); await assert.rejects(f.observe(), /selected Group account/);
  await assert.rejects(f.service.command(f.device, f.input('stop', { stopTracking: 1 })), /selected Group account/);
  assert.equal(f.count('agent.wait'), 0); assert.equal(f.count('chat.abort'), 0);
  const stop = f.child()!.stop!; assert('format' in stop && !stop.dispatchStarted);
  assert.equal(stop.state, 'failed'); f.capture();
});

test('a proven undispatched stop continues its original after reopen and membership revocation', async t => {
  const f = fixture(t); await f.setup(); await f.service.command(f.device, f.input('send'));
  f.failPolicy(true); const stopCommand = f.input('stop', { stopTracking: 1 });
  await assert.rejects(f.service.command(f.device, stopCommand), /pre-send policy/);
  const failed = f.child()!, stop = failed.stop!; assert('format' in stop && !stop.dispatchStarted);
  assert.equal(stop.state, 'failed'); assert.equal(stop.attempts, 1); assert.equal(f.count('chat.abort'), 0);
  f.failPolicy(false); await f.restartController();
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.epoch, kind: 'agent', entityId: f.agents[0].id,
    expectedRevision: 1, payload: { ...(f.agents[0].value as Record<string, unknown>), archived: true } });
  const continuation = f.input('continue-stop', { originalRequestId: stop.requestId, expectedSha256: digest(failed) });
  await f.service.command(f.device, continuation); await f.service.command(f.device, continuation);
  const kept = f.child()!.stop!; assert('format' in kept && kept.dispatchStarted);
  assert.equal(kept.requestId, stopCommand.requestId); assert.equal(kept.commandId, continuation.requestId);
  assert.equal(kept.attempts, 2); assert.equal(kept.state, 'unconfirmed'); assert.equal(f.count('chat.abort'), 1);
  assert.equal(f.count('agent'), 1); f.capture();
});

test('a dispatched abort with lost acknowledgement never becomes an unsent continuation', async t => {
  const f = fixture(t); await f.setup(); await f.service.command(f.device, f.input('send'));
  f.loseAbort(); const stopCommand = f.input('stop', { stopTracking: 1 });
  await assert.rejects(f.service.command(f.device, stopCommand), /lost abort acknowledgement/);
  const child = f.child()!, stop = child.stop!; assert('format' in stop && stop.dispatchStarted);
  assert.equal(stop.state, 'unconfirmed'); assert.equal(f.count('chat.abort'), 1);
  await f.service.command(f.device, stopCommand); assert.equal(f.count('chat.abort'), 1);
  await assert.rejects(f.service.command(f.device, f.input('continue-stop', {
    originalRequestId: stop.requestId, expectedSha256: digest(child) })), /proven undispatched/);
  assert.equal(f.count('chat.abort'), 1); f.capture();
});

test('interrupted tracked and legacy stops never invent proof of no dispatch on reopen', async t => {
  for (const tracked of [false, true]) {
    const f = fixture(t); await f.setup(); await f.service.command(f.device, f.input('send'));
    const command = f.input('stop', tracked ? { stopTracking: 1 } : {});
    f.store.admitGroupExecution(f.device, command, () => {}); await f.restartController();
    const child = f.child()!;
    assert.equal(f.service.read(f.device, { groupId: f.groupId, attemptId: child.binding.attemptId }).canContinueStop, false);
    await assert.rejects(f.service.command(f.device, f.input('continue-stop', {
      originalRequestId: command.requestId, expectedSha256: digest(child) })), /proven undispatched/);
    assert.equal(f.count('chat.abort'), 0); assert.equal(child.stop!.state, 'requested'); f.capture();
  }
});

test('the retained client explicitly continues only its proven unsent stop and keeps original receipts', async t => {
  const f = fixture(t), c = replyClient(f), j = c.create();
  await j.read(c.get); await j.start('setup', c.post, replyAccount); await j.start('send', c.post);
  f.failPolicy(true); assert.equal(await j.start('stop', c.post), false);
  assert.equal(j.unresolved, true); const original = j.value.pending!.command.requestId;
  f.failPolicy(false); const reopened = c.create(); await reopened.read(c.get);
  reopened.value.observation = { id: randomUUID(), dispatched: true, body: { epoch: f.epoch,
    groupId: f.groupId, attemptId: f.child()!.binding.attemptId, expectedRevision: reopened.value.last!.revision } };
  assert.equal(reopened.retain(), true); assert.equal(reopened.canAct, false);
  assert.equal(reopened.canContinueStop, true); assert.equal(await reopened.start('continue-stop', c.post), true);
  assert.equal(reopened.value.last!.stop!.requestId, original); assert.equal(f.count('chat.abort'), 1);
  assert.equal(reopened.value.pending!.command.action, 'continue-stop');
  assert(c.bytes.has(`${reopened.key}:request:${original}`));
  assert.equal(await reopened.start('continue-stop', c.post), false);
});

test('unsent stop continuation refuses wrong snapshots and remains bounded at four attempts', async t => {
  const f = fixture(t); await f.setup(); await f.service.command(f.device, f.input('send'));
  f.failPolicy(true);
  await assert.rejects(f.service.command(f.device, f.input('stop', { stopTracking: 1 })), /pre-send policy/);
  for (let attempt = 2; attempt <= 4; attempt++) {
    const child = f.child()!;
    await assert.rejects(f.service.command(f.device, f.input('continue-stop', {
      originalRequestId: child.stop!.requestId, expectedSha256: '0'.repeat(64) })), /proven undispatched/);
    await assert.rejects(f.service.command(f.device, f.input('continue-stop', {
      originalRequestId: child.stop!.requestId, expectedSha256: digest(child) })), /pre-send policy/);
    const stopped = f.child()!.stop!; assert('format' in stopped); assert.equal(stopped.attempts, attempt);
  }
  const child = f.child()!;
  assert.equal(f.service.read(f.device, { groupId: f.groupId, attemptId: child.binding.attemptId }).canContinueStop, false);
  f.failPolicy(false);
  await assert.rejects(f.service.command(f.device, f.input('continue-stop', {
    originalRequestId: child.stop!.requestId, expectedSha256: digest(child) })), /proven undispatched/);
  assert.equal(f.count('chat.abort'), 0); f.capture();
});
