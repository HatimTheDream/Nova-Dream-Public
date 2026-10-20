import { readCrmJournal, readCrmLegacy, type CrmJournal, type CrmKind, type CrmRecord, type CrmStorage } from './crm-draft-client';
import { activitySaveSchema, organizationSaveSchema } from '../../../packages/domain/crm';

export type CrmRecoveryScope = { kind: CrmKind; deviceId: string; windowId: string; epoch: string; contactId?: string; records: readonly CrmRecord<CrmKind>[] };
export type CrmRecoveryEntry = { key: string; raw: string; slot: string; windowId: string; title: string; preview: string; journal?: CrmJournal; legacy: boolean; problem?: string };
export type CrmKeptCopy = { key: string; raw: string; slot: string };
type Storage = CrmStorage & Pick<globalThis.Storage, 'length' | 'key'>;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const prefix = (scope: CrmRecoveryScope) => `e3:crm-${scope.kind === 'activity' ? 'activity' : 'org'}:${scope.deviceId}:`;
export const crmRecoveryKey = (scope: CrmRecoveryScope, slot: string) => `${prefix(scope)}${slot}:${scope.windowId}`;
function identity(key: string, scope: CrmRecoveryScope) {
  const start = prefix(scope), split = key.lastIndexOf(':');
  if (!key.startsWith(start) || split < start.length) return;
  const slot = key.slice(start.length, split), windowId = key.slice(split + 1);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(windowId)) return;
  if (scope.kind === 'organization' ? slot !== 'new' && !(slot.startsWith('organization:') && /^[a-zA-Z0-9:_-]{1,100}$/.test(slot)) :
    slot !== `${scope.contactId}:new` && !(slot.startsWith('activity:') && /^[a-zA-Z0-9:_-]{1,100}$/.test(slot))) return;
  return { slot, windowId };
}
function readEntry(key: string, raw: string, scope: CrmRecoveryScope): CrmRecoveryEntry | undefined {
  const source = identity(key, scope);
  if (!source || raw === 'null') return;
  const journal = readCrmJournal(raw, scope.kind), legacy = journal ? undefined : readCrmLegacy(raw, scope.kind);
  if (journal && scope.kind === 'activity' && journal.contactId !== scope.contactId) return;
  const newSlot = scope.kind === 'activity' ? `${scope.contactId}:new` : 'new';
  // Old idle activity drafts have no contact identity; only their exact new
  // slot or an existing row can establish which contact's editor owns them.
  const current = scope.records.find(record => record.id === source.slot);
  if (scope.kind === 'activity' && !journal && source.slot !== newSlot && (!current || !('contactId' in current) || current.contactId !== scope.contactId)) return;
  if (journal && !journal.dirty && !journal.pending) return;
  let problem: string | undefined;
  if (!journal && !legacy) problem = 'This writing uses an unsupported format. Its original bytes are kept unchanged.';
  if (journal) {
    const record = scope.records.find(record => record.id === journal.id);
    if (source.slot !== newSlot && source.slot !== journal.id || source.slot === newSlot && journal.revision > 0 && !journal.pending) problem = 'This writing does not match its original editor. Its original bytes are kept.';
    else if (journal.epoch !== scope.epoch) problem = 'This writing belongs to an earlier workspace. Read it here; its original is kept.';
    else if (!record && journal.revision > 0) problem = 'The original saved record is unavailable in this view. Reconnect or open its contact before recovering it.';
    else if (record && 'contactId' in record && record.contactId !== scope.contactId) problem = 'The original activity belongs to another contact. It has not been moved.';
    // Changed host revisions remain readable in the original editor, whose
    // explicit Review Saved Version action retains edits before rebasing.
  } else if (legacy?.pending) {
    const pending = (scope.kind === 'activity' ? activitySaveSchema : organizationSaveSchema).safeParse(legacy.pending);
    if (!pending.success || !pending.data.id.startsWith(scope.kind + ':') || pending.data.expectedRevision !== legacy.revision ||
      source.slot !== newSlot && source.slot !== pending.data.id ||
      pending.success && ('contactId' in pending.data ? pending.data.contactId : undefined) !== scope.contactId)
      problem = 'This earlier pending save does not match its original editor. Its original bytes are kept.';
    else if (pending.data.epoch !== scope.epoch) problem = 'This pending save belongs to an earlier workspace. Its original is kept unchanged.';
    else if (legacy.revision > 0 && !scope.records.some(record => record.id === pending.data.id)) problem = 'The original saved record is unavailable in this view. Its original save and writing are kept.';
  } else if (legacy && source.slot !== newSlot && !current) problem = 'The original saved record is unavailable. Its earlier writing is kept.';
  const value = journal?.value ?? (legacy || undefined)?.value;
  return { key, raw, ...source, journal, legacy: !!legacy, problem,
    title: value ? ('name' in value ? value.name : value.text).trim().slice(0, 240) || `Untitled ${scope.kind}` : `Unreadable ${scope.kind} writing`,
    preview: value ? ('notes' in value ? value.notes : value.text).slice(0, 10000) : raw.slice(0, 10000) };
}
export function discoverCrmDrafts(storage: Storage, scope: CrmRecoveryScope) {
  const entries: CrmRecoveryEntry[] = []; let notice = '', read = 0;
  try {
    const count = Math.min(storage.length, 4096);
    if (storage.length > count) notice = 'Only part of this browser storage could be checked. No writing was removed.';
    for (let index = 0; index < count; index++) {
      const key = storage.key(index);
      if (!key || !identity(key, scope)) continue;
      if (entries.length >= 128 || read >= 4 * 1024 * 1024) { notice = 'More writing exists than this bounded list can show. No writing was removed.'; break; }
      const raw = storage.getItem(key); if (raw === null) continue;
      if (raw.length > 512000) { notice = 'An oversized original could not be previewed. Its stored writing has not been changed.'; continue; }
      const size = bytes(raw);
      if (read + size > 4 * 1024 * 1024) { notice = 'More retained writing exists than this bounded list can show. No writing was removed.'; break; }
      read += size;
      const entry = readEntry(key, raw, scope); if (entry) entries.push(entry);
    }
  } catch { notice = 'Browser storage could not be read completely. Your original writing remains untouched.'; }
  return { entries: entries.sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key)), notice };
}
export function copyCrmDraft(storage: Storage, selected: CrmRecoveryEntry, scope: CrmRecoveryScope): CrmKeptCopy {
  const raw = storage.getItem(selected.key);
  if (raw === null || raw !== selected.raw) throw Error('The source writing changed. Refresh this list and review it again.');
  const source = readEntry(selected.key, raw, scope);
  if (!source || source.problem) throw Error(source?.problem ?? 'This retained writing is unavailable.');
  const key = crmRecoveryKey(scope, source.slot), current = storage.getItem(key);
  if (key === selected.key) return { key, raw, slot: source.slot };
  if (current !== null && current !== 'null') {
    const destination = readCrmJournal(current, scope.kind);
    if (!destination || destination.dirty || destination.pending || destination.rejection || destination.legacyOriginal || destination.epoch !== scope.epoch)
      throw Error('This window already has writing, an earlier original or an unconfirmed save. Open and resolve it before copying another version.');
    if (destination.contactId !== scope.contactId) throw Error('This window’s editor belongs to another contact. Its original is kept.');
    const newSlot = scope.kind === 'activity' ? `${scope.contactId}:new` : 'new';
    if (source.slot !== newSlot && destination.id !== source.slot) throw Error('This window’s writing does not match its editor. Its original is kept.');
  }
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw Error('Browser storage did not confirm the copy. The original writing is unchanged.');
  return { key, raw, slot: source.slot };
}
export function checkCrmCopy(storage: Storage, copy: CrmKeptCopy, scope: CrmRecoveryScope) {
  if (copy.key !== crmRecoveryKey(scope, copy.slot) || storage.getItem(copy.key) !== copy.raw) throw Error('This window’s kept writing changed. Refresh before opening it.');
  const current = readEntry(copy.key, copy.raw, scope);
  if (!current || current.problem) throw Error(current?.problem ?? 'This kept copy is unavailable.');
}
