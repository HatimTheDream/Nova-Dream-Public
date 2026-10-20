import { z } from 'zod';
import { canonical } from '../../../packages/domain/contracts';
import { activitySaveSchema, activitySchema, organizationSaveSchema, organizationSchema, type ContactActivity, type Organization, type OrganizationRecord } from '../../../packages/domain/crm';

export type CrmKind = 'activity' | 'organization';
export type CrmValues = { activity: ContactActivity['value']; organization: Organization };
export type CrmRecord<K extends CrmKind> = K extends 'activity' ? ContactActivity : OrganizationRecord;
export type CrmCommand<K extends CrmKind> = { requestId: string; epoch: string; id: string; expectedRevision: number; value: CrmValues[K]; contactId?: string };
export type CrmJournal<K extends CrmKind = CrmKind> = { format: 1; kind: K; id: string; epoch: string; contactId?: string; revision: number; value: CrmValues[K]; dirty: boolean; pending?: CrmCommand<K>; rejection?: { status: number; message: string }; legacyOriginal?: string };
export type CrmScope = { kind: CrmKind; id: string; deviceId: string; epoch: string; contactId?: string };
export type CrmStorage = Pick<Storage, 'getItem' | 'setItem'>;
const id = z.string().regex(/^[a-zA-Z0-9:_-]{1,100}$/);
const organizationWriting = z.object({ name: z.string(), website: z.string(), phone: z.string(), industry: z.string(), notes: z.string() }).strict();
const activityWriting = z.object({ kind: z.enum(['note', 'call', 'meeting', 'message']), at: z.string(), text: z.string(), archived: z.boolean() }).strict();
const legacyShape = z.object({ value: z.unknown(), revision: z.number().int().nonnegative(), pending: z.unknown().optional() }).strict();
const journalShape = z.object({ format: z.literal(1), kind: z.enum(['activity', 'organization']), id, epoch: z.uuid(), contactId: id.optional(),
  revision: z.number().int().nonnegative(), value: z.unknown(), dirty: z.boolean(), pending: z.unknown().optional(),
  rejection: z.object({ status: z.union([z.literal(400), z.literal(404), z.literal(409), z.literal(507)]), message: z.string().max(10000) }).strict().optional(), legacyOriginal: z.string().max(256000).optional() }).strict();
const writing = (kind: CrmKind, value: unknown) => (kind === 'activity' ? activityWriting : organizationWriting).safeParse(value).success;
const commandSchema = (kind: CrmKind) => kind === 'activity' ? activitySaveSchema : organizationSaveSchema;
const note = (reason: unknown) => reason instanceof Error ? reason.message : 'The original save is unconfirmed. Keep your writing and check the same request.';
export function readCrmJournal(raw: string, kind: CrmKind): CrmJournal | undefined {
  if (raw.length > 512000) return;
  let value: unknown; try { value = JSON.parse(raw); } catch { return; }
  const parsed = journalShape.safeParse(value);
  if (!parsed.success) return;
  const v = parsed.data;
  if (v.kind !== kind || !v.id.startsWith(kind + ':') || !writing(kind, v.value) || (kind === 'activity' ? !v.contactId?.startsWith('contact:') : v.contactId !== undefined)) return;
  if (v.pending !== undefined) {
    const pending = commandSchema(kind).safeParse(v.pending);
    if (!pending.success || pending.data.id !== v.id || pending.data.epoch !== v.epoch || pending.data.expectedRevision !== v.revision || !v.dirty ||
      ('contactId' in pending.data ? pending.data.contactId : undefined) !== v.contactId) return;
  } else if (v.rejection) return;
  return value as CrmJournal;
}
export function readCrmLegacy(raw: string, kind: CrmKind) {
  if (raw.length > 256000) return;
  try { const value = legacyShape.parse(JSON.parse(raw)); return writing(kind, value.value) ? value as { value: CrmValues[CrmKind]; revision: number; pending?: CrmCommand<CrmKind> } : undefined; } catch { return; }
}
export function crmDraftId(storage: Pick<Storage, 'getItem'>, key: string, kind: CrmKind, savedId?: string) {
  if (savedId) return savedId;
  try { const raw = storage.getItem(key); if (raw) {
    const kept = readCrmJournal(raw, kind); if (kept?.dirty || kept?.pending) return kept.id;
    const legacy = readCrmLegacy(raw, kind), parsed = commandSchema(kind).safeParse(legacy?.pending);
    if (parsed.success && parsed.data.id.startsWith(kind + ':')) return parsed.data.id;
  } } catch { /* The owner preserves/refuses unreadable storage. */ }
  return kind + ':' + crypto.randomUUID();
}
export function confirmedCrm<K extends CrmKind>(kind: K, original: CrmCommand<K>, response: unknown): CrmRecord<K> {
  const command = commandSchema(kind).parse(original);
  const common = { id, revision: z.number().int().positive(), deviceId: z.string().min(1), updatedAt: z.iso.datetime() };
  const schema = kind === 'activity' ? z.object({ ...common, contactId: id, value: activitySchema }).strict() : z.object({ ...common, memberIds: z.array(id), value: organizationSchema }).strict();
  const result = schema.parse(response);
  if (result.id !== command.id || result.revision !== command.expectedRevision + 1 || canonical(result.value) !== canonical(command.value) ||
    ('contactId' in result ? result.contactId : undefined) !== ('contactId' in command ? command.contactId : undefined)) throw Error('This response does not confirm the original CRM save. Check that same request.');
  return result as CrmRecord<K>;
}

/** One existing local journal owns writing and the original request. */
export class CrmDraft<K extends CrmKind> {
  journal: CrmJournal<K>; raw: string | null = null; invalid = false; legacy = false; original?: string;
  error = ''; busy = false; active = true;
  private result?: { command: CrmCommand<K>; record: CrmRecord<K> };
  constructor(private storage: CrmStorage, readonly key: string, readonly scope: CrmScope & { kind: K }, private fallback: CrmJournal<K>,
    private post: (command: CrmCommand<K>) => Promise<unknown>, private notify: () => void = () => {}, private owns: () => boolean = () => true) {
    this.journal = fallback;
    try {
      this.raw = storage.getItem(key);
      if (this.raw === null || this.raw === 'null') return;
      this.original = this.raw;
      const kept = readCrmJournal(this.raw, scope.kind);
      if (kept && kept.id === scope.id && kept.contactId === scope.contactId) {
        this.journal = kept as CrmJournal<K>;
        if (kept.epoch !== scope.epoch) this.error = 'This writing belongs to an earlier workspace. It is shown here with its original save preserved; it cannot be sent from this workspace.';
        return;
      }
      if (kept && !kept.dirty && !kept.pending && fallback.revision === 0 && kept.epoch === scope.epoch && kept.contactId === scope.contactId) { this.journal = { ...fallback, legacyOriginal: kept.legacyOriginal }; return; }
      const old = readCrmLegacy(this.raw, scope.kind);
      if (old) {
        this.legacy = true;
        this.journal = { ...fallback, value: old.value as CrmValues[K], revision: old.revision, dirty: true };
        if (old.pending) {
          const parsed = commandSchema(scope.kind).safeParse(old.pending);
          if (!parsed.success || parsed.data.id !== scope.id || ('contactId' in parsed.data ? parsed.data.contactId : undefined) !== scope.contactId || parsed.data.expectedRevision !== old.revision) throw Error('The earlier pending save cannot be verified.');
          this.journal = { ...this.journal, epoch: parsed.data.epoch, pending: old.pending as CrmCommand<K> };
        }
        this.error = old.pending ? 'Earlier writing and its exact pending save are kept. Review before checking that save.' : 'This earlier writing has no workspace identity. Review it before using it in this workspace.';
        return;
      }
      throw Error('The original CRM writing cannot be verified. Its bytes are kept unchanged.');
    } catch (reason) { this.invalid = true; this.error = note(reason); }
  }
  private current() { return this.active && this.owns(); }
  private emit() { if (this.current()) this.notify(); }
  get kept() { return this.raw === JSON.stringify(this.journal); }
  get blocked() { return this.invalid || this.legacy || this.journal.epoch !== this.scope.epoch; }
  private persist(next: CrmJournal<K>) {
    if (!this.current() || this.invalid) return false;
    try {
      const raw = JSON.stringify(next);
      if (!readCrmJournal(raw, this.scope.kind)) throw Error('This writing is too large or cannot be safely reopened. Its original is kept; keep this window open.');
      const actual = this.storage.getItem(this.key);
      if (actual !== this.raw && actual !== raw) throw Error('This CRM writing changed in another window. Your edits remain open here.');
      if (actual !== raw) this.storage.setItem(this.key, raw);
      if (this.storage.getItem(this.key) !== raw) throw Error('Browser storage did not confirm this writing. Keep this window open.');
      this.raw = raw; this.journal = next; this.error = ''; this.emit(); return true;
    } catch (reason) { this.error = note(reason); this.emit(); return false; }
  }
  retire() { this.active = false; }
  retain() { return !this.current() || this.invalid || this.legacy || this.journal.epoch !== this.scope.epoch || this.persist(this.journal); }
  change(value: CrmValues[K]) {
    if (!this.current() || this.blocked || this.busy || this.journal.pending) return false;
    this.journal = { ...this.journal, value, dirty: true }; this.emit(); return this.persist(this.journal);
  }
  adoptLegacy(current?: CrmRecord<K>) {
    if (!this.current() || !this.legacy || this.invalid || this.busy || !this.original) return false;
    const pending = this.journal.pending;
    if (pending && pending.epoch !== this.scope.epoch) { this.error = 'The pending save belongs to an earlier workspace. Its original is preserved.'; this.emit(); return false; }
    if (!this.matchesCurrent(current) || !pending && !current && this.fallback.revision > 0) return false;
    const next = { ...this.journal, epoch: pending?.epoch ?? this.scope.epoch, revision: pending?.expectedRevision ?? current?.revision ?? 0, legacyOriginal: this.original };
    if (!this.persist(next)) return false;
    this.legacy = false; this.emit(); return true;
  }
  private matchesCurrent(current?: CrmRecord<K>) {
    return !current || current.id === this.scope.id && ('contactId' in current ? current.contactId : undefined) === this.scope.contactId;
  }
  changed(current?: CrmRecord<K>) { return !this.matchesCurrent(current) || this.journal.epoch !== this.scope.epoch || this.journal.revision !== (current?.revision ?? 0); }
  review(current?: CrmRecord<K>) {
    if (!this.current() || this.blocked || this.busy || this.journal.pending && !this.journal.rejection || !current && this.journal.revision > 0 || !this.matchesCurrent(current)) return false;
    return this.persist({ ...this.journal, revision: current?.revision ?? 0, dirty: true, pending: undefined, rejection: undefined });
  }
  private settle() {
    if (!this.result || !this.current() || canonical(this.journal.pending) !== canonical(this.result.command)) return;
    const result = this.result.record;
    if (!this.persist({ ...this.journal, value: result.value as CrmValues[K], revision: result.revision, dirty: false, pending: undefined, rejection: undefined })) return;
    this.result = undefined; return result;
  }
  async save(current?: CrmRecord<K>, value?: CrmValues[K]): Promise<CrmRecord<K> | undefined> {
    if (!this.current() || this.busy || this.blocked) return;
    if (!this.matchesCurrent(current)) { this.error = 'The current record is not this draft’s original CRM record. Its writing and save are kept.'; this.emit(); return; }
    if (this.result) return this.settle();
    if (this.journal.rejection) return;
    if (!this.journal.pending) {
      if (this.changed(current) || !current && this.journal.revision > 0) { this.error = 'Review the current saved version before saving your kept edits.'; this.emit(); return; }
      if (value !== undefined) this.journal = { ...this.journal, value, dirty: true };
      if (!this.journal.dirty && this.journal.revision > 0) return;
      const parsed = commandSchema(this.scope.kind).safeParse({ requestId: crypto.randomUUID(), epoch: this.scope.epoch, id: this.scope.id, expectedRevision: this.journal.revision, value: this.journal.value, ...(this.scope.contactId ? { contactId: this.scope.contactId } : {}) });
      if (!parsed.success) { this.error = parsed.error.issues.map(issue => issue.message).join(' '); this.emit(); return; }
      this.journal = { ...this.journal, pending: parsed.data as CrmCommand<K>, dirty: true };
    }
    if (!this.persist(this.journal)) return;
    const command = this.journal.pending!;
    this.busy = true; this.emit();
    try {
      const response = await this.post(command);
      if (!this.current()) return;
      this.result = { command, record: confirmedCrm(this.scope.kind, command, response) };
      return this.settle();
    } catch (reason) {
      if (!this.current()) return;
      const status = reason && typeof reason === 'object' && 'status' in reason ? reason.status : undefined;
      const message = note(reason);
      if (!this.result && typeof status === 'number' && [400, 404, 409, 507].includes(status)) {
        this.journal = { ...this.journal, rejection: { status, message } };
        this.persist(this.journal);
      }
      this.error = message; this.emit();
    } finally { this.busy = false; this.emit(); }
  }
}
