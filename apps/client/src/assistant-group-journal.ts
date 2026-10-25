import { z } from 'zod';
import { canonical } from '../../../packages/domain/contracts';
import { assistantGroupSchema, groupCommandSchema, type GroupCommand, type GroupReceipt } from '../../../packages/domain/assistant-groups';
import { ApiError } from './api';

const uuid = z.string().uuid();
const scopeSchema = z.object({ epoch: uuid, deviceId: uuid, windowId: uuid, groupId: uuid }).strict();
export type GroupEditorScope = z.infer<typeof scopeSchema>;
const agent = z.object({ agentId: z.string().regex(/^agent:[a-zA-Z0-9:_-]+$/).max(100), agentRevision: z.number().int().positive() }).strict();
export const groupEditorDraftSchema = z.object({
  title: z.string().max(150), projectId: z.string().max(100).nullable(),
  members: z.array(agent).max(32).refine(rows => new Set(rows.map(row => row.agentId)).size === rows.length),
  defaultAgentId: z.string().max(100).nullable(),
}).strict();
export type GroupEditorDraft = z.infer<typeof groupEditorDraftSchema>;
const receiptSchema = z.object({
  format: z.literal(1), kind: z.literal('assistant-group-receipt'),
  requestId: uuid, epoch: uuid, action: z.enum(['create', 'rename', 'add-members', 'remove-member', 'choose-default', 'undo-removal', 'set-archived', 'set-trashed']),
  group: assistantGroupSchema, eventId: uuid,
  addedMembershipIds: z.array(uuid).max(32).refine(rows => new Set(rows).size === rows.length),
  restoredDefault: z.boolean(),
}).strict();
const rejectionSchema = z.object({
  kind: z.literal('confirmed-pre-effect-rejection'),
  requestId: uuid, epoch: uuid, groupId: uuid, status: z.literal(409),
  code: z.enum(['group_agent_changed', 'group_project_unavailable', 'group_revision_changed']),
  message: z.string().min(1).max(2048),
}).strict();
const journalSchema = z.object({
  format: z.literal(1), scope: scopeSchema, draft: groupEditorDraftSchema,
  origin: z.enum(['create', 'group']).optional(),
  recoveredFrom: z.array(scopeSchema).max(8).optional(),
  pending: z.object({ command: groupCommandSchema, dispatched: z.boolean(), receipt: receiptSchema.optional(),
    rejection: rejectionSchema.optional() }).strict().refine(pending => {
    const rejected = pending.rejection;
    return !rejected || pending.dispatched && !pending.receipt
      && rejected.requestId === pending.command.requestId && rejected.epoch === pending.command.epoch
      && rejected.groupId === pending.command.groupId;
  }, 'The kept rejection does not match the original Group request.').optional(),
}).strict();
export type GroupEditorRecord = z.infer<typeof journalSchema>;
type Journal = GroupEditorRecord;
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
export const emptyGroupEditor = (): GroupEditorDraft => ({ title: '', projectId: null, members: [], defaultAgentId: null });
export function groupEditorKey(scope: GroupEditorScope) {
  scopeSchema.parse(scope);
  return `e3:group-editor:${scope.deviceId}:${scope.epoch}:${scope.windowId}:${scope.groupId}`;
}
/** One reader for ordinary reload and explicit closed-window recovery. */
export function readGroupEditorJournal(raw: string, scope: GroupEditorScope): GroupEditorRecord {
  scopeSchema.parse(scope);
  if (raw.length > 128 * 1024 || new TextEncoder().encode(raw).length > 128 * 1024)
    throw Error('The kept Group editor exceeds its supported size.');
  const kept = journalSchema.parse(JSON.parse(raw));
  if (canonical(kept.scope) !== canonical(scope)) throw Error('This kept editor belongs to another Group or workspace.');
  const origins = kept.recoveredFrom ?? [];
  if (new Set(origins.map(origin => origin.windowId)).size !== origins.length
    || origins.some(origin => origin.epoch !== scope.epoch || origin.deviceId !== scope.deviceId
      || origin.groupId !== scope.groupId || origin.windowId === scope.windowId))
    throw Error('The original Group writing locations could not be verified.');
  if (kept.pending) {
    if (kept.pending.command.epoch !== scope.epoch || kept.pending.command.groupId !== scope.groupId)
      throw Error('The kept request belongs to another Group.');
    if (kept.pending.receipt) {
      if (!kept.pending.dispatched) throw Error('The kept Group receipt has no original dispatch marker.');
      originalGroupReceipt(scope, kept.pending.command, kept.pending.receipt);
    }
  }
  return kept;
}

/** A response is evidence for one original command, never a refreshed command. */
export function originalGroupReceipt(scope: GroupEditorScope, command: GroupCommand, raw: unknown): GroupReceipt {
  const reply = receiptSchema.parse(raw), group = reply.group;
  if (command.epoch !== scope.epoch || command.groupId !== scope.groupId
    || reply.requestId !== command.requestId || reply.epoch !== command.epoch || reply.action !== command.action
    || group.id !== command.groupId || group.revision !== command.expectedRevision + 1 || group.lastEventId !== reply.eventId)
    throw Error('This reply does not confirm the original Group change. Check its original status.');
  const added = command.action === 'create' || command.action === 'add-members' ? command.members.length : command.action === 'undo-removal' ? 1 : 0;
  if (reply.addedMembershipIds.length !== added || reply.addedMembershipIds.some(id => !group.activeMembershipIds.includes(id))
    || command.action !== 'undo-removal' && reply.restoredDefault)
    throw Error('The original Group membership result could not be verified.');
  if (command.action === 'create' || command.action === 'add-members' && command.defaultAgentId !== null) {
    const selected = command.members.findIndex(member => member.agentId === command.defaultAgentId);
    if (group.defaultMemberId !== (selected < 0 ? null : reply.addedMembershipIds[selected]))
      throw Error('The original default responder could not be verified.');
  }
  if (command.action === 'create' && (group.title !== command.title || group.projectId !== command.projectId
    || canonical(group.createdBy) !== canonical({ requestId: command.requestId, epoch: command.epoch, deviceId: scope.deviceId })
    || group.activeMembershipIds.length !== added || group.archived || group.trashed)
    || command.action === 'rename' && group.title !== command.title
    || command.action === 'choose-default' && group.defaultMemberId !== command.membershipId
    || command.action === 'remove-member' && group.activeMembershipIds.includes(command.membershipId)
    || command.action === 'set-archived' && group.archived !== command.archived
    || command.action === 'set-trashed' && group.trashed !== command.trashed)
    throw Error('The original Group result changed. Keep this request for review.');
  return reply;
}

/** Browser writing and one original metadata request. No send, timer or replay. */
export class GroupEditorJournal {
  readonly key: string;
  value: Journal;
  error = '';
  invalid = false;
  busy = false;
  private raw: string | null = null;
  private knownUnsent?: string;
  private clearAttempt?: { archiveKey: string; archived: string; cleared: string };
  constructor(private storage: StoragePort, readonly scope: GroupEditorScope,
    private current: () => boolean, initial: GroupEditorDraft = emptyGroupEditor(), origin?: 'create' | 'group') {
    scopeSchema.parse(scope);
    this.key = groupEditorKey(scope);
    this.value = { format: 1, scope, draft: groupEditorDraftSchema.parse(initial), ...(origin ? { origin } : {}) };
    try {
      this.raw = storage.getItem(this.key);
      if (this.raw === null) return;
      const kept = readGroupEditorJournal(this.raw, scope);
      this.value = origin === 'group' ? { ...kept, origin } : kept;
    } catch (error) {
      this.invalid = true; this.error = error instanceof Error ? error.message : 'The original Group editor could not be read.';
    }
  }
  get canContinueUnsent() {
    const pending = this.value.pending;
    return !!pending && !pending.receipt && !pending.rejection && (!pending.dispatched || this.knownUnsent === pending.command.requestId);
  }
  retain(): boolean {
    if (this.invalid || !this.current()) return false;
    try {
      const desired = JSON.stringify(journalSchema.parse(this.value));
      if (new TextEncoder().encode(desired).length > 128 * 1024) throw Error('The complete Group editor is too large to keep.');
      const actual = this.storage.getItem(this.key);
      if (actual !== desired) {
        if (actual !== this.raw) throw Error('This Group editor changed in another window. Both versions are kept.');
        this.storage.setItem(this.key, desired);
        if (this.storage.getItem(this.key) !== desired) throw Error('Your Group writing was not confirmed in browser storage. Keep this window open.');
      }
      this.raw = desired; this.error = ''; return true;
    } catch (error) { this.error = error instanceof Error ? error.message : 'Your Group writing could not be kept.'; return false; }
  }
  change(next: GroupEditorDraft): boolean {
    if (this.invalid || !this.current()) return false;
    this.value = { ...this.value, draft: groupEditorDraftSchema.parse(next) };
    return this.retain();
  }
  /** Archive a confirmed original before allowing a separate explicit change. */
  finish(): boolean {
    if (this.invalid || !this.current() || this.busy || !this.value.pending?.receipt) return false;
    return this.archiveOriginal('confirmed');
  }
  /** A known rejection permits a new explicit command only after its original is kept. */
  finishRejected(): boolean {
    if (this.invalid || !this.current() || this.busy || !this.value.pending?.rejection) return false;
    return this.archiveOriginal('rejected');
  }
  private archiveOriginal(kind: 'confirmed' | 'rejected'): boolean {
    const pending = this.value.pending;
    if (!pending) return false;
    try {
      const key = `${this.key}:${kind}:${pending.command.requestId}`, raw = JSON.stringify(pending);
      if (this.clearAttempt?.archiveKey === key && this.clearAttempt.archived === raw
        && this.storage.getItem(this.key) === this.clearAttempt.cleared) {
        if (this.storage.getItem(key) !== raw) throw Error('The original archived Group request changed.');
        // A prior pointer write reached storage but its readback failed. Adopt
        // only those exact attempted bytes as the baseline, never as new writing.
        this.raw = this.clearAttempt.cleared;
        return this.clearArchived(key, raw);
      }
      if (!this.retain()) return false;
      const prior = this.storage.getItem(key);
      if (prior !== null && prior !== raw) throw Error(`The original ${kind} Group request changed.`);
      if (prior === null) this.storage.setItem(key, raw);
      if (this.storage.getItem(key) !== raw) throw Error(`The ${kind} Group request could not be archived.`);
      return this.clearArchived(key, raw);
    } catch (error) { this.error = error instanceof Error ? error.message : 'The original request is kept.'; return false; }
  }
  private clearArchived(archiveKey: string, archived: string): boolean {
    const original = this.value, cleared = { ...this.value, pending: undefined };
    this.clearAttempt = { archiveKey, archived, cleared: JSON.stringify(journalSchema.parse(cleared)) };
    this.value = cleared;
    if (this.retain()) { this.clearAttempt = undefined; return true; }
    this.value = original; return false;
  }
  private accept(raw: unknown): GroupReceipt {
    const pending = this.value.pending;
    if (!pending) throw Error('The original Group request is unavailable.');
    const receipt = originalGroupReceipt(this.scope, pending.command, raw);
    // Preserve genuine late evidence and newer writing before fallible storage.
    this.value = { ...this.value, origin: 'group', pending: { ...pending, receipt } };
    if (this.current()) this.retain();
    return receipt;
  }
  async send(raw: GroupCommand, post: (command: GroupCommand) => Promise<unknown>): Promise<GroupReceipt | undefined> {
    if (this.busy || this.invalid || this.value.pending || !this.current()) return;
    const command = groupCommandSchema.parse(raw);
    if (command.epoch !== this.scope.epoch || command.groupId !== this.scope.groupId) throw Error('The Group request target changed.');
    this.value = { ...this.value, pending: { command, dispatched: false } };
    if (!this.retain()) return;
    return this.continueUnsent(post);
  }
  /** Only a durably kept request with no dispatch marker can be continued. */
  async continueUnsent(post: (command: GroupCommand) => Promise<unknown>): Promise<GroupReceipt | undefined> {
    if (this.busy || this.invalid || !this.current() || !this.value.pending || !this.canContinueUnsent
      || this.value.pending.receipt || !this.retain()) return;
    const command = this.value.pending.command;
    this.knownUnsent = command.requestId;
    this.value = { ...this.value, pending: { ...this.value.pending, dispatched: true } };
    if (!this.retain()) return;
    this.busy = true;
    try {
      if (!this.current()) throw Error('The original Group view closed before the request. Its writing is kept.');
      this.knownUnsent = undefined;
      let raw: unknown;
      try { raw = await post(command); }
      catch (error) {
        // Only these authenticated POST failures originate in fresh preparation,
        // before Group writes. Missing status, broad conflicts and transport errors
        // remain unknown; they never authorize clearing or repeating a request.
        if (error instanceof ApiError && error.status === 409) {
          const rejected = rejectionSchema.safeParse({ kind: 'confirmed-pre-effect-rejection',
            requestId: command.requestId, epoch: command.epoch, groupId: command.groupId,
            status: error.status, code: error.code, message: error.message });
          if (rejected.success) {
            this.value = { ...this.value, pending: { ...this.value.pending!, rejection: rejected.data } };
            if (this.current()) this.retain();
            return;
          }
        }
        throw error;
      }
      const result = this.accept(raw);
      return this.current() && !this.error ? result : undefined;
    } catch (error) { this.error = error instanceof Error ? error.message : 'The Group change is unconfirmed. Check its original status.'; }
    finally { this.busy = false; }
  }
  async observe(get: (groupId: string, requestId: string) => Promise<unknown>): Promise<GroupReceipt | undefined> {
    if (this.busy || this.invalid || !this.value.pending || !this.current()) return;
    if (this.value.pending.receipt) return this.retain() ? this.value.pending.receipt : undefined;
    if (this.value.pending.rejection) { this.retain(); return; }
    if (this.canContinueUnsent) { this.error = 'This original change has not been sent. Continue it when ready.'; return; }
    this.busy = true;
    try {
      const original = this.value.pending.command;
      const result = z.object({ epoch: uuid, view: z.literal('request'), receipt: receiptSchema }).strict().parse(await get(original.groupId, original.requestId));
      if (result.epoch !== this.scope.epoch) throw Error('The workspace changed. The original request is kept.');
      const receipt = this.accept(result.receipt);
      return this.current() && !this.error ? receipt : undefined;
    } catch (error) { this.error = error instanceof Error ? error.message : 'The original Group change is still unconfirmed.'; }
    finally { this.busy = false; }
  }
}
