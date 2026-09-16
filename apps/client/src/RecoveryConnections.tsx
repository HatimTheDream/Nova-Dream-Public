import { useEffect, useState } from 'react';
import type { RecoveryReview } from '../../../packages/domain/workspace-backup';
import { ApiError, readLocal, request, saveLocal } from './api';

export function RecoveryConnections({ review, epoch, deviceId, refresh, blocked, onBusy }: { review: RecoveryReview; epoch: string; deviceId: string; refresh: () => Promise<unknown>; blocked: boolean; onBusy: (busy: boolean) => void }) {
  const key = `e3:recovery-connections:${epoch}:${deviceId}`;
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [waiting, setWaiting] = useState(false);
  useEffect(() => { onBusy(busy || waiting); return () => onBusy(false); }, [busy, waiting, onBusy]);
  useEffect(() => {
    if (!waiting) return;
    let active = true, pending = false;
    const deadline = Date.now() + 30000;
    const timer = setInterval(async () => {
      if (!active || pending) return; pending = true;
      try {
        const result = await request<{ recovery: RecoveryReview; host?: { switching: boolean } }>('storage/backups');
        if (active && result.recovery.completed && !result.host?.switching) { saveLocal(key, null); location.reload(); return; }
      } catch { /* Wait for the same host to finish restarting. */ }
      finally { pending = false; }
      if (active && Date.now() > deadline) { setWaiting(false); setError('Setup is not confirmed. Refresh this review; the original request and saved work are kept.'); }
    }, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [waiting, key]);
  const prepare = async () => {
    if (blocked || busy || waiting) return;
    const command = readLocal<object>(key) ?? { requestId: crypto.randomUUID(), epoch, fingerprint: review.fingerprint, confirmNewConnections: true };
    if (!saveLocal(key, command)) { setError('Free browser storage before continuing. Your saved work is kept.'); return; }
    setBusy(true); setError('');
    try { await request('storage/recovery/resume', command); setWaiting(true); }
    catch (e) {
      if (e instanceof ApiError && ['recovery_review_changed', 'epoch_changed'].includes(e.code)) { saveLocal(key, null); setConfirm(false); await refresh(); }
      if (!(e instanceof ApiError)) setWaiting(true);
      setError(e instanceof Error ? e.message : 'Setup is unconfirmed. Check the original request before retrying.');
    } finally { setBusy(false); }
  };
  if (!review.available && !review.completed) return null;
  return <div className="backup-review"><h3>Connections after recovery</h3>
    {review.completed ? <p>Connection setup is available again. Sign into your accounts and connect the Assistant in Settings. Review paused routines before enabling them. Earlier chats and unconfirmed operations remain preserved.</p> : <>
      <p>This copy has {review.accounts} account connections, {review.taskRoutines + review.agentRoutines} active routines and {review.queuedMessages} queued messages. It preserves {review.savedConversations} conversations and {review.unconfirmedRuns} unconfirmed runs.</p>
      <p>Set up connections again to use this workspace normally. Accounts will require sign-in; routines and queued messages will stay paused. Earlier chats remain saved reading copies, and their original Assistant archives are kept in future backups.</p>
      {confirm ? <><p>Continue with new connection setup? No earlier message, agent run or external action will be sent again.</p><div className="button-row"><button className="primary" disabled={blocked || busy || waiting} onClick={() => void prepare()}>Prepare connection setup</button><button disabled={busy || waiting} onClick={() => setConfirm(false)}>Keep paused</button></div></> : <button disabled={blocked || busy || waiting} onClick={() => setConfirm(true)}>Set up connections again</button>}
    </>}
    {waiting && <p role="status">Restarting this recovered workspace…</p>}
    {error && <p role="alert" className="field-error">{error}</p>}
    {error && <button disabled={busy || waiting} onClick={() => void refresh()}>Refresh recovery review</button>}
  </div>;
}
