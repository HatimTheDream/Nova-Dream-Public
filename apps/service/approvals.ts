import { createHash } from 'node:crypto';
import { approvalSnapshotSchema, checkApprovalSchema, resolveApprovalSchema, type ApprovalSnapshot, type ApprovalState, type ReviewApproval } from '../../packages/domain/approvals.js';
import { canonical } from '../../packages/domain/contracts.js';
import type { Conversation } from '../../packages/domain/assistant.js';
import type { AssistantTransport } from './gateway.js';
import type { AccessTransport } from './full-access.js';
import { Store, Fault } from './store.js';

const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export type ApprovalTarget = Pick<Conversation, 'id' | 'nativeId' | 'nativeKey' | 'connectionGeneration' | 'state' | 'archived' | 'deleted'> & { readOnly?: boolean };
const prefix = 'assistant:approval:';
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

/** A finite reviewer connection. Ordinary chat cannot resolve approvals. */
export class AssistantApprovals {
  private control?: AccessTransport;
  private stopListening?: () => void;
  private stopOrdinary: () => void;
  private subscriptions = new Map<string, ApprovalTarget>();
  private subscribedIds = new Set<string>();
  private early: unknown[] = [];
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  private syncing?: Promise<void>;
  private error?: string;
  private lastCheck = 0;
  constructor(private store: Store, private ordinary: AssistantTransport, private conversations: () => ApprovalTarget[], private factory?: () => AccessTransport) {
    for (const record of this.all()) if (record.action?.state === 'sending') this.save({ ...record, action: { ...record.action, state: 'unknown', message: 'The workspace restarted. Check the original decision.' } });
    this.stopOrdinary = ordinary.subscribe(event => { if (['e3.connected', 'e3.disconnected', 'e3.connection-stopped'].includes(event.event)) void this.sync(); });
    this.timer = setInterval(() => { void this.sync(); }, 2500); this.timer.unref?.();
  }
  private all() { return this.store.internalList<ReviewApproval>(prefix); }
  private get(id: string) { const record = this.store.internalRead<ReviewApproval>(`${prefix}${id}`); if (!record) throw new Fault(404, 'approval_missing', 'This approval is unavailable.'); return record; }
  private save(record: ReviewApproval) { if (this.store.internalRead(`assistant:removed:${record.conversationId}`)) return record; return this.store.internalWrite(`${prefix}${record.id}`, { ...record, revision: record.revision + 1 }); }
  state(): ApprovalState {
    const current = this.ordinary.status(), control = this.control?.status();
    const ready = current.state === 'ready' && control?.state === 'ready' && current.generation === control.generation && current.url === control.url && control.grantedScopes.includes('operator.approvals');
    return { state: this.error ? 'error' : ready ? 'ready' : this.control ? 'connecting' : 'unavailable', ...(this.error ? { message: this.error } : {}), items: this.all().filter(item => item.epoch === this.store.epoch && item.connectionGeneration === current.generation && this.conversations().some(c => c.id === item.conversationId && c.nativeId === item.nativeId && c.nativeKey === item.nativeKey)).sort((a, b) => b.updatedAtMs - a.updatedAtMs) };
  }
  private target(record: ReviewApproval, forDecision = false) {
    const current = this.ordinary.status(), control = this.control?.status();
    const conversation = this.conversations().find(c => c.id === record.conversationId);
    if (this.closed || record.epoch !== this.store.epoch || !conversation || conversation.nativeId !== record.nativeId || conversation.nativeKey !== record.nativeKey || conversation.connectionGeneration !== record.connectionGeneration || current.state !== 'ready' || current.generation !== record.connectionGeneration || control?.state !== 'ready' || control.generation !== current.generation || control.url !== current.url || !control.grantedScopes.includes('operator.approvals')) throw new Fault(409, 'approval_host_changed', 'Reconnect to this conversation’s original host before reviewing its approval.');
    if (forDecision && (conversation.readOnly || conversation.archived || conversation.deleted)) throw new Fault(409, 'approval_read_only', 'This work is no longer active for approval. Its saved decisions are kept.');
    return conversation;
  }
  private accept(conversation: ApprovalTarget, raw: unknown, updatedAtMs: number, sourceSessionKey?: string) {
    const snapshot = approvalSnapshotSchema.parse(raw);
    if (!conversation.nativeId || conversation.connectionGeneration !== this.ordinary.status().generation || !Number.isSafeInteger(updatedAtMs)) return;
    const id = hash([this.store.epoch, conversation.connectionGeneration, conversation.id, conversation.nativeId, snapshot.id]);
    const prior = this.store.internalRead<ReviewApproval>(`${prefix}${id}`);
    // A late pending replay must never reopen a terminal approval.
    if (prior && (prior.updatedAtMs > updatedAtMs && !(prior.snapshot.status === 'pending' && snapshot.status !== 'pending') || prior.snapshot.status !== 'pending' && snapshot.status !== prior.snapshot.status)) return prior;
    if (prior && canonical(prior.snapshot) === canonical(snapshot) && prior.sourceSessionKey === (sourceSessionKey ?? prior.sourceSessionKey)) return prior;
    const action = prior?.action && snapshot.status !== 'pending' ? { ...prior.action, state: 'confirmed' as const, message: snapshot.decision === prior.action.decision ? 'Decision confirmed.' : 'The runtime resolved this request with a different outcome.' } : prior?.action;
    return this.save({ id, revision: prior?.revision ?? 0, epoch: this.store.epoch, connectionGeneration: conversation.connectionGeneration, conversationId: conversation.id, nativeId: conversation.nativeId, nativeKey: conversation.nativeKey, snapshot, updatedAtMs, ...(sourceSessionKey ?? prior?.sourceSessionKey ? { sourceSessionKey: sourceSessionKey ?? prior?.sourceSessionKey } : {}), ...(action ? { action } : {}) });
  }
  private receive(raw: unknown) {
    const data = object(raw), target = this.subscriptions.get(data.sessionKey);
    if (!target || this.control?.status().generation !== this.ordinary.status().generation) return false;
    const current = this.conversations().find(c => c.id === target.id && c.nativeId === target.nativeId && c.nativeKey === target.nativeKey);
    if (!current) return true;
    try { this.accept(current, data.approval, data.updatedAtMs, typeof data.sourceSessionKey === 'string' ? data.sourceSessionKey : undefined); }
    catch { this.subscribedIds.delete(`${current.id}:${current.nativeId}`); this.error = 'An approval could not be read completely. Check this request in OpenClaw before deciding.'; }
    return true;
  }
  sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this.synchronize().catch(() => { if (!this.closed) this.error = 'Approval requests could not be checked. Reconnect or check again before deciding.'; }).finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
  private async synchronize() {
    if (this.closed) return;
    const base = this.ordinary.status();
    if (this.control && (base.state !== 'ready' || base.generation !== this.control.status().generation || base.url !== this.control.status().url)) await this.disconnect();
    if (this.closed || base.state !== 'ready' || !this.factory || !['approval.get', 'approval.resolve', 'sessions.messages.subscribe'].every(m => base.methods.includes(m))) return;
    if (!this.control) {
      const control = this.factory(); this.control = control;
      this.stopListening = control.subscribe(event => {
        if (this.closed || this.control !== control) return;
        if (['e3.connected', 'e3.history-gap', 'e3.disconnected'].includes(event.event)) { this.subscriptions.clear(); this.subscribedIds.clear(); this.early = []; this.lastCheck = 0; }
        if (event.event === 'session.approval' && !this.receive(event.payload)) { if (this.early.length < 1000) this.early.push(event.payload); else this.error = 'Approval updates need to be checked again.'; }
      });
      control.start();
    }
    const control = this.control, status = control.status();
    if (status.state !== 'ready') { if (['error', 'pairing'].includes(status.state)) this.error = status.message; return; }
    if (!status.grantedScopes.includes('operator.approvals')) { this.error = 'This device needs OpenClaw approval-review permission.'; return; }
    this.error = undefined;
    for (const conversation of this.conversations().filter(c => c.state === 'ready' && c.nativeId && c.connectionGeneration === base.generation)) {
      const identity = `${conversation.id}:${conversation.nativeId}`;
      if (this.subscribedIds.has(identity)) continue;
      const result = await control.request<Record<string, any>>('sessions.messages.subscribe', { key: conversation.nativeKey, includeApprovals: true });
      if (this.closed || this.control !== control || this.ordinary.status().generation !== base.generation) return;
      if (result.subscribed !== true || result.key !== conversation.nativeKey || typeof result.approvalReplay?.sessionKey !== 'string' || !Array.isArray(result.approvalReplay.approvals)) throw Error('Invalid approval replay');
      this.subscriptions.set(result.approvalReplay.sessionKey, conversation);
      for (const snapshot of result.approvalReplay.approvals) this.accept(conversation, snapshot, result.approvalReplay.updatedAtMs, snapshot.sourceSessionKey);
      this.subscribedIds.add(identity);
      this.early = this.early.filter(event => !this.receive(event));
      if (result.approvalReplay.truncated) this.error = 'More approvals are pending than can be shown here. Review the remaining requests in OpenClaw.';
    }
    if (Date.now() - this.lastCheck > 15000) {
      this.lastCheck = Date.now();
      for (const item of this.state().items.filter(r => r.snapshot.status === 'pending' && r.action?.state !== 'sending')) { try { await this.read(item); } catch { this.error = 'Some approval outcomes could not be checked. Your decisions are retained.'; } }
    }
  }
  async prepare(conversationId: string) {
    if (!this.factory || !this.ordinary.status().methods.includes('approval.resolve')) return;
    const base = this.ordinary.status(), deadline = Date.now() + 12000;
    while (!this.closed && Date.now() < deadline) {
      await this.sync();
      const conversation = this.conversations().find(c => c.id === conversationId);
      if (this.state().state === 'ready' && conversation && this.subscribedIds.has(`${conversation.id}:${conversation.nativeId}`)) return;
      if (this.ordinary.status().generation !== base.generation || this.state().state === 'error') break;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Fault(503, 'approval_unavailable', 'Approval controls are not connected. Your message is kept; reconnect before sending.');
  }
  private async read(record: ReviewApproval) {
    const conversation = this.target(record), control = this.control!;
    const result = await control.request<{ approval: unknown }>('approval.get', { id: record.snapshot.id });
    this.target(record);
    const snapshot = approvalSnapshotSchema.parse(result.approval);
    if (snapshot.id !== record.snapshot.id || snapshot.presentation.kind !== record.snapshot.presentation.kind || snapshot.createdAtMs !== record.snapshot.createdAtMs) throw new Fault(409, 'approval_replaced', 'The original approval identity could not be confirmed.');
    return this.accept(conversation, snapshot, snapshot.resolvedAtMs ?? record.updatedAtMs, record.sourceSessionKey) ?? this.get(record.id);
  }
  async check(raw: unknown) {
    const input = checkApprovalSchema.parse(raw);
    if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed. Reopen this approval.');
    const original = this.get(input.id);
    const current = await this.read(original);
    // Only an explicit, successful native read can unlock a new decision after
    // uncertainty. Polling never resends or unlocks a possibly in-flight action.
    if (current.snapshot.status === 'pending' && current.action?.state === 'unknown' && original.action?.requestId === current.action.requestId) return this.save({ ...current, action: undefined });
    return current;
  }
  async resolve(device: string, raw: unknown) {
    const input = resolveApprovalSchema.parse(raw);
    const admitted = this.store.admit(device, input, { type: 'assistant.approval', ...input }, () => {
      const record = this.get(input.id), conversation = this.target(record, true);
      if (conversation.deleted || conversation.archived) throw new Fault(409, 'approval_read_only', 'Restore this conversation before deciding on its pending action.');
      if (record.revision !== input.expectedRevision || record.snapshot.status !== 'pending' || record.action && record.action.state !== 'confirmed') throw new Fault(409, 'approval_changed', 'This approval changed. Check its current status before deciding.');
      if (Date.now() >= record.snapshot.expiresAtMs) throw new Fault(409, 'approval_expired', 'The review window has elapsed. Check its final status.');
      if (!record.snapshot.presentation.allowedDecisions.some(decision => decision === input.decision)) throw new Fault(400, 'approval_choice', 'This action does not offer that decision.');
      return this.save({ ...record, action: { requestId: input.requestId, decision: input.decision, state: 'sending' } });
    });
    if (!admitted.fresh) return this.get(input.id);
    const original = admitted.value;
    try {
      const checked = await this.read(original);
      if (checked.snapshot.status !== 'pending') return checked;
      if (hash(checked.snapshot.presentation) !== hash(original.snapshot.presentation) || checked.snapshot.expiresAtMs !== original.snapshot.expiresAtMs) throw new Fault(409, 'approval_changed', 'The action changed before the decision was sent. Review it again.');
      this.target(original, true);
      if (Date.now() >= checked.snapshot.expiresAtMs) return this.save({ ...checked, action: { requestId: input.requestId, decision: input.decision, state: 'unknown', message: 'The review window elapsed before the decision was sent. Check the final status; no decision was sent by this request.' } });
      const response = await this.control!.request<{ applied: boolean; approval: unknown }>('approval.resolve', { id: original.snapshot.id, kind: original.snapshot.presentation.kind, decision: input.decision });
      const conversation = this.target(original), snapshot = approvalSnapshotSchema.parse(response.approval);
      if (snapshot.id !== original.snapshot.id || snapshot.createdAtMs !== original.snapshot.createdAtMs || snapshot.presentation.kind !== original.snapshot.presentation.kind || snapshot.status === 'pending' || typeof response.applied !== 'boolean') throw Error('Unconfirmed approval response');
      return this.accept(conversation, snapshot, snapshot.resolvedAtMs ?? Date.now(), original.sourceSessionKey) ?? this.get(original.id);
    } catch {
      const current = this.get(original.id);
      if (current.snapshot.status !== 'pending') return current;
      return this.save({ ...current, action: { requestId: input.requestId, decision: input.decision, state: 'unknown', message: 'This decision hasn’t been confirmed. Check the original request before trying again.' } });
    }
  }
  private async disconnect() { this.stopListening?.(); this.stopListening = undefined; const control = this.control; this.control = undefined; this.subscriptions.clear(); this.subscribedIds.clear(); this.early = []; await control?.stop(); }
  async close() { this.closed = true; clearInterval(this.timer); this.stopOrdinary(); await this.disconnect(); await this.syncing; }
}
