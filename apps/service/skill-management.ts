import { z } from 'zod';
import type { SkillCommand, SkillManagementState, SkillOperation, SkillOperationSummary } from '../../packages/domain/skill-management.js';
import type { SavedProposal } from '../../packages/domain/skill-workshop.js';
import type { AssistantTransport } from './gateway.js';
import { proposalAcknowledgement, SkillWorkshop } from './skill-workshop.js';
import { Fault, Store } from './store.js';
import { AgentSkills } from './agent-skills.js';

export interface SkillManagementTransport extends AssistantTransport { start(): void; stop(): Promise<void> }
const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), common = { requestId: uuid, epoch: uuid, generation: uuid };
const supportFile = z.object({ path: z.string().min(1).max(1024).refine(p => !/[\\:\0]/.test(p) && p.split('/').every(part => part && part !== '.' && part !== '..') && p.toLowerCase() !== 'skill.md' && p.toLowerCase() !== 'proposal.md'), content: z.string().max(262144) }).strict();
const draft = z.object({ name: z.string().trim().min(1).max(200), description: z.string().trim().min(1).max(20000), content: z.string().min(1).max(1048576), supportFiles: z.array(supportFile).max(64), goal: z.string().max(20000).optional(), evidence: z.string().max(20000).optional() }).strict().refine(d => new Set(d.supportFiles.map(f => f.path.toLowerCase())).size === d.supportFiles.length, 'Each support file needs a unique path.').refine(d => Buffer.byteLength(d.content) <= 1048576 && d.supportFiles.every(f => Buffer.byteLength(f.content) <= 262144) && Buffer.byteLength(JSON.stringify(d)) <= 8 * 1024 * 1024, 'The proposal exceeds the supported text size.');
const command = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('create'), draft, sourceReviewId: hash.optional() }).strict(), z.object({ ...common, action: z.literal('update'), draft, sourceReviewId: hash.optional() }).strict(),
  z.object({ ...common, action: z.literal('revise'), reviewId: hash, draft }).strict(),
  z.object({ ...common, action: z.literal('apply'), reviewId: hash, reason: z.string().max(2000) }).strict(),
  z.object({ ...common, action: z.literal('reject'), reviewId: hash, reason: z.string().max(2000) }).strict(),
]);
type Grant = { id: string; deviceId: string; epoch: string; generation: string; enabled: boolean };
const grantKey = (device: string) => `skill-management:grant:${device}`;
const operationKey = (id: string) => `skill-management:operation:${id}`;
const indexPrefix = 'skill-management:index:';
const busy = (state: SkillOperation['state']) => ['preparing', 'dispatched', 'unknown'].includes(state);
const sameSkill = (a: string, b: string) => a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();
const summary = ({ intent: _intent, authorizationId: _authorizationId, reviewId: _reviewId, preexistingProposalIds: _prior, scanCursor: _cursor, associatedReviewId: _associated, resolvedBy: _resolvedBy, resolutionReason: _reason, ...value }: SkillOperation): SkillOperationSummary => value;

/** One retained intent precedes each native dispatch. Reconciliation only reads. */
export class SkillManagement {
  private manager?: SkillManagementTransport;
  private stopping?: Promise<void>;
  private closed = false;
  private jobs = new Map<string, Promise<void>>();
  private checks = new Map<string, Promise<SkillOperation>>();
  private unsubscribe: () => void;
  constructor(private store: Store, private gateway: AssistantTransport, private workshop: SkillWorkshop, private factory?: () => SkillManagementTransport, private now = Date.now) {
    this.unsubscribe = gateway.subscribe(event => { if (event.event === 'e3.connection-stopped' || event.event === 'e3.disconnected') void this.stopConnection(); });
    for (const item of this.operations()) if (['preparing', 'dispatched'].includes(item.state)) {
      const operation = this.operation(item.id), knownUnsent = operation.state === 'preparing' && operation.epoch === store.epoch;
      this.save({ ...operation, state: knownUnsent ? 'not-sent' : 'unknown', message: knownUnsent ? 'The service stopped before dispatch. Review and submit a new request to continue.' : 'The service restarted or was recovered before the outcome was confirmed. Check the original operation.' });
    }
  }
  private operations() { return this.store.internalList<SkillOperationSummary>(indexPrefix).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)); }
  private save(value: SkillOperation) { const updated = { ...value, updatedAt: this.now() }; this.store.internalBatch([{ id: operationKey(value.id), value: updated }, { id: indexPrefix + value.id, value: summary(updated) }]); return updated; }
  operation(id: string) { uuid.parse(id); const value = this.store.internalRead<SkillOperation>(operationKey(id)); if (!value) throw new Fault(404, 'skill_operation_missing', 'This skill operation is unavailable.'); return value; }
  state(device: string): SkillManagementState {
    const base = this.gateway.status(), grant = this.store.internalRead<Grant>(grantKey(device)), manager = this.manager?.status();
    const enabled = !!grant?.enabled && grant.epoch === this.store.epoch && grant.generation === base.generation;
    const ready = enabled && base.state === 'ready' && manager?.state === 'ready' && manager.generation === base.generation && manager.grantedScopes.includes('operator.admin');
    const connection = ready ? 'ready' : !this.factory ? 'unavailable' : enabled && manager?.state === 'connecting' ? 'connecting' : enabled && manager?.state === 'pairing' ? 'pairing' : enabled && manager?.state === 'error' ? 'error' : 'disconnected';
    return { epoch: this.store.epoch, generation: base.generation ?? grant?.generation, enabled, canConnect: !!this.factory && base.state === 'ready' && !this.closed, connection, message: ready ? 'Skill management is connected for this device. Each change still needs its own review.' : connection === 'pairing' ? 'Approve the displayed skill-management device request in OpenClaw, then reconnect here.' : enabled ? 'Reconnect skill management on the original Assistant host to continue.' : 'Enable skill management on this device to create or change native proposals.', ...(enabled && manager?.pairingRequestId ? { pairingRequestId: manager.pairingRequestId } : {}), methods: ready ? manager!.methods.filter(m => ['create', 'update', 'revise', 'apply', 'reject'].some(a => m === `skills.proposals.${a}`)) : [], operations: this.operations() };
  }
  async access(device: string, input: unknown) {
    const cmd = z.object({ ...common, enabled: z.boolean() }).strict().parse(input);
    if (this.closed) throw new Fault(503, 'skill_management_closed', 'Skill management is closing.');
    const { value } = this.store.admit(device, cmd, { type: 'skill-management.access', ...cmd }, () => {
      if (cmd.enabled && (!this.factory || this.gateway.status().state !== 'ready' || this.gateway.status().generation !== cmd.generation)) throw new Fault(409, 'skill_management_host', 'Connect the original Assistant host before enabling skill management.');
      const grant: Grant = { id: cmd.requestId, deviceId: device, epoch: cmd.epoch, generation: cmd.generation, enabled: cmd.enabled };
      return this.store.internalWrite(grantKey(device), grant);
    });
    if (this.store.internalRead<Grant>(grantKey(device))?.id !== value.id) return this.state(device);
    if (!cmd.enabled) {
      if (!this.store.internalList<Grant>('skill-management:grant:').some(g => g.enabled && g.epoch === this.store.epoch && g.generation === this.gateway.status().generation)) await this.stopConnection();
    } else {
      await this.stopping;
      if (this.closed || this.store.internalRead<Grant>(grantKey(device))?.id !== value.id || this.gateway.status().state !== 'ready' || this.gateway.status().generation !== cmd.generation) return this.state(device);
      this.manager ??= this.factory!();
      if (['error', 'pairing', 'disconnected'].includes(this.manager.status().state) || (this.manager.status().generation && this.manager.status().generation !== cmd.generation)) await this.stopConnection();
      if (!this.closed && this.store.internalRead<Grant>(grantKey(device))?.id === value.id && this.gateway.status().state === 'ready' && this.gateway.status().generation === cmd.generation) this.manager.start();
    }
    return this.state(device);
  }
  private authorization(device: string, epoch: string, generation: string, action: string, id?: string) {
    const grant = this.store.internalRead<Grant>(grantKey(device)), base = this.gateway.status(), manager = this.manager?.status();
    if (this.closed || epoch !== this.store.epoch || !grant?.enabled || grant.epoch !== epoch || grant.generation !== generation || (id && grant.id !== id) || base.state !== 'ready' || base.generation !== generation || manager?.state !== 'ready' || manager.generation !== generation || !manager.grantedScopes.includes('operator.admin')) throw new Fault(409, 'skill_management_access', 'Enable or reconnect skill management on this device before submitting this change.');
    if (!manager.methods.includes(`skills.proposals.${action}`)) throw new Fault(501, 'skill_management_capability', 'This host does not expose that proposal operation.');
    return grant;
  }
  submit(device: string, input: unknown): SkillOperation {
    const cmd = command.parse(input) as SkillCommand;
    const { value: id, fresh } = this.store.admit(device, cmd, { type: 'skill-management.submit', ...cmd }, () => {
      const grant = this.authorization(device, cmd.epoch, cmd.generation, cmd.action);
      if ('sourceReviewId' in cmd && cmd.sourceReviewId) {
        const source = this.workshop.saved(cmd.sourceReviewId);
        if (cmd.action === 'update' && (source.epoch !== cmd.epoch || source.generation !== cmd.generation || source.record.skillKey !== cmd.draft.name)) throw new Fault(409, 'skill_update_source', 'This update must keep the reviewed skill and host. Copy the writing into a separate draft to choose another target.');
      }
      let review: SavedProposal | undefined;
      if ('reviewId' in cmd) {
        review = this.workshop.saved(cmd.reviewId);
        if (review.epoch !== cmd.epoch || review.generation !== cmd.generation || review.record.status !== 'pending') throw new Fault(409, 'skill_review_required', 'Keep a fresh review of the pending proposal before deciding this change.');
        if (cmd.action === 'revise' && !sameSkill(cmd.draft.name, review.record.skillKey)) throw new Fault(400, 'skill_target', 'A revision cannot change the proposal’s skill identity.');
      }
      if (cmd.action === 'create' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cmd.draft.name)) throw new Fault(400, 'skill_name', 'Use lowercase letters, numbers and single hyphens for a new skill name.');
      const skillKey = review?.record.skillKey ?? ('draft' in cmd ? cmd.draft.name : '');
      if (this.operations().some(o => o.generation === cmd.generation && sameSkill(o.skillKey, skillKey) && busy(o.state))) throw new Fault(409, 'skill_operation_busy', 'Check or review the existing uncertain operation for this skill before submitting another change.');
      const quota = this.store.internalRead<{ count: number; bytes: number }>('skill-management:quota') ?? { count: 0, bytes: 0 }, bytes = Buffer.byteLength(JSON.stringify(cmd));
      if (quota.count >= 500 || quota.bytes + bytes > 100 * 1024 * 1024) throw new Fault(507, 'skill_operation_storage', 'Skill operation history storage is full. Existing work is kept.');
      const value: SkillOperation = { id: cmd.requestId, epoch: cmd.epoch, generation: cmd.generation, deviceId: device, action: cmd.action, skillKey, state: 'preparing', message: 'Checking the exact request before dispatch.', createdAt: this.now(), updatedAt: this.now(), intent: cmd, authorizationId: grant.id, ...('reviewId' in cmd ? { reviewId: cmd.reviewId, proposalId: review!.record.id } : {}) };
      this.store.internalWrite(operationKey(value.id), value); this.store.internalWrite(indexPrefix + value.id, summary(value));
      this.store.internalWrite('skill-management:quota', { count: quota.count + 1, bytes: quota.bytes + bytes });
      return value.id;
    });
    if (fresh) { const job = this.perform(id).finally(() => this.jobs.delete(id)); this.jobs.set(id, job); }
    return this.operation(id);
  }
  private async perform(id: string) {
    let op = this.operation(id), dispatched = false;
    try {
      const cmd = op.intent; let params: Record<string, unknown>;
      if ('reviewId' in cmd) {
        const reviewed = this.workshop.saved(cmd.reviewId), current = await this.workshop.inspect(reviewed.record.id);
        if (current.epoch !== op.epoch || current.generation !== op.generation || current.record.status !== 'pending' || current.revisionHash !== reviewed.revisionHash || current.targetFingerprint !== reviewed.targetFingerprint) throw new Fault(409, 'skill_review_changed', 'The proposal or its destinations changed. Keep and review the current version before submitting a new decision.');
        if (cmd.action === 'apply' && current.record.scan.state !== 'clean') throw new Fault(409, 'skill_scan', 'The native scan is not clean. Review or revise the proposal before applying it.');
        params = { proposalId: reviewed.record.id, expectedRevisionHash: reviewed.revisionHash, correlationId: op.id, ...(cmd.action === 'revise' ? { content: cmd.draft.content, supportFiles: cmd.draft.supportFiles, description: cmd.draft.description, goal: cmd.draft.goal, evidence: cmd.draft.evidence } : { reason: cmd.reason }) };
      } else {
        if (cmd.action === 'update') {
          const installed = await new AgentSkills(this.gateway, this.now).installed();
          if (installed.generation !== op.generation) throw new Fault(409, 'skill_management_host', 'The Assistant host changed before the update target was resolved.');
          const target = installed.skills.find(skill => skill.skillKey === op.skillKey);
          if (!target?.name.trim()) throw new Fault(409, 'skill_update_target', 'This exact skill key is not in the current installed inventory. Refresh Skills and choose its installed key.');
          if (installed.skills.filter(skill => skill.name === target.name).length !== 1) throw new Fault(409, 'skill_update_target', 'The host reports more than one skill with that name. Resolve the duplicate names before updating this skill.');
          if (cmd.sourceReviewId && this.workshop.saved(cmd.sourceReviewId).record.skillName !== target.name) throw new Fault(409, 'skill_update_target', 'The installed skill name changed since this review. Inspect the current skill before proposing an update.');
          op = this.save({ ...op, skillName: target.name });
        }
        const before = await this.workshop.list();
        if (before.generation !== op.generation) throw new Fault(409, 'skill_management_host', 'The Assistant host changed before dispatch.');
        op = this.save({ ...op, preexistingProposalIds: before.proposals.filter(p => sameSkill(p.skillKey, op.skillKey)).map(p => p.id) });
        params = { ...(cmd.action === 'create' ? { name: cmd.draft.name } : { skillName: op.skillName }), description: cmd.draft.description, content: cmd.draft.content, supportFiles: cmd.draft.supportFiles, goal: cmd.draft.goal, evidence: cmd.draft.evidence };
      }
      this.authorization(op.deviceId, op.epoch, op.generation, op.action, op.authorizationId);
      op = this.save({ ...op, state: 'dispatched', message: 'The exact request was dispatched. Its outcome is being checked.' }); dispatched = true;
      const raw = await this.manager!.request(`skills.proposals.${op.action}`, { agentId: 'main', ...params });
      const ack = proposalAcknowledgement(raw);
      if (op.action === 'update' && (ack.skillKey !== op.skillKey || ack.skillName !== op.skillName)) throw new Error('The update acknowledgement belongs to a different installed identity.');
      if (!sameSkill(ack.skillKey, op.skillKey) || (op.proposalId && ack.proposalId !== op.proposalId) || ((op.action === 'create' || op.action === 'update') && ack.kind !== op.action) || (['apply', 'reject'].includes(op.action) && (ack.status !== (op.action === 'apply' ? 'applied' : 'rejected') || ack.revisionHash !== this.workshop.saved(op.reviewId!).revisionHash || ack.targetFingerprint !== this.workshop.saved(op.reviewId!).targetFingerprint)) || (['create', 'update', 'revise'].includes(op.action) && ack.status !== 'pending')) throw new Error('Unsupported acknowledgement.');
      this.save({ ...op, state: 'confirmed', message: op.action === 'apply' ? 'The reviewed native proposal was applied.' : op.action === 'reject' ? 'The reviewed native proposal was rejected.' : 'The host confirmed this proposal change. Inspect its full contents before applying it.', proposalId: ack.proposalId, resultRevisionHash: ack.revisionHash, proposedVersion: ack.proposedVersion, resultStatus: ack.status });
    } catch (error) {
      this.save({ ...op, state: dispatched ? 'unknown' : 'not-sent', message: dispatched ? 'The host did not confirm the outcome. Check this original operation; it will not be dispatched again automatically.' : error instanceof Fault ? error.message : 'The original request could not be checked. Nothing was dispatched; review it before submitting again.' });
    }
  }
  async check(id: string): Promise<SkillOperation> {
    const current = this.operation(id);
    if (current.state !== 'unknown' || this.jobs.has(id)) return current;
    if (this.checks.has(id)) return this.checks.get(id)!;
    const job = this.reconcile(current).finally(() => this.checks.delete(id)); this.checks.set(id, job); return job;
  }
  private async reconcile(op: SkillOperation) {
    if (this.closed || this.gateway.status().generation !== op.generation) throw new Fault(409, 'skill_operation_host', 'Reconnect the original Assistant host to check this operation.');
    if (!op.proposalId) {
      const list = await this.workshop.list();
      if (list.generation !== op.generation) throw new Fault(409, 'skill_operation_host', 'The original host changed during this check.');
      const candidates = list.proposals.filter(p => sameSkill(p.skillKey, op.skillKey) && p.kind === op.action && !op.preexistingProposalIds?.includes(p.id));
      return this.save({ ...this.operation(op.id), message: candidates.length ? `The host has ${candidates.length} possible matching proposal${candidates.length === 1 ? '' : 's'}. Inspect them and associate the correct review explicitly; their presence alone does not confirm this request.` : 'No matching new proposal is visible. This does not prove the request had no effect. Keep the outcome unconfirmed until reviewed.' });
    }
    const page = await this.workshop.events(op.proposalId, op.scanCursor ?? 0);
    if (page.generation !== op.generation) throw new Fault(409, 'skill_operation_host', 'The original host changed during this check.');
    const expected = op.action === 'apply' ? 'applied' : op.action === 'reject' ? 'rejected' : 'revised';
    const event = page.events.find(e => e.type === expected && e.correlationId === op.id && (op.action === 'revise' || e.revisionHash === this.workshop.saved(op.reviewId!).revisionHash));
    const current = this.operation(op.id); if (current.state !== 'unknown') return current;
    if (event) return this.save({ ...current, state: 'confirmed', resultRevisionHash: event.revisionHash, proposedVersion: event.proposedVersion, resultStatus: op.action === 'apply' ? 'applied' : op.action === 'reject' ? 'rejected' : 'pending', message: 'The retained native correlation event confirms this original operation.' });
    return this.save({ ...current, scanCursor: page.nextSequence ?? page.events.at(-1)?.sequence ?? op.scanCursor, message: page.nextSequence ? 'More native history remains. Check again to read the next page without redispatching the change.' : 'The native history does not yet confirm this request. No change has been dispatched again.' });
  }
  resolve(device: string, input: unknown) {
    const cmd = z.object({ requestId: uuid, epoch: uuid, operationId: uuid, reason: z.string().trim().min(1).max(2000), reviewId: hash.optional(), acknowledgeUnconfirmed: z.literal(true) }).strict().parse(input);
    return this.store.admit(device, cmd, { type: 'skill-management.resolve', ...cmd }, () => {
      const op = this.operation(cmd.operationId);
      if (op.state !== 'unknown' || this.jobs.has(op.id) || this.checks.has(op.id)) throw new Fault(409, 'skill_operation_state', 'Wait for the current operation check before reviewing its uncertainty.');
      if (cmd.reviewId) {
        const copy = this.workshop.saved(cmd.reviewId);
        if (copy.generation !== op.generation || !sameSkill(copy.record.skillKey, op.skillKey) || (op.proposalId ? copy.record.id !== op.proposalId : copy.record.kind !== op.action) || op.preexistingProposalIds?.includes(copy.record.id)) throw new Fault(409, 'skill_operation_association', 'Choose a review of a matching proposal on the original host.');
      }
      const updated: SkillOperation = { ...op, state: 'reviewed-unconfirmed', message: cmd.reviewId ? 'You associated a reviewed proposal with this request. Its original execution remains unconfirmed.' : 'You reviewed this uncertainty. The original outcome remains unconfirmed; a later change needs a separate explicit request.', resolvedBy: device, resolutionReason: cmd.reason, associatedReviewId: cmd.reviewId, updatedAt: this.now() };
      this.store.internalWrite(operationKey(op.id), updated); this.store.internalWrite(indexPrefix + op.id, summary(updated));
      return updated;
    }).value;
  }
  private stopConnection() {
    if (!this.stopping) { const stopped = this.manager?.stop() ?? Promise.resolve(); this.stopping = stopped.finally(() => { this.stopping = undefined; }); }
    return this.stopping;
  }
  async close() { this.closed = true; this.unsubscribe(); await this.stopConnection(); await Promise.allSettled([...this.jobs.values(), ...this.checks.values()]); }
}
