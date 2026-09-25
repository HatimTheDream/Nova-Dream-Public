import { z } from 'zod';
import { assignmentRuntimeAgent, assignmentNativeRuntimeAgent, configuredAssignmentNativeTools, nativeToolNamesSchema, matchesAssignmentRuntimePolicy } from '../../../packages/domain/agent-capabilities.js';
import { workerCapabilitiesSchema, workerContract, workerIdentitySchema, readNativeWorkerObservation, workerPluginId, workerReceiptSchema, workerRunSchema, supportsWorkerRuntime, type WorkerIdentity, type WorkerReceipt, type WorkerStatus } from '../../../packages/domain/worker.js';
import { workerInputHash, workerNativeIdentity } from './identity.js';
import { WorkerJournal } from './journal.js';

// Public SDK subset, verified against OpenClaw 2026.9.2 and 2026.9.6. No private Gateway
// context, global credentials, or generic runtime.gateway access is used.
export type WorkerPluginApi = {
  config?: { mcp?: unknown; agents?: { entries?: Record<string, unknown>; list?: { id: string; [key: string]: unknown }[] } };
  registrationMode: string; pluginConfig?: Record<string, unknown>;
  runtime: { version: string; subagent: {
    run(params: { sessionKey: string; message: string; disableTools: boolean; deliver: false; promptMode: 'minimal'; lightContext: true; idempotencyKey: string }): Promise<{ runId: string; sessionKey?: string; runtime?: { harness: string; provider: string; model: string } }>;
    waitForRun(params: { runId: string; timeoutMs: number }): Promise<unknown>;
  } };
  registerGatewayMethod(method: string, handler: (options: { params: Record<string, unknown>; respond: (ok: boolean, result?: unknown, error?: { code: string; message: string }) => void }) => Promise<void>, options: { scope: 'operator.read' | 'operator.write' }): void;
  registerService(service: { id: string; start: () => void; stop: () => void }): void;
  agent: { events: { registerAgentEventSubscription(subscription: { id: string; streams: string[]; handle: (event: { runId: string; sessionKey?: string; data: Record<string, unknown> }) => Promise<void> | void }): void } };
};

export function registerWorker(api: WorkerPluginApi) {
  if (api.registrationMode !== 'full') return;
  const config = z.object({ epoch: z.string().uuid(), bundlePath: z.string().min(1), receiptDirectory: z.string().min(1), nativeTools: nativeToolNamesSchema.optional() }).strict().parse(api.pluginConfig);
  // Creation is lazy: discovery/registration does not open persistent state.
  let journal: WorkerJournal | undefined, closing = false;
  const store = () => { if (closing) throw new Error('The worker runtime is stopping. Reconcile after reconnecting.'); return journal ??= new WorkerJournal(config.receiptDirectory); };
  const workspaceToolsReady = () => {
    const entry = api.config?.agents?.entries?.[assignmentRuntimeAgent] ?? api.config?.agents?.list?.find(a => a.id === assignmentRuntimeAgent);
    if (!entry || typeof entry !== 'object') return false;
    const { id, ...policy } = entry as Record<string, unknown>;
    return matchesAssignmentRuntimePolicy(policy);
  };
  const nativeTools = () => {
    const names = configuredAssignmentNativeTools(api.config);
    const entry = api.config?.agents?.entries?.[assignmentNativeRuntimeAgent] ?? api.config?.agents?.list?.find(a => a.id === assignmentNativeRuntimeAgent);
    if (!names.length || !entry || typeof entry !== 'object') return [];
    const { id, ...policy } = entry as Record<string, unknown>;
    return matchesAssignmentRuntimePolicy(policy, names) ? names : [];
  };
  const flights = new Map<string, Promise<WorkerReceipt>>();
  const observing = new Map<string, Promise<void>>();
  let observerTimer: ReturnType<typeof setInterval> | undefined;
  const hostId = () => store().hostId;
  const read = (id: string) => { const value = store().lookup(id); return value === undefined ? undefined : workerReceiptSchema.parse(value); };
  const save = (receipt: WorkerReceipt) => { const value = workerReceiptSchema.parse(receipt); store().register(value.attemptId, value); return value; };
  const observe = (receipt: WorkerReceipt) => {
    const previous = observing.get(receipt.attemptId); if (previous) return previous;
    const work = (async () => {
      if (closing || store().outcome(receipt)) return;
      const observation = readNativeWorkerObservation(await api.runtime.subagent.waitForRun({ runId: receipt.runId, timeoutMs: 0 }));
      if (!closing && observation.runId === receipt.runId) store().retainOutcome(receipt, observation);
    })().catch(() => { /* Preserve the original receipt; later status can reconcile. */ }).finally(() => observing.delete(receipt.attemptId));
    observing.set(receipt.attemptId, work); return work;
  };
  const validate = (raw: unknown) => {
    if (!supportsWorkerRuntime(api.runtime.version)) throw new Error('The worker adapter requires its verified OpenClaw version.');
    const input = workerIdentitySchema.parse(raw);
    if (input.epoch !== config.epoch) throw new Error('This worker belongs to a different workspace generation.');
    if (input.hostId !== hostId()) throw new Error('Reconnect the original assignment runtime before continuing.');
    const previous = read(input.attemptId);
    if (previous && (previous.inputHash !== input.inputHash || previous.epoch !== input.epoch || JSON.stringify(previous.nativeTools ?? []) !== JSON.stringify(input.nativeTools ?? []))) throw new Error('This worker request identity already belongs to different work.');
    return { input, previous };
  };
  const run = async (raw: unknown) => {
    const input = workerRunSchema.parse(raw), identity = { epoch: input.epoch, hostId: input.hostId, attemptId: input.attemptId, inputHash: input.inputHash, ...(input.toolMode ? { toolMode: input.toolMode } : {}), ...(input.nativeTools ? { nativeTools: input.nativeTools } : {}) };
    const { previous } = validate(identity);
    if (workerInputHash(input.message) !== input.inputHash) throw new Error('The supplied assignment no longer matches its captured input.');
    if (input.toolMode && !workspaceToolsReady()) throw new Error('The dedicated workspace tool policy is unavailable. Nothing was dispatched.');
    if (previous) {
      if (JSON.stringify(previous.nativeTools ?? []) !== JSON.stringify(input.nativeTools ?? [])) throw new Error('Keep the original native tool set.');
      if (previous.toolMode !== input.toolMode) throw new Error('Keep the original tool policy.');
      if (previous.deadlineAt !== undefined && previous.deadlineAt !== input.deadlineAt) throw new Error('Keep the original assignment deadline.');
      return flights.get(input.attemptId) ?? (previous.state === 'dispatching' ? save({ ...previous, state: 'unknown' }) : previous);
    }
    const configured = input.toolMode === 'workspace' ? nativeTools() : [];
    if (input.nativeTools?.length && (JSON.stringify(configured) !== JSON.stringify(input.nativeTools) || !input.toolMode)) throw new Error('The configured native tool set changed. Nothing was dispatched.');
    const now = Date.now();
    if (input.deadlineAt <= now || input.deadlineAt > now + 600000) throw new Error('Start a current assignment with at most ten minutes of runtime.');
    const receipt: WorkerReceipt = { ...identity, ...workerNativeIdentity(input), state: 'dispatching', stopRequested: false, createdAt: now, deadlineAt: input.deadlineAt };
    if (!store().registerIfAbsent(input.attemptId, receipt)) throw new Error('This assignment is already being admitted. Check its existing status.');
    const work = Promise.resolve().then(async () => {
      try {
        const beforeDispatch = read(input.attemptId)!;
        if (beforeDispatch.stopRequested || Date.now() >= input.deadlineAt) return save({ ...beforeDispatch, state: 'cancelled', stopRequested: true });
        // These fixed SDK options are the executable boundary, not prompt text.
        const accepted = await api.runtime.subagent.run({ sessionKey: receipt.sessionKey, message: input.message, disableTools: input.toolMode !== 'workspace', deliver: false, promptMode: 'minimal', lightContext: true, idempotencyKey: receipt.runId });
        const current = read(input.attemptId)!;
        if (accepted.runId !== receipt.runId || (accepted.sessionKey && accepted.sessionKey !== receipt.sessionKey)) return save({ ...current, state: 'unknown' });
        return save({ ...current, state: 'accepted', ...(accepted.runtime ? { runtime: accepted.runtime } : {}) });
      } catch {
        // Neither a thrown SDK call nor a lost acknowledgment proves no effect.
        return save({ ...read(input.attemptId)!, state: 'unknown' });
      } finally { flights.delete(input.attemptId); }
    });
    flights.set(input.attemptId, work);
    return work;
  };
  const stop = (raw: unknown) => {
    const { input, previous } = validate(raw);
    if (previous) return save({ ...previous, stopRequested: true });
    // A durable barrier rejects a delayed initial dispatch, even after restart.
    const barrier: WorkerReceipt = { ...input, ...workerNativeIdentity(input), state: 'cancelled', stopRequested: true, createdAt: Date.now() };
    if (!store().registerIfAbsent(input.attemptId, barrier)) throw new Error('The original worker is being admitted. Check its status before retrying stop.');
    return barrier;
  };
  const status = async (raw: unknown): Promise<WorkerStatus> => {
    const { input, previous } = validate(raw);
    if (!previous || previous.state === 'cancelled') return { receipt: previous ?? null };
    const receipt = previous.state === 'dispatching' && !flights.has(input.attemptId) ? save({ ...previous, state: 'unknown' }) : previous;
    try {
      const saved = store().outcome(receipt);
      if (saved) return { receipt, observation: saved };
      const observation = readNativeWorkerObservation(await api.runtime.subagent.waitForRun({ runId: receipt.runId, timeoutMs: 0 }));
      if (observation.runId !== receipt.runId) return { receipt, observationUnavailable: true };
      return { receipt: read(input.attemptId) ?? receipt, observation: store().retainOutcome(receipt, observation) ?? observation };
    } catch { return { receipt: read(input.attemptId) ?? receipt, observationUnavailable: true }; }
  };
  const method = (name: string, scope: 'operator.read' | 'operator.write', action: (params: Record<string, unknown>) => unknown | Promise<unknown>) => api.registerGatewayMethod(name, async ({ params, respond }) => {
    try { respond(true, await action(params)); } catch (reason) { respond(false, undefined, { code: 'INVALID_REQUEST', message: reason instanceof z.ZodError ? 'The worker request did not match its supported contract.' : reason instanceof Error ? reason.message : 'The worker could not confirm this request.' }); }
  }, { scope });
  method('e3.assignments.capabilities', 'operator.read', raw => {
    z.object({ epoch: z.string().uuid() }).strict().parse(raw);
    if (raw.epoch !== config.epoch || !supportsWorkerRuntime(api.runtime.version)) throw new Error('This worker adapter does not match the selected workspace and runtime.');
    return workerCapabilitiesSchema.parse({ contract: workerContract, epoch: config.epoch, hostId: hostId(), runtimeVersion: api.runtime.version, tools: workspaceToolsReady() ? 'workspace' : 'none', ...(workspaceToolsReady() && nativeTools().length ? { nativeTools: nativeTools() } : {}), automaticDelivery: false, durableReceipts: true, durableOutcomes: true, newRunsAvailable: store().hasCapacity() });
  });
  method('e3.assignments.run', 'operator.write', run);
  method('e3.assignments.stop', 'operator.write', stop);
  method('e3.assignments.status', 'operator.read', status);
  api.agent.events.registerAgentEventSubscription({ id: 'edition3-worker-terminal', streams: ['lifecycle'], handle: async event => {
    if (closing || !journal || !['end', 'error'].includes(String(event.data.phase))) return;
    const receipt = journal.lookupRun(event.runId);
    if (receipt && receipt.epoch === config.epoch && (!event.sessionKey || event.sessionKey === receipt.sessionKey)) await observe(receipt);
  } });
  api.registerService({ id: 'edition3-worker-journal', start: () => {
    closing = false;
    if (observerTimer) clearInterval(observerTimer);
    observerTimer = setInterval(() => { if (!closing) { try { for (const receipt of store().pending(config.epoch)) void observe(receipt); } catch { /* Status reports unavailable storage without crashing the native host. */ } } }, 1000); observerTimer.unref();
  }, stop: () => { closing = true; if (observerTimer) clearInterval(observerTimer); journal?.close(); journal = undefined; } });
}
export default { id: workerPluginId, name: 'Nova Dream assignment worker', description: 'Tool-free assignment execution for the owning Nova Dream workspace.', register: registerWorker };
