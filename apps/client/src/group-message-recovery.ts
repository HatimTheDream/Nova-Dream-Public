import { canonical } from '../../../packages/domain/contracts';
import { groupDraftScopeSchema, type GroupDraftScope } from '../../../packages/domain/assistant-group-turns';
import { GroupMessageJournal, emptyGroupWriting, groupMessageKey } from './group-message-journal';
import type { GroupRecoveryStorage } from './group-writing-recovery';

export type MessageRecoveryScope = Pick<GroupDraftScope, 'epoch' | 'deviceId' | 'windowId' | 'groupId'>;
export type MessageWritingEntry = { key: string; raw: string; scope: GroupDraftScope;
  value?: GroupMessageJournal['value']; problem?: string };
export type MessageWritingCopy = { source: MessageWritingEntry; scope: GroupDraftScope;
  key: string; before: string | null; raw: string; provenanceKey: string };
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function read(raw: string, scope: GroupDraftScope) {
  const journal = new GroupMessageJournal({ getItem: () => raw, setItem: () => { throw Error('Read only'); } }, scope, () => true);
  if (journal.invalid) throw Error(journal.error);
  return journal.value;
}
function entry(key: string, raw: string, scope: GroupDraftScope, owner: MessageRecoveryScope): MessageWritingEntry {
  try {
    const value = read(raw, scope);
    return { key, raw, scope, value, ...(scope.epoch !== owner.epoch
      ? { problem: 'This writing belongs to an earlier workspace. Its original is kept.' } : {}) };
  } catch { return { key, raw, scope, problem: 'This original draft needs review. Its stored bytes have not been changed.' }; }
}
export function discoverGroupMessages(storage: GroupRecoveryStorage, owner: MessageRecoveryScope) {
  const entries: MessageWritingEntry[] = [];
  let notice = '', bytes = 0;
  try {
    const count = storage.length;
    if (count > 4096) notice = 'Only part of this browser storage could be checked. No writing was removed.';
    for (let i = 0; i < Math.min(count, 4096); i++) {
      const key = storage.key(i);
      if (!key?.startsWith('e3:group-message:') || key.length > 24000) continue;
      let scope: GroupDraftScope;
      try { scope = groupDraftScopeSchema.parse(JSON.parse(decodeURIComponent(key.slice('e3:group-message:'.length)))); } catch { continue; }
      if (key !== groupMessageKey(scope) || scope.deviceId !== owner.deviceId || scope.groupId !== owner.groupId) continue;
      if (entries.length >= 64 || bytes >= 4 * 1024 * 1024) { notice = 'More kept messages exist than this list can show. Their originals are untouched.'; break; }
      const raw = storage.getItem(key); if (raw === null) continue;
      if (raw.length > 1024 * 1024) { notice = 'An oversized draft could not be inspected. Its original is kept; this list may be incomplete.'; break; }
      bytes += new TextEncoder().encode(raw).length;
      if (bytes > 4 * 1024 * 1024) { notice = 'The recovery read limit was reached. Remaining drafts are kept.'; break; }
      const item = entry(key, raw, scope, owner);
      if (!item.problem && item.value && !item.value.pending && !item.value.savedRaw
        && equal(item.value.writing, emptyGroupWriting())) continue;
      entries.push(item);
    }
  } catch { notice = 'Some browser writing could not be read. No original was changed.'; }
  return { entries, notice };
}
function original(storage: GroupRecoveryStorage, selected: MessageWritingEntry, owner: MessageRecoveryScope) {
  if (selected.scope.deviceId !== owner.deviceId || selected.scope.groupId !== owner.groupId || selected.scope.epoch !== owner.epoch
    || selected.key !== groupMessageKey(selected.scope) || storage.getItem(selected.key) !== selected.raw)
    throw Error('The original writing changed or belongs to another workspace. Refresh before recovery.');
  return read(selected.raw, selected.scope);
}
const vacant = (raw: string | null, scope: GroupDraftScope) => {
  if (raw === null) return true;
  const value = read(raw, scope);
  return !value.pending && !value.savedRaw && equal(value.writing, emptyGroupWriting());
};
/** Planning captures both exact local versions, without touching either one. */
export function planGroupMessageCopy(storage: GroupRecoveryStorage, selected: MessageWritingEntry, owner: MessageRecoveryScope): MessageWritingCopy {
  const value = original(storage, selected, owner);
  if (value.pending && !value.pending.receipt && !value.pending.rejection)
    throw Error('Check or continue the original request before making a separate draft. Your full writing is kept.');
  const scope = groupDraftScopeSchema.parse({ ...selected.scope, windowId: owner.windowId });
  const key = groupMessageKey(scope), before = storage.getItem(key);
  if (key === selected.key) return { source: selected, scope, key, before, raw: selected.raw, provenanceKey: '' };
  if (!vacant(before, scope)) throw Error('This window already has a draft for those recipients. Open it before recovering another copy.');
  const raw = JSON.stringify({ format: 1, scope, writing: value.writing, savedRaw: null });
  read(raw, scope);
  return { source: selected, scope, key, before, raw,
    provenanceKey: `e3:group-message-recovery:${owner.epoch}:${owner.deviceId}:${owner.groupId}:${crypto.randomUUID()}` };
}
/** Explicit copy: the old draft/request remain intact; the new draft is unsaved.
 * Exact already-written bytes are the only continuation after a failed readback. */
export function applyGroupMessageCopy(storage: GroupRecoveryStorage, plan: MessageWritingCopy, owner: MessageRecoveryScope) {
  const value = original(storage, plan.source, owner);
  const expectedScope = { ...plan.source.scope, windowId: owner.windowId };
  const expectedRaw = plan.key === plan.source.key ? plan.source.raw
    : JSON.stringify({ format: 1, scope: groupDraftScopeSchema.parse(expectedScope), writing: value.writing, savedRaw: null });
  if (plan.scope.windowId !== owner.windowId || plan.key !== groupMessageKey(plan.scope)
    || !equal(plan.scope, expectedScope) || plan.raw !== expectedRaw
    || plan.key !== plan.source.key && (!vacant(plan.before, plan.scope)
      || value.pending && !value.pending.receipt && !value.pending.rejection))
    throw Error('The destination window changed. Your original writing is kept.');
  const actual = storage.getItem(plan.key);
  if (actual !== plan.before && actual !== plan.raw) throw Error('New writing appeared in this window. Both originals are kept.');
  read(plan.raw, plan.scope);
  if (plan.key !== plan.source.key) {
    if (!plan.provenanceKey.startsWith(`e3:group-message-recovery:${owner.epoch}:${owner.deviceId}:${owner.groupId}:`))
      throw Error('The recovery record does not belong to this workspace.');
    const provenance = JSON.stringify({ format: 1, source: { key: plan.source.key, raw: plan.source.raw },
      target: { key: plan.key, raw: plan.raw } });
    const previous = storage.getItem(plan.provenanceKey);
    if (previous !== null && previous !== provenance) throw Error('The kept recovery record changed.');
    storage.setItem(plan.provenanceKey, provenance);
    if (storage.getItem(plan.provenanceKey) !== provenance) throw Error('The original writing could not be kept before copying.');
    original(storage, plan.source, owner);
    const beforeWrite = storage.getItem(plan.key);
    if (beforeWrite !== plan.before && beforeWrite !== plan.raw) throw Error('The destination draft changed. Recovery did not overwrite it.');
    if (beforeWrite !== plan.raw) storage.setItem(plan.key, plan.raw);
  }
  if (storage.getItem(plan.key) !== plan.raw || storage.getItem(plan.source.key) !== plan.source.raw)
    throw Error('Recovery readback is unconfirmed. Keep this window open and check the same kept copy.');
  return plan.scope;
}
