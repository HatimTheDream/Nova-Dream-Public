import { useEffect, useRef, useState } from 'react';
import { statusNames, type TaskHistory as History } from '../../../packages/domain/tasks';
import { request } from './api';

export function TaskHistory({ taskId }: { taskId: string }) {
  const [page, setPage] = useState<History>({ versions: [], beforeRevision: null }), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(true), loading = useRef(false);
  const load = async (beforeRevision?: number) => {
    if (loading.current) return; loading.current = true; setBusy(true); setError('');
    try { const next = await request<History>('tasks/history', { taskId, ...(beforeRevision ? { beforeRevision } : {}) }); if (active.current) setPage(previous => ({ ...next, versions: beforeRevision ? [...previous.versions, ...next.versions] : next.versions })); }
    catch (error) { if (active.current) setError(error instanceof Error ? error.message : 'Task history is unavailable.'); }
    finally { loading.current = false; if (active.current) setBusy(false); }
  };
  useEffect(() => { active.current = true; void load(); return () => { active.current = false; }; }, [taskId]);
  return <div className="task-history">{page.versions.map(version => <details key={version.revision}><summary>{version.value.trashed ? 'Moved to Trash' : statusNames[version.value.status]} · {new Date(version.updatedAt).toLocaleString()} · v{version.revision}</summary><p><strong>{version.value.title}</strong></p>{version.value.notes && <p className="task-history-notes">{version.value.notes}</p>}<p>{version.value.planned ? `Planned ${version.value.planned}` : 'No plan date'}{version.value.due ? ` · Due ${version.value.due}` : ''}</p>{version.value.checklist?.map(i => <p key={i.id}>{i.done ? '✓' : '○'} {i.text}</p>)}</details>)}{error && <p role="alert">{error}</p>}{(page.beforeRevision || error) && <button type="button" disabled={busy} onClick={() => void load(page.beforeRevision ?? undefined)}>{error ? 'Retry history' : 'Earlier versions'}</button>}{busy && <p role="status">Reading saved history…</p>}</div>;
}
