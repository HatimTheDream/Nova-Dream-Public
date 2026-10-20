import { z } from 'zod';
import { canonical } from '../../packages/domain/contracts.js';
import type { AssistantOperation, Conversation } from '../../packages/domain/assistant.js';
import { assertDirectAgentOperation } from '../../packages/domain/direct-agent.js';
import type { AssistantTransport } from './gateway.js';
import { Fault, type Store } from './store.js';
import { DirectAgentReadAuthority } from './direct-agent-reads.js';
import { assertDirectConfiguration } from './direct-agent-runtime-policy.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().min(1).max(512);
const sessionSchema = z.object({
  key: id, id: z.uuid(), lifecycleRevision: id.nullable(),
  permissionMode: z.literal('read-only'), permissionModePending: z.literal(false),
  accountId: id.nullable(), model: id.nullable(),
}).strict();
const policySchema = z.object({
  format: z.literal(1), epoch: z.uuid(), agentId: z.literal('edition3-direct'),
  registrationId: z.uuid(), sourcePolicySha256: sha, policySha256: sha,
  nativeKey: id, session: sessionSchema.nullable(),
}).strict();
export type DirectPolicyObservation = z.infer<typeof policySchema>;
const accountSchema = z.object({ format: z.literal(1), epoch: z.uuid(), agentId: z.literal('edition3-direct'),
  profileId: id, identityKey: sha, expiresAt: z.number().finite().positive(), ready: z.literal(true) }).strict();
type DirectAccount = z.infer<typeof accountSchema>;
export type DirectRuntimeIdentity = {
  epoch: string; pid: number; startedAt: number; generation: string; version: string; url: string;
  sourcePolicySha256: string; pluginSha256: string; configuration: unknown;
};
export type DirectSessionObservation = {
  runtime: DirectRuntimeIdentity; policy: DirectPolicyObservation; account?: DirectAccount;
};
type Lease = DirectSessionObservation & { operationId: string; requestId: string; nativeId: string; nativeKey: string };
const identity = ({ configuration: _configuration, ...value }: DirectRuntimeIdentity) => value;

/** Ephemeral admission belonging to the existing Assistant/runtime owner, not
 * another dispatcher or saved-operation engine. No lease survives restart. */
export class DirectAgentOwner {
  private closed = false;
  private readonly registrations = new Map<string, string>();
  private readonly leases = new Map<string, Lease>();
  constructor(private readonly store: Store, private readonly gateway: AssistantTransport,
    private readonly runtime: () => DirectRuntimeIdentity | undefined) {}
  current(): DirectRuntimeIdentity {
    const value = this.runtime(), connection = this.gateway.status();
    if (this.closed || this.store.recoveryEffectsPaused || this.store.updateMaintenanceHeld
      || !value || value.epoch !== this.store.epoch || value.version !== '2026.9.8'
      || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isFinite(value.startedAt)
      || connection.state !== 'ready' || connection.generation !== value.generation || connection.url !== value.url
      || !connection.grantedScopes.includes('operator.read') || !connection.grantedScopes.includes('operator.write')
      || !['e3.direct.policy', 'e3.accounts.direct-profile', 'agent', 'chat.history', 'sessions.create', 'sessions.patch', 'chat.abort', 'agent.wait'].every(method => connection.methods.includes(method)))
      throw new Fault(409, 'direct_agent_runtime_unavailable', 'The original managed direct-agent connection is unavailable. Your chat and writing are kept.');
    assertDirectConfiguration(value.configuration, value.sourcePolicySha256);
    sha.parse(value.pluginSha256);
    return value;
  }
  assertCurrent(observed: DirectSessionObservation) {
    const current = this.current();
    if (canonical(identity(current)) !== canonical(identity(observed.runtime))
      || this.registrations.get(this.runtimeKey(current)) !== observed.policy.registrationId)
      throw new Fault(409, 'direct_agent_owner_changed', 'The original direct-agent runtime or policy was replaced. Check the original request.');
  }
  private runtimeKey(value: DirectRuntimeIdentity) {
    return canonical([value.epoch, value.pid, value.startedAt, value.generation, value.pluginSha256]);
  }
  async observe(conversation: Pick<Conversation, 'nativeKey' | 'nativeId'>): Promise<DirectSessionObservation> {
    const runtime = this.current();
    const policy = policySchema.parse(await this.gateway.request('e3.direct.policy', {
      epoch: runtime.epoch, nativeKey: conversation.nativeKey, nativeId: conversation.nativeId,
    }));
    const after = this.current();
    if (canonical(identity(after)) !== canonical(identity(runtime)) || policy.epoch !== runtime.epoch
      || policy.sourcePolicySha256 !== runtime.sourcePolicySha256 || policy.nativeKey !== conversation.nativeKey
      || policy.session && policy.session.key !== conversation.nativeKey
      || conversation.nativeId && policy.session?.id !== conversation.nativeId)
      throw new Fault(409, 'direct_agent_policy_changed', 'The original direct-agent policy or session changed.');
    const key = this.runtimeKey(runtime), original = this.registrations.get(key);
    if (original && original !== policy.registrationId)
      throw new Fault(409, 'direct_agent_registration_changed', 'The direct-agent registration changed. Reconnect its owned runtime before starting a new request.');
    this.registrations.set(key, policy.registrationId);
    const observation: DirectSessionObservation = { runtime, policy };
    if (policy.session?.accountId) observation.account = await this.account(observation, policy.session.accountId);
    this.assertCurrent(observation);
    return observation;
  }
  private async account(observed: DirectSessionObservation, profileId: string) {
    this.assertCurrent(observed);
    const value = accountSchema.parse(await this.gateway.request('e3.accounts.direct-profile', {
      epoch: observed.runtime.epoch, agentId: 'edition3-direct', profileId,
    }));
    this.assertCurrent(observed);
    if (value.epoch !== observed.runtime.epoch || value.profileId !== profileId || value.expiresAt <= Date.now() + 30000
      || observed.account && value.identityKey !== observed.account.identityKey)
      throw new Fault(409, 'direct_agent_account_changed', 'The original selected account changed. No other account may be used.');
    return value;
  }
  /** Called synchronously immediately before the existing dispatch boundary. */
  admit(operation: AssistantOperation, conversation: Conversation, observation: DirectSessionObservation) {
    this.assertCurrent(observation);
    const capture = assertDirectAgentOperation(conversation, operation), session = observation.policy.session;
    if (!session || session.id !== operation.nativeId || session.key !== operation.nativeKey
      || session.accountId !== capture.account.profileId || session.model !== capture.account.model
      || !capture.account.identityKey || observation.account?.identityKey !== capture.account.identityKey
      || operation.state !== 'prepared' || operation.nativeRunId !== null || operation.cancelRequested
      || operation.epoch !== observation.runtime.epoch || operation.connectionGeneration !== observation.runtime.generation
      || this.leases.has(operation.id))
      throw new Fault(409, 'direct_agent_admission_changed', 'The original direct-agent turn changed before sending.');
    this.leases.set(operation.id, { ...observation, operationId: operation.id, requestId: operation.requestId,
      nativeId: operation.nativeId!, nativeKey: operation.nativeKey });
  }
  end(operationId: string) { this.leases.delete(operationId); }
  acceptsEvent(operation: AssistantOperation, payload: Record<string, unknown>): boolean {
    try {
      const lease = this.leases.get(operation.id);
      if (!lease || lease.requestId !== operation.requestId || operation.nativeRunId !== lease.requestId
        || payload.runId !== lease.requestId || payload.sessionKey !== lease.nativeKey
        || payload.sessionId !== undefined && payload.sessionId !== lease.nativeId
        || payload.agentId !== undefined && payload.agentId !== 'edition3-direct') return false;
      this.assertCurrent(lease); return true;
    } catch { return false; }
  }
  close() { this.closed = true; this.leases.clear(); this.registrations.clear(); }
  private readOwner(raw: unknown) {
    const envelope = z.object({ registrationId: z.uuid(), request: z.unknown() }).strict().parse(raw);
    const request = envelope.request as Record<string, any> | null;
    const origin = request?.origin ?? request;
    const matches = [...this.leases.values()].filter(lease => lease.requestId === origin?.runId
      && lease.nativeKey === origin?.sessionKey && lease.nativeId === origin?.sessionId
      && lease.policy.registrationId === envelope.registrationId);
    if (matches.length !== 1) throw Error('The original native read has no active managed owner.');
    const lease = matches[0];
    const check = () => {
      this.assertCurrent(lease);
      if (this.leases.get(lease.operationId) !== lease) throw Error('The original native read owner closed.');
      const operation = this.store.internalRead<AssistantOperation>(`assistant:operation:${lease.operationId}`);
      if (!operation || operation.requestId !== lease.requestId || operation.cancelRequested
        || !['dispatching', 'accepted', 'running'].includes(operation.state)) throw Error('The original native run is no longer active.');
    };
    check();
    return { request: envelope.request, lease, authority: new DirectAgentReadAuthority(this.store, {
      epoch: lease.runtime.epoch, generation: lease.runtime.generation, policySha256: lease.policy.policySha256, assertCurrent: check,
    }) };
  }
  async authorize(raw: unknown) {
    const { request, lease, authority } = this.readOwner(raw);
    if (!lease.account) throw Error('The captured exact account is unavailable.');
    await this.account(lease, lease.account.profileId);
    const value = authority.authorize(request);
    await this.account(lease, lease.account.profileId);
    this.readOwner(raw);
    if (canonical(authority.authorize(request)) !== canonical(value)) throw Error('The original read authority changed.');
    return value;
  }
  async read(raw: unknown) {
    const { request, lease, authority } = this.readOwner(raw);
    if (!lease.account) throw Error('The captured exact account is unavailable.');
    await this.account(lease, lease.account.profileId);
    const value = await authority.read(request);
    await this.account(lease, lease.account.profileId);
    this.readOwner(raw);
    authority.assertCurrentRead(request);
    return value;
  }
}
