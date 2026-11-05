import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { AssistantService } from '../apps/service/assistant.js';
import { DirectAgentOwner, type DirectRuntimeIdentity } from '../apps/service/direct-agent-owner.js';
import { directConfigurationHash, directRuntimePolicy, directPluginId } from '../apps/service/direct-agent-runtime-policy.js';
import { directAgentMessage } from '../apps/service/direct-agent-dispatch.js';
import { directAgentGatewaySchema } from '../apps/service/direct-agent-gateway.js';
import { directReadInput } from '../apps/service/direct-agent-tool-calls.js';
import { updateMaintenanceBlockers } from '../apps/service/update-maintenance.js';
import { phoneRouteAllowed } from '../apps/service/phone-policy.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import { canonical, emptyDraft } from '../packages/domain/contracts.js';
import type { AssistantConnection } from '../packages/domain/assistant.js';
import type { AssistantTransport } from '../apps/service/gateway.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await turn();
  assert.equal(check(), true, 'the bounded synthetic transition completed');
}
/** Real isolated Store/Assistant; the transport below is entirely synthetic.
 * No Gateway process, provider, native plugin or HTTP listener is started. */
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-direct-core-')), store = new Store(directory);
  const device = store.session().deviceId, epoch = store.epoch, generation = randomUUID();
  const configuration = {
    cron: { enabled: false }, update: { checkOnStart: false, auto: { enabled: false } },
    models: { catalogRefresh: { enabled: false } },
    plugins: { enabled: true, allow: [directPluginId], entries: { [directPluginId]: { enabled: true, config: { policySha256: '' } } } },
    agents: { defaults: { skipBootstrap: true, heartbeat: { every: '0m' } }, entries: {
      'edition3-direct': { ...structuredClone(directRuntimePolicy), workspace: '/synthetic/workspace', agentDir: '/synthetic/agent' },
    } }, gateway: { bind: 'loopback', controlUi: { enabled: false } },
  };
  const sourcePolicySha256 = directConfigurationHash(configuration);
  configuration.plugins.entries[directPluginId].config.policySha256 = sourcePolicySha256;
  let runtime: DirectRuntimeIdentity | undefined = { epoch, pid: 1001, startedAt: Date.now(), generation,
    version: '2026.9.8', url: 'ws://127.0.0.1:49111', sourcePolicySha256, pluginSha256: 'b'.repeat(64), configuration };
  let registrationId = randomUUID(), accountIdentity = 'a'.repeat(64), holdPolicy: Promise<void> | undefined;
  let lostSend = false, lostCreate = false, policyFailure = false, historyReads = 0;
  let onHistory = () => {}, onAccount = () => {};
  const calls: { method: string; input: any }[] = [], messages: any[] = [];
  const sessions = new Map<string, { id: string; accountId: string | null }>();
  const explicitLabels = new Map<string, string>();
  const listeners = new Set<(event: any) => void>();
  const gateway: AssistantTransport = {
    status: (): AssistantConnection => ({ state: 'ready', url: 'ws://127.0.0.1:49111', generation,
      message: 'Synthetic only', grantedScopes: ['operator.read', 'operator.write'], modelAuthReady: true,
      methods: ['e3.direct.policy', 'e3.accounts.direct-profile', 'agent', 'chat.history', 'sessions.create', 'sessions.patch', 'chat.abort', 'agent.wait'] }),
    models: async () => [], attachmentPolicy: () => ({}),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async request<T>(method: string, input: any): Promise<T> {
      calls.push({ method, input });
      if (method === 'e3.direct.policy') {
        await holdPolicy;
        if (policyFailure) throw Error('Synthetic policy is temporarily unavailable before send');
        const session = sessions.get(input.nativeKey);
        return { format: 1, epoch, agentId: 'edition3-direct', registrationId, sourcePolicySha256,
          policySha256: sourcePolicySha256, nativeKey: input.nativeKey, session: session ? {
            key: input.nativeKey, id: session.id, lifecycleRevision: 'native-lifecycle',
            permissionMode: 'read-only', permissionModePending: false, accountId: session.accountId, model: 'openai/synthetic',
          } : null } as T;
      }
      if (method === 'e3.accounts.direct-profile') {
        onAccount();
        return { format: 1, epoch, agentId: 'edition3-direct', profileId: input.profileId,
          identityKey: accountIdentity, expiresAt: Date.now() + 600000, ready: true } as T;
      }
      if (method === 'sessions.create') {
        assert.equal(input.emitCommandHooks, false); assert.equal(input.permissionMode, 'read-only');
        // Native 9.8 labels are unique within an agent; display names are not.
        if (typeof input.label === 'string') {
          const claimed = explicitLabels.get(input.label);
          if (claimed && claimed !== input.key) throw Error('label already in use: ' + input.label);
          explicitLabels.set(input.label, input.key);
        }
        const id = randomUUID(); sessions.set(input.key, { id, accountId: null });
        if (lostCreate) throw Error('Synthetic lost create reply');
        return { key: input.key, sessionId: id, runStarted: false,
          entry: { sessionId: id, permissionMode: 'read-only', permissionModePending: false } } as T;
      }
      if (method === 'sessions.patch') {
        const session = sessions.get(input.key)!;
        assert.equal(input.expectedSessionId, session.id);
        if (input.model) session.accountId = input.model.split('@')[1];
        return { entry: { sessionId: session.id, authProfileOverride: session.accountId } } as T;
      }
      if (method === 'chat.history') {
        historyReads++; onHistory();
        const session = sessions.get(input.sessionKey)!;
        return { sessionId: session.id, messages, hasMore: false,
          sessionInfo: { activeRunIds: [], hasActiveRun: false, permissionMode: 'read-only', model: 'openai/synthetic' } } as T;
      }
      if (method === 'agent') {
        directAgentGatewaySchema.parse(input);
        if (lostSend) throw Error('Synthetic lost accepted response');
        return { runId: input.idempotencyKey, sessionKey: input.sessionKey, agentId: 'edition3-direct', status: 'accepted' } as T;
      }
      if (method === 'chat.abort') return { ok: true } as T;
      if (method === 'agent.wait') return { status: 'running', runId: input.runId } as T;
      throw Error('Unexpected synthetic method: ' + method);
    },
  };
  const service = new AssistantService(store, gateway), owner = new DirectAgentOwner(store, gateway, () => runtime);
  service.setDirectAgentOwner(owner);
  let selected = 'openai:synthetic';
  service.setAccountRouter(async () => ({ profileId: selected, selectedAt: new Date().toISOString() }), async () => {});
  const agent = store.mutate(device, { requestId: randomUUID(), epoch, kind: 'agent', entityId: 'agent:original', expectedRevision: 0,
    payload: { ...blankRecord('agent', 'UTC'), name: 'Aster', position: 'Research partner', instructions: 'Read original records.', access: { tasks: 'read' } } });
  const draftId = `draft:${device}`;
  store.mutate(device, { requestId: randomUUID(), epoch, kind: 'draft', entityId: draftId, expectedRevision: 0,
    payload: { ...emptyDraft, text: 'Read my original saved task.' } });
  t.after(() => { service.close(); store.close(); });
  const createInput = { requestId: randomUUID(), epoch, title: 'Aster', projectId: null, model: 'openai/synthetic',
    recipient: { agentId: agent.id, agentRevision: 1 } };
  const input = (id: string) => ({ requestId: randomUUID(), epoch, conversationId: id,
    conversationRevision: service.conversations().find(c => c.id === id)!.revision, draftId, draftRevision: 1, projectRevision: 0 });
  return { store, device, service, owner, gateway, configuration, calls, messages, sessions, createInput, input,
    counts: (method: string) => calls.filter(call => call.method === method).length,
    loseSend: () => { lostSend = true; }, loseCreate: () => { lostCreate = true; },
    failPolicy: (value: boolean) => { policyFailure = value; },
    replaceRegistration: () => { registrationId = randomUUID(); },
    replaceRuntime: () => { runtime = runtime && { ...runtime, pid: 1002 }; },
    replaceAccount: () => { accountIdentity = 'c'.repeat(64); },
    selected: (value: string) => { selected = value; },
    history: (hook: () => void) => { onHistory = hook; },
    account: (hook: () => void) => { onAccount = hook; },
    historyReads: () => historyReads, holdPolicy: (hold: Promise<void>) => { holdPolicy = hold; },
    emit: async (event: any) => { for (const listener of listeners) listener(event); await turn(); },
  };
}
test('one exact direct setup and captured turn use the original engine without generic chat.send', async t => {
  const f = fixture(t), chat = await f.service.create(f.device, f.createInput);
  assert.equal(chat.state, 'ready'); assert.ok(chat.nativeId); assert.equal(f.counts('agent'), 0);
  assert.equal((await f.service.create(f.device, f.createInput)).id, chat.id); assert.equal(f.counts('sessions.create'), 1);
  const input = f.input(chat.id), operation = await f.service.submitRequest(f.device, input);
  await until(() => f.service.operations()[0]?.state === 'accepted');
  const kept = f.service.operations()[0];
  assert.equal(kept.id, operation.id); assert.equal(kept.nativeRunId, input.requestId);
  assert.equal(kept.context.directAgent!.account.identityKey, 'a'.repeat(64));
  assert.equal(kept.context.directAgent!.recipient.agentId, f.createInput.recipient.agentId);
  assert.equal(kept.context.planning, undefined); assert.equal(kept.context.memory, undefined);
  assert.equal(f.counts('agent'), 1); assert.equal(f.counts('chat.send'), 0);
  assert.equal((await f.service.submitRequest(f.device, input)).id, kept.id); assert.equal(f.counts('agent'), 1);
  f.messages.push({ id: 'saved-user', role: 'user', text: directAgentMessage(kept), runId: kept.nativeRunId },
    { id: 'saved-reply', role: 'assistant', text: 'An actual synthetic reply', runId: kept.nativeRunId });
  const history = await f.service.history(chat.id);
  assert.equal(history.messages[0].authoredText, kept.input);
  assert.equal(history.messages[1].author?.role, 'assistant');
  assert.equal(history.messages[1].author?.recordId, f.createInput.recipient.agentId);
  f.messages.push({ id: 'unbound', role: 'assistant', text: 'Aster says so', runId: randomUUID() });
  assert.equal((await f.service.history(chat.id)).messages[2].author, undefined);
});
test('two chats with the same agent name keep distinct native identities without a unique label claim', async t => {
  const f = fixture(t), secondInput = { ...f.createInput, requestId: randomUUID() };
  const first = await f.service.create(f.device, f.createInput);
  const firstSaved = f.service.conversations().find(chat => chat.id === first.id);
  const second = await f.service.create(f.device, secondInput);
  assert.equal(first.state, 'ready'); assert.equal(second.state, 'ready');
  assert.equal(first.title, 'Aster'); assert.equal(second.title, first.title);
  assert.notEqual(second.id, first.id); assert.notEqual(second.nativeKey, first.nativeKey);
  assert.ok(first.nativeId); assert.ok(second.nativeId); assert.notEqual(second.nativeId, first.nativeId);
  assert.equal(f.sessions.size, 2);
  assert.deepEqual(f.service.conversations().find(chat => chat.id === first.id), firstSaved);
  const creates = f.calls.filter(call => call.method === 'sessions.create');
  assert.deepEqual(creates.map(call => call.input), [first, second].map((chat, index) => ({
    key: chat.nativeKey, idempotencyKey: [f.createInput.requestId, secondInput.requestId][index],
    displayName: 'Aster', model: 'openai/synthetic', permissionMode: 'read-only', emitCommandHooks: false,
  })));
  assert.equal((await f.service.create(f.device, f.createInput)).id, first.id);
  assert.equal((await f.service.create(f.device, secondInput)).id, second.id);
  assert.equal(f.counts('sessions.create'), 2); assert.equal(f.counts('agent'), 0);
});

test('lost setup reply is original observation only and never creates another session', async t => {
  const f = fixture(t); f.loseCreate();
  const chat = await f.service.create(f.device, f.createInput);
  assert.equal(chat.state, 'unknown'); assert.equal(chat.nativeId, null);
  await f.service.create(f.device, f.createInput); assert.equal(f.counts('sessions.create'), 1);
  await f.service.reconcile(chat.id);
  assert.equal(f.service.conversations()[0].nativeId, f.sessions.get(chat.nativeKey)!.id);
  assert.equal(f.counts('sessions.create'), 1); assert.equal(f.counts('agent'), 0);
});
test('lost direct send remains unknown; original request replay and reconciliation do not resend', async t => {
  const f = fixture(t), chat = await f.service.create(f.device, f.createInput); f.loseSend();
  const input = f.input(chat.id); await f.service.submitRequest(f.device, input);
  await until(() => f.service.operations()[0]?.state === 'unknown');
  const original = f.service.operations()[0];
  await f.service.submitRequest(f.device, input); await f.service.reconcile(chat.id);
  assert.equal(f.service.operations()[0].id, original.id); assert.equal(f.counts('agent'), 1);
});
test('account replacement after capture refuses the first send and preserves input', async t => {
  const f = fixture(t), chat = await f.service.create(f.device, f.createInput);
  f.history(() => { if (f.store.internalList('assistant:operation:').length) f.replaceAccount(); });
  await f.service.submitRequest(f.device, f.input(chat.id));
  await until(() => f.service.operations()[0]?.state === 'failed');
  assert.equal(f.counts('agent'), 0);
  assert.equal(f.service.operations()[0].input, 'Read my original saved task.');
});
test('same-process registration or owned runtime replacement refuses a previously observed policy', async t => {
  for (const replacement of ['registration', 'runtime'] as const) {
    const f = fixture(t), chat = await f.service.create(f.device, f.createInput), before = await f.owner.observe(chat);
    if (replacement === 'registration') { f.replaceRegistration(); await assert.rejects(f.owner.observe(chat)); }
    else { f.replaceRuntime(); assert.throws(() => f.owner.assertCurrent(before)); }
    assert.equal(f.counts('agent'), 0);
  }
});
test('closing during original policy preparation cannot start native setup or publish late success', async t => {
  const f = fixture(t); let release!: () => void;
  f.holdPolicy(new Promise<void>(resolve => { release = resolve; }));
  const pending = f.service.create(f.device, f.createInput);
  await until(() => f.counts('e3.direct.policy') === 1);
  f.service.close(); release(); await pending;
  assert.equal(f.counts('sessions.create'), 0); assert.equal(f.counts('agent'), 0);
});
test('Gateway direct schema refuses generic retargeting or command-shaped input', () => {
  const valid = { sessionKey: `agent:edition3-direct:e3:${randomUUID()}`, expectedExistingSessionId: randomUUID(),
    expectedExistingSessionLifecycleRevision: null, idempotencyKey: randomUUID(), promptMode: 'minimal',
    bootstrapContextMode: 'lightweight', deliver: false, message: 'Owner message:\n/reset', extraSystemPrompt: 'Captured agent', attachments: [] };
  assert.doesNotThrow(() => directAgentGatewaySchema.parse(valid));
  for (const patch of [{ sessionKey: `agent:main:e3:${randomUUID()}` }, { message: '/reset' },
    { deliver: true }, { cwd: '/other' }, { agentId: 'main' }, { expectedExistingSessionLifecycleRevision: 4 }])
    assert.throws(() => directAgentGatewaySchema.parse({ ...valid, ...patch }));
});
test('phone setup authority is one exact owner command and never exposes plugin reads', () => {
  assert.equal(phoneRouteAllowed('/api/assistant/conversation/direct-connect', 'POST'), true);
  for (const method of ['GET', 'PUT', 'DELETE'])
    assert.equal(phoneRouteAllowed('/api/assistant/conversation/direct-connect', method), false);
  for (const path of ['/workspace/direct/read', '/workspace/direct/policy', '/api/assistant/conversation/direct-connect/again'])
    assert.equal(phoneRouteAllowed(path, 'POST'), false);
});
test('restart closes only captured unfinished preparation without resending or replacing its input', async t => {
  const f = fixture(t), chat = await f.service.create(f.device, f.createInput), input = f.input(chat.id);
  f.service.close();
  const original = { format: 1, id: randomUUID(), requestId: input.requestId, deviceId: f.device,
    epoch: f.store.epoch, input, conversationId: chat.id, conversationRevision: chat.revision,
    nativeId: chat.nativeId, nativeKey: chat.nativeKey, generation: chat.connectionGeneration,
    sourceDigest: 'a'.repeat(64), source: { input: 'Original retained text', manifest: {} }, state: 'preparing', createdAt: new Date().toISOString() };
  const key = `assistant:direct-preparation:${input.requestId}`;
  f.store.internalWrite(key, original);
  assert.ok(updateMaintenanceBlockers(f.store).some(item => item.kind === 'assistant'));
  const calls = f.calls.length, restarted = new AssistantService(f.store, f.gateway);
  try {
    assert.deepEqual(f.store.internalRead(key), { ...original, state: 'failed' });
    assert.equal(f.calls.length, calls); assert.equal(f.counts('agent'), 0);
  } finally { restarted.close(); }
});
for (const recovery of [{ held: true }, { held: false, effectsPaused: true }]) {
  test(`held recovery preserves ordinary and direct checkpoints: ${JSON.stringify(recovery)}`, async t => {
    const f = fixture(t), chat = await f.service.create(f.device, f.createInput), input = f.input(chat.id);
    await f.service.submitRequest(f.device, input);
    await until(() => f.service.operations()[0]?.state === 'accepted');
    f.service.close();
    const connectionKey = `assistant:direct-connection:${chat.id}`;
    const connection = f.store.internalRead<any>(connectionKey);
    f.store.internalWrite(connectionKey, { ...connection, state: 'preparing', dispatchStarted: false });
    f.store.internalWrite(`assistant:conversation:${chat.id}`, { ...chat, state: 'creating' });
    const ordinaryId = randomUUID(), { directAgent: _direct, ...ordinary } = chat;
    f.store.internalWrite(`assistant:conversation:${ordinaryId}`, {
      ...ordinary, id: ordinaryId, nativeId: null, connectionGeneration: '', nativeKey: 'kept:ordinary', state: 'creating',
    });
    f.store.internalWrite('recovery:state', recovery);
    const capture = () => {
      const { id: _id, createdAt: _at, ...value } = f.store.captureBackup('held-recovery-regression', { status: 'not-configured', notes: [] });
      return value;
    };
    const before = capture(), calls = f.calls.length;
    const restarted = new AssistantService(f.store, f.gateway);
    try {
      assert.deepEqual(capture(), before, 'No checkpoint, revision, receipt, file or cursor changes while held');
      assert.equal(f.calls.length, calls, 'No native command or observation is started');
    } finally { restarted.close(); }
  });
}
test('Stop targets the original native run and closes its read authority without another dispatch', async t => {
  const f = fixture(t), chat = await f.service.create(f.device, f.createInput), input = f.input(chat.id);
  await f.service.submitRequest(f.device, input);
  await until(() => f.service.operations()[0]?.state === 'accepted');
  const original = f.service.operations()[0], cancel = { requestId: randomUUID(), epoch: f.store.epoch, operationId: original.id };
  await f.service.cancel(f.device, cancel); await f.service.cancel(f.device, cancel);
  assert.deepEqual(f.calls.filter(call => call.method === 'chat.abort').map(call => call.input),
    [{ sessionKey: original.nativeKey, runId: original.nativeRunId, preserveSideRuns: true }]);
  assert.equal(f.service.operations()[0].cancelRequested, true); assert.equal(f.counts('agent'), 1);
  assert.equal(f.owner.acceptsEvent(original, { runId: original.nativeRunId, sessionKey: original.nativeKey }), false);
});
test('revocation or Project move during the final account reply withholds results without rereading data', async t => {
  for (const phase of ['read', 'authorize'] as const) for (const change of ['permissions', 'project'] as const) {
    const f = fixture(t), chat = await f.service.create(f.device, f.createInput);
    const task = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch,
      kind: 'task', entityId: 'task:' + randomUUID(), expectedRevision: 0,
      payload: { title: 'Private retained task', notes: 'Must be withheld after revocation', status: 'open', planned: '', due: '' } });
    await f.service.submitRequest(f.device, f.input(chat.id));
    await until(() => f.service.operations()[0]?.state === 'accepted');
    const operation = f.service.operations()[0], observed = await f.owner.observe(f.service.conversations()[0]);
    const read = directReadInput({ operation: 'records.read', input: { kind: 'task', id: task.id } });
    const policy = { epoch: f.store.epoch, policySha256: observed.policy.policySha256, agentId: 'edition3-direct',
      sessionKey: operation.nativeKey, sessionId: operation.nativeId, runId: operation.requestId,
      toolCallId: 'original-call', inputSha256: read.inputSha256, read: read.input };
    const envelope = { registrationId: observed.policy.registrationId, request: policy };
    const origin = phase === 'read' ? await f.owner.authorize(envelope) : undefined;
    let accountCalls = 0, sourceReads = 0;
    const originalRead = f.store.readEntity.bind(f.store);
    f.store.readEntity = ((kind: any, id: string) => {
      if (kind === 'task' && id === task.id) sourceReads++;
      return originalRead(kind, id);
    }) as typeof f.store.readEntity;
    f.account(() => {
      if (++accountCalls !== 2) return;
      if (change === 'permissions') {
        const agent = originalRead('agent', f.createInput.recipient.agentId)!;
        f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'agent',
          entityId: agent.id, expectedRevision: agent.revision, payload: { ...agent.value, access: {} } });
      } else {
        const current = f.service.conversations()[0];
        f.store.internalWrite(`assistant:conversation:${current.id}`, { ...current,
          revision: current.revision + 1, projectId: 'project:changed' });
      }
    });
    try {
      await assert.rejects(phase === 'read'
        ? f.owner.read({ registrationId: observed.policy.registrationId, request: { origin, read: read.input } })
        : f.owner.authorize(envelope), /permissions/);
      assert.equal(accountCalls, 2);
      assert.equal(sourceReads, phase === 'read' ? 1 : 0);
      assert.equal(f.counts('agent'), 1);
    } finally { f.store.readEntity = originalRead; }
  }
});

const setupKey = (id: string) => `assistant:direct-connection:${id}`;
const sha = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function continueInput(f: ReturnType<typeof fixture>, id: string) {
  const setup = f.store.internalRead<any>(setupKey(id));
  return { requestId: randomUUID(), epoch: f.store.epoch, conversationId: id,
    expectedRevision: f.service.conversations().find(item => item.id === id)!.revision,
    action: 'continue-unsent', originalRequestId: setup.requestId, expectedSetupSha256: sha(setup) };
}

test('explicit unsent continuation preserves the failed snapshot and sends the original identity once', async t => {
  const f = fixture(t); f.failPolicy(true);
  const chat = await f.service.create(f.device, f.createInput), failed = f.store.internalRead<any>(setupKey(chat.id));
  assert.equal(chat.state, 'failed'); assert.equal(failed.dispatchStarted, false);
  assert.equal(failed.noDispatch.kind, 'confirmed-before-native-create'); assert.equal(f.counts('sessions.create'), 0);
  await f.service.create(f.device, f.createInput); assert.equal(f.counts('sessions.create'), 0);
  f.failPolicy(false);
  const input = continueInput(f, chat.id), ready = await f.service.connectDirect(f.device, input);
  assert.equal(ready.state, 'ready'); assert.equal(ready.id, chat.id); assert.equal(ready.nativeKey, chat.nativeKey);
  assert.equal(f.counts('sessions.create'), 1);
  const call = f.calls.find(item => item.method === 'sessions.create')!;
  assert.equal(call.input.idempotencyKey, f.createInput.requestId); assert.equal(call.input.key, chat.nativeKey);
  assert.deepEqual(f.store.internalRead(`assistant:direct-connection-attempt:${chat.id}:${input.requestId}`),
    { format: 1, continuationRequestId: input.requestId, expectedSetupSha256: sha(failed), failed });
  const result = f.store.internalRead<any>(setupKey(chat.id));
  assert.equal(result.requestId, failed.requestId); assert.equal(result.continuationRequestId, input.requestId);
  assert.equal(result.dispatchStarted, true); assert.equal(result.noDispatch, undefined);
  await f.service.connectDirect(f.device, input); assert.equal(f.counts('sessions.create'), 1);
});

test('setup status is a bounded original-device read projection, never admission or raw authority', async t => {
  const f = fixture(t); f.failPolicy(true);
  const chat = await f.service.create(f.device, f.createInput), setup = f.store.internalRead<any>(setupKey(chat.id));
  const other = f.store.session().deviceId, before = f.store.internalList(''), calls = f.calls.length;
  const status = f.service.state(f.device).directConnections!;
  assert.deepEqual(status, [{ conversationId: chat.id, originalRequestId: f.createInput.requestId,
    setupSha256: sha(setup), setupRevision: chat.revision, conversationRevision: chat.revision,
    state: 'failed', canContinueUnsent: true }]);
  assert.deepEqual(f.service.state(other).directConnections, []);
  assert.equal(f.service.state().directConnections, undefined);
  assert.deepEqual(f.store.internalList(''), before); assert.equal(f.calls.length, calls);
  f.store.internalWrite(setupKey(chat.id), { ...setup, dispatchStarted: true, state: 'unknown' });
  assert.equal(f.service.state(f.device).directConnections![0].canContinueUnsent, false);
  // No context/account/configuration data can enter this exact response shape.
  assert.deepEqual(Object.keys(status[0]).sort(), ['conversationId', 'originalRequestId', 'setupSha256',
    'setupRevision', 'conversationRevision', 'state', 'canContinueUnsent'].sort());
});

test('continuation refuses changed hash, owner, epoch, revision and caller-supplied proof before admission', async t => {
  const f = fixture(t); f.failPolicy(true);
  const chat = await f.service.create(f.device, f.createInput), original = f.store.internalRead<any>(setupKey(chat.id));
  f.failPolicy(false);
  const input = continueInput(f, chat.id);
  const cases = [
    { device: f.device, input: { ...input, expectedSetupSha256: '0'.repeat(64) } },
    { device: f.store.session().deviceId, input },
    { device: f.device, input: { ...input, epoch: randomUUID() } },
    { device: f.device, input: { ...input, expectedRevision: chat.revision + 1 } },
    { device: f.device, input: { ...input, originalRequestId: randomUUID() } },
    { device: f.device, input: { ...input, dispatchStarted: false, noDispatch: original.noDispatch } },
  ];
  for (const item of cases) {
    await assert.rejects(f.service.connectDirect(item.device, item.input));
    assert.deepEqual(f.store.internalRead(setupKey(chat.id)), original);
  }
  assert.equal(f.store.internalList('assistant:direct-connection-attempt:').length, 0);
  assert.equal(f.counts('sessions.create'), 0);
});

test('unknown, dispatched, legacy and incomplete proof records cannot continue even with their exact current hash', async t => {
  const f = fixture(t); f.failPolicy(true);
  const chat = await f.service.create(f.device, f.createInput), original = f.store.internalRead<any>(setupKey(chat.id));
  f.failPolicy(false);
  const { dispatchStarted: _marker, noDispatch: _proof, ...legacy } = original;
  for (const kept of [
    { ...original, state: 'unknown' }, { ...original, dispatchStarted: true }, legacy,
    { ...legacy, dispatchStarted: false },
    { ...original, noDispatch: { ...original.noDispatch, requestId: randomUUID() } },
  ]) {
    f.store.internalWrite(setupKey(chat.id), kept);
    await assert.rejects(f.service.connectDirect(f.device, continueInput(f, chat.id)));
    assert.deepEqual(f.store.internalRead(setupKey(chat.id)), kept);
  }
  assert.equal(f.counts('sessions.create'), 0);
  assert.equal(f.store.internalList('assistant:direct-connection-attempt:').length, 0);
});

test('interrupted preparation never acquires a live no-dispatch proof on restart', async t => {
  const f = fixture(t); f.failPolicy(true);
  const chat = await f.service.create(f.device, f.createInput), original = f.store.internalRead<any>(setupKey(chat.id));
  const { noDispatch: _proof, ...interrupted } = original;
  f.store.internalWrite(setupKey(chat.id), { ...interrupted, state: 'preparing' });
  f.service.close();
  const restarted = new AssistantService(f.store, f.gateway);
  const owner = new DirectAgentOwner(f.store, f.gateway, () => undefined); restarted.setDirectAgentOwner(owner);
  try {
    const kept = f.store.internalRead<any>(setupKey(chat.id));
    assert.equal(kept.state, 'failed'); assert.equal(kept.dispatchStarted, false); assert.equal(kept.noDispatch, undefined);
    assert.equal(f.counts('sessions.create'), 0);
  } finally { restarted.close(); }
});

test('a lost continuation reply keeps its send marker and can only observe the original session', async t => {
  const f = fixture(t); f.failPolicy(true);
  const chat = await f.service.create(f.device, f.createInput); f.failPolicy(false); f.loseCreate();
  const input = continueInput(f, chat.id), unknown = await f.service.connectDirect(f.device, input);
  assert.equal(unknown.state, 'unknown');
  const kept = f.store.internalRead<any>(setupKey(chat.id));
  assert.equal(kept.dispatchStarted, true); assert.equal(kept.noDispatch, undefined);
  await f.service.connectDirect(f.device, input);
  await assert.rejects(f.service.connectDirect(f.device, continueInput(f, chat.id)));
  assert.equal(f.counts('sessions.create'), 1);
  await f.service.reconcile(chat.id); assert.equal(f.counts('sessions.create'), 1);
  assert.equal(f.service.conversations()[0].nativeId, f.sessions.get(chat.nativeKey)!.id);
});

test('even a synchronous transport refusal cannot reset the durable dispatch marker', async t => {
  const f = fixture(t); f.failPolicy(true);
  const chat = await f.service.create(f.device, f.createInput); f.failPolicy(false);
  const request = f.gateway.request.bind(f.gateway); let entered = 0;
  f.gateway.request = ((method: string, input: unknown) => {
    if (method === 'sessions.create') {
      entered++;
      assert.equal(f.store.internalRead<any>(setupKey(chat.id)).dispatchStarted, true);
      throw Error('Synthetic synchronous transport refusal');
    }
    return request(method, input);
  }) as typeof f.gateway.request;
  const result = await f.service.connectDirect(f.device, continueInput(f, chat.id));
  assert.equal(result.state, 'unknown'); assert.equal(entered, 1);
  assert.equal(f.store.internalRead<any>(setupKey(chat.id)).noDispatch, undefined);
  await assert.rejects(f.service.connectDirect(f.device, continueInput(f, chat.id)));
  assert.equal(entered, 1);
});

test('continuation rechecks actual native absence and current recipient before creating', async t => {
  for (const change of ['native', 'recipient'] as const) {
    const f = fixture(t); f.failPolicy(true);
    const chat = await f.service.create(f.device, f.createInput); f.failPolicy(false);
    if (change === 'native') f.sessions.set(chat.nativeKey, { id: randomUUID(), accountId: null });
    else {
      const agent = f.store.readEntity('agent', f.createInput.recipient.agentId)!;
      f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'agent',
        entityId: agent.id, expectedRevision: agent.revision, payload: { ...agent.value, archived: true } });
    }
    const result = await f.service.connectDirect(f.device, continueInput(f, chat.id));
    assert.equal(result.state, 'failed'); assert.equal(f.counts('sessions.create'), 0);
    assert.equal(f.store.internalRead<any>(setupKey(chat.id)).dispatchStarted, false);
  }
});
