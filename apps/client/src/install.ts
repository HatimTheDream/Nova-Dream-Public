type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
let pending: InstallEvent | undefined;
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); pending = event as InstallEvent; changed(); });
window.addEventListener('appinstalled', () => { pending = undefined; changed(); });
export const subscribeInstall = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const installAvailable = () => !!pending;
export async function installNova() { const event = pending; if (!event) return false; pending = undefined; changed(); await event.prompt(); return (await event.userChoice).outcome === 'accepted'; }
export function installationRoute(userAgent: string, touchPoints: number, standalone: boolean) {
  if (standalone) return { title: 'Nova is installed', instructions: 'Open Nova from your Home Screen, Dock or applications.' };
  if (/iPhone|iPad|iPod/.test(userAgent) || /Macintosh/.test(userAgent) && touchPoints > 1) return { title: 'Install on iPhone or iPad', instructions: 'In Safari, open Share → Add to Home Screen, then tap Add. Use the same Nova address to connect to this workspace.' };
  if (/Android/.test(userAgent)) return { title: 'Install on Android', instructions: 'Open your browser menu and choose Install app or Add to Home screen.' };
  if (/Macintosh/.test(userAgent) && /Safari/.test(userAgent) && !/Chrome|Chromium|Edg/.test(userAgent)) return { title: 'Install on this Mac', instructions: 'In Safari, choose File → Add to Dock. The desktop companion below is a separate optional connection for computer access.' };
  return { title: 'Install Nova', instructions: 'Use the install icon in Chrome or Edge’s address bar, or choose Install from the browser menu. If your browser does not support installation, Nova still works in a tab.' };
}
