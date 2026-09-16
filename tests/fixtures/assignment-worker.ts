import { assignmentRuntimePolicy, assignmentPolicyWithNativeTools, configuredAssignmentNativeTools, assignmentNativeRuntimeAgent } from '../../packages/domain/agent-capabilities.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { registerWorker, type WorkerPluginApi } from '../../apps/service/worker-plugin/index.js';
import type { AssistantTransport } from '../../apps/service/gateway.js';
import type { AssistantConnection } from '../../packages/domain/assistant.js';

type Handler = Parameters<WorkerPluginApi['registerGatewayMethod']>[1];
export class WorkerTransport implements AssistantTransport {
  generation = randomUUID(); available = true; epoch: string; handlers = new Map<string, Handler>();
  methods = ['e3.assignments.capabilities', 'e3.assignments.run', 'e3.assignments.stop', 'e3.assignments.status', 'chat.abort', 'chat.history'];
  calls: { method: string; params: any }[] = []; nativeCalls: any[] = [];
  holdAdmission?: Promise<void>; holdCapabilities?: Promise<void>; loseAck = false; foreignReceipt = false; foreignSession = false;
  observation: any = { status: 'timeout' }; nativeId = randomUUID(); stopJournal?: () => void;
  constructor(directory: string, epoch: string, nativeConfig: Record<string, unknown> = {}) {
    this.epoch = epoch;
    registerWorker({ registrationMode: 'full', config: { ...nativeConfig, agents: { entries: { 'edition3-assignment': assignmentRuntimePolicy, [assignmentNativeRuntimeAgent]: assignmentPolicyWithNativeTools(configuredAssignmentNativeTools(nativeConfig)) } } }, pluginConfig: { epoch, bundlePath: '/fixture/worker', receiptDirectory: join(directory, 'worker') }, runtime: { version: '2026.9.2', subagent: {
      run: async params => { this.nativeCalls.push(params); this.observation = { status: 'timeout' }; await this.holdAdmission; if (this.loseAck) throw new Error('Lost acknowledgment'); return { runId: params.idempotencyKey, sessionKey: params.sessionKey }; },
      waitForRun: async params => ({ runId: params.runId, ...this.observation, ...(this.observation.terminalReceipt ? { terminalReceipt: { ...this.observation.terminalReceipt, runId: this.foreignReceipt ? randomUUID() : params.runId, sessionId: this.nativeId } } : {}) }),
    } }, agent: { events: { registerAgentEventSubscription: () => {} } }, registerGatewayMethod: (name, handler) => this.handlers.set(name, handler), registerService: service => { this.stopJournal = service.stop; } });
  }
  status(): AssistantConnection { return { state: this.available ? 'ready' : 'disconnected', generation: this.generation, message: 'Fixture', methods: this.methods, grantedScopes: ['operator.read', 'operator.write'], modelAuthReady: true }; }
  subscribe() { return () => {}; } models() { return Promise.resolve([]); } attachmentPolicy() { return {}; }
  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    if (!this.available) throw new Error('Disconnected');
    if (method === 'e3.assignments.capabilities') await this.holdCapabilities;
    if (method === 'chat.history') return { sessionId: this.foreignSession ? randomUUID() : this.nativeId } as T;
    if (method === 'chat.abort') return { aborted: true, runIds: [params.runId] } as T;
    return new Promise<T>((ok, reject) => {
      void this.handlers.get(method)!({ params, respond: (success, result, error) => success ? ok(result as T) : reject(new Error(error?.message)) }).catch(reject);
    });
  }
  finish(text = 'Complete native result', status: 'ok' | 'error' = 'ok') {
    this.observation = { status, endedAt: Date.now(), stopReason: status === 'error' ? 'aborted' : 'stop', terminalReceipt: { turnId: randomUUID(), effective: { provider: 'fixture', model: 'worker' }, successfulToolNames: [] }, terminalReply: { disposition: 'visible', text } };
  }
}
