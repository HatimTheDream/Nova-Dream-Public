import { commandSchema, type Command, type Entity } from '../../../packages/domain/contracts';
import { recordSchemas, type Contact, type Content, type RecordKind, type RecordValues } from '../../../packages/domain/workspace-records';

export type RecoveryKind = 'contact' | 'content';
type Value = Contact | Content;
type Journal<T = Value> = { value: T; revision: number; epoch: string; dirty: boolean; pending?: Command; conflict?: { code: string; message: string; current?: Entity<T> } };
export type RecoveryScope = { kind: RecoveryKind; deviceId: string; windowId: string; epoch: string; records: readonly Entity<Value>[] };
export type RecoveryEntry = { key: string; raw: string; id: string; windowId: string; title: string; preview: string; journal?: Journal; problem?: string };
export type RecoveryStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'>;
export type KeptCopy = { key: string; raw: string; id: string };
const maxJournal = 512 * 1024, maxRead = 4 * 1024 * 1024, maxKeys = 4096, maxEntries = 128;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9:_-]{1,100}$/.test(v);

// Drafts can contain incomplete email, dates and required text. Preserve those
// bytes, while refusing missing fields, wrong types and unsupported shapes.
function writingIssue(issue: { code: string; errors?: unknown[][] }): boolean {
  if (['too_small', 'too_big', 'invalid_format', 'custom'].includes(issue.code)) return true;
  return issue.code === 'invalid_union' && !!issue.errors?.some(branch => branch.every(item => object(item) && typeof item.code === 'string' && writingIssue(item as { code: string; errors?: unknown[][] })));
}
function writing<K extends RecordKind>(kind: K, value: unknown): value is RecordValues[K] {
  try {
    const parsed = recordSchemas[kind].safeParse(value);
    return parsed.success || parsed.error.issues.every(issue => writingIssue(issue));
  } catch { return false; }
}
export function readRecordJournal<K extends RecordKind>(raw: string, kind: K, id: string): Journal<RecordValues[K]> | undefined {
  if (bytes(raw) > maxJournal) return;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return; }
  if (!object(v) || Object.keys(v).some(key => !['value', 'revision', 'epoch', 'dirty', 'pending', 'conflict'].includes(key)) || !writing(kind, v.value) || !Number.isSafeInteger(v.revision) || (v.revision as number) < 0 || typeof v.epoch !== 'string' || !v.epoch || v.epoch.length > 100 || typeof v.dirty !== 'boolean') return;
  if (v.pending !== undefined) {
    const parsed = commandSchema.safeParse(v.pending);
    if (!parsed.success || parsed.data.kind !== kind || parsed.data.entityId !== id || parsed.data.epoch !== v.epoch || parsed.data.expectedRevision !== v.revision || !writing(kind, parsed.data.payload) || !v.dirty) return;
  }
  if (v.conflict !== undefined) {
    const c = v.conflict;
    if (!object(c) || Object.keys(c).some(key => !['code', 'message', 'current'].includes(key)) || typeof c.code !== 'string' || c.code.length > 100 || typeof c.message !== 'string' || c.message.length > 10000) return;
    if (c.current !== undefined) {
      const e = c.current;
      if (!object(e) || e.id !== id || !Number.isSafeInteger(e.revision) || (e.revision as number) < 1 || typeof e.deviceId !== 'string' || typeof e.updatedAt !== 'string' || !writing(kind, e.value)) return;
    }
  }
  return v as Journal<RecordValues[K]>;
}
// Keep Contact/Content discovery and explicit copy on the original reader contract.
const journal = (raw: string, kind: RecoveryKind, id: string) => readRecordJournal(raw, kind, id);
export function recordJournalKey(scope: Pick<RecoveryScope, 'deviceId' | 'windowId'>, id: string) {
  return `e3:journal:${scope.deviceId}:${id}:${scope.windowId}`;
}
function identity(key: string, scope: RecoveryScope) {
  const prefix = `e3:journal:${scope.deviceId}:`, split = key.lastIndexOf(':');
  if (!key.startsWith(prefix) || split < prefix.length) return;
  const id = key.slice(prefix.length, split), windowId = key.slice(split + 1);
  if (!id.startsWith(scope.kind + ':') || !identifier(id) || !/^[a-zA-Z0-9_-]{1,100}$/.test(windowId)) return;
  return { id, windowId };
}
function blocked(value: Journal, id: string, scope: RecoveryScope): string | undefined {
  if (value.epoch !== scope.epoch) return 'This writing belongs to an earlier workspace. It is kept here, but cannot be copied into this workspace.';
  const saved = scope.records.find(record => record.id === id);
  if (saved && 'mergedInto' in saved.value && saved.value.mergedInto) return 'This contact was combined with another person. The original writing is kept; copying is blocked.';
  if (!saved && value.revision > 0) return 'The original saved record is unavailable. Reconnect before recovering its writing.';
  // An original pending save may already have advanced the host. Only that
  // unchanged command can reconcile it; never rebase or replace its payload.
  if (!value.pending && (saved?.revision ?? 0) !== value.revision) return 'The saved record changed since this writing. The original is kept; copying is blocked until it can be reviewed.';
}
function entry(key: string, raw: string, scope: RecoveryScope): RecoveryEntry | undefined {
  const source = identity(key, scope);
  if (!source) return;
  const kept = journal(raw, scope.kind, source.id);
  if (kept && !kept.dirty && !kept.pending && !kept.conflict) return;
  const value = kept?.value;
  return { key, raw, ...source, journal: kept,
    title: value ? ('name' in value ? value.name : value.title).trim().slice(0, 240) || `Untitled ${scope.kind}` : `Unreadable ${scope.kind} writing`,
    preview: value ? ('notes' in value ? value.notes : value.body || value.brief).slice(0, 1600) : '',
    problem: kept ? blocked(kept, source.id, scope) : 'This retained record is malformed or uses an unsupported format. Its original bytes have not been changed.' };
}
export function discoverRecordDrafts(storage: RecoveryStorage, scope: RecoveryScope) {
  const entries: RecoveryEntry[] = [];
  let notice = '', read = 0;
  try {
    const count = Math.min(storage.length, maxKeys);
    if (storage.length > maxKeys) notice = 'Only part of this browser storage could be checked. No writing was removed.';
    for (let i = 0; i < count; i++) {
      const key = storage.key(i);
      if (!key || !identity(key, scope)) continue; // Never read unrelated keys.
      if (entries.length >= maxEntries || read >= maxRead) { notice = 'More retained writing exists than this bounded list can show. No writing was removed.'; break; }
      const raw = storage.getItem(key);
      if (raw === null) continue;
      read += bytes(raw);
      const item = entry(key, raw, scope);
      if (item) entries.push(item);
    }
  } catch { notice = 'Browser storage could not be read completely. Your original writing remains untouched.'; }
  return { entries: entries.sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key)), notice };
}
export function copyRecordDraft(storage: RecoveryStorage, selected: RecoveryEntry, scope: RecoveryScope): KeptCopy {
  const raw = storage.getItem(selected.key);
  if (raw === null || raw !== selected.raw) throw Error('The source writing changed. Refresh this list and review it again.');
  const source = entry(selected.key, raw, scope);
  if (!source?.journal || source.problem) throw Error(source?.problem ?? 'This retained writing is unavailable.');
  const key = recordJournalKey(scope, source.id), current = storage.getItem(key);
  if (key === source.key) return { key, raw, id: source.id }; // Open an existing local branch without a write.
  if (current !== null) {
    const destination = journal(current, scope.kind, source.id);
    if (!destination || destination.dirty || destination.pending || destination.conflict) throw Error('This window already has writing or an unconfirmed save for this record. Open and resolve it before copying another version.');
    if (destination.epoch !== scope.epoch) throw Error('This window has an earlier workspace version of this record. Review it first.');
  }
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw Error('The copied writing changed before it could be opened. Both source records are retained.');
  return { key, raw, id: source.id };
}
export function checkKeptCopy(storage: RecoveryStorage, copy: KeptCopy, scope: RecoveryScope) {
  if (copy.key !== recordJournalKey(scope, copy.id) || storage.getItem(copy.key) !== copy.raw) throw Error('This window’s kept writing changed. Refresh the list before opening it.');
  const current = entry(copy.key, copy.raw, scope);
  if (!current?.journal || current.problem) throw Error(current?.problem ?? 'The kept copy is unavailable.');
}
export function currentRecordDraftTitle(storage: Pick<Storage, 'getItem'>, scope: Pick<RecoveryScope, 'deviceId' | 'windowId' | 'kind'>, id: string): string | undefined {
  try {
    const raw = storage.getItem(recordJournalKey(scope, id));
    const value = raw && journal(raw, scope.kind, id)?.value;
    return value ? ('name' in value ? value.name : value.title).trim().slice(0, 240) || undefined : undefined;
  } catch { return; }
}
