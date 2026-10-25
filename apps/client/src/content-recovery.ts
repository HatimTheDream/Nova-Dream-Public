import { z } from 'zod';
import { canonical, commandSchema, attachmentSchema, type Attachment, type Command, type Entity } from '../../../packages/domain/contracts';
import { contentSchema, type Content } from '../../../packages/domain/workspace-records';
import { readRecordJournal } from './record-draft-recovery';

const identity = z.string().min(1).max(200);
const scopeSchema = z.object({ epoch: identity, deviceId: identity, windowId: identity, id: z.string().regex(/^content:/).max(100) }).strict();
export type ContentRecoveryScope = z.infer<typeof scopeSchema>;
const entitySchema = z.object({ id: z.string().regex(/^content:/).max(100), revision: z.number().int().positive(),
  updatedAt: z.string(), deviceId: identity, value: contentSchema }).strict();
const ackSchema = z.object({ command: commandSchema, result: entitySchema }).strict();
const copySchema = z.object({ id: z.string().uuid(), at: z.string().datetime(), original: z.string().max(512000),
  saved: entitySchema.nullable() }).strict();
const archiveSchema = z.object({ id: z.string().uuid(), before: entitySchema, acknowledgement: ackSchema.optional(),
  undoRequested: z.boolean(), undo: ackSchema.optional() }).strict();
const journalSchema = z.object({ format: z.literal(1), scope: scopeSchema,
  copies: z.array(copySchema).max(16), archives: z.array(archiveSchema).max(16),
  fileRemovals:z.array(z.object({id:z.uuid(),file:attachmentSchema,index:z.number().int().nonnegative().max(31)}).strict()).max(32).default([]) }).strict();
type Journal = z.infer<typeof journalSchema>;
export type ContentKeptCopy = z.infer<typeof copySchema>;
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const limit = 2 * 1024 * 1024;
const explain = (e: unknown) => e instanceof Error ? e.message : 'The original writing remains in this window.';
const archivePayload = (before: Entity<Content>) => ({ ...before.value, archived: true });
function exactAck(scope: ContentRecoveryScope, before: Entity<Content>, payload: Content, raw: unknown) {
  const ack = ackSchema.parse(raw), c = ack.command, r = ack.result;
  if (c.kind !== 'content' || c.entityId !== scope.id || c.epoch !== scope.epoch || c.expectedRevision !== before.revision
    || !same(c.payload, payload) || r.id !== scope.id || r.deviceId !== scope.deviceId
    || r.revision !== before.revision + 1 || !same(r.value, payload))
    throw Error('This result does not confirm the exact Content change.');
  return ack;
}
export const contentCopyText = (value: Content) => `${value.title}\n\n${value.body}${value.brief ? `\n\nBrief\n${value.brief}` : ''}`;

/** Recovery evidence stays local to this exact record/window. No remote commands,
 * implicit merges, deletion or automatic removal of an older kept copy. */
export class ContentRecoveryJournal {
  readonly key: string;
  value: Journal;
  invalid = false;
  error = '';
  private raw: string | null = null;
  private attempted?: string;
  constructor(private storage: StoragePort, readonly scope: ContentRecoveryScope) {
    scopeSchema.parse(scope);
    this.key = `e3:content-recovery:${encodeURIComponent(canonical(scope))}`;
    this.value = { format: 1, scope, copies: [], archives: [], fileRemovals:[] };
    try {
      this.raw = storage.getItem(this.key);
      if (this.raw === null) return;
      if (this.raw.length > limit) throw Error('The kept Content recovery record exceeds its supported size. Its original is untouched.');
      const saved = journalSchema.parse(JSON.parse(this.raw));
      if (!same(scope, saved.scope)) throw Error('This recovery record belongs to another Content workspace.');
      for (const copy of saved.copies) {
        const original = readRecordJournal(copy.original, 'content', scope.id);
        if (!original || original.epoch !== scope.epoch || copy.saved && copy.saved.id !== scope.id)
          throw Error('An original comparison lost its Content identity.');
      }
      for (const row of saved.archives) {
        if (row.before.id !== scope.id || row.before.value.archived) throw Error('An original archive has no exact active version.');
        if (row.acknowledgement) exactAck(scope, row.before, archivePayload(row.before), row.acknowledgement);
        if (row.undo) {
          if (!row.undoRequested || !row.acknowledgement) throw Error('The original Undo is not bound to a confirmed archive.');
          exactAck(scope, row.acknowledgement.result, row.before.value, row.undo);
        }
      }
      this.value = saved;
    } catch (e) { this.invalid = true; this.error = explain(e); }
  }
  retain() {
    if (this.invalid) return false;
    try {
      const actual = this.storage.getItem(this.key);
      if (actual !== this.raw && actual !== this.attempted) throw Error('Another window changed this recovery record. Both versions are kept.');
      const raw = JSON.stringify(journalSchema.parse(this.value));
      if (raw.length > limit || new TextEncoder().encode(raw).length > limit)
        throw Error('The recovery record is full. Copy your writing before making another recovery choice.');
      this.attempted = raw; this.storage.setItem(this.key, raw);
      if (this.storage.getItem(this.key) !== raw) throw Error('Recovery is kept only in this window. Copy the complete writing before leaving.');
      this.raw = raw; this.attempted = undefined; this.error = ''; return true;
    } catch (e) { this.error = explain(e); return false; }
  }
  keepComparison(originalRaw: string, saved?: Entity<Content>) {
    if (this.invalid) return false;
    try {
      if (originalRaw.length > 512000) throw Error('The complete original writing exceeds the comparison limit. Copy it before leaving.');
      const original = readRecordJournal(originalRaw, 'content', this.scope.id);
      if (!original || original.epoch !== this.scope.epoch || saved && saved.id !== this.scope.id)
        throw Error('The comparison belongs to another original Content record.');
      if (this.value.copies.some(row => row.original === originalRaw && same(row.saved, saved ?? null))) return this.retain();
      if (this.value.copies.length >= 16) throw Error('Sixteen earlier comparisons are kept. Copy your writing before making another choice.');
      const row = copySchema.parse({ id: crypto.randomUUID(), at: new Date().toISOString(), original: originalRaw, saved: saved ?? null });
      this.value = { ...this.value, copies: [...this.value.copies, row] }; return this.retain();
    } catch (e) { this.error = explain(e); return false; }
  }
  beginArchive(before: Entity<Content>, value: Content) {
    if (this.invalid) return false;
    try {
      entitySchema.parse(before);
      if (before.id !== this.scope.id || before.value.archived || !same(before.value, value))
        throw Error('Save or review this exact Content version before archiving it.');
      const existing = this.value.archives.find(row => same(row.before, before) && !row.acknowledgement);
      if (existing) return this.retain();
      if (this.value.archives.length >= 16) throw Error('The local archive recovery history is full. Its original receipts are kept.');
      this.value = { ...this.value, archives: [...this.value.archives, { id: crypto.randomUUID(), before: structuredClone(before), undoRequested: false }] };
      return this.retain();
    } catch (e) { this.error = explain(e); return false; }
  }
  /** Called only by the mounted editor after its immutable command is acknowledged. */
  acknowledge(command: Command, result: Entity<Content>) {
    if (this.invalid || command.kind !== 'content' || command.entityId !== this.scope.id || command.epoch !== this.scope.epoch) return false;
    try {
      const row = [...this.value.archives].reverse().find(entry => command.expectedRevision === entry.before.revision
        && same(command.payload, archivePayload(entry.before))
        || entry.undoRequested && !!entry.acknowledgement && command.expectedRevision === entry.acknowledgement.result.revision
        && same(command.payload, entry.before.value));
      if (!row) return false;
      const undo = !!row.acknowledgement && command.expectedRevision === row.acknowledgement.result.revision;
      const ack = exactAck(this.scope, undo ? row.acknowledgement!.result : row.before,
        undo ? row.before.value : archivePayload(row.before), { command, result });
      const prior = undo ? row.undo : row.acknowledgement;
      if (prior && !same(prior, ack)) throw Error('This archive already has a different original acknowledgement.');
      this.value = { ...this.value, archives: this.value.archives.map(entry => entry.id === row.id
        ? { ...entry, ...(undo ? { undo: ack } : { acknowledgement: ack }) } : entry) };
      return this.retain();
    } catch (e) { this.error = explain(e); return false; }
  }
  undoFor(current?: Entity<Content>) {
    if (this.invalid || this.error || !current) return;
    return [...this.value.archives].reverse().find(row => !row.undo && row.acknowledgement
      && same(row.acknowledgement.result, current));
  }
  canContinueArchive(value: Content, revision: number) {
    return !this.invalid && !this.error && this.value.archives.some(row => !row.acknowledgement
      && row.before.revision === revision && same(value, archivePayload(row.before)));
  }
  beginUndo(current: Entity<Content>) {
    const row = this.undoFor(current);
    if (!row) return;
    this.value = { ...this.value, archives: this.value.archives.map(entry => entry.id === row.id ? { ...entry, undoRequested: true } : entry) };
    return this.retain() ? structuredClone(row.before.value) : undefined;
  }
  detachFile(value:Content,file:Attachment){
    if(this.invalid)return;
    try{
      const index=value.assets?.findIndex(f=>same(f,file))??-1;
      if(index<0||file.id===value.source?.fileId)throw Error('The original source file stays attached to this draft.');
      const previous=this.value.fileRemovals.find(row=>same(row.file,file)&&row.index===index);
      if(!previous){
        if(this.value.fileRemovals.length>=32)throw Error('The kept file Undo history is full. Existing references remain unchanged.');
        this.value={...this.value,fileRemovals:[...this.value.fileRemovals,{id:crypto.randomUUID(),file:structuredClone(file),index}]};
      }
      return this.retain()?value.assets!.filter(f=>f.id!==file.id):undefined;
    }catch(error){this.error=explain(error);return;}
  }
  fileUndoFor(value:Content){
    if(this.invalid||this.error||(value.assets?.length??0)>=32)return;
    return [...this.value.fileRemovals].reverse().find(row=>!value.assets?.some(file=>file.id===row.file.id));
  }
  undoFile(value:Content){
    const row=this.fileUndoFor(value);if(!row||!this.retain())return;
    const assets=[...(value.assets??[])];assets.splice(Math.min(row.index,assets.length),0,structuredClone(row.file));return assets;
  }
}
