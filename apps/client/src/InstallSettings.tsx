import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AccessContext } from '../../../packages/domain/phone';
import type { CompanionChallenge, CompanionDevice } from '../../../packages/domain/companion';
import { computerAccessActive } from '../../../packages/domain/companion';
import { request, readLocal, saveLocal, ApiError } from './api';
import { installationRoute, installAvailable, installNova, subscribeInstall } from './install';
import { Dialog } from './ui';
import type { AppIconChoice } from '../../../packages/domain/contracts';
import { NovaAppMark } from './AppIcon';
import { startPolling } from './polling';

type NativeCompanion = { linked(): Promise<{ deviceId: string; epoch: string } | null>; prepareLink(challenge: CompanionChallenge): Promise<Record<string, unknown>>; finishLink(value: { epoch: string; deviceId: string }): Promise<void>; openControls(): Promise<void> };
import { downloadCompanion, type CompanionDownload as Download } from './companion-download';
const size = (value?: number) => value === undefined ? 'Unavailable' : value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${Math.round(value / 1024 / 1024)} MB`;
export function InstallSettings({ epoch, access, appIcon, active = true }: { epoch: string; access?: AccessContext; appIcon: AppIconChoice; active?: boolean }) {
  const available = useSyncExternalStore(subscribeInstall, installAvailable);
  const [installed, setInstalled] = useState(() => matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone);
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [devices, setDevices] = useState<CompanionDevice[]>(), [downloads, setDownloads] = useState<Download[]>([]);
  const [deviceError, setDeviceError] = useState(false);
  const [storage, setStorage] = useState<{ usage?: number; quota?: number; persistent?: boolean }>();
  const acting = useRef(false), downloading = useRef<AbortController | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number>();
  useEffect(() => () => downloading.current?.abort(), []);
  const [linked, setLinked] = useState(false);
  const [remove, setRemove] = useState<CompanionDevice>();
  const native = (window as Window & { novaCompanion?: NativeCompanion }).novaCompanion;
  useEffect(() => { setDevices(undefined); setDownloads([]); setDeviceError(false); }, [epoch]);
  useEffect(() => { void native?.linked().then(value => setLinked(value?.epoch === epoch), () => setLinked(false)); }, [native, epoch]);
  const route = native ? { title: 'Desktop companion', instructions: 'Link this computer, then choose selected apps or full desktop access in Desktop controls.' } : installationRoute(navigator.userAgent, navigator.maxTouchPoints, installed);
  useEffect(() => { const changed = () => setInstalled(true); window.addEventListener('appinstalled', changed); return () => window.removeEventListener('appinstalled', changed); }, []);
  const readStorage = async () => { try { const estimate = await navigator.storage?.estimate(); const persistent = await navigator.storage?.persisted?.(); setStorage({ ...estimate, persistent }); } catch { setStorage({}); } };
  const refresh = async () => { const state = await request<{ devices: CompanionDevice[]; downloads?: Download[] }>('companions/state'); setDevices(state.devices); setDownloads(state.downloads ?? []); void native?.linked().then(value => setLinked(value?.epoch === epoch), () => setLinked(false)); };
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const abort = new AbortController();
    const stop = startPolling({ interval: () => 10000, read: async () => {
      try {
        const state = await request<{ devices: CompanionDevice[]; downloads?: Download[] }>('companions/state', undefined, abort.signal);
        if (alive) { setDeviceError(false); setDevices(state.devices); setDownloads(state.downloads ?? []); void native?.linked().then(value => { if (alive) setLinked(value?.epoch === epoch); }, () => { if (alive) setLinked(false); }); }
        return true;
      } catch { if (alive) setDeviceError(true); return false; }
    } });
    void readStorage();
    return () => { alive = false; stop(); abort.abort(); };
  }, [epoch, active]);
  const act = async (work: () => Promise<void>) => { if (acting.current) return; acting.current = true; setBusy(true); setMessage(''); try { await work(); } catch (error) { setMessage(error instanceof Error ? error.message : 'This action could not be confirmed.'); } finally { acting.current = false; setBusy(false); } };
  return <>
    <section className="card settings-card"><div className="install-summary"><NovaAppMark choice={appIcon} width="44" height="44"/><div><h2>{route.title}</h2><p>{route.instructions}</p></div></div>{available && !installed && <button className="primary" disabled={busy} onClick={() => void act(async () => { const accepted = await installNova(); setMessage(accepted ? 'Installation accepted. Open Nova from your device’s app list.' : 'You can install Nova later.'); })}>Install Nova</button>}</section>
    <section className="card settings-card"><h2>Computers</h2>
      {deviceError && <p className="notice" role="status">Computer status is unavailable.{devices && ' Showing last known access.'}</p>}
      {devices?.filter(d => !d.revokedAt).map(device => <div className="setting-row" key={device.id}><div><strong>{device.name}</strong><p>{device.connected ? 'Connected' : 'Offline'} · {computerAccessActive(device.enabledUntil) ? `${device.scope === 'desktop' ? 'full desktop' : 'selected apps'} · ${device.enabledUntil === null ? 'until turned off' : 'until '+new Date(device.enabledUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'computer access off'}{device.apps.length ? ` · ${device.apps.join(', ')}` : ''}</p></div><button disabled={busy} onClick={() => setRemove(device)}>Revoke link</button></div>)}
      {!devices ? !deviceError && <p role="status">Checking computers…</p> : !devices.some(d => !d.revokedAt) && <p className="metadata">No computers linked.</p>}
      {downloadProgress !== undefined && <p className="metadata"><span role="status">Downloading and verifying: {downloadProgress}% </span><button onClick={() => downloading.current?.abort()}>Cancel download</button></p>}
      <details className="settings-details"><summary>Computer link options</summary><p>Link a computer for local apps and files. The companion must be open with access enabled.</p>
      {native ? <div className="button-row"><button className="primary" disabled={busy || linked} onClick={() => void act(async () => { const key = 'nova-desktop-link:' + epoch;
        let command = readLocal<Record<string, unknown>>(key);
        if (!command) {
          const challenge = await request<CompanionChallenge>('companions/challenge', { requestId: crypto.randomUUID(), epoch });
          const prepared = await native.prepareLink(challenge);
          command = { requestId: crypto.randomUUID(), epoch, challengeId: challenge.id, ...prepared };
          if (!saveLocal(key, command)) throw new Error('Allow device storage before linking this desktop.');
        }
        const value = await request<{ epoch: string; deviceId: string }>('companions/link', command).catch(error => { if (error instanceof ApiError && error.code === 'companion_unlinked') localStorage.removeItem(key); throw error; });
        await native.finishLink(value); localStorage.removeItem(key); setLinked(true); await refresh(); setMessage('Desktop linked. Open Desktop controls to choose its access and duration.'); })}>{linked ? 'Desktop linked' : 'Link this desktop'}</button><button disabled={busy} onClick={() => void act(() => native.openControls())}>Desktop controls</button></div> : downloads.length ? <div className="install-downloads">{downloads.map(file => <div key={file.name}><button disabled={busy} onClick={() => void act(async () => { const controller = new AbortController(); downloading.current = controller; setDownloadProgress(0); try { await downloadCompanion(file, setDownloadProgress, controller.signal); setMessage('Download verified. Unzip it and open Nova Dream Desktop.'); } finally { downloading.current = null; setDownloadProgress(undefined); } })}>{file.platform === 'darwin' ? 'Download for Mac' : file.platform === 'win32' ? 'Download for Windows' : 'Download for Linux'} · {file.arch}</button><p className="metadata">{file.version} · {size(file.bytes)} · {file.signing === 'local-ad-hoc' ? 'Private local build; not notarized' : file.signing}</p><details><summary>Verify download</summary><p className="preserve-lines">SHA-256: {file.sha256}</p></details></div>)}</div> : <p className="notice">No desktop download is available yet. Continue using Nova in your browser.</p>}
      <p className="metadata">Linking alone grants no access. Choose access and duration in Desktop controls; it may persist across restarts. Stop access there or revoke the link here.</p></details>
    </section>
    <details className="settings-disclosure"><summary>Storage on this device</summary><div className="settings-disclosure-body"><p>Drafts and pending uploads stay on this device; saved records stay on your host. Keep editors open during disconnection to retain unsaved writing.</p><div className="setting-row"><div><strong>{size(storage?.usage)} used{storage?.quota ? ` · ${size(storage.quota)} site quota` : ''}</strong><p>{storage?.persistent ? 'This browser has granted persistent storage.' : 'The browser may clear storage when space runs low. Clearing site data removes local drafts.'}</p></div>{navigator.storage?.persist && !storage?.persistent && <button disabled={busy} onClick={() => void act(async () => { const kept = await navigator.storage.persist(); await readStorage(); setMessage(kept ? 'Persistent storage is enabled for this device.' : 'The browser did not grant persistent storage. Your current drafts are unchanged.'); })}>Keep device storage</button>}</div><p className="metadata">Installation does not make AI, mail or all workspace screens available offline.</p></div></details>
    {message && <p className="notice" role="status">{message}</p>}
    {remove && <Dialog title={`Revoke ${remove.name}?`} close={() => setRemove(undefined)}><p>Stop new computer actions. Saved work stays intact; completed actions cannot be undone.</p><div className="button-row"><button onClick={() => setRemove(undefined)}>Keep link</button><button className="primary" disabled={busy} onClick={() => void act(async () => { await request('companions/revoke', { epoch, requestId: crypto.randomUUID(), deviceId: remove.id }); setRemove(undefined); await refresh(); })}>Revoke link</button></div></Dialog>}
  </>;
}
