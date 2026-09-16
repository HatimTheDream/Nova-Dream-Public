import { assignmentNativeRuntimeAgent, assignmentRuntimePolicy, configuredAssignmentNativeTools } from '../packages/domain/agent-capabilities.js';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerWorker, type WorkerPluginApi } from '../apps/service/worker-plugin/index.js';
import { workerInputHash, workerNativeIdentity } from '../apps/service/worker-plugin/identity.js';
import { withWorkerPlugin } from '../apps/service/worker-runtime-config.js';
import type { WorkerReceipt, WorkerStatus } from '../packages/domain/worker.js';

const cleanups: (() => void)[] = [];
after(() => { for (const cleanup of cleanups) cleanup(); });
function fixture() {
  const epoch = randomUUID(), receiptDirectory = mkdtempSync(join(tmpdir(), 'edition3-worker-journal-'));
  let stop = () => {}; cleanups.push(() => { stop(); rmSync(receiptDirectory, { recursive: true, force: true }); });
  const handlers = new Map<string, Parameters<WorkerPluginApi['registerGatewayMethod']>[1]>(), scopes = new Map<string, string>();
  let eventHandler: Parameters<WorkerPluginApi['agent']['events']['registerAgentEventSubscription']>[0]['handle'] = () => {};
  const calls: Parameters<WorkerPluginApi['runtime']['subagent']['run']>[0][] = [];
  let run: WorkerPluginApi['runtime']['subagent']['run'] = async params => ({ runId: params.idempotencyKey, sessionKey: params.sessionKey });
  let observe: (params: { runId: string; timeoutMs: number }) => Promise<unknown> = async params => ({ runId: params.runId, status: 'pending' });
  const api: WorkerPluginApi = { registrationMode: 'full', pluginConfig: { epoch, bundlePath: '/fixture/worker', receiptDirectory }, runtime: { version: '2026.9.2', subagent: { run: async params => { calls.push(params); return run(params); }, waitForRun: params => observe(params) } }, registerGatewayMethod: (method, handler, options) => { handlers.set(method, handler); scopes.set(method, options.scope); }, agent: { events: { registerAgentEventSubscription: subscription => { eventHandler = subscription.handle; } } }, registerService: service => { stop = service.stop; } };
  registerWorker(api);
  const invoke = async <T = WorkerReceipt>(name: string, params: Record<string, unknown>): Promise<T> => {
    let result: unknown, error: string | undefined, answered = false;
    await handlers.get(`e3.assignments.${name}`)!({ params, respond: (ok, value, failure) => { answered = true; if (ok) result = value; else error = failure?.message; } });
    assert.equal(answered, true); if (error) throw new Error(error); return result as T;
  };
  const input = async (message = 'Review these supplied fixture notes only.') => {
    const caps = await invoke<{ hostId: string }>('capabilities', { epoch });
    return { epoch, hostId: caps.hostId, attemptId: randomUUID(), inputHash: workerInputHash(message), message, deadlineAt: Date.now() + 300000 };
  };
  return { epoch, api, receiptDirectory, emit: (event: Parameters<typeof eventHandler>[0]) => eventHandler(event), storageExists: () => existsSync(join(receiptDirectory, 'receipts.sqlite')), handlers, scopes, calls, invoke, input, setRun: (value: typeof run) => { run = value; }, setObserve: (value: typeof observe) => { observe = value; }, reload: () => { stop(); handlers.clear(); registerWorker(api); } };
}
const identity = (input: Awaited<ReturnType<ReturnType<typeof fixture>['input']>>) => ({ epoch: input.epoch, hostId: input.hostId, attemptId: input.attemptId, inputHash: input.inputHash });

test('settled failure category survives journal reload without raw provider details or another native call',async()=>{
  const f=fixture(),input=await f.input(),receipt=await f.invoke('run',input);
  f.setObserve(async params=>({runId:params.runId,status:'error',endedAt:123,error:'subscription usage limit private-provider-sentinel'}));
  await f.emit({runId:receipt.runId,sessionKey:receipt.sessionKey,data:{phase:'error'}});
  f.reload(); f.setObserve(async()=>{throw new Error('Native wait is no longer available');});
  const value=await f.invoke<WorkerStatus>('status',identity(input));
  assert.equal(value.observation?.failureReason,'usage_limit'); assert.equal(value.observation?.endedAt,123);
  assert.equal(JSON.stringify(value).includes('private-provider-sentinel'),false); assert.equal('error' in value.observation!,false);
  for(const name of ['receipts.sqlite','receipts.sqlite-wal'])if(existsSync(join(f.receiptDirectory,name)))assert.equal(readFileSync(join(f.receiptDirectory,name)).includes(Buffer.from('private-provider-sentinel')),false);
  assert.equal(f.calls.length,1);
});

test('worker discovery has no persistent state or methods; execution/status use appropriate operator scopes', () => {
  const f = fixture(); assert.equal(f.storageExists(), false);
  assert.deepEqual(Object.fromEntries(f.scopes), { 'e3.assignments.capabilities': 'operator.read', 'e3.assignments.run': 'operator.write', 'e3.assignments.stop': 'operator.write', 'e3.assignments.status': 'operator.read' });
  f.handlers.clear(); f.api.registrationMode = 'discovery'; registerWorker(f.api); assert.equal(f.handlers.size, 0); assert.equal(f.storageExists(), false);
});
test('concurrent worker retries use one fixed tool-free native call and retain the accepted identity', async () => {
  const f = fixture(), input = await f.input(); let finish!: () => void;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  f.setRun(async params => { await hold; return { runId: params.idempotencyKey, sessionKey: params.sessionKey, runtime: { harness: 'fixture', provider: 'fixture', model: 'fixture' } }; });
  const first = f.invoke('run', input), second = f.invoke('run', input); await Promise.resolve(); assert.equal(f.calls.length, 1); finish();
  const [a, b] = await Promise.all([first, second]); assert.deepEqual(a, b); assert.equal(a.state, 'accepted'); assert.equal(a.stopRequested, false);
  assert.deepEqual(f.calls[0], { sessionKey: workerNativeIdentity(input).sessionKey, message: input.message, disableTools: true, deliver: false, promptMode: 'minimal', lightContext: true, idempotencyKey: workerNativeIdentity(input).runId });
  assert.equal(f.storageExists(), true);
  assert.equal(readFileSync(join(f.receiptDirectory, 'receipts.sqlite')).includes(Buffer.from(input.message)), false);
  f.reload(); assert.deepEqual(await f.invoke('run', input), a); assert.equal(f.calls.length, 1);
});
test('a lost native acknowledgment remains unknown after reloading the adapter and is never dispatched again', async () => {
  const f = fixture(), input = await f.input(); f.setRun(async () => { throw new Error('Fixture lost native acknowledgment'); });
  const first = await f.invoke('run', input); assert.equal(first.state, 'unknown'); f.reload();
  assert.deepEqual(await f.invoke('run', input), first); assert.equal(f.calls.length, 1);
  await assert.rejects(f.invoke('run', { ...input, message: 'Different work', inputHash: workerInputHash('Different work') }), /different work/);
  await assert.rejects(f.invoke('run', { ...input, deadlineAt: input.deadlineAt + 1 }), /original assignment deadline/);
  const status = await f.invoke<WorkerStatus>('status', identity(input)); assert.equal(status.receipt?.state, 'unknown'); assert.equal(status.observation?.status, 'pending');
});
test('stop barriers prevent a late first run, including a stop between local admission and native dispatch', async () => {
  const f = fixture(), input = await f.input();
  assert.equal((await f.invoke('stop', identity(input))).state, 'cancelled'); f.reload();
  assert.equal((await f.invoke('run', input)).state, 'cancelled'); assert.equal(f.calls.length, 0);
  const next = await f.input(); const starting = f.invoke('run', next), stopping = f.invoke('stop', identity(next));
  assert.equal((await stopping).stopRequested, true); assert.equal((await starting).state, 'cancelled'); assert.equal(f.calls.length, 0);
});
test('stop during a native admission keeps the real accepted run unresolved until native terminal evidence', async () => {
  const f = fixture(), input = await f.input(); let finish!: () => void; const hold = new Promise<void>(resolve => { finish = resolve; });
  f.setRun(async params => { await hold; return { runId: params.idempotencyKey, sessionKey: params.sessionKey }; });
  const starting = f.invoke('run', input); await Promise.resolve(); assert.equal(f.calls.length, 1);
  const stop = await f.invoke('stop', identity(input)); assert.equal(stop.state, 'dispatching'); assert.equal(stop.stopRequested, true); finish();
  const accepted = await starting; assert.equal(accepted.state, 'accepted'); assert.equal(accepted.stopRequested, true);
});
test('runtime version, host, input hash, deadline and unsupported options are fenced before native work', async () => {
  const f = fixture(), input = await f.input();
  await assert.rejects(f.invoke('run', { ...input, hostId: randomUUID() }), /original assignment runtime/);
  await assert.rejects(f.invoke('run', { ...input, epoch: randomUUID() }), /different workspace/);
  await assert.rejects(f.invoke('run', { ...input, inputHash: 'f'.repeat(64) }), /captured input/);
  await assert.rejects(f.invoke('run', { ...input, deadlineAt: Date.now() - 1 }), /at most ten minutes/);
  await assert.rejects(f.invoke('run', { ...input, model: 'other/model' }), /supported contract/);
  f.api.runtime.version = '2026.9.3'; await assert.rejects(f.invoke('capabilities', { epoch: f.epoch }), /runtime/); assert.equal(f.calls.length, 0);
});
test('mismatched native acknowledgments and wait replies cannot confirm another run', async () => {
  const f = fixture(), input = await f.input(); f.setRun(async () => ({ runId: randomUUID(), sessionKey: 'agent:main:foreign' }));
  assert.equal((await f.invoke('run', input)).state, 'unknown');
  f.setObserve(async () => ({ runId: randomUUID(), status: 'ok', endedAt: Date.now() }));
  const foreign = await f.invoke<WorkerStatus>('status', identity(input)); assert.equal(foreign.observationUnavailable, true); assert.equal(foreign.observation, undefined);
  f.setObserve(async params => ({ runId: params.runId, status: 'timeout' }));
  assert.equal((await f.invoke<WorkerStatus>('status', identity(input))).observation?.status, 'timeout');
});
test('owned runtime plugin updates preserve unrelated settings and replace the prior bundle path atomically', () => {
  const epoch = randomUUID(), original = { agents: { defaults: { model: { primary: 'owner/choice' } } }, auth: { profiles: { 'private-fixture': { provider: 'fixture', mode: 'oauth' } } }, plugins: { allow: ['openai', 'codex', 'owner-plugin', 'edition3-worker'], load: { paths: ['/owner/plugin', '/old/worker'] }, entries: { 'owner-plugin': { enabled: true }, 'edition3-worker': { enabled: true, config: { epoch, bundlePath: '/old/worker' } } } } };
  const updated = withWorkerPlugin(original, epoch, '/new/worker', '/fixture/receipts');
  assert.equal(updated.agents.ownership, 'explicit');
  assert.deepEqual(updated.agents.defaults, {...original.agents.defaults, systemAgent: {agentId:'main'}}); assert.deepEqual((updated.agents as any).entries['edition3-assignment'].tools.allow, ['nova_read','nova_write']); assert.deepEqual(updated.auth, original.auth); assert.deepEqual(updated.plugins.load.paths, ['/owner/plugin', '/new/worker']); assert.deepEqual(updated.plugins.allow, original.plugins.allow);
  assert.deepEqual(withWorkerPlugin(updated, epoch, '/new/worker', '/fixture/receipts'), updated); assert.deepEqual(original.plugins.load.paths, ['/owner/plugin', '/old/worker']);
  assert.throws(() => withWorkerPlugin({ plugins: { enabled: false } }, epoch, '/new/worker', '/fixture/receipts'), /disabled/);
  assert.throws(() => withWorkerPlugin({ plugins: { entries: { 'edition3-worker': { enabled: false } } } }, epoch, '/new/worker', '/fixture/receipts'), /disabled/);
});
test('native lifecycle capture retains the exact encrypted terminal reply before any client status request, then survives reload', async () => {
  const f = fixture(), input = await f.input(); const receipt = await f.invoke('run', input);
  const text = '\uFEFFOriginal terminal sentinel 🐾\r\n'.repeat(150), nativeId = randomUUID(), turnId = randomUUID();
  f.setObserve(async params => ({ runId: params.runId, status: 'ok', endedAt: Date.now(), terminalReceipt: { runId: params.runId, sessionId: nativeId, turnId, effective: { provider: 'fixture', model: 'original-model' }, successfulToolNames: [] }, terminalReply: { disposition: 'visible', text } }));
  await f.emit({ runId: receipt.runId, sessionKey: receipt.sessionKey, data: { phase: 'end' } });
  f.reload(); f.setObserve(async params => ({ runId: params.runId, status: 'timeout' }));
  const status = await f.invoke<WorkerStatus>('status', identity(input)); assert.equal(status.observation?.status, 'ok');
  assert.equal(status.observation?.terminalReceipt?.turnId, turnId); assert.deepEqual(status.observation?.terminalReply, { disposition: 'visible', text });
  for (const name of ['receipts.sqlite', 'receipts.sqlite-wal']) if (existsSync(join(f.receiptDirectory, name))) assert.equal(readFileSync(join(f.receiptDirectory, name)).includes(Buffer.from('Original terminal sentinel')), false);
  assert.equal(f.calls.length, 1);
});
test('wait timeouts, pending errors and foreign run/session lifecycle events cannot create durable terminal proof', async () => {
  const f = fixture(), input = await f.input(); const receipt = await f.invoke('run', input); let waits = 0;
  f.setObserve(async params => { waits++; return { runId: params.runId, status: 'error', endedAt: Date.now(), pendingError: true }; });
  await f.emit({ runId: randomUUID(), data: { phase: 'end' } }); await f.emit({ runId: receipt.runId, sessionKey: 'agent:main:unrelated', data: { phase: 'end' } }); assert.equal(waits, 0);
  await f.emit({ runId: receipt.runId, sessionKey: receipt.sessionKey, data: { phase: 'error' } }); assert.equal(waits, 1);
  f.reload(); f.setObserve(async params => ({ runId: params.runId, status: 'timeout' }));
  assert.equal((await f.invoke<WorkerStatus>('status', identity(input))).observation?.status, 'timeout');
});
test('outcome key replacement fails closed and reserved journal capacity prevents unbounded native admissions', async () => {
  const f = fixture(), inputs = [];
  for (let i = 0; i < 7; i++) { const input = await f.input(`Fixture ${i}`); inputs.push(input); await f.invoke('run', input); }
  const blocked = await f.input('Unadmitted fixture');
  const capacity = await f.invoke<{ newRunsAvailable: boolean }>('capabilities', { epoch: f.epoch }); assert.equal(capacity.newRunsAvailable, false);
  await assert.rejects(f.invoke('run', blocked), /journal is full/); assert.equal(f.calls.length, 7);
  // Stops remain available even when no additional inference can be admitted.
  assert.equal((await f.invoke('stop', identity(blocked))).state, 'cancelled');
  f.setObserve(async params => ({ runId: params.runId, status: 'error', endedAt: Date.now(), stopReason: 'rpc' }));
  await f.invoke('status', identity(inputs[0]));
  assert.equal((await f.invoke<{ newRunsAvailable: boolean }>('capabilities', { epoch: f.epoch })).newRunsAvailable, true);
  const keyPath = join(f.receiptDirectory, 'outcomes.key'), original = readFileSync(keyPath);
  f.reload(); writeFileSync(keyPath, Buffer.alloc(32, 5)); await assert.rejects(f.invoke('capabilities', { epoch: f.epoch }), /key did not verify/);
  writeFileSync(keyPath, original); f.reload(); assert.equal((await f.invoke<WorkerStatus>('status', identity(inputs[0]))).observation?.status, 'error');
});

test('workspace assignments require the exact dedicated tool policy and keep a distinct native session', async () => {
  const { assignmentRuntimePolicy } = await import('../packages/domain/agent-capabilities.js');
  const f = fixture(), input = { ...await f.input(), toolMode: 'workspace' as const };
  await assert.rejects(f.invoke('run', input), /policy is unavailable/);
  assert.equal(f.calls.length, 0);
  f.api.config = { agents: { entries: { 'edition3-assignment': assignmentRuntimePolicy } } };
  await f.invoke('run', input);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].disableTools, false);
  assert.match(f.calls[0].sessionKey, /^agent:edition3-assignment:/);
  f.api.config = { agents: { entries: { 'edition3-assignment': { ...assignmentRuntimePolicy, tools: { allow: ['*'] } } } } };
  await assert.rejects(f.invoke('run', { ...await f.input(), toolMode: 'workspace' }), /policy is unavailable/);
  assert.equal(f.calls.length, 1);
});

test('owned native policy is separate, revocable and cannot widen an admitted tool set',async()=>{
 const f=fixture(),raw={mcp:{servers:{calculator:{command:'/official/driver',codex:{agents:[assignmentNativeRuntimeAgent],defaultToolsApprovalMode:'prompt'},toolFilter:{include:['click']}}}}};
 const cfg=withWorkerPlugin(raw,f.epoch,'/fixture/worker',f.receiptDirectory);f.api.config=cfg as any;f.reload();
 assert.deepEqual((cfg.agents as any).entries['edition3-assignment'],assignmentRuntimePolicy);
 const names=configuredAssignmentNativeTools(cfg),input={...await f.input(),toolMode:'workspace',nativeTools:names};
 const accepted=await f.invoke('run',input);assert.match(accepted.sessionKey,/^agent:edition3-native-assignment:/);
 assert.equal((await f.invoke('run',input)).runId,accepted.runId);assert.equal(f.calls.length,1);
 await assert.rejects(f.invoke('run',{...input,nativeTools:['calculator__click','calculator__type_text']}),/different work|original native tool/);assert.equal(f.calls.length,1);
 const revoked=withWorkerPlugin({...cfg,mcp:{servers:{}}},f.epoch,'/fixture/worker',f.receiptDirectory);assert.deepEqual((revoked.agents as any).entries[assignmentNativeRuntimeAgent],assignmentRuntimePolicy);
 f.api.config=revoked as any;const later={...await f.input(),toolMode:'workspace',nativeTools:names};await assert.rejects(f.invoke('run',later),/native tool set changed/);assert.equal(f.calls.length,1);
});
