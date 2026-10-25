import { z } from 'zod';
import { canonical } from '../../../packages/domain/contracts';
import {
  groupDraftScopeSchema, groupHistoryRefSchema, groupResponseRefSchema, groupSourceRefSchema,
  groupPreparationCommandSchema, groupPreparationReceiptSchema, groupPreparationRejectionSchema, parseGroupDraft,
  type GroupDraftScope, type GroupPreparationCommand, type GroupPreparationReceipt,
} from '../../../packages/domain/assistant-group-turns';
import { ApiError } from './api';

const writingSchema = z.object({
  text: z.string().max(20000), sources: z.array(groupSourceRefSchema).max(32),
  history: z.array(groupHistoryRefSchema).max(64), responses: z.array(groupResponseRefSchema).max(32),
}).strict();
export type GroupWriting = z.infer<typeof writingSchema>;
const pendingSchema = z.object({ command: groupPreparationCommandSchema, dispatched: z.boolean(),
  receipt: groupPreparationReceiptSchema.optional(), rejection: groupPreparationRejectionSchema.optional() }).strict();
const journalSchema = z.object({
  format: z.literal(1), scope: groupDraftScopeSchema, writing: writingSchema,
  savedRaw: z.string().max(262144).nullable(), pending: pendingSchema.optional(),
}).strict();
type Journal = z.infer<typeof journalSchema>;
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
export const emptyGroupWriting = (): GroupWriting => ({ text: '', sources: [], history: [], responses: [] });
export const writingFromDraft = (raw: string): GroupWriting => {
  const d = parseGroupDraft(raw);
  return { text: d.text, sources: d.sources, history: d.history, responses: d.format === 2 ? d.responses : [] };
};
export const groupMessageKey = (scope: GroupDraftScope) => `e3:group-message:${encodeURIComponent(canonical(groupDraftScopeSchema.parse(scope)))}`;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const explanation = (error: unknown) => error instanceof Error ? error.message : 'The original writing is kept.';

/** Validate a response against the captured command, never against newer writing. */
export function originalPreparationReceipt(scope: GroupDraftScope, command: GroupPreparationCommand, raw: unknown) {
  const receipt = groupPreparationReceiptSchema.parse(raw);
  if (command.epoch !== scope.epoch || command.groupId !== scope.groupId || receipt.epoch !== scope.epoch
    || receipt.groupId !== scope.groupId || receipt.requestId !== command.requestId || receipt.action !== command.action)
    throw Error('This result does not confirm the original Group message request.');
  if (command.action === 'save-draft-v2') {
    const d = receipt.draftRaw && parseGroupDraft(receipt.draftRaw);
    const before = command.expectedRaw && parseGroupDraft(command.expectedRaw);
    if (!d || d.format !== 2 || !same(command.scope, scope) || !same(d.scope, scope)
      || d.revision !== (before ? before.revision : 0) + 1 || d.preparedRoundId !== null
      || before && (before.id !== d.id || !same(before.scope, scope))
      || !same(writingFromDraft(receipt.draftRaw!), { text: command.text, sources: command.sources, history: command.history, responses: command.responses })
      || receipt.roundId !== null || receipt.grantId !== null)
      throw Error('This saved draft does not match the original writing and recipients.');
  } else if (command.action === 'prepare') {
    const before = parseGroupDraft(command.expectedRaw), after = receipt.draftRaw && parseGroupDraft(receipt.draftRaw);
    if (!same(before.scope, scope) || !after || !receipt.roundId || receipt.grantId !== null
      || receipt.sequence !== command.expectedSequence + 1 || before.id !== command.draftId
      || !same(after, { ...before, revision: before.revision + 1, preparedRoundId: receipt.roundId }))
      throw Error('This prepared input does not match the original saved draft.');
  } else throw Error('This editor cannot submit that Group operation.');
  return receipt;
}

/** One recipient scope, one original request. No timers, native calls or automatic replay. */
export class GroupMessageJournal {
  readonly key: string;
  value: Journal;
  error = '';
  retentionError = '';
  invalid = false;
  busy = false;
  checked = false;
  conflict: string | null | undefined;
  private raw: string | null = null;
  private unsent?: string;
  private attempted?: string;
  constructor(private storage: StoragePort, readonly scope: GroupDraftScope, private current: () => boolean) {
    this.key = groupMessageKey(scope);
    this.value = { format: 1, scope, writing: emptyGroupWriting(), savedRaw: null };
    try {
      this.raw = storage.getItem(this.key);
      if (this.raw === null) return;
      if (this.raw.length > 1024 * 1024) throw Error('This original message journal is too large to open.');
      const value = journalSchema.parse(JSON.parse(this.raw));
      if (!same(scope, value.scope)) throw Error('The original message belongs to different recipients.');
      if (value.savedRaw && !same(parseGroupDraft(value.savedRaw).scope, scope)) throw Error('The saved draft scope changed.');
      if (value.pending) {
        const c = value.pending.command;
        if (c.epoch !== scope.epoch || c.groupId !== scope.groupId
          || c.action === 'save-draft-v2' && !same(c.scope, scope)
          || c.action === 'prepare' && !same(parseGroupDraft(c.expectedRaw).scope, scope)
          || !['save-draft-v2', 'prepare'].includes(c.action)) throw Error('The original pending message scope changed.');
        if (value.pending.receipt) {
          if (!value.pending.dispatched) throw Error('This receipt has no original dispatch marker.');
          originalPreparationReceipt(scope, c, value.pending.receipt);
        }
        if (value.pending.rejection && (!value.pending.dispatched || value.pending.receipt
          || !same(value.pending.rejection.command, c))) throw Error('This rejection does not match the original message request.');
      }
      this.value = value;
    } catch (e) { this.invalid = true; this.error = explanation(e); }
  }
  get canContinue() { return !!this.value.pending && !this.value.pending.receipt && !this.value.pending.rejection
    && (!this.value.pending.dispatched || this.unsent === this.value.pending.command.requestId); }
  get dirty() { return !this.value.savedRaw ? !same(this.value.writing, emptyGroupWriting())
    : !same(this.value.writing, writingFromDraft(this.value.savedRaw)); }
  retain() {
    if (this.invalid || !this.current()) return false;
    try {
      const desired = JSON.stringify(journalSchema.parse(this.value));
      if (desired.length > 1024 * 1024) throw Error('This message is too large to keep on this device. Copy your writing.');
      const actual = this.storage.getItem(this.key);
      // A failed readback may have left our exact attempted bytes. Nothing else
      // is eligible as a new baseline.
      if (actual !== this.raw && actual !== this.attempted && actual !== desired)
        throw Error('This message changed in another window. Your current writing is still here.');
      if (actual !== desired) { this.attempted = desired; this.storage.setItem(this.key, desired); }
      if (this.storage.getItem(this.key) !== desired) throw Error('Your writing is kept only in this window. Copy it before leaving.');
      this.raw = desired; this.attempted = undefined; this.retentionError = ''; this.error = ''; return true;
    } catch (e) { this.error = this.retentionError = explanation(e); return false; }
  }
  change(writing: GroupWriting) {
    if (this.invalid || !this.current()) return false;
    this.value = { ...this.value, writing: writingSchema.parse(writing) };
    return this.retain();
  }
  /** GET evidence alone never clears an uncertain operation or newer writing. */
  readSaved(raw: string | null) {
    if (this.invalid || !this.current()) return false;
    if (raw && !same(parseGroupDraft(raw).scope, this.scope)) throw Error('The saved draft belongs to another recipient scope.');
    this.checked = true;
    if (raw === this.value.savedRaw) { this.conflict = undefined; return true; }
    if (!this.value.pending && !this.dirty && this.value.savedRaw === null) {
      this.value = { ...this.value, savedRaw: raw, writing: raw ? writingFromDraft(raw) : emptyGroupWriting() };
      this.conflict = undefined; return this.retain();
    }
    this.conflict = raw; return false;
  }
  /** Keep both copies before preparing an explicit conflict choice. Does not save. */
  chooseSaved(useSaved: boolean) {
    if (this.conflict === undefined || this.value.pending || !this.current() || this.invalid || this.busy) return false;
    try {
      if (!this.retain()) return false;
      const copy = JSON.stringify({ current: this.value, incoming: this.conflict });
      const key = `${this.key}:comparison:${crypto.randomUUID()}`;
      this.storage.setItem(key, copy);
      if (this.storage.getItem(key) !== copy) throw Error('Keep both versions before choosing one.');
      this.value = { ...this.value, savedRaw: this.conflict,
        writing: useSaved ? this.conflict ? writingFromDraft(this.conflict) : emptyGroupWriting() : this.value.writing };
      this.conflict = undefined; return this.retain();
    } catch (e) { this.error = explanation(e); return false; }
  }
  finish() {
    if (!this.value.pending?.receipt || this.busy || !this.current() || this.invalid) return false;
    return this.archiveOriginal('confirmed');
  }
  finishRejected() {
    if (!this.value.pending?.rejection || this.busy || !this.current() || this.invalid) return false;
    return this.archiveOriginal('rejected');
  }
  private archiveOriginal(kind: 'confirmed' | 'rejected') {
    try {
      if (!this.retain()) return false;
      const key = `${this.key}:${kind}:${this.value.pending!.command.requestId}`, value = JSON.stringify(this.value.pending);
      const prior = this.storage.getItem(key);
      if (prior !== null && prior !== value) throw Error('The original confirmed request changed.');
      this.storage.setItem(key, value);
      if (this.storage.getItem(key) !== value) throw Error('The original confirmed request could not be retained.');
      this.value = { ...this.value, pending: undefined };
      return this.retain();
    } catch (e) { this.error = explanation(e); return false; }
  }
  async save(post: (command: GroupPreparationCommand) => Promise<unknown>) {
    if (!this.checked || this.conflict !== undefined || !this.dirty) return;
    return this.begin({ action: 'save-draft-v2', epoch: this.scope.epoch, groupId: this.scope.groupId,
      requestId: crypto.randomUUID(), scope: this.scope, expectedRaw: this.value.savedRaw, ...this.value.writing }, post);
  }
  async prepare(sequence: number, post: (command: GroupPreparationCommand) => Promise<unknown>) {
    if (!this.checked || this.conflict !== undefined || this.dirty || !this.value.savedRaw || !this.value.writing.text.trim()) return;
    const draft = parseGroupDraft(this.value.savedRaw);
    if (draft.preparedRoundId) return;
    return this.begin({ action: 'prepare', epoch: this.scope.epoch, groupId: this.scope.groupId,
      requestId: crypto.randomUUID(), draftId: draft.id, expectedRaw: this.value.savedRaw, expectedSequence: sequence }, post);
  }
  private async begin(command: GroupPreparationCommand, post: (command: GroupPreparationCommand) => Promise<unknown>) {
    if (this.busy || this.invalid || !this.current() || this.value.pending && !this.finish()) return;
    this.value = { ...this.value, pending: { command: groupPreparationCommandSchema.parse(command), dispatched: false } };
    if (!this.retain()) return;
    return this.continueOriginal(post);
  }
  private accept(raw: unknown) {
    const pending = this.value.pending!;
    const receipt = originalPreparationReceipt(this.scope, pending.command, raw);
    this.value = { ...this.value, savedRaw: receipt.draftRaw, pending: { ...pending, receipt } };
    this.checked = true; this.conflict = undefined;
    return this.current() && this.retain() ? receipt : undefined;
  }
  async continueOriginal(post: (command: GroupPreparationCommand) => Promise<unknown>) {
    if (!this.current() || this.invalid || this.busy || !this.canContinue || !this.retain()) return;
    const pending = this.value.pending!;
    this.unsent = pending.command.requestId;
    this.value = { ...this.value, pending: { ...pending, dispatched: true } };
    if (!this.retain()) return;
    this.busy = true;
    try {
      if (!this.current()) return;
      this.unsent = undefined;
      let result: unknown;
      try { result = await post(pending.command); }
      catch (e) {
        if (e instanceof ApiError && (e.status === 409 || e.status === 413)) {
          const proof = groupPreparationRejectionSchema.safeParse(e.current);
          if (proof.success && same(proof.data.command, pending.command)) {
            this.value = { ...this.value, pending: { ...this.value.pending!, rejection: proof.data } };
            if (this.current()) this.retain();
          }
        }
        throw e;
      }
      return this.accept(result);
    } catch (e) { this.error = explanation(e); }
    finally { this.busy = false; }
  }
  async observe(get: (command: GroupPreparationCommand) => Promise<unknown>) {
    if (!this.current() || this.invalid || this.busy || !this.value.pending || this.canContinue || this.value.pending.rejection) return;
    if (this.value.pending.receipt) return this.retain() ? this.value.pending.receipt : undefined;
    this.busy = true;
    try {
      const result = z.object({ epoch: z.literal(this.scope.epoch), groupId: z.literal(this.scope.groupId),
        view: z.literal('request'), sequence: z.number().int().nonnegative(),
        execution: z.literal('unavailable'), mode: z.literal('provided-context-only'),
        receipt: groupPreparationReceiptSchema }).strict().parse(await get(this.value.pending.command));
      return this.accept(result.receipt);
    } catch (e) { this.error = explanation(e); }
    finally { this.busy = false; }
  }
}
