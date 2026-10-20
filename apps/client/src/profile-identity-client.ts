import { z } from 'zod';
import { canonical, commandSchema, type Command, type Entity } from '../../../packages/domain/contracts';
import { blankRecord, profileSchema, type PersonalProfile } from '../../../packages/domain/workspace-records';
import { readRecordJournal } from './record-draft-recovery';
import { readProfileSlot, writeProfileSlot, type ProfileSlot, type ProfileStorage } from './profile-kept-state';

export type ProfileIdentityJournal = NonNullable<ReturnType<typeof readRecordJournal<'profile'>>>;
const entitySchema = z.object({
  id: z.literal('profile:owner'), revision: z.number().int().positive(), updatedAt: z.iso.datetime(),
  deviceId: z.string().min(1).max(100), value: profileSchema,
}).strict();
export const profileIdentityKey = (deviceId: string, windowId: string) => `e3:journal:${deviceId}:profile:owner:${windowId}`;
const message = (error: unknown) => error instanceof Error ? error.message : 'Your original profile save is unconfirmed. Your writing is kept.';
const knownRefusals = new Set(['revision_conflict', 'validation', 'invalid_target', 'record_quota']);
function validJournal(value: unknown): value is ProfileIdentityJournal {
  return !!readRecordJournal(JSON.stringify(value), 'profile', 'profile:owner');
}
function entity(value: unknown): Entity<PersonalProfile> {
  const parsed = entitySchema.parse(value);
  if (canonical(parsed) !== canonical(value)) throw Error('This saved identity is not in its confirmed form.');
  return parsed;
}
export function confirmedProfileIdentity(command: Command, value: unknown, deviceId: string) {
  const result = entity(value), payload = profileSchema.parse(command.payload);
  if (command.kind !== 'profile' || command.entityId !== 'profile:owner' || result.deviceId !== deviceId || result.revision !== command.expectedRevision + 1 ||
    canonical(result.value) !== canonical(payload)) throw Error('This reply does not confirm the original profile save. Its request remains kept.');
  return result;
}

/** Profile-only authority over the existing legacy record journal and command route. */
export class ProfileIdentityDraft {
  readonly key: string;
  slot: ProfileSlot<ProfileIdentityJournal>; journal: ProfileIdentityJournal;
  saved?: Entity<PersonalProfile>; error = ''; busy = false; active = true;
  private confirmed?: { command: Command; result: Entity<PersonalProfile> };
  readonly initial: PersonalProfile;
  constructor(private storage: ProfileStorage, readonly scope: { epoch: string; deviceId: string; windowId: string },
    saved: Entity<PersonalProfile> | undefined, private post: (command: Command) => Promise<unknown>,
    private notify: () => void = () => {}, private owns: () => boolean = () => true) {
    this.key = profileIdentityKey(scope.deviceId, scope.windowId);
    this.initial = structuredClone(blankRecord('profile', 'UTC') as PersonalProfile);
    this.saved = saved ? entity(saved) : undefined;
    const fallback: ProfileIdentityJournal = { value: saved?.value ?? this.initial, revision: saved?.revision ?? 0, epoch: scope.epoch, dirty: false };
    this.slot = readProfileSlot(storage, this.key, fallback, validJournal); this.journal = this.slot.value;
    if (this.slot.invalid) this.error = 'This kept profile could not be read safely. Its original browser record is unchanged.';
    else if (this.journal.epoch !== scope.epoch) this.error = 'This writing belongs to an earlier workspace. It remains kept and cannot be sent here.';
    else if (this.journal.revision > 0 && !this.saved) this.error = 'The original saved profile is unavailable. Its writing remains kept.';
  }
  private current() { return this.active && this.owns(); }
  private emit() { if (this.current()) this.notify(); }
  get blocked() { return this.slot.invalid || this.journal.epoch !== this.scope.epoch; }
  get pending() { return this.journal.pending; }
  get hasConfirmedResult() { return !!this.confirmed; }
  get changed() { return (this.saved?.revision ?? 0) !== this.journal.revision; }
  get kept() { return this.slot.raw === JSON.stringify(this.journal); }
  get canReview() { return !this.blocked && !this.busy && !this.confirmed &&
    (!this.pending || !!this.journal.conflict && knownRefusals.has(this.journal.conflict.code)); }
  get canCloseSaved() { return this.current() && !this.blocked && !this.busy && !this.pending && !this.journal.dirty && !this.changed && this.kept; }
  retire() { this.active = false; }
  observe(value: Entity<PersonalProfile> | undefined, epoch: string) {
    if (!this.current() || epoch !== this.scope.epoch) return false;
    try {
      const next = value ? entity(value) : undefined;
      if (!next && this.saved) throw Error('The saved profile is unavailable. Your confirmed identity and writing are kept.');
      if ((next?.revision ?? 0) < (this.saved?.revision ?? 0)) return false; // A delayed snapshot cannot displace a command receipt.
      if (next?.revision === this.saved?.revision && canonical(next) !== canonical(this.saved))
        throw Error('The saved identity changed without a new version. Your confirmed identity is kept.');
      this.saved = next; this.emit(); return true;
    } catch (error) { this.error = message(error); this.emit(); return false; }
  }
  private persist(next: ProfileIdentityJournal) {
    if (!this.current() || this.blocked) return false;
    try {
      const normalized = readRecordJournal(JSON.stringify(next), 'profile', 'profile:owner');
      if (!normalized || normalized.epoch !== this.scope.epoch) throw Error('This profile proposal cannot be safely reopened. Keep the original window open.');
      this.slot = writeProfileSlot(this.storage, this.slot, normalized);
      this.journal = normalized; this.error = ''; this.emit(); return true;
    } catch (error) { this.error = message(error); this.emit(); return false; }
  }
  retain() {
    if (!this.current() || this.blocked) return true;
    return this.persist(this.journal);
  }
  change(value: PersonalProfile) {
    if (!this.current() || this.blocked || this.busy || this.pending) return false;
    const next = { ...this.journal, value, dirty: this.changed || canonical(value) !== canonical(this.saved?.value ?? this.initial) };
    if (!validJournal(next)) { this.error = 'This profile writing has an unsupported shape. Its original remains kept.'; this.emit(); return false; }
    this.journal = next; this.emit(); return this.persist(next);
  }
  cancelLook() {
    if (!this.current() || this.blocked || this.busy || this.pending) return false;
    return this.change({ ...this.journal.value, appearance: this.saved?.value.appearance ?? this.initial.appearance });
  }
  review(value: Entity<PersonalProfile> | undefined, epoch: string, keepWriting: boolean) {
    if (!this.current() || !this.canReview || epoch !== this.scope.epoch) return false;
    try {
      const next = value ? entity(value) : undefined, nextRevision = next?.revision ?? 0, savedRevision = this.saved?.revision ?? 0;
      if (!next && (this.saved || this.journal.revision > 0)) throw Error('The original saved identity is unavailable. It cannot be recreated automatically.');
      if (nextRevision < savedRevision || nextRevision === savedRevision && canonical(next) !== canonical(this.saved))
        throw Error('A newer saved identity is already confirmed. Review that version before choosing what to keep.');
      const writing = keepWriting ? this.journal.value : next?.value ?? this.initial;
      const proposal: ProfileIdentityJournal = { value: writing, revision: nextRevision, epoch: this.scope.epoch,
        dirty: canonical(writing) !== canonical(next?.value ?? this.initial) };
      if (!this.persist(proposal)) return false;
      this.saved = next; this.emit(); return true;
    } catch (error) { this.error = message(error); this.emit(); return false; }
  }
  private settle() {
    if (!this.current() || !this.confirmed || canonical(this.pending) !== canonical(this.confirmed.command)) return;
    const { result } = this.confirmed;
    const next: ProfileIdentityJournal = { ...this.journal, revision: result.revision, pending: undefined, conflict: undefined,
      dirty: canonical(this.journal.value) !== canonical(result.value) };
    if (!this.persist(next)) return;
    if (result.revision >= (this.saved?.revision ?? 0)) this.saved = result;
    this.confirmed = undefined; this.emit(); return result;
  }
  private async flush(payload?: PersonalProfile, originalRequestId?: string) {
    if (!this.current() || this.blocked || this.busy) return;
    if (originalRequestId && this.pending?.requestId !== originalRequestId) return;
    if (this.confirmed) return this.settle();
    if (this.journal.conflict) return;
    if (!this.pending) {
      if (!payload || !this.journal.dirty) return;
      if (this.changed) { this.error = 'The saved profile changed. Review it before saving your kept writing.'; this.emit(); return; }
      const command = commandSchema.parse({ kind: 'profile', entityId: 'profile:owner', requestId: crypto.randomUUID(),
        epoch: this.scope.epoch, expectedRevision: this.journal.revision, payload });
      this.journal = { ...this.journal, pending: command, dirty: true };
    }
    if (!this.persist(this.journal)) return;
    const command = this.pending!; this.busy = true; this.emit();
    try {
      const result = await this.post(command);
      if (!this.current() || canonical(this.pending) !== canonical(command)) return;
      this.confirmed = { command, result: confirmedProfileIdentity(command, result, this.scope.deviceId) };
      return this.settle();
    } catch (error) {
      if (!this.current()) return;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      // Auth, epoch and held/update failures may precede original receipt lookup.
      if (!this.confirmed && typeof code === 'string' && knownRefusals.has(code)) {
        const rawCurrent = error && typeof error === 'object' && 'current' in error ? error.current : undefined;
        let current: Entity<PersonalProfile> | undefined;
        try { if (rawCurrent) current = entity(rawCurrent); } catch { /* Only a fresh exact review can replace an invalid conflict value. */ }
        this.journal = { ...this.journal, conflict: { code, message: message(error), ...(current ? { current } : {}) } };
        this.persist(this.journal);
      }
      this.error = message(error); this.emit(); return;
    } finally { this.busy = false; this.emit(); }
  }
  checkOriginal(requestId: string) { return this.flush(undefined, requestId); }
  async saveProfile() {
    if (!this.current() || this.blocked || this.busy || this.pending || this.journal.conflict || !this.journal.dirty) return;
    const parsed = profileSchema.safeParse(this.journal.value);
    if (!parsed.success) { this.error = parsed.error.issues.map(issue => `${issue.path.join('.') || 'Profile'}: ${issue.message}`).join(' '); this.emit(); return; }
    if (!this.change(parsed.data)) return;
    return this.flush(parsed.data);
  }
  async saveLook(appearance: PersonalProfile['appearance']) {
    if (!this.current() || this.blocked || this.busy || this.pending || this.journal.conflict) return;
    if (this.changed) { this.error = 'The saved profile changed. Review it before saving this look.'; this.emit(); return; }
    if (this.saved && canonical(appearance) === canonical(this.saved.value.appearance)) return;
    if (!this.saved) {
      this.change({ ...this.journal.value, appearance }); return;
    }
    const parsed = profileSchema.safeParse({ ...this.saved.value, appearance });
    if (!parsed.success) { this.error = 'This look could not be validated. Your existing writing is kept.'; this.emit(); return; }
    if (!this.change({ ...this.journal.value, appearance })) return;
    return this.flush(parsed.data);
  }
}
