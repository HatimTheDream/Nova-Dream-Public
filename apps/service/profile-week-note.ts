import { createHash } from 'node:crypto';
import { canonical } from '../../packages/domain/contracts.js';
import { profileWeekIdentitySchema, sameProfileWeek, type ProfileWeekIdentity } from '../../packages/domain/profile-week.js';
import {
  weekNoteSchema, weekNoteCommandSchema, weekNoteIdentityKey, weekNotesQuerySchema,
  type WeekNote, type WeekNoteState, type WeekNoteReceipt, type WeekNotesPage,
} from '../../packages/domain/profile-week-note.js';
import { Fault, Store } from './store.js';

export const weekNotePrefix = 'profile:week-note:';
export const weekNoteKey = (identity: ProfileWeekIdentity) => weekNotePrefix + weekNoteIdentityKey(identity);

/** Workspace-only metadata. Do not add these notes to entity/source/tool projections. */
export class ProfileWeekNotes {
  constructor(private store: Store, private now: () => Date = () => new Date()) {}
  private read(identity: ProfileWeekIdentity): WeekNote | null {
    const raw = this.store.internalRead<unknown>(weekNoteKey(identity));
    if (raw === undefined) return null;
    const parsed = weekNoteSchema.safeParse(raw);
    if (!parsed.success || !sameProfileWeek(parsed.data.identity, identity))
      throw new Fault(409, 'week_note_unreadable', 'This saved note cannot be verified. Its original writing is kept unchanged.');
    return parsed.data;
  }
  state(raw: unknown): WeekNoteState {
    const identity = profileWeekIdentitySchema.parse(raw);
    return this.store.internalAtomic(() => ({ epoch: this.store.epoch, identity, note: this.read(identity) }));
  }
  index(raw: unknown): WeekNotesPage {
    const input = weekNotesQuerySchema.parse(raw);
    return this.store.internalAtomic(() => {
      const keys = new Set<string>();
      const rows = this.store.internalList<unknown>(weekNotePrefix).map(raw => {
        const parsed = weekNoteSchema.safeParse(raw);
        if (!parsed.success) throw new Fault(409, 'week_note_index_unreadable', 'A saved note needs review. Your current list and original notes are kept.');
        const note = parsed.data, key = weekNoteIdentityKey(note.identity);
        if (keys.has(key) || canonical(this.read(note.identity)) !== canonical(note))
          throw new Fault(409, 'week_note_index_identity', 'The saved note list cannot be verified. Original notes are kept.');
        keys.add(key);
        const { format: _format, text: _text, ...summary } = note;
        return summary;
      }).sort((a, b) => b.identity.start.localeCompare(a.identity.start) || a.identity.timezone.localeCompare(b.identity.timezone));
      const version = createHash('sha256').update(canonical(rows)).digest('hex');
      const cursor = input.before ? rows.findIndex(note => weekNoteIdentityKey(note.identity) === input.before) : -1;
      if (input.before && (input.version !== version || cursor < 0))
        throw new Fault(409, 'week_note_list_changed', 'The saved notes changed. Refresh the list; your loaded entries and writing are kept.');
      const start = cursor + 1, page = rows.slice(start, start + 50);
      return { epoch: this.store.epoch, version, rows: page, total: rows.length,
        next: start + page.length < rows.length ? weekNoteIdentityKey(page.at(-1)!.identity) : null };
    });
  }
  save(device: string, raw: unknown): WeekNoteReceipt {
    const input = weekNoteCommandSchema.parse(raw);
    this.store.assertUpdateAdmission();
    if (this.store.recoveryHeld) throw new Fault(409, 'recovery_held', 'Finish reviewing the recovered workspace before changing your note.');
    return this.store.admit(device, input, { type: 'profile-week-note', ...input }, () => {
      const old = this.read(input.identity);
      if ((old?.revision ?? 0) !== input.expectedRevision)
        throw new Fault(409, 'week_note_changed', 'This note changed in another window or device. Review the saved version before keeping your edits.');
      if (input.action === 'save' && old?.trashed)
        throw new Fault(409, 'week_note_trashed', 'Restore this note before saving your kept writing.');
      if (input.action !== 'save' && (!old || old.trashed === (input.action === 'trash')))
        throw new Fault(409, 'week_note_state_changed', 'The note state changed. Review its current version before this action.');
      const note: WeekNote = { format: 1, identity: input.identity, revision: input.expectedRevision + 1,
        text: input.action === 'save' ? input.text : old!.text, trashed: input.action === 'trash', updatedAt: this.now().toISOString() };
      weekNoteSchema.parse(note);
      this.store.internalWrite(weekNoteKey(input.identity), note);
      return { requestId: input.requestId, epoch: input.epoch, action: input.action, note };
    }).value;
  }
}
