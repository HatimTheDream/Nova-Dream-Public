import { useEffect, useRef, useState } from 'react';
import type { UpdateInstallRequest, UpdateStatus } from '../../../packages/domain/software-update';
import { ApiError, readLocal, request, saveLocal } from './api';
import { pollReader } from './polling';
import { RefreshReader } from './refresh-reader';

type JobState = NonNullable<UpdateStatus['job']>['state'];
const stages: Record<JobState, string> = {
  waiting: 'Waiting for current work', downloading: 'Downloading update', verifying: 'Verifying update',
  preparing: 'Preparing recovery', installing: 'Installing update', restarting: 'Restarting',
  checking: 'Checking readiness', completed: 'Updated', restored: 'Previous version restored',
  failed: 'Could not update', cancelled: 'Update cancelled',
};
const activeJob = (status?: UpdateStatus) => !!status?.job && !['completed', 'restored', 'failed', 'cancelled'].includes(status.job.state);
const bytes = (value: number) => value < 1024 * 1024 ? `${Math.round(value / 1024)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
function heading(status?: UpdateStatus, stale = false, pending = false): string {
  if (stale) return status?.job ? 'Reconnecting to update status' : 'Update status unavailable';
  if (pending && !activeJob(status)) return 'Update request unconfirmed';
  if (status?.job && (activeJob(status) || status.availability !== 'available' || (status.release?.releaseId ? status.job.releaseId === status.release.releaseId : status.job.candidateId === status.release?.candidateId))) return stages[status.job.state];
  if (!status?.release && status?.agentUpdate?.state === 'available') return 'OpenClaw update available';
  return !status || status.availability === 'checking' ? 'Checking for updates…'
    : status.availability === 'current' ? 'Up to date' : status.availability === 'available' ? 'Update available'
      : status.availability === 'error' ? 'Could not check for updates' : 'Updates unavailable';
}

// A lost reply retains the same candidate and receipt across navigation/reload.
export function retainedUpdateRequest(value: unknown, epoch: string): UpdateInstallRequest | undefined {
  if (!value || typeof value !== 'object') return;
  const item = value as UpdateInstallRequest;
  if (item.epoch === epoch && typeof item.candidateId === 'string' && (item.releaseId === undefined || typeof item.releaseId === 'string' && /^[a-f0-9]{64}$/.test(item.releaseId)) && typeof item.idempotencyKey === 'string' && (item.when === 'now' || item.when === 'idle')) return { epoch, candidateId: item.candidateId, ...(item.releaseId?{releaseId:item.releaseId}:{}), idempotencyKey: item.idempotencyKey, when: item.when };
}
export function confirmedUpdateReceipt(intent: UpdateInstallRequest, response: UpdateStatus) {
  return response?.job?.candidateId === intent.candidateId && (intent.releaseId === undefined || response.job.releaseId === intent.releaseId) ? response.job : undefined;
}

type ViewProps = {
  status?: UpdateStatus; online: boolean; failed: boolean; restricted?: string; busy?: 'check' | 'install' | 'cancel'; pending: boolean; error?: string; receipt?: string;
  check: () => void; install: () => void; cancel: () => void; retry: () => void;
};

export function SoftwareUpdateView({ status, online, failed, restricted, busy, pending, error, receipt, check, install, cancel, retry }: ViewProps) {
  const stale = !online || failed, job = status?.job, running = activeJob(status);
  const canInstall = !!status?.release && status.availability === 'available' && status.installation.supported && !restricted && !stale && !busy && !running && !pending;
  const agent = status?.installed.agent;
  const agentVersion = stale ? 'Unavailable' : !agent ? 'Checking…' : agent.state === 'ready' ? agent.version ?? 'Version unavailable'
    : agent.state === 'connecting' ? 'Connecting…' : ['unconfigured', 'disconnected'].includes(agent.state) ? 'Not connected' : 'Unavailable';
  const download = job?.state === 'downloading' && job.download && Number.isFinite(job.download.total) && job.download.total > 0 && Number.isFinite(job.download.received) && job.download.received >= 0 ? job.download : undefined;
  const showCancel = !!job && ['waiting', 'downloading', 'verifying'].includes(job.state);
  const canCancel = showCancel && !restricted && !stale && !busy;
  const release = status?.release;
  const novaChanges = !!release && release.novaVersion !== status?.installed.novaVersion;
  const agentChanges = !!release && release.agentVersion !== status?.installed.agent.version;
  const installLabel = novaChanges && agentChanges ? 'Update all' : agentChanges ? `Update ${agent?.name ?? 'agent'}` : 'Update Nova Dream';
  const agentUpdate = status?.agentUpdate;
  const unpreparedAgent = agentUpdate?.state === 'available' && agentUpdate.version !== release?.agentVersion;
  return <div className="software-update-body">
    <dl className="settings-versions software-update-versions" aria-label="Installed versions">
      <div><dt>Nova Dream</dt><dd>{status ? `${stale ? 'Last known: ' : ''}${status.installed.novaVersion}` : online ? 'Checking…' : 'Unavailable'}{novaChanges && <> → {release.novaVersion}</>}</dd></div>
      <div><dt>{agent?.name ?? 'Agent service'}</dt><dd>{agentVersion}{agentChanges ? <> → {release.agentVersion}</> : agentUpdate?.state === 'available' ? <> → {agentUpdate.version}</> : null}</dd></div>
    </dl>
    <section className="software-update-release" aria-label="Update availability">
      <div className="software-update-row"><div><h3 role="status">{heading(status, stale, pending)}</h3>
        {release && <p>Nova Dream {release.novaVersion} · {agent?.name ?? 'Agent service'} {release.agentVersion}</p>}
      </div>{release && !running && !pending && status?.availability === 'available' && <button type="button" className="primary" disabled={!canInstall} onClick={install}>{busy === 'install' ? 'Requesting…' : status.blocker ? `${installLabel} when idle` : installLabel}</button>}
        {showCancel && <button type="button" disabled={!canCancel} onClick={cancel}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel update'}</button>}
      </div>
      {release && !!release.notes.length && <ul className="software-update-notes" aria-label="Release notes">{release.notes.slice(0, 3).map((note, index) => <li key={index}>{note}</li>)}</ul>}
      {release && release.notes.length > 3 && <details className="software-update-more"><summary>More release notes</summary><ul className="software-update-notes">{release.notes.slice(3).map((note, index) => <li key={index}>{note}</li>)}</ul></details>}
      {running && job?.message && <p className="software-update-message">{stale ? 'Last reported: ' : ''}{job.message}</p>}
      {!running && job?.message && ['failed', 'restored'].includes(job.state) && <p className="software-update-message">{job.message}</p>}
      {download && <div className="software-update-download"><progress aria-label={stale ? 'Last reported download progress' : 'Download progress'} max={download.total} value={Math.min(download.received, download.total)}/><span>{stale ? 'Last reported: ' : ''}{bytes(download.received)} of {bytes(download.total)} downloaded</span></div>}
      {status?.blocker && (release || running) && <p className="software-update-message">{status.blocker.message}</p>}
      {!stale && unpreparedAgent && <p className="software-update-message">OpenClaw {agentUpdate.version} is available. A compatible installation package is not yet available for this host.</p>}
      {!stale && agentUpdate?.releaseNotesUrl && <a href={agentUpdate.releaseNotesUrl} target="_blank" rel="noreferrer">OpenClaw release notes</a>}
      {(restricted || status && !status.installation.supported) && <p className="software-update-message">{restricted ?? status?.installation.reason ?? 'Installation is unavailable on this host.'}</p>}
      {!online && <p className="software-update-message">Connect to refresh this host’s update status.</p>}
      {failed && online && <p className="software-update-message">The host could not be reached. The last response is kept; reconnect to confirm the current state.</p>}
      {status && ['error', 'unavailable'].includes(status.availability) && status.error && <p className="software-update-message">{status.error}</p>}
      {pending && <div className="software-update-pending"><p className="software-update-message">The earlier request is saved. Reconcile it before starting another update.</p><button type="button" disabled={!online || !!restricted || !!busy} onClick={retry}>Reconcile update request</button></div>}
      {error && <p className="software-update-message" role="alert">{error}</p>}
      {receipt && <p className="software-update-message" role="status">{receipt}</p>}
    </section>
    <div className="software-update-check"><span>{status?.checkedAt ? `Checked ${new Date(status.checkedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'No successful check yet'}</span><button type="button" disabled={!online || !!restricted || !!busy || status?.availability === 'checking'} onClick={check}>{busy === 'check' || status?.availability === 'checking' ? 'Checking…' : 'Check for updates'}</button></div>
  </div>;
}

export function SoftwareUpdateSettings({ identity, epoch, active, online, restricted }: { identity: string; epoch: string; active: boolean; online: boolean; restricted?: string }) {
  const [open, setOpen] = useState(false), [status, setStatus] = useState<UpdateStatus>();
  const [failed, setFailed] = useState(false), [error, setError] = useState<string>(), [busy, setBusy] = useState<ViewProps['busy']>();
  const [pending, setPending] = useState<UpdateInstallRequest>();
  const [receipt, setReceipt] = useState<string>();
  const context = useRef({ identity, epoch, active, online, restricted }); context.current = { identity, epoch, active, online, restricted };
  const latest = useRef<UpdateStatus>(undefined), intent = useRef<UpdateInstallRequest>(undefined), mutation = useRef<AbortController>(undefined);
  const storageKey = (id: string) => `nova-software-update:${id}`;
  const keep = (value?: UpdateInstallRequest) => { intent.current = value; setPending(value); saveLocal(storageKey(context.current.identity), value ?? null); };
  const [reader] = useState(() => new RefreshReader({
    identity: () => context.current.identity,
    read: signal => request<UpdateStatus>('software-update', undefined, signal),
    accept: value => {
      latest.current = value; setStatus(value); setFailed(false);
    },
    fail: () => setFailed(true),
  }));
  useEffect(() => {
    latest.current = undefined; setStatus(undefined); setFailed(false); setError(undefined); setReceipt(undefined); setBusy(undefined);
    intent.current = retainedUpdateRequest(readLocal(storageKey(identity)), epoch); setPending(intent.current);
    return () => { reader.cancel(); mutation.current?.abort(); mutation.current = undefined; };
  }, [identity, epoch, reader]);
  useEffect(() => {
    if (!active || !online) return;
    if (!open) { if (!latest.current) void reader.poll(); return () => { if (!mutation.current) reader.cancel(); }; }
    const stop = pollReader(reader, () => activeJob(latest.current) || latest.current?.availability === 'checking' || intent.current ? 3000 : 60000);
    return () => { stop(); if (!mutation.current) reader.cancel(); };
  }, [identity, active, online, open, reader]);

  async function act(kind: NonNullable<ViewProps['busy']>, retry = false) {
    if (mutation.current || !context.current.online || context.current.restricted) return;
    const captured = context.current, displayedCandidate = status?.release?.candidateId, displayedRelease = status?.release?.releaseId, selectedWhen = status?.blocker ? 'idle' : 'now';
    const abort = new AbortController(); mutation.current = abort; setBusy(kind); setError(undefined); setReceipt(undefined);
    const current = () => mutation.current === abort && captured.identity === context.current.identity && !abort.signal.aborted;
    try {
      // Refresh first: a reconnect or a second tab may already have admitted the job.
      await reader.refresh();
      if (!current()) return;
      if (reader.failed || !context.current.online) throw new Error('Reconnect to the host before changing this update.');
      const value = latest.current;
      if (kind === 'check') {
        await request('software-update/check', { epoch: captured.epoch }, abort.signal);
      } else if (kind === 'cancel') {
        if (!value?.job || !['waiting', 'downloading', 'verifying'].includes(value.job.state)) return;
        await request('software-update/cancel', { epoch: captured.epoch, jobId: value.job.id }, abort.signal);
      } else {
        if (activeJob(value) && !intent.current) return;
        if (retry && !intent.current) return;
        if (!intent.current) {
          if (value?.availability !== 'available' || !value.release || !value.installation.supported) return;
          if (value.release.candidateId !== displayedCandidate || value.release.releaseId !== displayedRelease) throw new Error('The available update changed. Review its release notes before updating.');
          const next: UpdateInstallRequest = { epoch: captured.epoch, candidateId: displayedCandidate, ...(displayedRelease?{releaseId:displayedRelease}:{}), idempotencyKey: crypto.randomUUID(), when: selectedWhen };
          if (!saveLocal(storageKey(captured.identity), next)) throw new Error('Browser storage is needed to retain this update request.');
          intent.current = next; setPending(next);
        }
        const submitted=intent.current, response=await request<UpdateStatus>('software-update/install', submitted, abort.signal);
        if (current()) {
          const confirmed=confirmedUpdateReceipt(submitted,response);
          if(!confirmed)throw new Error('The host did not confirm the saved update request.');
          latest.current=response;setStatus(response);setFailed(false);keep();
          if(retry)setReceipt(`Saved update request: ${stages[confirmed.state]}.`);
        }
      }
    } catch (failure) {
      if (current()) {
        if (kind === 'install' && failure instanceof ApiError && failure.code === 'update_rejected') keep();
        setError(failure instanceof ApiError ? failure.message : kind === 'install' && intent.current ? 'The host’s reply was not confirmed. Reconcile the saved request to check the same update.' : failure instanceof Error ? failure.message : 'The update request could not be completed.');
      }
    } finally {
      if (current()) { await reader.refresh(); if (current()) { mutation.current = undefined; setBusy(undefined); } }
    }
  }
  return <details className="software-update" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Software Update <span>{status && heading(status, !online || failed, !!pending)}</span></summary>
    {open && <SoftwareUpdateView status={status} online={online} failed={failed} restricted={restricted} busy={busy} pending={!!pending} error={error} receipt={receipt} check={() => void act('check')} install={() => void act('install')} cancel={() => void act('cancel')} retry={() => void act('install', true)}/>}
  </details>;
}
