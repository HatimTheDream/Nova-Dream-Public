import { z } from 'zod';
import { canonical } from '../../../packages/domain/contracts';
import { groupPreparationCommandSchema, groupPreparationReceiptSchema, groupPreparationRejectionSchema,
  groupHistoryGrantSchema, groupHistoryRefSchema, groupResponseRefSchema, type GroupPreparationCommand } from '../../../packages/domain/assistant-group-turns';
import { ApiError } from './api';
import { preparationUrl } from './group-message-reader';

const uuid = z.string().uuid();
const ownerSchema = z.object({ epoch: uuid, deviceId: uuid, groupId: uuid }).strict();
export type HistoryOwner = z.infer<typeof ownerSchema>;
export type HistoryCommand = Extract<GroupPreparationCommand, { action: 'grant-history-v2' }>;
const commandSchema = groupPreparationCommandSchema.refine((c): c is HistoryCommand => c.action === 'grant-history-v2');
const base = z.object({ epoch: uuid, groupId: uuid, sequence: z.number().int().nonnegative().max(1000),
  execution: z.literal('unavailable'), mode: z.literal('provided-context-only') });
const previewSchema = base.extend({ view: z.literal('grant-preview'), command: commandSchema,
  includedHistory: z.array(groupHistoryRefSchema).min(1).max(256), includedResponses: z.array(groupResponseRefSchema).max(256) }).strict();
export type HistoryPreview = z.infer<typeof previewSchema>;
const confirmationSchema = base.extend({ view: z.literal('grant-request'), command: commandSchema,
  receipt: groupPreparationReceiptSchema, grant: groupHistoryGrantSchema }).strict();
const pendingSchema = z.object({ preview: previewSchema, dispatched: z.boolean(),
  confirmation: confirmationSchema.optional(), rejection: groupPreparationRejectionSchema.optional() }).strict();
const journalSchema = z.object({ format: z.literal(1), owner: ownerSchema, pending: pendingSchema.optional() }).strict();
type Journal = z.infer<typeof journalSchema>;
type Get = (path: string) => Promise<unknown>;
type Post = (command: HistoryCommand) => Promise<unknown>;
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const explain = (error: unknown) => error instanceof Error ? error.message : 'Your original history-sharing choice is kept.';

export function validateHistoryPreview(owner: HistoryOwner, command: HistoryCommand, raw: unknown) {
  const preview = previewSchema.parse(raw);
  if (command.epoch !== owner.epoch || command.groupId !== owner.groupId || preview.epoch !== owner.epoch
    || preview.groupId !== owner.groupId || preview.sequence !== command.expectedSequence || !same(preview.command, command)
    || new Set(preview.includedHistory.map(r => r.roundId)).size !== preview.includedHistory.length
    || new Set(preview.includedResponses.map(r => r.attemptId)).size !== preview.includedResponses.length
    || command.history.some(ref => !preview.includedHistory.some(row => same(row, ref)))
    || command.responses.some(ref => !preview.includedResponses.some(row => same(row, ref))))
    throw Error('This review does not match the original member and history selection.');
  return preview;
}
function confirm(owner: HistoryOwner, preview: HistoryPreview, raw: unknown) {
  const result = confirmationSchema.parse(raw), c = preview.command, r = result.receipt, grant = result.grant;
  if (result.epoch !== owner.epoch || result.groupId !== owner.groupId || !same(result.command, c)
    || r.requestId !== c.requestId || r.epoch !== c.epoch || r.groupId !== c.groupId || r.action !== c.action
    || r.sequence !== c.expectedSequence + 1 || result.sequence < r.sequence || r.draftRaw !== null || r.roundId !== null
    || !r.grantId || grant.id !== r.grantId || grant.sequence !== r.sequence || grant.format !== 2
    || grant.requestId !== c.requestId || grant.epoch !== c.epoch || grant.deviceId !== owner.deviceId
    || grant.groupId !== c.groupId || grant.groupRevision !== c.expectedGroupRevision
    || grant.membershipId !== c.membershipId || grant.throughSequence !== c.throughSequence
    || !same(grant.history, preview.includedHistory) || !same(grant.responses, preview.includedResponses))
    throw Error('This saved history choice does not confirm the exact reviewed request.');
  return result;
}
/** One retained original per device/Group. Unknown requests permit GET only. */
export class GroupHistoryJournal {
  readonly key: string;
  value: Journal;
  busy = false;
  invalid = false;
  error = '';
  private raw: string | null = null;
  private attempted?: string;
  private notCalled?: string;
  constructor(private storage: StoragePort, readonly owner: HistoryOwner, private current: () => boolean) {
    ownerSchema.parse(owner);
    this.key = `e3:group-history-sharing:${owner.epoch}:${owner.deviceId}:${owner.groupId}`;
    this.value = { format: 1, owner };
    try {
      this.raw = storage.getItem(this.key);
      if (this.raw === null) return;
      if (this.raw.length > 512000) throw Error('The original history-sharing record is too large to open safely.');
      const saved = journalSchema.parse(JSON.parse(this.raw));
      if (!same(saved.owner, owner)) throw Error('This original history choice belongs to another workspace.');
      const p = saved.pending;
      if (p) {
        validateHistoryPreview(owner, p.preview.command, p.preview);
        if (p.confirmation) {
          if (!p.dispatched || p.rejection) throw Error('The original history-sharing result is inconsistent.');
          confirm(owner, p.preview, p.confirmation);
        }
        if (p.rejection && (!p.dispatched || !same(p.rejection.command, p.preview.command)))
          throw Error('This rejection belongs to another original history choice.');
      }
      this.value = saved;
    } catch (e) { this.invalid = true; this.error = explain(e); }
  }
  retain() {
    if (this.invalid || !this.current()) return false;
    try {
      const actual = this.storage.getItem(this.key);
      if (actual !== this.raw && actual !== this.attempted) throw Error('Another tab changed this original history choice. Reopen its saved record.');
      const raw = JSON.stringify(journalSchema.parse(this.value));
      if (raw.length > 512000) throw Error('This history-sharing choice exceeds the supported retained size.');
      this.attempted = raw; this.storage.setItem(this.key, raw);
      if (this.storage.getItem(this.key) !== raw) throw Error('The original choice is not confirmed on this device. Keep this window open.');
      this.raw = raw; this.attempted = undefined; this.error = ''; return true;
    } catch (e) { this.error = explain(e); return false; }
  }
  get canContinue() {
    const p = this.value.pending;
    return !!p && !p.confirmation && !p.rejection && (!p.dispatched || this.notCalled === p.preview.command.requestId);
  }
  keep(preview: HistoryPreview) {
    if (!this.current() || this.invalid || this.busy || this.value.pending) return false;
    this.value = { ...this.value, pending: { preview: validateHistoryPreview(this.owner, preview.command, preview), dispatched: false } };
    return this.retain();
  }
  async send(post: Post, get: Get) {
    if (!this.current() || this.invalid || this.busy || !this.canContinue || !this.retain()) return;
    const p = this.value.pending!;
    this.notCalled = p.preview.command.requestId;
    this.value = { ...this.value, pending: { ...p, dispatched: true } };
    if (!this.retain()) return;
    this.busy = true;
    try {
      if (!this.current()) return;
      this.notCalled = undefined;
      try { await post(p.preview.command); }
      catch (e) {
        if (this.current() && e instanceof ApiError && (e.status === 409 || e.status === 413)) {
          const proof = groupPreparationRejectionSchema.safeParse(e.current);
          if (proof.success && same(proof.data.command, p.preview.command)) {
            this.value = { ...this.value, pending: { ...this.value.pending!, rejection: proof.data } }; this.retain();
          }
        }
        throw e;
      }
      if (this.current()) await this.readOriginal(get);
    } catch (e) { if (this.current()) this.error = explain(e); }
    finally { this.busy = false; }
  }
  private async readOriginal(get: Get) {
    const p = this.value.pending!;
    const result = confirm(this.owner, p.preview, await get(preparationUrl(this.owner.groupId, {
      view: 'grant-request', requestId: p.preview.command.requestId,
    })));
    if (!this.current()) return;
    this.value = { ...this.value, pending: { ...p, confirmation: result } };
    return this.retain() ? result : undefined;
  }
  async observe(get: Get) {
    if (!this.current() || this.invalid || this.busy || !this.value.pending?.dispatched || this.value.pending.rejection) return;
    this.busy = true;
    try { return await this.readOriginal(get); }
    catch (e) { if (this.current()) this.error = explain(e); }
    finally { this.busy = false; }
  }
  finish(abandonUnsent = false) {
    const p = this.value.pending;
    if (!this.current() || this.invalid || this.busy || !p
      || !p.confirmation && !p.rejection && !(abandonUnsent && !p.dispatched) || !this.retain()) return false;
    try {
      const key = `${this.key}:original:${p.preview.command.requestId}`, raw = JSON.stringify(p), old = this.storage.getItem(key);
      if (old !== null && old !== raw) throw Error('The archived original history choice changed.');
      this.storage.setItem(key, raw);
      if (this.storage.getItem(key) !== raw) throw Error('The original history choice could not be preserved.');
      this.value = { ...this.value, pending: undefined }; return this.retain();
    } catch (e) { this.error = explain(e); return false; }
  }
}
