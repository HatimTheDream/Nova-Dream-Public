/** Unlike the general convenience reader, navigation must distinguish absent
 * metadata from unreadable existing data before replacing an editor pointer. */
export const unreadableNavigation = Symbol('unreadable-navigation');
export function readNavigationLocal(key: string): unknown {
  try { const raw = localStorage.getItem(key); return raw === null ? undefined : JSON.parse(raw); }
  catch { return unreadableNavigation; }
}
