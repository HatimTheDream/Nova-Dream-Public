import type { AppIconChoice } from '../../../packages/domain/contracts';

export const appIconCacheKey = 'e3:app-icon:v1';
export const resolveAppIcon = (value: unknown): AppIconChoice => value === 'cream' ? 'cream' : 'red';
export function appIconAssets(value: unknown) {
  const icon = resolveAppIcon(value);
  return {
    brand: `/icons/nova-dream-${icon}-brand-192-v4.png`,
    launcher: `/icons/nova-dream-${icon}-192-v4.png`,
    launcherLarge: `/icons/nova-dream-${icon}-512-v4.png`,
    touch: `/icons/apple-touch-icon-${icon}-v4.png`,
    manifest: `/nova-dream-${icon}.webmanifest`,
  };
}
export type StartupIconJournal = { epoch: string; dirty: boolean; pending?: unknown; value?: { appIcon?: unknown } };
/** The known workspace replaces the global hint; retain only this window's unsaved choice. */
export function startupAppIcon(snapshot: { epoch: string; layout: { value: { appIcon?: unknown } } } | undefined, journal: StartupIconJournal | undefined, cached: unknown): AppIconChoice {
  if (!snapshot) return resolveAppIcon(cached);
  const proposed = journal?.value?.appIcon;
  if (journal?.epoch === snapshot.epoch && (journal.dirty || journal.pending) && (proposed === 'red' || proposed === 'cream')) return proposed;
  return resolveAppIcon(snapshot.layout.value.appIcon);
}

type IconStorage = Pick<Storage, 'getItem' | 'setItem'>;
function browserStorage(): IconStorage | undefined { try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; } }
/** A first-paint hint only. The revisioned workspace Layout remains authoritative. */
export function readCachedAppIcon(storage = browserStorage()): AppIconChoice {
  try { return resolveAppIcon(storage?.getItem(appIconCacheKey)); } catch { return 'red'; }
}
export function cacheAppIcon(value: AppIconChoice, storage = browserStorage()): boolean {
  try { if (!storage) return false; storage.setItem(appIconCacheKey, value); return true; } catch { return false; }
}
export function applyDocumentAppIcon(value: AppIconChoice, target: Document = document) {
  const assets = appIconAssets(value);
  for (const icon of target.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) {
    icon.href = assets.brand;
    icon.type = 'image/png';
  }
  for (const icon of target.querySelectorAll<HTMLLinkElement>('link[rel="apple-touch-icon"]')) icon.href = assets.touch;
  for (const manifest of target.querySelectorAll<HTMLLinkElement>('link[rel="manifest"]')) manifest.href = assets.manifest;
}