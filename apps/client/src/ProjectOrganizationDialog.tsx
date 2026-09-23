import { useEffect, useRef, useState } from 'react';
import type { Entity, Project, ProjectOrganization, Snapshot } from '../../../packages/domain/contracts';
import { projectIsDeleted } from '../../../packages/domain/project-organization';
import { readLocal, request, saveLocal } from './api';
import { runRetainedProjectOrganization, type PendingProjectOrganization } from './project-organization-action';
import { Dialog } from './ui';

export const projectOrganizationKey = (snapshot: Snapshot, id: string) => `e3:project-organization:${snapshot.deviceId}:${id}`;

export function ProjectOrganizationDialog({ snapshot, project, close, refresh }: { snapshot: Snapshot; project: Entity<Project>; close: () => void; refresh: () => Promise<void> }) {
  const key = projectOrganizationKey(snapshot, project.id);
  const [pending, setPending] = useState(() => readLocal<PendingProjectOrganization>(key));
  const [acknowledged, setAcknowledged] = useState<number>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), flight = useRef(false);
  const action = pending?.action ?? (projectIsDeleted(snapshot, project.id) ? 'restore' : 'delete');
  const visibleRevision = snapshot.projectOrganization?.find(row => row.projectId === project.id)?.revision ?? 0;
  useEffect(() => { if (acknowledged !== undefined && visibleRevision >= acknowledged) close(); }, [acknowledged, visibleRevision, close]);
  const refreshList = async () => {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError('');
    try { await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The latest project list could not load. Try again.'); }
    finally { flight.current = false; setBusy(false); }
  };
  const change = async () => {
    if (flight.current) return;
    const intent: PendingProjectOrganization = pending ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, projectId: project.id, projectRevision: project.revision, expectedRevision: snapshot.projectOrganization?.find(row => row.projectId === project.id)?.revision ?? 0, action };
    flight.current = true; setBusy(true); setError('');
    try {
      const result = await runRetainedProjectOrganization({
        read: () => readLocal<PendingProjectOrganization>(key),
        write: command => { if (command) return saveLocal(key, command); try { localStorage.removeItem(key); return true; } catch { return false; } },
        retained: setPending, send: command => request<ProjectOrganization>('projects/organize', command), refresh,
      }, intent);
      setPending(result.pending); setError(result.error);
      if (result.confirmed && !result.pending) setAcknowledged(result.acknowledged!.revision);
    } finally { flight.current = false; setBusy(false); }
  };
  return <Dialog title={action === 'delete' ? 'Move project to Deleted?' : 'Restore project?'} close={close}>
    <p><strong className="preserve-case">{project.value.name}</strong></p>
    <p>{action === 'delete' ? 'This removes the project from your sidebar. Its conversations stay in Recents, and its files and saved work are kept. You can restore it from Deleted.' : 'This returns the project and its conversation grouping to your sidebar.'}</p>
    {pending && <p className="metadata" role="status">A previous change is awaiting confirmation. Checking will finish that same request.</p>}
    {acknowledged !== undefined && <p className="metadata" role="status">The change is saved. Updating the project list…</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="dialog-footer"><button disabled={busy} onClick={close}>{acknowledged === undefined ? 'Cancel' : 'Close'}</button><button className={action === 'delete' ? 'chat-delete-action' : 'primary'} disabled={busy} onClick={() => void (acknowledged === undefined ? change() : refreshList())}>{busy ? 'Checking…' : acknowledged !== undefined ? 'Refresh project list' : pending ? 'Check change' : action === 'delete' ? 'Move to Deleted' : 'Restore project'}</button></div>
  </Dialog>;
}
