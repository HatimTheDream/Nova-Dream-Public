import { z } from 'zod';
import { canonical } from '../../../packages/domain/contracts';
import {
  groupExecutionCommandSchema, groupExecutionReceiptSchema, groupExecutionRejectionSchema,
  groupExecutionViewSchema, type GroupExecutionCommand, type GroupExecutionView,
} from '../../../packages/domain/assistant-group-execution';
import { ApiError } from './api';

const uuid = z.string().uuid(), sha = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.object({
  epoch: uuid, deviceId: uuid, groupId: uuid, roundId: uuid, roundSha256: sha, attemptId: uuid,
  author: groupExecutionViewSchema.shape.author,
}).strict();
export type GroupReplyBinding = z.infer<typeof bindingSchema>;
const pendingSchema = z.object({ command: groupExecutionCommandSchema, dispatched: z.boolean(),
  receipt: groupExecutionReceiptSchema.optional(), rejection: groupExecutionRejectionSchema.optional() }).strict();
const observationSchema = z.object({ epoch: uuid, groupId: uuid, attemptId: uuid,
  expectedRevision: z.number().int().positive() }).strict();
const journalSchema = z.object({ format: z.literal(1), binding: bindingSchema,
  pending: pendingSchema.optional(), last: groupExecutionViewSchema.nullable(),
  observation: z.object({ id: uuid, body: observationSchema, dispatched: z.boolean() }).strict().optional(),
}).strict();
type Journal = z.infer<typeof journalSchema>;
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
type Get = (path: string) => Promise<unknown>;
type Post = (path: string, body: unknown) => Promise<unknown>;
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const explain = (e: unknown) => e instanceof Error ? e.message : 'The original reply request is kept.';
export const groupReplyKey = (b: GroupReplyBinding) => `e3:group-reply:${b.epoch}:${b.deviceId}:${b.groupId}:${b.attemptId}`;
export const groupReplyUrl = (b: GroupReplyBinding, requestId?: string) =>
  'assistant/group-execution?' + new URLSearchParams({ groupId: b.groupId, attemptId: b.attemptId, ...(requestId ? { requestId } : {}) });
const terminal = (state: string) => ['completed', 'failed', 'cancelled'].includes(state);

/** A single original child across windows. Reading never dispatches native work.
 * Cached state is readable but cannot authorize a new action before a fresh GET. */
export class GroupReplyJournal {
  readonly key: string;
  value: Journal;
  checked = false;
  busy = false;
  invalid = false;
  error = '';
  retentionError = '';
  private raw: string | null = null;
  private attempted?: string;
  private notCalled?: string;
  constructor(private storage: StoragePort, readonly binding: GroupReplyBinding, private current: () => boolean) {
    bindingSchema.parse(binding); this.key = groupReplyKey(binding);
    this.value = { format: 1, binding, last: null };
    try {
      this.raw = storage.getItem(this.key);
      if (this.raw !== null) {
        if (this.raw.length > 1_200_000) throw Error('The original reply journal exceeds its retained limit.');
        const saved = journalSchema.parse(JSON.parse(this.raw));
        if (!equal(saved.binding, binding)) throw Error('The original reply belongs to another captured recipient.');
        if (saved.last) this.validateView(saved.last);
        if (saved.pending) {
          this.validateCommand(saved.pending.command);
          if (saved.pending.receipt) {
            if (!saved.last) throw Error('The original reply receipt has no verified saved state.');
            this.validateReceipt(saved.pending.command, saved.pending.receipt, saved.last);
          }
          if (saved.pending.rejection && !equal(saved.pending.rejection.command, saved.pending.command))
            throw Error('The saved rejection belongs to a different request.');
        }
        if (saved.observation && (saved.observation.body.epoch !== binding.epoch
          || saved.observation.body.groupId !== binding.groupId || saved.observation.body.attemptId !== binding.attemptId))
          throw Error('The original progress check belongs to another reply.');
        this.value = saved;
      }
    } catch (e) { this.invalid = true; this.error = explain(e); }
  }
  private validateCommand(command: GroupExecutionCommand) {
    groupExecutionCommandSchema.parse(command);
    for (const key of ['epoch', 'groupId', 'roundId', 'roundSha256', 'attemptId'] as const)
      if (command[key] !== this.binding[key]) throw Error('The reply request lost its original captured recipient.');
  }
  private validateView(raw: unknown) {
    const view = groupExecutionViewSchema.parse(raw);
    for (const key of ['epoch', 'groupId', 'roundId', 'roundSha256', 'attemptId'] as const)
      if (view[key] !== this.binding[key]) throw Error('This saved reply belongs to a different original message.');
    if (!equal(view.author, this.binding.author)) throw Error('The saved reply changed its original author.');
    if (this.value.last && !equal(view.account, this.value.last.account))
      throw Error('The original reply account or model changed.');
    if (view.revision < (this.value.last?.revision ?? 0)) throw Error('An older reply state cannot replace the last confirmed state.');
    return view;
  }
  private validateReceipt(command: GroupExecutionCommand, raw: unknown, view: GroupExecutionView) {
    const receipt = groupExecutionReceiptSchema.parse(raw);
    if (receipt.requestId !== command.requestId || receipt.epoch !== command.epoch
      || receipt.groupId !== command.groupId || receipt.attemptId !== command.attemptId
      || receipt.sequence !== command.expectedRevision + 1 || receipt.sequence > view.revision
      || !equal(view.originalCommand, command) || !equal(view.originalReceipt, receipt)
      || command.action === 'setup' && !equal(view.account, command.account))
      throw Error('This response does not confirm the exact original reply request.');
    return receipt;
  }
  retain() {
    if (this.invalid || !this.current()) return false;
    try {
      const prior = this.storage.getItem(this.key);
      if (prior !== this.raw && prior !== this.attempted) throw Error('Another window changed this original reply. Reopen it to read the kept request.');
      const raw = JSON.stringify(journalSchema.parse(this.value));
      if (raw.length > 1_200_000) throw Error('The reply journal exceeds its retained limit.');
      this.attempted = raw; this.storage.setItem(this.key, raw);
      if (this.storage.getItem(this.key) !== raw) throw Error('The original reply request was not confirmed on this device.');
      this.raw = raw; this.attempted = undefined; this.retentionError = ''; return true;
    } catch (e) { this.retentionError = explain(e); this.error = this.retentionError; return false; }
  }
  private archive(key: string, value: unknown) {
    const raw = canonical(value), path = `${this.key}:${key}`;
    const previous = this.storage.getItem(path);
    if (previous !== null && previous !== raw) throw Error('An original reply record was changed.');
    this.storage.setItem(path, raw);
    if (this.storage.getItem(path) !== raw) throw Error('The original reply record could not be kept.');
  }
  private finishOriginal() {
    const p = this.value.pending;
    if (!p) return true;
    if (!p.receipt && !p.rejection || !this.retain()) return false;
    this.archive(`request:${p.command.requestId}`, p);
    this.value = { ...this.value, pending: undefined }; return this.retain();
  }
  get unresolved() { const p = this.value.pending; return !!p && !p.receipt && !p.rejection; }
  get canContinueOriginal() {
    const p = this.value.pending;
    return !!p && !p.receipt && !p.rejection && (!p.dispatched || this.notCalled === p.command.requestId);
  }
  get canAct() { return this.current() && !this.invalid && !this.busy && this.checked
    && !this.unresolved && !this.value.observation && !this.value.last?.observationInFlight; }
  // An uncertain read-only observation must not remove the owner's ability to
  // stop a freshly read active original. Stop still has its own retained intent
  // and the service's exact revision/dispatch checks.
  get canStop() { return this.current() && !this.invalid && !this.busy && this.checked
    && !this.unresolved && !!this.value.last?.canStop; }
  get canContinueStop() { return this.current() && !this.invalid && !this.busy && this.checked
    && !this.unresolved && !!this.value.last?.canContinueStop; }
  async read(get: Get) {
    if (!this.current() || this.invalid || this.busy) return false;
    this.busy = true; this.checked = false;
    const p = this.value.pending, requestId = p && !p.rejection ? p.command.requestId : undefined;
    try {
      const view = this.validateView(await get(groupReplyUrl(this.binding, requestId)));
      if (!this.current()) return false;
      if (p && !p.rejection) {
        const receipt = this.validateReceipt(p.command, view.originalReceipt, view);
        this.value = { ...this.value, pending: { ...p, receipt } };
      }
      this.value = { ...this.value, last: view }; this.checked = true; this.error = '';
      // An inactive owner alone is not proof that a timed-out HTTP request
      // cannot arrive later. A newer revision also makes that old body stale.
      if (this.value.observation && !view.observationInFlight
        && (!this.value.observation.dispatched || view.revision > this.value.observation.body.expectedRevision)) {
        if (!this.retain()) return false;
        this.archive(`observation:${this.value.observation.id}`, this.value.observation);
        this.value = { ...this.value, observation: undefined };
      }
      return this.retain();
    } catch (e) {
      if (!this.current()) return false;
      if ((!p || p.rejection) && !this.value.last && e instanceof ApiError && e.status === 404 && e.code === 'group_child_missing') {
        this.checked = true; this.error = ''; return true;
      }
      this.error = explain(e); return false;
    } finally { this.busy = false; }
  }
  async start(action: 'setup' | 'send' | 'stop' | 'continue-unsent' | 'continue-stop', post: Post,
    options?: { account?: { profileId: string; model: string }; phase?: 'setup' | 'send' }) {
    if (action === 'stop' ? !this.canStop : action === 'continue-stop' ? !this.canContinueStop : !this.canAct) return false;
    const last = this.value.last;
    try {
      if (action === 'setup' ? !!last : !last) return false;
      if (action === 'send' && (!last!.canSend || last!.setup.state !== 'ready' || last!.send || last!.stop)) return false;
      if (action === 'stop' && (!last!.canStop || !last!.send?.dispatchStarted || terminal(last!.send.state) || last!.stop)) return false;
      if (action === 'continue-stop' && (!last!.canContinueStop || !last!.stop || !('format' in last!.stop)
        || last!.stop.state !== 'failed' || last!.stop.dispatchStarted)) return false;
      const phase = options?.phase, original = phase && last?.[phase];
      if (action === 'continue-unsent' && (!phase || !original?.canContinueUnsent
        || original.state !== 'failed' || original.dispatchStarted || last!.stop)) return false;
      const { epoch, groupId, roundId, roundSha256, attemptId } = this.binding;
      const base = { epoch, groupId, roundId, roundSha256, attemptId, requestId: crypto.randomUUID(),
        expectedRevision: last?.revision ?? 0 };
      const command = groupExecutionCommandSchema.parse(action === 'setup' ? { ...base, action, account: options?.account }
        : action === 'continue-unsent' ? { ...base, action, phase, originalRequestId: original!.requestId, expectedSha256: last!.sha256 }
        : action === 'continue-stop' ? { ...base, action, originalRequestId: last!.stop!.requestId, expectedSha256: last!.sha256 }
        : action === 'stop' ? { ...base, action, stopTracking: 1 }
        : { ...base, action });
      this.validateCommand(command);
      if (!this.finishOriginal()) return false;
      this.value = { ...this.value, pending: { command, dispatched: false } };
      if (!this.retain()) return false;
      return await this.continueOriginal(post);
    } catch (e) { this.error = explain(e); return false; }
  }
  async continueOriginal(post: Post) {
    if (!this.current() || this.invalid || this.busy || !this.canContinueOriginal) return false;
    const p = this.value.pending!;
    this.busy = true; this.notCalled = p.command.requestId;
    try {
      this.value = { ...this.value, pending: { ...p, dispatched: true } };
      if (!this.retain()) return false;
      if (!this.current()) return false;
      this.notCalled = undefined; this.checked = false;
      const result = z.object({ receipt: groupExecutionReceiptSchema, current: groupExecutionViewSchema }).strict()
        .parse(await post('assistant/group-execution', p.command));
      const view = this.validateView(result.current);
      const receipt = this.validateReceipt(p.command, result.receipt, view);
      if (!this.current()) return false;
      this.value = { ...this.value, last: view, pending: { ...p, dispatched: true, receipt } };
      this.checked = true; this.error = ''; return this.retain();
    } catch (e) {
      if (!this.current()) return false;
      if (e instanceof ApiError && [409, 413, 503].includes(e.status ?? 0)) {
        const proof = groupExecutionRejectionSchema.safeParse(e.current);
        if (proof.success && equal(proof.data.command, p.command)) {
          this.value = { ...this.value, pending: { ...p, dispatched: true, rejection: proof.data } };
          this.retain();
        }
      }
      this.error = explain(e); return false;
    } finally { this.busy = false; }
  }
  async observe(post: Post) {
    if (!this.canAct || !this.value.last) return false;
    this.busy = true;
    const { epoch, groupId, attemptId } = this.binding;
    try {
      const observation = { id: crypto.randomUUID(), body: { epoch, groupId, attemptId,
        expectedRevision: this.value.last.revision }, dispatched: false };
      this.value = { ...this.value, observation }; if (!this.retain()) return false;
      this.value = { ...this.value, observation: { ...observation, dispatched: true } };
      if (!this.retain() || !this.current()) return false;
      this.checked = false;
      const view = this.validateView(await post('assistant/group-execution/observe', observation.body));
      if (!this.current()) return false;
      // Observation responses intentionally have no selected command. Preserve
      // the original admission proof while adopting newer saved state.
      const p = this.value.pending;
      const last = p?.receipt ? { ...view, originalReceipt: p.receipt, originalCommand: p.command } : view;
      this.value = { ...this.value, last };
      if (!this.retain()) return false;
      this.archive(`observation:${observation.id}`, this.value.observation);
      this.value = { ...this.value, observation: undefined }; this.checked = true; this.error = '';
      return this.retain();
    } catch (e) { if (this.current()) this.error = explain(e); return false; }
    finally { this.busy = false; }
  }
}
