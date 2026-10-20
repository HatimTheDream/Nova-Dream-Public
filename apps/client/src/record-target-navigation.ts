import type { Snapshot } from '../../../packages/domain/contracts';
import { contactDestination } from '../../../packages/domain/contacts';
import type { RecordKind } from '../../../packages/domain/workspace-records';
import type { SearchStorage } from './search-workspace';
import { readRecordJournal } from './record-draft-recovery';

export type RecordNavigationIndex = { selected: string | null; drafts: string[]; seenTarget?: string; editing?: boolean; attempt?: { id: string; epoch: string } };
export type RecordSelection = { kind: RecordKind; selected: string | null; editing?: boolean };
export type AdmittedRecordTarget = { epoch: string; deviceId: string; windowId: string; revision: number; restore?: RecordSelection };
type Target = { kind: RecordKind; id: string; nonce: string; admitted?: AdmittedRecordTarget };
export const recordIndexKey = (deviceId: string, kind: RecordKind, windowId: string) => `e3:record-index:${deviceId}:${kind}:${windowId}`;
const kinds = ['contact', 'content', 'agent', 'assignment', 'profile'];
export function readRecordIndex(value: unknown): RecordNavigationIndex | undefined {
  const row = value as RecordNavigationIndex | undefined;
  return row && typeof row === 'object' && (row.selected === null || typeof row.selected === 'string')
    && Array.isArray(row.drafts) && row.drafts.every(id => typeof id === 'string')
    && (row.editing === undefined || typeof row.editing === 'boolean') ? row : undefined;
}
export function validRecordSelection(value: unknown): value is RecordSelection {
  const row = value as RecordSelection | undefined;
  return !!row && kinds.includes(row.kind) && (row.selected === null || typeof row.selected === 'string' && row.selected.length <= 200)
    && (row.editing === undefined || typeof row.editing === 'boolean');
}
/** One navigation write before mounting an editor; no journal mutation or command. */
export function admitRecordTarget(snapshot: Snapshot, windowId: string, target: Target, storage: SearchStorage): string | undefined {
  const admission = target.admitted;
  if (!admission || admission.epoch !== snapshot.epoch || admission.deviceId !== snapshot.deviceId || admission.windowId !== windowId) return 'This saved source belongs to another workspace.';
  const restoring = admission.restore;
  if (restoring && (!validRecordSelection(restoring) || restoring.kind !== target.kind)) return 'The original selection could not be read.';
  const entity = snapshot.records?.[target.kind]?.find(row => row.id === target.id);
  if (!restoring && (!entity || entity.revision !== admission.revision)) return 'This source changed or is unavailable. Review its current version in Search.';
  if (!restoring && target.kind === 'contact' && contactDestination(target.id, snapshot.records?.contact ?? []) !== target.id) return 'This Contact was combined with another record. Open Contacts to review the combined record; the original Search reference is kept.';
  if (target.kind === 'profile' && target.id !== 'profile:owner') return 'This Profile is unavailable.';
  const selected = restoring ? restoring.selected : target.id;
  const rawJournal = selected === null ? undefined : storage.read(`e3:journal:${snapshot.deviceId}:${selected}:${windowId}`);
  const journal = rawJournal && typeof rawJournal === 'object' ? readRecordJournal(JSON.stringify(rawJournal), target.kind, selected!) : undefined;
  if (rawJournal !== undefined && (!journal || journal.epoch !== snapshot.epoch)) return 'The kept writing could not be read in this workspace. Its original browser data is preserved.';
  if (target.kind === 'profile') return;
  const key = recordIndexKey(snapshot.deviceId, target.kind, windowId), raw = storage.read(key);
  const index = raw === undefined ? { selected: null, drafts: [] } : readRecordIndex(raw);
  if (!index) return 'The kept selection could not be read. Its original browser data is preserved.';
  const next: RecordNavigationIndex = { ...index, selected: restoring ? restoring.selected : target.id, seenTarget: target.nonce, attempt: undefined,
    ...(target.kind === 'contact' ? { editing: restoring?.editing ?? (!!journal?.dirty || !!journal?.pending) } : {}) };
  return storage.write(key, next) ? undefined : 'Free browser storage before opening this source. Your current selection and writing are kept.';
}
export function admittedRecordIndex(snapshot: Snapshot, windowId: string, target: Target, storage: Pick<SearchStorage, 'read'>) {
  const admission = target.admitted;
  if (!admission || admission.epoch !== snapshot.epoch || admission.deviceId !== snapshot.deviceId || admission.windowId !== windowId) return;
  const index = readRecordIndex(storage.read(recordIndexKey(snapshot.deviceId, target.kind, windowId)));
  return index?.seenTarget === target.nonce && index.selected === (admission.restore ? admission.restore.selected : target.id) ? index : undefined;
}
