import { lazy, Suspense, useEffect, useState } from 'react';
import type { Conversation } from '../../../packages/domain/assistant';
import type { WorkProjectDiff } from '../../../packages/domain/work-project';
import { request } from './api';
import { RotateCcw } from './icons';
const WorkPublish = lazy(() => import('./WorkPublish').then(m=>({ default:m.WorkPublish })));
export function WorkProjectChanges({ conversation, epoch }: { conversation: Conversation; epoch:string }) {
  const [publishing,setPublishing]=useState(false);
  const [diff, setDiff] = useState<WorkProjectDiff>(), [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false);
  useEffect(() => {
    const abort = new AbortController(); setBusy(true); setError(''); setDiff(undefined);
    void request<WorkProjectDiff>(`assistant/work-changes/${conversation.id}`, undefined, abort.signal).then(next => { if (!abort.signal.aborted) setDiff(next); }).catch(e => { if (!abort.signal.aborted) setError(e.message); }).finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => abort.abort();
  }, [conversation.id, conversation.nativeId, refresh]);
  return <section className="work-project-changes"><div className="section-heading"><span className="metadata">{conversation.workspace?.path ?? conversation.workspace?.folder}</span><button className="icon-button" aria-label="Refresh project changes" disabled={busy} onClick={() => setRefresh(n => n + 1)}><RotateCcw size={16}/></button></div>
    {busy && <p role="status" className="metadata">Checking changes…</p>}{error && <p role="alert" className="field-error">{error}</p>}
    {diff && (diff.unavailableReason ? <p className="metadata">{diff.unavailableReason === 'not_git' ? 'This folder does not use Git. Saved files remain available from this conversation.' : 'The original checkout is unavailable.'}</p> : <><p className="metadata">{diff.branch ?? 'Working tree'} · +{diff.additions} −{diff.deletions}</p><p className="metadata">Current checkout changes, including edits made outside Nova Dream.</p>{diff.files.length === 0 && <p className="metadata">No changes in this checkout.</p>}{diff.files.map(file => <details key={file.path}><summary>{file.path} <small>+{file.additions} −{file.deletions}</small></summary><pre className="work-project-patch">{file.patch ?? (file.binary ? 'Binary file changed.' : 'Patch unavailable for this file.')}</pre>{file.truncated && <small>Patch shortened.</small>}</details>)}{diff.truncated && <p className="metadata">This report is shortened.</p>}</>)}
    {conversation.workspace?.folder.includes("work-repositories") && <details open={publishing} onToggle={e=>setPublishing(e.currentTarget.open)}><summary>Commit & publish</summary>{publishing&&<Suspense fallback={<p role="status">Opening publication review…</p>}><WorkPublish conversationId={conversation.id} epoch={epoch}/></Suspense>}</details>}
  </section>;
}
