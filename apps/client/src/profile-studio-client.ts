import { z } from 'zod';
import { canonical } from '../../../packages/domain/contracts';
import { studioCommandSchema, studioReceiptSchema, studioStateSchema, type StudioReceipt, type StudioState } from '../../../packages/domain/profile-studio';
import { readProfileSlot, writeProfileSlot, type ProfileSlot, type ProfileStorage } from './profile-kept-state';

const journalSchema = z.object({ format: z.literal(1), epoch: z.uuid(), device: z.string().min(1), window: z.string().min(1), baseRevision: z.number().int().min(0),
  questIds: z.array(z.uuid()).max(2).refine(ids => new Set(ids).size === ids.length), dirty: z.boolean(), pending: studioCommandSchema.optional()
}).strict().superRefine((value, ctx) => {
  if (value.pending && (value.pending.epoch !== value.epoch || value.pending.expectedRevision !== value.baseRevision || canonical(value.pending.questIds) !== canonical(value.questIds))) ctx.addIssue({ code: 'custom', message: 'The kept command does not match its original choices.' });
});
export type StudioJournal = z.infer<typeof journalSchema>;
export type StudioScope = { epoch: string; device: string; window: string };
export const studioJournalKey = (scope: StudioScope) => `e3:profile-studio:${scope.epoch}:${scope.device}:${scope.window}`;
const message = (error: unknown) => error instanceof Error ? error.message : 'The Studio save is unconfirmed. Keep this window open.';

/** One original save per journal. Late responses never take ownership of a new window. */
export class StudioEditor {
  journal: StudioJournal;
  slot: ProfileSlot<StudioJournal>;
  error = '';
  conflict = false;
  busy = false;
  active = true;
  private confirmed?: StudioReceipt;
  constructor(private storage: ProfileStorage, readonly scope: StudioScope, state: StudioState, private post: (input: unknown) => Promise<unknown>, private notify: () => void = () => {}) {
    const original = studioStateSchema.parse(state);
    if (original.epoch !== scope.epoch) throw Error('Studio belongs to another workspace.');
    const fallback: StudioJournal = { format: 1, ...scope, baseRevision: state.curation.revision, questIds: [...state.availableQuestIds], dirty: canonical(state.availableQuestIds) !== canonical(state.curation.questIds) };
    this.slot = readProfileSlot(storage, studioJournalKey(scope), fallback, (value): value is StudioJournal => {
      const parsed = journalSchema.safeParse(value); return parsed.success && parsed.data.epoch === scope.epoch && parsed.data.device === scope.device && parsed.data.window === scope.window;
    });
    this.journal = !this.slot.invalid && !this.slot.value.dirty && !this.slot.value.pending ? fallback : this.slot.value;
    if (this.slot.invalid) this.error = 'Your kept Studio choices cannot be verified. The original browser record is preserved.';
  }
  private emit() { if (this.active) this.notify(); }
  private persist(next: StudioJournal): boolean {
    if (!this.active) return false;
    try { this.slot = writeProfileSlot(this.storage, this.slot, next); this.journal = next; this.error = ''; this.emit(); return true; }
    catch (error) { this.error = message(error); this.emit(); return false; }
  }
  retain(): boolean { return !this.active || this.slot.invalid || this.persist(this.journal); }
  retire() { this.active = false; }
  choose(ids: string[]) {
    if (!this.active || this.busy || this.journal.pending || this.slot.invalid) return false;
    const next = { ...this.journal, questIds: ids, dirty: true };
    if (!journalSchema.safeParse(next).success) return false;
    this.journal = next; // A storage refusal must not erase the user's latest input.
    return this.persist(next);
  }
  review(state: StudioState) {
    if (!this.active || this.busy || this.journal.pending || this.slot.invalid) return false;
    const current = studioStateSchema.parse(state);
    if (current.epoch !== this.scope.epoch) return false;
    if (!this.persist({ ...this.journal, baseRevision: current.curation.revision, dirty: true })) return false;
    this.conflict = false; this.emit(); return true;
  }
  async save(state: StudioState): Promise<StudioReceipt | undefined> {
    if (!this.active || this.busy || this.slot.invalid || !this.journal.dirty && !this.journal.pending) return;
    const current = studioStateSchema.parse(state), journal = this.journal;
    if (current.epoch !== this.scope.epoch) { this.error = 'The workspace changed. Your original choices are kept.'; this.emit(); return; }
    if (!journal.pending && (this.conflict || current.curation.revision !== journal.baseRevision)) { this.conflict = true; this.error = 'Review the current Studio selection before saving your kept choices.'; this.emit(); return; }
    const pending = journal.pending ?? { requestId: crypto.randomUUID(), epoch: journal.epoch, expectedRevision: journal.baseRevision, questIds: [...journal.questIds] };
    if (!this.persist({ ...journal, pending })) return;
    this.busy = true; this.emit();
    try {
      const response = this.confirmed ?? studioReceiptSchema.parse(await this.post(pending));
      if (!this.active) return;
      if (response.requestId !== pending.requestId || response.epoch !== pending.epoch || response.curation.revision !== pending.expectedRevision + 1 || canonical(response.curation.questIds) !== canonical(pending.questIds)) throw Error('The response does not confirm this original Studio save. Check the same request.');
      this.confirmed = response;
      // If local acknowledgement fails, the original pending command remains.
      // Same-window retries only retain this confirmed response; reload reuses its ID.
      if (!this.persist({ ...journal, pending: undefined, baseRevision: response.curation.revision, questIds: [...response.curation.questIds], dirty: false })) return;
      this.confirmed = undefined; this.conflict = false; return response;
    } catch (error) {
      if (!this.active) return;
      this.error = message(error);
      const status = typeof error === 'object' && error !== null && 'status' in error ? (error as { status?: unknown }).status : undefined;
      if (!this.confirmed && typeof status === 'number' && status >= 400 && status < 500) {
        const originalError = this.error;
        if (this.persist({ ...this.journal, pending: undefined })) { this.error = originalError; this.conflict = status === 409; }
      }
    } finally { this.busy = false; this.emit(); }
  }
}
