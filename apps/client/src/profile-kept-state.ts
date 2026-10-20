export type ProfileStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type ProfileSlot<T> = { key: string; raw: string | null; value: T; invalid: boolean; original?: string };
/** Unknown or unreadable bytes stay in place. Missing and explicit null are empty. */
export function readProfileSlot<T>(storage: ProfileStorage, key: string, fallback: T, validate: (value: unknown) => value is T): ProfileSlot<T> {
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
    if (raw === null || raw === 'null') return { key, raw, value: fallback, invalid: false };
    const value: unknown = raw.length <= 256000 ? JSON.parse(raw) : undefined;
    if (validate(value)) return { key, raw, value, invalid: false };
  } catch { /* Preserve failed reads without turning them into an empty draft. */ }
  return { key, raw, value: fallback, invalid: true, ...(raw === null ? {} : { original: raw }) };
}
export function writeProfileSlot<T>(storage: ProfileStorage, slot: ProfileSlot<T>, value: T): ProfileSlot<T> {
  if (slot.invalid) throw Error('This kept Profile record cannot be verified. Its original writing is preserved.');
  const raw = JSON.stringify(value), actual = storage.getItem(slot.key);
  if (actual === raw) return { ...slot, raw, value };
  if (actual !== slot.raw) throw Error('This Profile record changed in another window. Keep this window open to preserve your writing.');
  storage.setItem(slot.key, raw);
  if (storage.getItem(slot.key) !== raw) throw Error('Profile writing could not be confirmed in browser storage. Keep this window open.');
  return { ...slot, raw, value };
}
