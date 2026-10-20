import { sameProfileWeek, type ProfileWeekIdentity } from '../../../packages/domain/profile-week';
import { parseWeekNoteDraftKey, readWeekNoteJournal, weekNoteDraftKey, type WeekNoteJournal } from './profile-week-note-client';

export type WeekNoteRecoveryStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'>;
export type WeekNoteRecoveryEntry = {
  key: string; windowId: string; identity: ProfileWeekIdentity; original?: string;
  journal?: WeekNoteJournal; unavailable?: string; current: boolean;
};
export function discoverWeekNoteWriting(storage: WeekNoteRecoveryStorage, deviceId: string, epoch: string, windowId: string) {
  const entries: WeekNoteRecoveryEntry[] = [];
  let bytes = 0, error = '';
  try {
    const size = storage.length;
    for (let index = 0; index < Math.min(size, 4096); index++) {
      const key = storage.key(index);
      if (!key?.startsWith(`e3:week-note:${encodeURIComponent(deviceId)}:`)) continue;
      const scope = parseWeekNoteDraftKey(key);
      if (!scope || scope.deviceId !== deviceId) {
        error = 'Some note draft keys could not be verified. Their originals have not been changed.'; continue;
      }
      if (entries.length >= 128) { error = 'The first 128 note drafts are shown. Other original drafts remain in this browser.'; break; }
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const entry: WeekNoteRecoveryEntry = { key, windowId: scope.windowId, identity: scope.identity, current: scope.windowId === windowId };
      if (raw.length > 256000) { entries.push({ ...entry, unavailable: 'This original is too large to inspect safely. It remains unchanged.' }); continue; }
      bytes += new TextEncoder().encode(raw).length;
      if (bytes > 4 * 1024 * 1024) { error = 'The bounded note draft preview is full. Remaining originals have not been changed.'; break; }
      const journal = readWeekNoteJournal(raw);
      if (!journal || !sameProfileWeek(journal.identity, scope.identity)) {
        entries.push({ ...entry, original: raw, unavailable: 'This original has an unknown or damaged format. It has not been changed.' }); continue;
      }
      if (journal.epoch !== epoch) {
        entries.push({ ...entry, original: raw, journal, unavailable: 'This writing belongs to an earlier workspace. Its original request cannot be sent here.' }); continue;
      }
      if (journal.dirty || journal.pending || journal.rejection) entries.push({ ...entry, original: raw, journal });
    }
    if (size > 4096) error ||= 'The first 4096 browser keys were inspected. Other originals remain unchanged.';
  } catch (problem) { error = problem instanceof Error ? problem.message : 'Note drafts could not be read. Existing writing is kept.'; }
  return { entries, error };
}

/** Copy exact original bytes only into a vacant current-window slot. Never sends a note command. */
export function recoverWeekNoteWriting(storage: WeekNoteRecoveryStorage, entry: WeekNoteRecoveryEntry,
  deviceId: string, epoch: string, windowId: string) {
  if (entry.unavailable || !entry.original || !entry.journal) throw Error('This original cannot be safely opened for editing.');
  const source = parseWeekNoteDraftKey(entry.key), current = storage.getItem(entry.key);
  const journal = current === null ? undefined : readWeekNoteJournal(current);
  if (!source || source.deviceId !== deviceId || current !== entry.original || !journal || journal.epoch !== epoch ||
    !sameProfileWeek(journal.identity, source.identity) || !sameProfileWeek(source.identity, entry.identity)) {
    throw Error('The original draft changed or belongs to another workspace. Refresh the list; neither draft was replaced.');
  }
  const target = weekNoteDraftKey(deviceId, windowId, source.identity);
  if (target === entry.key) return { key: target, identity: source.identity, copied: false };
  if (storage.getItem(target) !== null) throw Error('This window already has writing or an original save for that week. Open it here; nothing was replaced.');
  // Recheck both owners immediately before the single synchronous browser write.
  if (storage.getItem(entry.key) !== current || storage.getItem(target) !== null) throw Error('The draft destination or source changed. Refresh before opening it.');
  storage.setItem(target, current);
  if (storage.getItem(target) !== current) throw Error('Browser storage did not confirm the copy. The original remains kept; check this same destination before trying again.');
  return { key: target, identity: source.identity, copied: true };
}
