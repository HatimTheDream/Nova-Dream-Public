import { apiFailure, clientHeaders } from './api';
import { useEffect, useRef, useState } from 'react';
import type { BackupSummary, RecoveryReview } from '../../../packages/domain/workspace-backup';
import { RecoveryConnections } from './RecoveryConnections';
import { backupMaxBytes } from '../../../packages/domain/workspace-backup';
import { request, readLocal, saveLocal } from './api';
import './backup-settings.css';

type Job = { id: string; kind: 'export' | 'inspect' | 'restore'; state: 'working' | 'ready' | 'failed' | 'removed'; createdAt: string; summary?: BackupSummary; message?: string; bytes?: number };
type Host = { active: boolean; switching: boolean; error?: string };
type Kept = { id: string; kind: Job['kind']; uploadId?: string; reviewId?: string };
const size = (bytes: number) => bytes < 1024*1024 ? `${Math.ceil(bytes/1024)} KB` : `${(bytes/(1024*1024)).toFixed(1)} MB`;
export function BackupSettings({ epoch, deviceId, refreshRevision = 0, remoteHost = false }: { epoch: string; deviceId: string; refreshRevision?: number; remoteHost?: boolean }) {
  const journal = 'e3:backup-request:' + deviceId;
  const [jobs, setJobs] = useState<Job[]>([]), [pending, setPending] = useState<Kept | undefined>(() => readLocal(journal));
  const [password, setPassword] = useState(''), [confirm, setConfirm] = useState(''), [restorePassword, setRestorePassword] = useState('');
  const reviewKey = 'e3:backup-review:' + deviceId;
  const [keptReview] = useState(() => readLocal<{ epoch: string; uploadId?: string; reviewId?: string }>(reviewKey));
  const [file, setFile] = useState<File>(), [uploadId, setUploadId] = useState<string | undefined>(keptReview?.epoch === epoch ? keptReview.uploadId : undefined), [reviewId, setReviewId] = useState<string | undefined>(keptReview?.epoch === epoch ? keptReview.reviewId : undefined);
  const [host, setHost] = useState<Host>(), [switchTarget, setSwitchTarget] = useState<string>(), [switching, setSwitching] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryReview>();
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [removeId, setRemoveId] = useState<string>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [recoveryUrl, setRecoveryUrl] = useState('');
  const active = useRef(false);
  const load = async () => {
    const result = await request<{ jobs: Job[]; host?: Host; recovery: RecoveryReview }>('storage/backups'); setJobs(result.jobs); setHost(result.host); setRecovery(result.recovery);
    if (pending && result.jobs.some(job => job.id === pending.id)) { saveLocal(journal, null); setPending(undefined); }
    return result.jobs;
  };
  const needsPoll = jobs.some(job => job.state === 'working') || !!pending;
  useEffect(() => {
    let alive = true;
    const poll = async () => { try { const result = await request<{ jobs: Job[]; host?: Host; recovery: RecoveryReview }>('storage/backups'); if (alive) { setJobs(result.jobs); setHost(result.host); setRecovery(result.recovery); } } catch { /* Explicit reload keeps errors actionable. */ } };
    void poll(); const timer = needsPoll ? setInterval(poll, 2000) : undefined;
    return () => { alive = false; clearInterval(timer); };
  }, [epoch, deviceId, needsPoll, refreshRevision]);
  useEffect(() => {
    if (!switching) return;
    let alive = true, checking = false;
    const started = Date.now();
    const timer = setInterval(async () => {
      if (!alive || checking) return; checking = true;
      try {
        await request('session', {});
        const snapshot = await request<{ epoch: string }>('snapshot');
        if (alive && snapshot.epoch !== epoch) { window.location.reload(); return; }
        if (alive && Date.now() - started > 30000) { setSwitching(false); setError('The switch is not confirmed. Reload to check the selected workspace; both saved copies are kept.'); }
      } catch { if (alive && Date.now() - started > 30000) { setSwitching(false); setError('The service has not reconnected. Reload to check the selected workspace; both saved copies are kept.'); } }
      finally { checking = false; }
    }, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [switching, epoch]);
  const switchWorkspace = async () => {
    if (!switchTarget || active.current) return;
    active.current = true; setBusy(true); setError('');
    try { await request('storage/backups/' + (switchTarget === 'original' ? 'return' : 'activate'), { requestId: crypto.randomUUID(), epoch, ...(switchTarget === 'original' ? {} : { recoveryId: switchTarget }) }); setSwitchTarget(undefined); setSwitching(true); }
    catch (e) { setError(e instanceof Error ? e.message : 'The switch is not confirmed. Reload to check your workspace.'); }
    finally { active.current = false; setBusy(false); }
  };
  const backupBusy = switching || busy || jobs.some(job => job.state === 'working');
  const working = backupBusy || recoveryBusy;
  const perform = async (kind: Job['kind'], passphrase: string, extra: { uploadId?: string; reviewId?: string } = {}) => {
    if (active.current) return;
    const kept: Kept = pending ?? { id: crypto.randomUUID(), kind, ...extra };
    if (kept.kind !== kind) { setError('Check the earlier backup request first.'); return; }
    if (!saveLocal(journal, kept)) { setError('Free browser storage before starting. Your saved workspace is unchanged.'); return; }
    setPending(kept); active.current = true; setBusy(true); setError('');
    try {
      const job = await request<Job>(`storage/backups/${kind === 'export' ? 'create' : kind}`, { requestId: kept.id, epoch, passphrase, ...(kept.uploadId ? { uploadId: kept.uploadId } : {}), ...(kept.reviewId ? { reviewId: kept.reviewId } : {}) });
      setJobs(previous => [job, ...previous.filter(j => j.id !== job.id)]); saveLocal(journal, null); setPending(undefined);
      if (kind === 'inspect') { setReviewId(job.id); saveLocal(reviewKey, { epoch, uploadId: kept.uploadId, reviewId: job.id }); }
      if (kind === 'export') { setPassword(''); setConfirm(''); }
      if (kind === 'restore') setRestorePassword('');
    } catch (e) { setError(e instanceof Error ? e.message : 'The response was interrupted. Check the original request.'); }
    finally { active.current = false; setBusy(false); }
  };
  const inspect = async () => {
    if ((!file && !uploadId) || active.current) return;
    setBusy(true); active.current = true; setError('');
    let id = uploadId;
    try {
      if (!id && file) {
        if (file.size > backupMaxBytes) throw new Error('Choose a backup smaller than 384 MB.');
        const transfer = file.size > 2 * 1024 * 1024 ? await (await import('./upload-body')).uploadBody('storage/backups/upload', file.slice(0, file.size, 'application/octet-stream'), epoch) : undefined;
        const response = await fetch('/api/storage/backups/upload', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', ...clientHeaders(), ...transfer, 'X-Edition3-Epoch': epoch }, body: transfer ? undefined : file, signal: AbortSignal.timeout(120000) });
        const result = await response.json(); if (!response.ok) throw apiFailure(result, response.status); id = result.uploadId; setUploadId(id); saveLocal(reviewKey, { epoch, uploadId: id });
      }
      active.current = false; await perform('inspect', restorePassword, { uploadId: id });
    } catch (e) { setError(e instanceof Error ? e.message : 'Select the backup again.'); }
    finally { active.current = false; setBusy(false); }
  };
  const review = jobs.find(j => j.id === reviewId && j.kind === 'inspect' && j.state === 'ready');
  const check = async () => { setError(''); try { const found = await load(); if (pending && !found.some(j => j.id === pending.id)) setError('The host has no saved operation for this request. Re-enter its password and retry the same action.'); } catch (e) { setError(e instanceof Error ? e.message : 'Reconnect to check the operation.'); } };
  return <section className="card settings-card backup-settings"><div className="section-heading"><h2>Backup & recovery</h2><button onClick={() => void check()}>Refresh</button></div>
    {recovery && host?.active && <RecoveryConnections review={recovery} epoch={epoch} deviceId={deviceId} refresh={load} blocked={backupBusy} onBusy={setRecoveryBusy}/>}
    <details><summary>Create a backup</summary><p>Save an encrypted copy of your workspace, character, progress and files. Finish saving in other windows first.</p><form className="backup-form" onSubmit={event => { event.preventDefault(); if (password !== confirm) { setError('The passwords must match.'); return; } void perform('export', password); }}>
      <label>Backup password<input type="password" autoComplete="new-password" minLength={12} maxLength={256} required value={password} onChange={e => setPassword(e.target.value)}/></label>
      <label>Confirm password<input type="password" autoComplete="new-password" minLength={12} maxLength={256} required value={confirm} onChange={e => setConfirm(e.target.value)}/></label>
      <p className="metadata">Use at least 12 characters and keep the password somewhere safe. It is never saved by Nova Dream and is required to recover this backup.</p>
      <button className="primary" disabled={working || !!pending && pending.kind !== 'export'}>Create encrypted backup</button>
    </form></details>
    <details><summary>Recover from a backup</summary><form className="backup-form" onSubmit={event => { event.preventDefault(); void inspect(); }}>
      <label>Backup file<input type="file" accept=".novabackup" disabled={working} onChange={e => { setFile(e.target.files?.[0]); setUploadId(undefined); setReviewId(undefined); saveLocal(reviewKey, null); }}/></label>
      {uploadId && !file && <p className="metadata">Your uploaded backup and review are kept. Re-enter its password to continue.</p>}<label>Backup password<input type="password" autoComplete="off" minLength={12} maxLength={256} required value={restorePassword} onChange={e => setRestorePassword(e.target.value)}/></label>
      <button disabled={(!file && !uploadId) || working || !!pending && pending.kind !== 'inspect'}>Check backup</button>
    </form>{review?.summary && <div className="backup-review"><h3>Review this backup</h3><Summary value={review.summary}/><p>Recovery creates a separate copy for inspection. Your current workspace stays in place. Connected accounts, agent runs and routines remain paused in that copy.</p><button className="primary" disabled={working || restorePassword.length < 12 || !!pending} onClick={() => void perform('restore', restorePassword, { uploadId, reviewId: review.id })}>Restore separate copy</button></div>}</details>
    {switchTarget && <div className="notice"><p>{switchTarget === 'original' ? 'Return to your original workspace? Edits in this recovered copy will stay saved here.' : 'Use this recovered copy in the main app? Finish saving in other windows. Active work will stop during the switch. Local editing becomes available; accounts, Assistant and routines remain paused. The original workspace stays available.'}</p><button className="primary" disabled={working} onClick={() => void switchWorkspace()}>{switchTarget === 'original' ? 'Return to original workspace' : 'Use this recovered copy'}</button><button disabled={working} onClick={() => setSwitchTarget(undefined)}>Keep current workspace</button></div>}
    {switching && <p role="status">Switching workspace… This window will reload when the saved copy is ready.</p>}
    {host?.error && <p role="alert">{host.error}</p>}
    {host?.active && <p><button disabled={working} onClick={() => setSwitchTarget('original')}>Return to original workspace</button></p>}
    {pending && <div className="notice"><p>A request is awaiting confirmation. Its password has not been saved.</p><button disabled={busy} onClick={() => void check()}>Check original request</button><button disabled={busy} onClick={() => { saveLocal(journal, null); setPending(undefined); }}>Keep work and clear local request</button></div>}
    {removeId && <div className="notice"><p>Remove this prepared download copy from this computer? Keep a downloaded copy and its password first. Your workspace and downloaded files stay unchanged.</p><button disabled={busy} onClick={async () => { setBusy(true); try { await request('storage/backups/remove', { requestId: crypto.randomUUID(), epoch, backupId: removeId }); setRemoveId(undefined); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Removal is unconfirmed.'); } finally { setBusy(false); } }}>Remove prepared copy</button><button onClick={() => setRemoveId(undefined)}>Keep it</button></div>}
    {error && <p role="alert" className="field-error">{error}</p>}
    <div aria-live="polite">{jobs.some(j => j.state === 'working') && <p>Preparing and verifying… You can keep using the workspace.</p>}</div>
    {jobs.length > 0 && <ul className="backup-jobs">{jobs.filter(j => j.kind !== 'inspect' && j.state !== 'removed').slice(0,10).map(job => <li key={job.id}><div><strong>{job.kind === 'export' ? 'Encrypted backup' : 'Recovered workspace'}</strong><p className="metadata">{new Date(job.createdAt).toLocaleString()} · {job.state === 'working' ? 'Preparing' : job.state === 'ready' ? 'Verified' : 'Needs attention'}{job.bytes ? ` · ${size(job.bytes)}` : ''}</p>{job.message && <p>{job.message}</p>}{job.summary && <details><summary>Included work</summary><Summary value={job.summary}/></details>}{host && job.kind === 'restore' && job.state === 'ready' && <button disabled={working} onClick={() => setSwitchTarget(job.id)}>Use recovered workspace</button>}{job.kind === 'export' && job.state === 'ready' && <button className="text-button" onClick={() => setRemoveId(job.id)}>Remove local copy</button>}</div>{job.state === 'ready' && (job.kind === 'export' ? <a className="button" href={`/api/storage/backups/${job.id}/download`} download>Download backup</a> : !remoteHost && <button disabled={working} onClick={async () => { setBusy(true); setError(''); try { const result = await request<{ origin: string }>('storage/backups/open', { requestId: crypto.randomUUID(), epoch, recoveryId: job.id }, undefined, 30000); setRecoveryUrl(result.origin); } catch (e) { setError(e instanceof Error ? e.message : 'Recovery preview is unavailable.'); } finally { setBusy(false); } }}>Open recovered copy</button>)}</li>)}</ul>}
    {jobs.filter(j => j.kind === 'inspect' && j.state === 'failed').slice(0,1).map(job => <p className="field-error" role="alert" key={job.id}>{job.message}</p>)}
    {recoveryUrl && <p><a href={recoveryUrl} target="_blank" rel="noopener noreferrer">View recovered workspace</a> · Opens a separate window with changes paused.</p>}
    <details><summary>Coverage and recovery limits</summary><p>Browser-only writing and staged uploads remain on their original device. Separately hosted Assistant history and external Work folders need their own backups. Each verified archive lists its actual Assistant coverage.</p><p>Restoring prepares a review copy. After review, use the recovered copy in the main app. A return action keeps your original workspace available. Reconnecting accounts and Assistant history remains a separate recovery step. Keep the original backup until that review is complete.</p></details>
  </section>;
}
function Summary({ value }: { value: BackupSummary }) {
  return <><p className="metadata">Nova Dream {value.version} · {new Date(value.createdAt).toLocaleString()}</p><dl className="backup-counts">{Object.entries(value.counts).filter(([kind]) => kind !== 'layout').map(([kind, count]) => <div key={kind}><dt>{kind === 'profile' ? 'Profiles' : kind.charAt(0).toUpperCase() + kind.slice(1) + 's'}</dt><dd>{count.toLocaleString()}</dd></div>)}<div><dt>Files</dt><dd>{value.files} · {size(value.fileBytes)}</dd></div><div><dt>History entries</dt><dd>{value.history.toLocaleString()}</dd></div></dl><p>Assistant archive: {value.native === 'included' ? 'Included' : value.native === 'separate-host' ? 'Separate host — not included' : 'Not configured'}</p><ul>{value.notes.map(note => <li key={note}>{note}</li>)}</ul></>;
}
