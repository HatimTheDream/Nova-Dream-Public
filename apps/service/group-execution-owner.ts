import { z } from 'zod';
import { canonical } from '../../packages/domain/contracts.js';
import { assertGroupRuntimeProof, groupRuntimeAgent, groupRuntimeProofSchema, type GroupExecution } from '../../packages/domain/assistant-group-execution.js';
import type { AssistantTransport } from './gateway.js';
import { Fault, type Store } from './store.js';
import { assertGroupConfiguration } from './group-runtime-policy.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().min(1).max(512);
export const groupSessionPolicySchema = z.object({
  format: z.literal(1), epoch: z.string().uuid(), agentId: z.literal(groupRuntimeAgent),
  registrationId: z.string().uuid(), sourcePolicySha256: sha, policySha256: sha, nativeKey: id,
  session: z.object({ key: id, id: z.string().uuid(), lifecycleRevision: id.nullable(),
    permissionMode: z.literal('read-only'), permissionModePending: z.literal(false),
    accountId: id.nullable(), model: id.nullable() }).strict().nullable(),
}).strict();
const identitySchema = z.object({ format: z.literal(1), epoch: z.string().uuid(), agentId: z.literal(groupRuntimeAgent),
  profileId: id, identityKey: sha }).strict();
const accountSchema = identitySchema.extend({ expiresAt: z.number().finite().positive(), ready: z.literal(true) }).strict();
export type GroupRuntimeIdentity = {
  epoch: string; pid: number; startedAt: number; generation: string; version: string; url: string;
  sourcePolicySha256: string; pluginSha256: string; configuration: unknown;
};
export type GroupOwnerObservation = {
  runtime: GroupRuntimeIdentity; policy: z.infer<typeof groupSessionPolicySchema>;
  account: z.infer<typeof identitySchema> | z.infer<typeof accountSchema>;
};
const identity = ({ configuration: _configuration, ...value }: GroupRuntimeIdentity) => value;

/** A distinct, ephemeral Group authority on the one existing managed Gateway.
 * It cannot adopt a personal chat, infer an account, or refresh credentials. */
export class GroupExecutionOwner {
  private closed = false;
  private registrations = new Map<string, string>();
  constructor(private store: Store, private gateway: AssistantTransport,
    private runtime: () => GroupRuntimeIdentity | undefined) {}
  current() {
    const value = this.runtime(), connection = this.gateway.status();
    if (this.closed || this.store.recoveryEffectsPaused || this.store.updateMaintenanceHeld
      || !value || value.epoch !== this.store.epoch || value.version !== '2026.9.8'
      || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isFinite(value.startedAt)
      || connection.state !== 'ready' || connection.generation !== value.generation || connection.url !== value.url
      || !['operator.read', 'operator.write'].every(scope => connection.grantedScopes.includes(scope))
      || !['e3.group.policy', 'e3.accounts.group-profile', 'e3.accounts.group-identity', 'sessions.create', 'agent', 'chat.history', 'agent.wait', 'chat.abort']
        .every(method => connection.methods.includes(method)))
      throw new Fault(409, 'group_runtime_unavailable', 'The original managed Group connection is unavailable. Prepared work is kept.');
    assertGroupConfiguration(value.configuration, value.sourcePolicySha256);
    sha.parse(value.pluginSha256);
    return value;
  }
  private key(value: GroupRuntimeIdentity) {
    return canonical([value.epoch, value.pid, value.startedAt, value.generation, value.pluginSha256]);
  }
  assertCurrent(observed: GroupOwnerObservation) {
    const current = this.current();
    if (canonical(identity(current)) !== canonical(identity(observed.runtime))
      || this.registrations.get(this.key(current)) !== observed.policy.registrationId)
      throw new Fault(409, 'group_owner_changed', 'The original Group owner, selected account or registration changed.');
  }
  assertReady(observed: GroupOwnerObservation) {
    this.assertCurrent(observed);
    if (!('ready' in observed.account) || observed.account.ready !== true || observed.account.expiresAt <= Date.now() + 30000)
      throw new Fault(409, 'group_account_unavailable', 'The exact selected account is not ready for a new native request.');
  }
  async observe(child: GroupExecution, authorize: () => void = () => {}, purpose: 'dispatch' | 'original' = 'dispatch'): Promise<GroupOwnerObservation> {
    authorize();
    const runtime = this.current(), b = child.binding;
    if (b.epoch !== runtime.epoch || b.nativeKey !== `agent:${groupRuntimeAgent}:e3:${b.attemptId}`)
      throw new Fault(409, 'group_original_changed', 'This child belongs to a different original workspace.');
    const policy = groupSessionPolicySchema.parse(await this.gateway.request('e3.group.policy', {
      epoch: runtime.epoch, nativeKey: b.nativeKey, nativeId: child.nativeId,
    }));
    authorize();
    const after = this.current();
    if (canonical(identity(after)) !== canonical(identity(runtime)) || policy.epoch !== runtime.epoch
      || policy.sourcePolicySha256 !== runtime.sourcePolicySha256 || policy.nativeKey !== b.nativeKey
      || policy.session && policy.session.key !== b.nativeKey
      || child.nativeId && policy.session?.id !== child.nativeId)
      throw new Fault(409, 'group_policy_changed', 'The original Group policy or session changed.');
    const key = this.key(runtime), registered = this.registrations.get(key);
    if (registered && registered !== policy.registrationId)
      throw new Fault(409, 'group_registration_changed', 'The Group registration changed within its original runtime.');
    this.registrations.set(key, policy.registrationId);
    const account = (purpose === 'dispatch' ? accountSchema : identitySchema).parse(await this.gateway.request(
      purpose === 'dispatch' ? 'e3.accounts.group-profile' : 'e3.accounts.group-identity', {
      epoch: runtime.epoch, agentId: groupRuntimeAgent, profileId: b.account.profileId,
    }));
    authorize();
    const observed = { runtime, policy, account };
    this.assertCurrent(observed);
    if (purpose === 'dispatch') this.assertReady(observed);
    if (account.epoch !== runtime.epoch || account.profileId !== b.account.profileId
      || policy.session && (policy.session.accountId !== b.account.profileId || policy.session.model !== b.account.model)
      || child.setup.proof && child.setup.proof.accountIdentitySha256 !== account.identityKey)
      throw new Fault(409, 'group_account_changed', 'The original selected Group account or model changed. No fallback is allowed.');
    // The in-memory registration map is only an additional live-owner check.
    // A reopened controller must still prove the original retained lifetime
    // before send, stop, or original observation can use this native owner.
    if (child.setup.proof) assertGroupRuntimeProof(child.setup.proof, this.proof(observed));
    return observed;
  }
  proof(observed: GroupOwnerObservation) {
    this.assertCurrent(observed);
    return groupRuntimeProofSchema.parse({ epoch: observed.runtime.epoch, generation: observed.runtime.generation,
      runtimePid: observed.runtime.pid, runtimeStartedAt: observed.runtime.startedAt,
      registrationId: observed.policy.registrationId, sourcePolicySha256: observed.runtime.sourcePolicySha256,
      policySha256: observed.policy.policySha256, pluginSha256: observed.runtime.pluginSha256,
      accountIdentitySha256: observed.account.identityKey });
  }
  close() { this.closed = true; this.registrations.clear(); }
}
