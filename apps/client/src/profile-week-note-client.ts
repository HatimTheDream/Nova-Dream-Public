import { z } from 'zod';
import { canonical } from '../../../packages/domain/contracts';
import { profileWeekIdentitySchema, sameProfileWeek, type ProfileWeekIdentity } from '../../../packages/domain/profile-week';
import { weekNoteCommandSchema, weekNoteReceiptSchema, weekNoteSchema, weekNoteStateSchema, type WeekNote, type WeekNoteCommand, type WeekNoteReceipt, type WeekNoteState } from '../../../packages/domain/profile-week-note';

export type WeekNoteStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type WeekNoteJournal = {
  format: 1; epoch: string; identity: ProfileWeekIdentity; base: WeekNote | null;
  text: string; dirty: boolean; pending?: WeekNoteCommand; rejection?: { code: string; message: string };
};
const journalSchema = z.object({
  format: z.literal(1), epoch: z.uuid(), identity: profileWeekIdentitySchema, base: weekNoteSchema.nullable(),
  text: z.string().max(20000), dirty: z.boolean(), pending: weekNoteCommandSchema.optional(),
  rejection: z.object({ code: z.enum(['week_note_changed', 'week_note_trashed', 'week_note_state_changed']), message: z.string().max(10000) }).strict().optional(),
}).strict();
export const weekNoteDraftKey = (deviceId: string, windowId: string, identity: ProfileWeekIdentity) =>
  `e3:week-note:${encodeURIComponent(deviceId)}:${encodeURIComponent(windowId)}:${identity.start}:${encodeURIComponent(identity.timezone)}`;
export function parseWeekNoteDraftKey(key: string) {
  const parts = key.split(':');
  if (parts.length !== 6 || parts[0] !== 'e3' || parts[1] !== 'week-note') return;
  try {
    const deviceId = decodeURIComponent(parts[2]), windowId = decodeURIComponent(parts[3]);
    const identity = profileWeekIdentitySchema.parse({ start: parts[4], timezone: decodeURIComponent(parts[5]) });
    if (!deviceId || !windowId || deviceId.length > 100 || windowId.length > 100 || weekNoteDraftKey(deviceId, windowId, identity) !== key) return;
    return { deviceId, windowId, identity };
  } catch { return; }
}
export function readWeekNoteJournal(raw: string): WeekNoteJournal | undefined {
  if (raw.length > 256000) return;
  try {
    const result = journalSchema.safeParse(JSON.parse(raw));
    if (!result.success) return;
    const value = result.data;
    if (value.base && !sameProfileWeek(value.identity, value.base.identity)) return;
    if (!value.dirty && value.text !== (value.base?.text ?? '')) return;
    const command = value.pending;
    if (command && (!value.dirty || command.epoch !== value.epoch || !sameProfileWeek(command.identity, value.identity) ||
      command.expectedRevision !== (value.base?.revision ?? 0) ||
      (command.action === 'save' ? command.text !== value.text || value.base?.trashed : !value.base ||
        (command.action === 'trash' ? value.base.trashed || value.text !== value.base.text : !value.base.trashed)))) return;
    if (value.rejection && !command) return;
    return value;
  } catch { return; }
}
export function confirmedWeekNote(command: WeekNoteCommand, base: WeekNote | null, value: unknown): WeekNoteReceipt {
  const result = weekNoteReceiptSchema.parse(value);
  if (result.requestId !== command.requestId || result.epoch !== command.epoch || result.action !== command.action ||
    !sameProfileWeek(result.note.identity, command.identity) || result.note.revision !== command.expectedRevision + 1 ||
    result.note.trashed !== (command.action === 'trash') ||
    result.note.text !== (command.action === 'save' ? command.text : base?.text)) {
    throw Error('This reply does not confirm the original note request. Your writing and that request are kept.');
  }
  return result;
}
const message = (problem: unknown) => problem instanceof Error ? problem.message : 'The original note request is unconfirmed. Your writing is kept.';
const refusalCodes = new Set(['week_note_changed', 'week_note_trashed', 'week_note_state_changed']);

/** Owns one device/window/week journal; it does not create another save after uncertainty. */
export class WeekNoteDraft {
  journal: WeekNoteJournal; raw: string | null = null; original?: string;
  invalid = false; error = ''; busy = false; active = true; currentState: WeekNoteState;
  private confirmed?: { command: WeekNoteCommand; receipt: WeekNoteReceipt };
  constructor(private storage: WeekNoteStorage, readonly key: string, readonly scope: {
    epoch: string; deviceId: string; windowId: string; identity: ProfileWeekIdentity;
  }, state: WeekNoteState, private post: (command: WeekNoteCommand) => Promise<unknown>,
  private notify: () => void = () => {}, private owns: () => boolean = () => true) {
    this.currentState = this.validateState(state);
    this.journal = { format: 1, epoch: scope.epoch, identity: scope.identity, base: state.note,
      text: state.note?.text ?? '', dirty: false };
    try {
      if (key !== weekNoteDraftKey(scope.deviceId, scope.windowId, scope.identity)) throw Error('The original note window could not be verified.');
      this.raw = storage.getItem(key);
      if (this.raw === null) return;
      this.original = this.raw;
      const saved = readWeekNoteJournal(this.raw);
      if (!saved || !sameProfileWeek(saved.identity, scope.identity)) throw Error('This kept note could not be verified. Its original bytes remain unchanged.');
      this.journal = saved;
      if (saved.epoch !== scope.epoch) this.error = 'This writing belongs to an earlier workspace. Its original is kept and cannot be sent here.';
    } catch (problem) { this.invalid = true; this.error = message(problem); }
  }
  private current() { return this.active && this.owns(); }
  private emit() { if (this.current()) this.notify(); }
  private validateState(value: unknown) {
    const state = weekNoteStateSchema.parse(value);
    if (state.epoch !== this.scope.epoch || !sameProfileWeek(state.identity, this.scope.identity)) throw Error('This saved version belongs to another workspace or week.');
    return state;
  }
  observe(value: unknown) {
    if (!this.current()) return false;
    try {
      const next = this.validateState(value);
      if ((next.note?.revision ?? 0) < (this.currentState.note?.revision ?? 0)) throw Error('This saved note response is older than the confirmed version. Your writing is kept.');
      if ((next.note?.revision ?? 0) === (this.currentState.note?.revision ?? 0) &&
        canonical(next.note) !== canonical(this.currentState.note)) throw Error('This saved version changed without a new revision. Your confirmed note is kept.');
      this.currentState = next; this.emit(); return true;
    }
    catch (problem) { this.error = message(problem); this.emit(); return false; }
  }
  get blocked() { return this.invalid || this.journal.epoch !== this.scope.epoch; }
  get kept() { return this.raw === JSON.stringify(this.journal); }
  get hasConfirmedResult() { return !!this.confirmed; }
  get changed() { return canonical(this.currentState.note) !== canonical(this.journal.base); }
  private persist(next: WeekNoteJournal) {
    if (!this.current() || this.invalid) return false;
    try {
      const desired = JSON.stringify(next), normalized = readWeekNoteJournal(desired);
      if (!normalized) throw Error('This writing cannot be safely reopened. Keep this window open with its original text.');
      const actual = this.storage.getItem(this.key);
      if (actual !== this.raw && actual !== desired) throw Error('This note draft changed in another window. Your current writing remains open here.');
      if (actual !== desired) this.storage.setItem(this.key, desired);
      if (this.storage.getItem(this.key) !== desired) throw Error('Browser storage did not confirm your writing. Keep this window open.');
      this.raw = desired; this.journal = normalized; this.error = ''; this.emit(); return true;
    } catch (problem) { this.error = message(problem); this.emit(); return false; }
  }
  retain() { return !this.current() || this.blocked || this.persist(this.journal); }
  retire() { this.active = false; }
  change(text: string) {
    if (!this.current() || this.blocked || this.busy || this.journal.pending || this.journal.base?.trashed) return false;
    this.journal = { ...this.journal, text, dirty: text !== (this.journal.base?.text ?? '') };
    this.emit(); return this.persist(this.journal);
  }
  acceptReviewed(value: unknown, keepWriting = true) {
    if (!this.current() || this.blocked || this.busy || this.confirmed || this.journal.pending && !this.journal.rejection) return false;
    try {
      const state = this.validateState(value);
      const reviewedRevision = state.note?.revision ?? 0, confirmedRevision = this.currentState.note?.revision ?? 0;
      if (reviewedRevision < confirmedRevision || reviewedRevision === confirmedRevision && canonical(state.note) !== canonical(this.currentState.note))
        throw Error('A newer or different saved note has already been confirmed. Review it again; your current writing is kept.');
      if (!state.note && this.journal.base) throw Error('The original saved note is unavailable. It cannot be recreated automatically.');
      const text = keepWriting ? this.journal.text : state.note?.text ?? '';
      const next = { ...this.journal, base: state.note, text, dirty: text !== (state.note?.text ?? ''),
        pending: undefined, rejection: undefined };
      if (!this.persist(next)) return false;
      this.currentState = state; this.emit(); return true;
    } catch (problem) { this.error = message(problem); this.emit(); return false; }
  }
  private settle() {
    if (!this.confirmed || !this.current() || canonical(this.journal.pending) !== canonical(this.confirmed.command)) return;
    const { command, receipt } = this.confirmed;
    const text = command.action === 'restore' ? this.journal.text : receipt.note.text;
    if (!this.persist({ ...this.journal, base: receipt.note, text, dirty: text !== receipt.note.text,
      pending: undefined, rejection: undefined })) return;
    if ((this.currentState.note?.revision ?? 0) <= receipt.note.revision)
      this.currentState = { epoch: receipt.epoch, identity: receipt.note.identity, note: receipt.note };
    this.confirmed = undefined; this.emit(); return receipt;
  }
  async send(action: WeekNoteCommand['action']): Promise<WeekNoteReceipt | undefined> {
    if (!this.current() || this.blocked || this.busy) return;
    if (this.confirmed) return this.settle();
    if (this.journal.rejection) return;
    if (!this.journal.pending) {
      if (this.changed) { this.error = 'Review the current saved note before changing it. Your writing is kept.'; this.emit(); return; }
      if (action === 'save' && (!this.journal.dirty || this.journal.base?.trashed) ||
        action === 'trash' && (!this.journal.base || this.journal.base.trashed || this.journal.dirty) ||
        action === 'restore' && !this.journal.base?.trashed) return;
      const parsed = weekNoteCommandSchema.safeParse({ requestId: crypto.randomUUID(), epoch: this.scope.epoch,
        identity: this.scope.identity, expectedRevision: this.journal.base?.revision ?? 0, action,
        ...(action === 'save' ? { text: this.journal.text } : {}) });
      if (!parsed.success) { this.error = parsed.error.issues.map(issue => issue.message).join(' '); this.emit(); return; }
      this.journal = { ...this.journal, dirty: true, pending: parsed.data };
    }
    if (!this.persist(this.journal)) return;
    const command = this.journal.pending!, base = this.journal.base;
    this.busy = true; this.emit();
    try {
      const response = await this.post(command);
      if (!this.current()) return;
      this.confirmed = { command, receipt: confirmedWeekNote(command, base, response) };
      return this.settle();
    } catch (problem) {
      if (!this.current()) return;
      const code = problem && typeof problem === 'object' && 'code' in problem ? problem.code : undefined;
      // Admission/auth/recovery errors can precede a replay lookup; they do not prove an original never saved.
      if (!this.confirmed && typeof code === 'string' && refusalCodes.has(code)) {
        this.journal = { ...this.journal, rejection: { code, message: message(problem) } };
        this.persist(this.journal);
      }
      this.error = message(problem); this.emit();
    } finally { this.busy = false; this.emit(); }
  }
}
