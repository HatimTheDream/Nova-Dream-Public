import { BackupSettings } from './BackupSettings';
import { ImportSettings } from './ImportSettings';
import { useEffect, useRef, useState } from 'react';
import { ApiError, readLocal, request, saveLocal } from './api';

type State = { protection: 'file' | 'os' | 'server'; verified: boolean; protectedCopy: boolean; provider: 'macos-keychain' | 'windows-dpapi' | 'server-secret' | 'unavailable' };
type Pending = { requestId: string; epoch: string };
export function StorageSettings({ epoch, deviceId, remoteHost = false }: { epoch: string; deviceId: string; remoteHost?: boolean }) {
  const [state, setState] = useState<State>();
  const key = 'e3:protect-key:' + deviceId;
  const readPending = () => { const kept = readLocal<Pending>(key); return kept?.epoch === epoch ? kept : undefined; };
  const [pending, setPending] = useState(readPending);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [statusRevision, setStatusRevision] = useState(0);
  const active = useRef(false);
  const context = useRef(''); context.current = `${epoch}:${deviceId}`;
  useEffect(() => { let alive = true; const abort = new AbortController(); setState(undefined); setMessage(''); setBusy(false); setPending(readPending()); void request<State>('storage/state', undefined, abort.signal).then(value => { if (alive) setState(value); }, () => { if (alive) setMessage('Storage status is unavailable. Reconnect to your workspace host.'); }); return () => { alive = false; abort.abort(); }; }, [epoch, deviceId, statusRevision]);
  const protect = async () => {
    if (active.current) return;
    const current = () => context.current === `${epoch}:${deviceId}`;
    const operation = pending?.epoch === epoch ? pending : { requestId: crypto.randomUUID(), epoch };
    const clear = () => { if (readLocal<Pending>(key)?.requestId === operation.requestId) saveLocal(key, null); if (current()) setPending(undefined); };
    if (!saveLocal(key, operation)) { setMessage('Free browser storage before starting key protection.'); return; }
    setPending(operation); active.current = true; setBusy(true); setMessage('');
    try { const result = await request<State>('storage/protect', operation, undefined, 60000); clear(); if (current()) { setState(result); setMessage('The workspace key is protected and verified.'); } }
    catch (error) {
      if (current()) setMessage(error instanceof Error ? error.message : 'Protection is unconfirmed. Retry to check the original change.');
      if (error instanceof ApiError && error.status && error.status < 500) clear();
    } finally { active.current = false; if (current()) setBusy(false); }
  };
  const provider = state?.provider === 'macos-keychain' ? 'Mac Keychain' : state?.provider === 'windows-dpapi' ? 'Windows account protection' : state?.provider === 'server-secret' ? 'Server credential' : 'Operating system';
  const protectedKey = state?.protection === 'os' || state?.protection === 'server';
  const [backupRevision,setBackupRevision] = useState(0);
  return <>
    <BackupSettings remoteHost={remoteHost} epoch={epoch} deviceId={deviceId} refreshRevision={backupRevision}/>
    <ImportSettings epoch={epoch} deviceId={deviceId} onPrepared={()=>setBackupRevision(n=>n+1)}/>
    <section className="card settings-card"><div className="setting-row"><div><h2>Security</h2><p role="status">{!state ? message ? 'Status unavailable' : 'Checking security…' : protectedKey ? state.verified ? 'Protected and verified' : 'Protection not verified' : state.protectedCopy ? 'Protected copy kept · finish setup' : 'Local key file'}</p></div>{!state && message && <button onClick={() => setStatusRevision(value => value + 1)}>Retry status</button>}{state && (!protectedKey || pending) && <button disabled={busy || state.provider === 'unavailable'} onClick={() => void protect()}>{busy ? 'Verifying…' : pending ? 'Retry protection' : 'Protect key'}</button>}</div>
      {state && !protectedKey && <p>Protect your workspace key with this computer’s signed-in account. The existing key stays until the protected copy is verified.</p>}
      {state?.provider === 'unavailable' && <p>This host needs Mac Keychain, Windows account protection, or a separately configured server credential.</p>}
      {pending && !busy && <p className="notice" role="status">Protection is unconfirmed. {state ? 'Retry to check the original change.' : 'Reconnect to check its status.'}</p>}
      {message && <p role="status">{message}</p>}
      <details className="settings-details"><summary>Protection details</summary>
        {protectedKey && <p>{provider} protects encrypted workspace records and files. Browser drafts and Assistant history have separate storage boundaries.</p>}
        <p>Windows protection uses your signed-in account; other apps running as you may access it. Mac Keychain uses Nova’s identity.</p>
        <p>Keep the server credential and its protected backup outside workspace data. Server administrators can unlock the workspace; browsers never receive the credential.</p>
        <p>Older backups may contain the earlier key. Key protection does not replace backups.</p>
      </details>
    </section>
  </>;
}
