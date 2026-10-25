import { z } from 'zod';
import type { AssistantGroup } from '../../../packages/domain/assistant-groups';
import { ApiError } from './api';
import { GroupReader } from './assistant-group-reader';
import { groupEditorKey, readGroupEditorJournal, type GroupEditorScope, type GroupEditorRecord } from './assistant-group-journal';
import type { GroupViewTarget } from './assistant-group-view';

export type GroupRecoveryScope = Omit<GroupEditorScope, 'groupId'>;
export type GroupRecoveryStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'>;
export type GroupWritingEntry = { key: string; raw: string; scope: GroupEditorScope; title: string; journal?: GroupEditorRecord; problem?: string };
export type GroupWritingCopy = { key: string; raw: string; target: NonNullable<GroupViewTarget> };
const uuid = z.string().uuid();
const size = (text: string) => new TextEncoder().encode(text).length;
const maxKeys = 4096, maxEntries = 128, maxRead = 4 * 1024 * 1024;

function identity(key: string, scope: GroupRecoveryScope): GroupEditorScope | undefined {
  const parts = key.split(':');
  // Ignore archived original requests and every unrelated browser namespace.
  if (parts.length !== 6 || parts[0] !== 'e3' || parts[1] !== 'group-editor' || parts[2] !== scope.deviceId
    || !parts.slice(2).every(value => uuid.safeParse(value).success)) return;
  return { deviceId: parts[2], epoch: parts[3], windowId: parts[4], groupId: parts[5] };
}
function entry(key: string, raw: string, scope: GroupRecoveryScope): GroupWritingEntry {
  const owner = identity(key, scope);
  if (!owner) throw Error('The original Group writing location changed.');
  let journal: GroupEditorRecord | undefined, problem: string | undefined;
  try { journal = readGroupEditorJournal(raw, owner); }
  catch { problem = 'This writing has an unsupported format. Its original bytes are kept.'; }
  if (owner.epoch !== scope.epoch) problem = 'This writing belongs to an earlier workspace. Its original is kept here.';
  return { key, raw, scope: owner, journal, problem, title: journal?.draft.title.trim() || 'Untitled Group' };
}
export function discoverGroupWriting(storage: GroupRecoveryStorage, scope: GroupRecoveryScope, groups: readonly AssistantGroup[] = []) {
  const entries: GroupWritingEntry[] = [];
  let notice = '', read = 0;
  try {
    const count = storage.length;
    if (count > maxKeys) notice = 'Only part of this browser storage could be checked. No writing was removed.';
    for (let i = 0; i < Math.min(count, maxKeys); i++) {
      const key = storage.key(i);
      if (!key || !identity(key, scope)) continue;
      if (entries.length >= maxEntries || read >= maxRead) { notice = 'More kept writing exists than this list can show. No writing was removed.'; break; }
      const raw = storage.getItem(key);
      if (raw === null) continue;
      if (raw.length > 128 * 1024) { notice = 'An oversized Group draft stopped this recovery scan. Its original is kept; some other writing may not be listed.'; break; }
      const length = size(raw); read += length;
      if (length > 128 * 1024 || read > maxRead) { notice = 'Some writing exceeds the supported recovery size. Its original remains in this browser.'; continue; }
      const item = entry(key, raw, scope), kept = item.journal;
      if (!item.problem && kept && !kept.pending) {
        const saved = groups.find(group => group.id === item.scope.groupId);
        if (!kept.draft.members.length && !kept.draft.defaultAgentId
          && (saved ? kept.draft.title === saved.title && kept.draft.projectId === saved.projectId
            : kept.origin === 'create' && !kept.draft.title && !kept.draft.projectId)) continue;
      }
      entries.push(item);
    }
  } catch { notice = 'Browser storage could not be read completely. Your original writing remains untouched.'; }
  return { entries: entries.sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key)), notice };
}
function original(storage: GroupRecoveryStorage, selected: GroupWritingEntry, scope: GroupRecoveryScope) {
  if (storage.getItem(selected.key) !== selected.raw) throw Error('The source writing changed. Refresh the list and review it again.');
  const source = entry(selected.key, selected.raw, scope);
  if (!source.journal || source.problem) throw Error(source.problem ?? 'The original Group writing is unavailable.');
  return source as GroupWritingEntry & { journal: GroupEditorRecord };
}
/** The saved list may be paginated. Only an exact read can decide which editor opens. */
export async function groupWritingTarget(selected: GroupWritingEntry, scope: GroupRecoveryScope,
  get: (url: string) => Promise<unknown>, current: () => boolean): Promise<NonNullable<GroupViewTarget>> {
  const source = entry(selected.key, selected.raw, scope);
  if (!source.journal || source.problem || !current()) throw Error(source.problem ?? 'The recovery view changed.');
  const reader = new GroupReader(scope.epoch, source.scope.groupId, current);
  let missing = false;
  const found = await reader.load(async url => {
    try { return await get(url); }
    catch (error) { missing = error instanceof ApiError && error.status === 404 && error.code === 'group_missing'; throw error; }
  });
  if (!current()) throw Error('The recovery view changed. Your original writing is kept.');
  if (found) return { kind: 'group', groupId: source.scope.groupId };
  const pending = source.journal.pending;
  if (!missing || source.journal.origin === 'group' || pending?.receipt
    || pending && pending.command.action !== 'create'
    || source.journal.origin !== 'create' && pending?.command.action !== 'create')
    throw Error(reader.error || 'The original saved Group is unavailable. Reconnect before opening its writing.');
  return { kind: 'create', groupId: source.scope.groupId };
}
/** Explicit copy only. Preserve the original request and leave every source untouched. */
export function copyGroupWriting(storage: GroupRecoveryStorage, selected: GroupWritingEntry, scope: GroupRecoveryScope,
  target: NonNullable<GroupViewTarget>): GroupWritingCopy {
  const source = original(storage, selected, scope);
  if (target.groupId !== source.scope.groupId || !['create', 'group'].includes(target.kind)) throw Error('The recovery target changed.');
  const owner = { ...scope, groupId: source.scope.groupId }, key = groupEditorKey(owner);
  if (key === source.key) return { key, raw: source.raw, target };
  if (storage.getItem(key) !== null) throw Error('This window already has writing for this Group. Open it before copying another version.');
  const recoveredFrom = [...(source.journal.recoveredFrom ?? []), source.scope];
  const raw = JSON.stringify({ ...source.journal, scope: owner, recoveredFrom });
  readGroupEditorJournal(raw, owner); // Bounds and provenance checked before any write.
  original(storage, selected, scope);
  if (storage.getItem(key) !== null) throw Error('Writing appeared in this window. Refresh the list before opening it.');
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw || storage.getItem(source.key) !== source.raw)
    throw Error('The writing changed during recovery. Both versions are kept; refresh the list before opening.');
  return { key, raw, target };
}
export function checkGroupWritingCopy(storage: GroupRecoveryStorage, kept: GroupWritingCopy, scope: GroupRecoveryScope) {
  const owner = { ...scope, groupId: kept.target.groupId };
  if (groupEditorKey(owner) !== kept.key || storage.getItem(kept.key) !== kept.raw)
    throw Error('This window’s writing changed. Refresh the list before opening it.');
  readGroupEditorJournal(kept.raw, owner);
}
