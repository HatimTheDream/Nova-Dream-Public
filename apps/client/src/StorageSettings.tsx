import { BackupSettings } from './BackupSettings';
import { ImportSettings } from './ImportSettings';
import { useEffect, useRef, useState } from 'react';
import { ApiError, readLocal, request, saveLocal } from './api';

type State = { protection: 'file' | 'os' | 'server'; verified: boolean; protectedCopy: boolean; provider: 'macos-keychain' | 'windows-dpapi' | 'server-secret' | 'unavailable' };
type Pending = { requestId: string; epoch: string };
export function StorageSettings({ epoch, deviceId, remoteHost = false }: { epoch: string; deviceId: string; remoteHost?: boolean }) {
  const [state, setState] = useState<State>();
  const key = 'e3:protect-key:' + deviceId;
  const [pending, setPending] = useState<Pending | undefined>(() => readLocal(key));
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const active = useRef(false);
  useEffect(() => { let alive = true; void request<State>('storage/state').then(value => { if (alive) setState(value); }, () => { if (alive) setMessage('Storage status is unavailable. Reconnect to your workspace host.'); }); return () => { alive = false; }; }, []);
  const protect = async () => {
    if (active.current) return;
    const operation = pending ?? { requestId: crypto.randomUUID(), epoch };
    if (!saveLocal(key, operation)) { setMessage('Free browser storage before starting key protection.'); return; }
    setPending(operation); active.current = true; setBusy(true); setMessage('');
    try { setState(await request<State>('storage/protect', operation, undefined, 60000)); saveLocal(key, null); setPending(undefined); setMessage('The workspace key is protected and verified.'); }
    catch (error) {
      setMessage(error instanceof Error ? error.message : 'Protection is unconfirmed. Retry to check the original change.');
      if (error instanceof ApiError && error.status && error.status < 500) { saveLocal(key, null); setPending(undefined); }
    } finally { active.current = false; setBusy(false); }
  };
  const provider = state?.provider === 'macos-keychain' ? 'Mac Keychain' : state?.provider === 'windows-dpapi' ? 'Windows account protection' : state?.provider === 'server-secret' ? 'Server credential' : 'Operating system';
  const protectedKey = state?.protection === 'os' || state?.protection === 'server';
  const [backupRevision,setBackupRevision] = useState(0);
  return <><section className="card settings-card"><h2>Workspace storage</h2><div className="setting-row"><div><strong>{protectedKey ? `${provider} · ${state.verified ? 'verified' : 'protected'}` : state?.protectedCopy ? 'Protected copy kept · finish setup' : 'Local key file'}</strong><p>{protectedKey ? state?.protection === 'server' ? 'A separate server credential protects the active workspace key. Your browser does not receive that credential.' : 'Your operating system protects the active key for encrypted workspace records and files.' : 'Protect your workspace key with this computer’s signed-in account. The existing key stays until the protected copy is verified.'}</p></div>{(!protectedKey || pending) && <button disabled={busy || !state || state.provider === 'unavailable'} onClick={() => void protect()}>{busy ? 'Verifying…' : pending ? 'Retry protection' : 'Protect key'}</button>}</div>{state?.provider === 'unavailable' && <p>This host needs Mac Keychain, Windows account protection, or a separately configured server credential.</p>}{message && <p role="status">{message}</p>}<details><summary>What this protects</summary><p>Mac Keychain protects the workspace key under this app’s identity. Windows protection is tied to your Windows account; other applications running as you may access it. Browser drafts and the Assistant’s native storage have their own storage boundaries.</p><p>Keep the server credential outside workspace data, with a separate protected copy. Server administrators can use it to unlock the workspace.</p><p>Existing recovery copies may retain an earlier key file. Protecting the active key is separate from backing up your work. Use Backup & recovery below to export and review a separate recovered copy.</p></details></section><ImportSettings epoch={epoch} deviceId={deviceId} onPrepared={()=>setBackupRevision(n=>n+1)}/><BackupSettings remoteHost={remoteHost} epoch={epoch} deviceId={deviceId} refreshRevision={backupRevision}/></>;
}
