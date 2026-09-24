import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { GatewayClient, type DeviceIdentity, type GatewayClientOptions } from '@openclaw/gateway-client';
import type { EventFrame, HelloOk } from '@openclaw/gateway-protocol/frame-guards';
import type { AssistantConnection, AssistantModel } from '../../packages/domain/assistant.js';
import { agentServiceInfo, type AgentServiceInfo } from '../../packages/domain/agent-service.js';
import { Fault, Store } from './store.js';
import { chatGptProfileIdSchema } from '../../packages/domain/chatgpt-accounts.js';

type Configuration = { url: string; token: string; generation: string };
type DeviceToken = { token: string; scopes: string[] };
type Client = Pick<GatewayClient, 'start' | 'stopAndWait' | 'request'>;
type ModelCatalog = { models?: { id: string; name?: string; provider?: string; available?: boolean; reasoning?: boolean; tags?: string[]; thinkingLevels?: { id: string }[] }[] };
const catalogSignature = (catalog: ModelCatalog) => JSON.stringify((catalog.models ?? []).map(({ id, provider, available, reasoning, thinkingLevels }) => ({ id, provider, available, reasoning, thinkingLevels })).sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`)));
export interface AssistantTransport {
  status(): AssistantConnection;
  serviceInfo?(): AgentServiceInfo;
  request<T = Record<string, unknown>>(method: string, params: unknown): Promise<T>;
  subscribe(listener: (event: EventFrame) => void): () => void;
  models(): Promise<AssistantModel[]>;
  attachmentPolicy(): { maxBytes?: number; maxImageBytes?: number; maxPayload?: number };
}
const initialStatus = (): AssistantConnection => ({ state: 'unconfigured', message: 'Connect OpenClaw to use your ChatGPT account.', methods: [], grantedScopes: [], modelAuthReady: false });
const allowedMethods = new Set(['e3.workspace.policy', 'e3.accounts.snapshot', 'usage.status', 'usage.cost', 'sessions.diff', 'sessions.goal.update', 'sessions.goal.clear', 'e3.sources.stage', 'skills.status', 'e3.assignments.capabilities', 'e3.assignments.run', 'e3.assignments.stop', 'e3.assignments.status', 'models.list', 'models.authStatus', 'sessions.create', 'sessions.patch', 'sessions.delete', 'sessions.describe', 'sessions.fork', 'sessions.list', 'sessions.search', 'sessions.subscribe', 'sessions.messages.subscribe', 'chat.history', 'chat.send', 'chat.abort', 'agent.wait', 'artifacts.download', 'talk.catalog', 'talk.client.create', 'talk.client.close', 'talk.client.transcript', 'talk.client.toolCall', 'talk.client.steer', 'talk.session.create', 'talk.session.appendAudio', 'talk.session.close', 'talk.session.steer', 'talk.speak']);
const questionMethods = new Set(['sessions.messages.subscribe', 'question.list', 'question.get', 'question.resolve']);
const reviewMethods = new Set(['sessions.messages.subscribe', 'approval.get', 'approval.resolve']);
const skillReadMethods = new Set(['skills.proposals.list', 'skills.proposals.inspect', 'skills.proposals.events.list']);
const skillManagementMethods = new Set([...skillReadMethods, 'skills.proposals.create', 'skills.proposals.update', 'skills.proposals.revise', 'skills.proposals.apply', 'skills.proposals.reject']);

/** Supported, version-pinned Gateway transport. All credentials stay in host storage. */
export class Gateway implements AssistantTransport {
  private client?: Client;
  private connection = initialStatus();
  private listeners = new Set<(event: EventFrame) => void>();
  private hello?: HelloOk;
  private stopped = false;
  private lifecycle = 0;
  private catalogEpoch = 0;
  private catalogRequest?: Promise<AssistantModel[]>;
  private discoveredCatalog?: string;
  private resetModels() { ++this.catalogEpoch; this.catalogRequest = undefined; this.discoveredCatalog = undefined; }
  constructor(private store: Store, private version = 'development', private createClient: (options: GatewayClientOptions) => Client = options => new GatewayClient(options), private purpose: 'assistant' | 'skill-management' | 'permission-control' | 'response-control' | 'approval-review' | 'question-review' | 'browser-control' | 'account-control' | 'speech-playback' = 'assistant') {}
  status(): AssistantConnection { return structuredClone(this.connection); }
  serviceInfo(): AgentServiceInfo { return agentServiceInfo({ id: 'openclaw', name: 'OpenClaw', state: this.connection.state, version: this.hello?.server?.version }); }
  subscribe(listener: (event: EventFrame) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  attachmentPolicy() { return { ...this.hello?.policy.attachments, maxPayload: this.hello?.policy.maxPayload }; }
  async configure(url: string, token?: string) {
    if (this.purpose !== 'assistant') throw new Fault(403, 'gateway_configuration', 'Management uses the Assistant’s configured host.');
    const target = new URL(url);
    if (target.username || target.password || target.hash || (target.protocol !== 'wss:' && !(target.protocol === 'ws:' && ['127.0.0.1', '[::1]'].includes(target.hostname)))) throw new Fault(400, 'gateway_address', 'Use a private secure Gateway address, or loopback on this host.');
    const old = this.store.internalRead<Configuration>('gateway:configuration');
    if (old && old.url !== url && !token) throw new Fault(400, 'gateway_credentials', 'A different Gateway needs its own connection credential.');
    const configuration = { url, token: token ?? old?.token ?? '', generation: old?.url === url ? old.generation : randomUUID() };
    if (!configuration.token) throw new Fault(400, 'gateway_credentials', 'Enter the Gateway connection token from its supported setup.');
    await this.stop();
    this.store.internalWrite('gateway:configuration', configuration);
    this.start();
    return this.status();
  }
  start() {
    if (this.client) return;
    this.stopped = false;
    const config = this.store.internalRead<Configuration>('gateway:configuration');
    if (!config) return;
    const prefix = this.purpose === 'assistant' ? 'gateway' : `gateway:${this.purpose}`;
    // Native approvals are bound to the device that submitted the turn. The
    // review connection represents that same owner device, with separate scopes
    // and an RPC allowlist; a different key cannot receive its approval route.
    const identityPrefix = this.purpose === 'approval-review' ? 'gateway' : prefix;
    const identityKey = `${identityPrefix}:identity:${config.generation}`;
    let identity = this.store.internalRead<DeviceIdentity>(identityKey);
    if (!identity) {
      const keys = generateKeyPairSync('ed25519');
      identity = { deviceId: createHash('sha256').update(keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).digest('hex'), publicKeyPem: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(), privateKeyPem: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
      this.store.internalWrite(identityKey, identity);
    }
    // Keep the former reviewer identity/token intact for recovery. Never load a
    // token issued to that old device into the owner-bound review connection.
    const tokenPrefix = this.purpose === 'approval-review' ? `${prefix}:owner-bound` : prefix;
    const tokenKey = `${tokenPrefix}:device-token:${config.generation}`;
    this.connection = { ...initialStatus(), state: 'connecting', message: 'Connecting to OpenClaw…', url: config.url, generation: config.generation };
    const generation = config.generation, lifecycle = ++this.lifecycle;
    const live = () => !this.stopped && this.lifecycle === lifecycle && this.connection.generation === generation;
    this.client = this.createClient({
      url: config.url, token: config.token, clientName: 'gateway-client', clientDisplayName: this.purpose === 'assistant' ? 'Nova Dream' : this.purpose === 'speech-playback' ? 'Nova Dream — Read aloud' : this.purpose === 'account-control' ? 'Nova Dream — Account selection' : this.purpose === 'browser-control' ? 'Nova Dream — Host browser' : this.purpose === 'question-review' ? 'Nova Dream — Question review' : this.purpose === 'approval-review' ? 'Nova Dream — Approval review' : this.purpose === 'response-control' ? 'Nova Dream — Response controls' : this.purpose === 'permission-control' ? 'Nova Dream — Access controls' : 'Nova Dream — Skill management', clientVersion: this.version, mode: 'backend', platform: process.platform, role: 'operator', scopes: this.purpose === 'question-review' ? ['operator.read', 'operator.questions'] : this.purpose === 'approval-review' ? ['operator.read', 'operator.approvals'] : this.purpose === 'speech-playback' ? ['operator.read', 'operator.talk'] : this.purpose === 'assistant' ? ['operator.read', 'operator.write'] : ['operator.read', 'operator.admin'], caps: this.purpose === 'approval-review' ? ['approvals'] : this.purpose === 'assistant' ? ['tool-events'] : [], minProtocol: 4, maxProtocol: 4, deviceIdentity: identity, requestTimeoutMs: this.purpose === 'browser-control' ? 45000 : 12000,
      hostDeps: {
        signDevicePayload: (pem, payload) => sign(null, Buffer.from(payload), pem).toString('base64url'),
        publicKeyRawBase64UrlFromPem: pem => createPublicKey(pem).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
        loadDeviceAuthToken: () => this.store.internalRead<DeviceToken>(tokenKey) ?? null,
        storeDeviceAuthToken: value => { if (live()) this.store.internalWrite(tokenKey, { token: value.token, scopes: value.scopes }); },
        clearDeviceAuthToken: () => { if (live()) this.store.internalWrite(tokenKey, null); },
      },
      onHelloOk: hello => {
        if (!live()) return;
        this.resetModels();
        this.hello = hello;
        this.connection = { ...this.connection, state: 'ready', protocol: hello.protocol, methods: hello.features.methods, grantedScopes: hello.auth?.scopes ?? [], message: 'OpenClaw connected.', pairingRequestId: undefined };
        if (this.purpose === 'assistant') void this.models().catch(() => undefined);
        for (const listener of this.listeners) listener({ type: 'event', event: 'e3.connected', payload: { generation } });
      },
      onEvent: event => { if (live()) for (const listener of this.listeners) listener(event); },
      onGap: () => { if (live()) for (const listener of this.listeners) listener({ type: 'event', event: 'e3.history-gap', payload: { generation } }); },
      onClose: () => { if (live()) { this.hello = undefined; this.resetModels(); this.connection = { ...this.connection, state: 'disconnected', modelAuthReady: false, message: 'OpenClaw disconnected. Saved work is kept; admitted runs will be reconciled.' }; for (const listener of this.listeners) listener({ type: 'event', event: 'e3.disconnected', payload: { generation } }); } },
      onConnectError: error => {
        if (!live()) return;
        this.hello = undefined;
        this.resetModels();
        const details = (error as Error & { details?: Record<string, unknown> }).details;
        const pairing = typeof details?.requestId === 'string';
        this.connection = { ...this.connection, state: pairing ? 'pairing' : 'error', pairingRequestId: pairing ? String(details.requestId) : undefined, modelAuthReady: false, message: pairing ? 'Approve this exact Nova Dream device in OpenClaw, then reconnect.' : 'OpenClaw could not authenticate or negotiate this connection. Review its address and sign-in.' };
      },
    });
    this.client.start();
  }
  async request<T = Record<string, unknown>>(method: string, params: unknown): Promise<T> {
    if (this.store.recoveryEffectsPaused) throw new Fault(409, 'recovery_held', 'Assistant execution is paused in this recovered copy.');
    if (!(this.purpose === 'assistant' ? allowedMethods.has(method) || skillReadMethods.has(method) : this.purpose === 'speech-playback' ? ['talk.catalog', 'talk.speak'].includes(method) : this.purpose === 'account-control' ? method === 'models.authOrderSet' : this.purpose === 'browser-control' ? method === 'browser.request' : this.purpose === 'question-review' ? questionMethods.has(method) : this.purpose === 'approval-review' ? reviewMethods.has(method) : this.purpose === 'response-control' ? method === 'sessions.patch' : this.purpose === 'permission-control' ? ['sessions.create', 'sessions.patch'].includes(method) : skillManagementMethods.has(method))) throw new Fault(403, 'gateway_method', 'This Gateway operation is not exposed by Nova Dream.');
    if (this.purpose === 'account-control') {
      const input = params as Record<string, unknown> | null;
      if (!input || input.provider !== 'openai' || input.agentId !== 'main' || !Array.isArray(input.profileIds) || !input.profileIds.length || input.profileIds.length > 100 || new Set(input.profileIds).size !== input.profileIds.length || input.profileIds.some(id => !chatGptProfileIdSchema.safeParse(id).success) || Object.keys(input).some(key => !['provider', 'agentId', 'profileIds'].includes(key))) throw new Fault(403, 'gateway_method', 'Account controls accept only the complete ChatGPT profile order on this host.');
    }
    if (this.purpose === 'browser-control') {
      const input=params as Record<string,any>;
      if(input?.query?.profile!=='nova-work' || !['GET','POST','DELETE'].includes(input.method) || !(/^\/(?:|tabs|snapshot|screenshot|navigate|act|stop|tabs\/open|tabs\/[A-Za-z0-9%_-]+)$/.test(input.path))) throw new Fault(403,'browser_scope','Host browser controls use only the isolated Nova profile.');
    }
    if (this.purpose === 'response-control') {
      const input = params as Record<string, unknown> | null;
      if (!input || typeof input.key !== 'string' || typeof input.expectedSessionId !== 'string' || (!Object.hasOwn(input, 'thinkingLevel') && !Object.hasOwn(input, 'fastMode')) || (input.permissionMode !== undefined && !['read-only', 'guarded', 'workspace'].includes(String(input.permissionMode))) || Object.keys(input).some(key => !['key', 'expectedSessionId', 'thinkingLevel', 'fastMode', 'label', 'archived', 'pinned', 'unread', 'permissionMode'].includes(key))) throw new Fault(403, 'gateway_method', 'Response controls accept only response settings and ordinary metadata for the captured conversation.');
    }
    if (this.purpose === 'permission-control') {
      const input = params as Record<string, unknown> | null;
      const allowed = method === 'sessions.create' ? ['key', 'idempotencyKey', 'cwd', 'worktree', 'label', 'model', 'thinkingLevel', 'fastMode', 'permissionMode', 'emitCommandHooks'] : ['key', 'expectedSessionId', 'expectedPermissionMode', 'permissionMode', 'label', 'archived', 'pinned', 'unread', 'model', 'thinkingLevel', 'fastMode'];
      if (!input || !(input.permissionMode === 'full' || method === 'sessions.create' && typeof input.cwd === 'string' && ['read-only', 'guarded', 'workspace'].includes(String(input.permissionMode))) || Object.keys(input).some(key => !allowed.includes(key)) || typeof input.key !== 'string' || (method === 'sessions.patch' && typeof input.expectedSessionId !== 'string') || (method === 'sessions.create' && (input.emitCommandHooks !== false || typeof input.idempotencyKey !== 'string'))) throw new Fault(403, 'gateway_method', 'Access controls accept only an explicit Full access setting or a captured new working-folder session.');
    }
    if (!this.client || this.connection.state !== 'ready') throw new Fault(503, 'gateway_disconnected', 'OpenClaw is unavailable. Your work is retained.');
    const managementConfig = this.purpose !== 'assistant' ? this.store.internalRead<Configuration>('gateway:configuration') : undefined;
    if (this.purpose !== 'assistant') {
      const config = managementConfig;
      if (!config || config.generation !== this.connection.generation || config.url !== this.connection.url) throw new Fault(409, 'gateway_replaced', 'These controls belong to the original Assistant host. Reconnect for the current host.');
      if (!this.connection.grantedScopes.includes(this.purpose === 'speech-playback' ? (method === 'talk.catalog' ? 'operator.read' : 'operator.talk') : this.purpose === 'question-review' ? (method === 'sessions.messages.subscribe' ? 'operator.read' : 'operator.questions') : this.purpose === 'approval-review' ? (method === 'sessions.messages.subscribe' ? 'operator.read' : 'operator.approvals') : skillReadMethods.has(method) ? 'operator.read' : 'operator.admin')) throw new Fault(403, 'gateway_scope', 'OpenClaw has not granted the required management permission.');
    }
    if (!this.connection.methods.includes(method)) throw new Fault(501, 'gateway_capability', 'This OpenClaw version does not expose the required operation.');
    const lifecycle = this.lifecycle;
    const result = await this.client.request<T>(method, params, method === 'talk.speak' ? { timeoutMs: 45000 } : undefined);
    if (this.stopped || this.lifecycle !== lifecycle) throw new Fault(503, 'gateway_replaced', 'The OpenClaw connection changed before this result was confirmed. Check the original operation.');
    if (managementConfig && JSON.stringify(managementConfig) !== JSON.stringify(this.store.internalRead<Configuration>('gateway:configuration'))) throw new Fault(409, 'gateway_replaced', 'The Assistant host changed before this management result was confirmed. Check the original operation.');
    return result;
  }
  models(): Promise<AssistantModel[]> {
    if (this.catalogRequest) return this.catalogRequest;
    const pending = this.readModels(); this.catalogRequest = pending;
    void pending.finally(() => { if (this.catalogRequest === pending) this.catalogRequest = undefined; }).catch(() => undefined);
    return pending;
  }
  private async readModels(): Promise<AssistantModel[]> {
    const epoch = this.catalogEpoch;
    const check = () => { if (this.stopped || epoch !== this.catalogEpoch) throw new Fault(503, 'gateway_replaced', 'The model connection changed. Reload the current models.'); };
    let result = await this.request<ModelCatalog>('models.list', { agentId: 'main' }); check();
    // A prepared native catalog can omit capabilities. Discover once for an
    // unchanged incomplete catalog; subsequent UI polling uses the cheap read.
    if (result.models?.some(model => model.available === true && model.reasoning === undefined && model.thinkingLevels === undefined) && catalogSignature(result) !== this.discoveredCatalog) {
      result = await this.request<ModelCatalog>('models.list', { agentId: 'main', refresh: true }); check();
      this.discoveredCatalog = catalogSignature(result);
    }
    const models = (result.models ?? []).filter(m => typeof m.id === 'string').map(model => ({ id: model.id.includes('/') ? model.id : `${model.provider}/${model.id}`, name: model.name ?? model.id, provider: model.provider ?? 'OpenClaw', reasoning: model.thinkingLevels?.map(level => level.id), isDefault: model.tags?.includes('default') === true, available: model.available === true }));
    this.connection = { ...this.connection, modelAuthReady: models.some(model => model.available), message: models.some(model => model.available) ? 'OpenClaw and account models are ready.' : 'OpenClaw is connected. Sign in to ChatGPT through its model setup.' };
    return models;
  }
  async stop() {
    this.stopped = true; ++this.lifecycle;
    this.resetModels();
    const client = this.client;
    const generation = this.connection.generation;
    this.client = undefined; this.hello = undefined; this.connection = initialStatus();
    if (generation) for (const listener of this.listeners) listener({ type: 'event', event: 'e3.connection-stopped', payload: { generation } });
    await client?.stopAndWait({ timeoutMs: 2000 });
  }
}
