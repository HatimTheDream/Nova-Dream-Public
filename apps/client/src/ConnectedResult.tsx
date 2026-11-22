import { useEffect, useRef, useState } from 'react';
import type { AssignmentAttempt } from '../../../packages/domain/assignments';
import type { Snapshot } from '../../../packages/domain/contracts';
import { ConnectedInputs, ConnectedReviewPanel } from './ConnectedReviewPanel';
import { useConnectedResult } from './useConnectedResult';
import { reviewCanBeAccepted } from './connected-result-draft';
import { useLibraryWorkRoutes } from './LibraryWorkNavigation';
import { registerRecordDraftNavigation } from './record-draft-navigation';
import { retainedWindowId } from './useWorkspace';
import { Dialog } from './ui';

export function ConnectedResult({ attempt, snapshot, refresh, openContent, choose }: {
  attempt: AssignmentAttempt; snapshot: Snapshot; refresh: () => Promise<void>; openContent: (id: string) => void;
  choose: (id: string) => void;
}) {
  const routes = useLibraryWorkRoutes();
  const state = useConnectedResult(attempt, snapshot, refresh, (assignmentId, id) => routes?.openWork(assignmentId, id));
  const { detail, subject } = state;
  const [panel, setPanel] = useState<'review' | 'sources' | 'revision' | null>(null);
  const [acknowledgments, setAcknowledgments] = useState<{ reviewId: string; ids: string[] }>();
  const correctionKey = state.key + ':correction:' + retainedWindowId;
  const [correction, setCorrection] = useState('');
  const [draftError, setDraftError] = useState('');
  const writing = useRef({ text: '', dirty: false, readable: false });
  useEffect(() => {
    try {
      const text = localStorage.getItem(correctionKey) ?? '';
      writing.current = { text, dirty: false, readable: true }; setCorrection(text);
    } catch { setDraftError('The kept correction could not be read. Restore browser storage to continue.'); }
    function retain() {
      if (!writing.current.dirty) return true;
      try { localStorage.setItem(correctionKey, writing.current.text); writing.current.dirty = false; return true; }
      catch { setDraftError('Keep this window open until browser storage can keep your correction.'); return false; }
    }
    function beforeUnload(event: BeforeUnloadEvent) { if (!retain()) { event.preventDefault(); event.returnValue = ''; } }
    window.addEventListener('beforeunload', beforeUnload);
    const unregister = registerRecordDraftNavigation(retain);
    return () => { unregister(); window.removeEventListener('beforeunload', beforeUnload); };
  }, [correctionKey]);
  const changeCorrection = (text: string) => {
    if (!writing.current.readable) return;
    writing.current = { text, dirty: true, readable: true }; setCorrection(text);
    try { localStorage.setItem(correctionKey, text); writing.current.dirty = false; setDraftError(''); }
    catch { setDraftError('Your correction is still in this window. Free browser storage to keep it.'); }
  };
  const command = () => ({ ...subject, requestId: crypto.randomUUID() });
  if (!detail) return <section aria-label="Review Result">{state.readError ? <><p role="alert">{state.readError}</p><button onClick={state.reload}>Check Original Result</button></> : <p role="status">Opening the saved result…</p>}</section>;
  if (!detail.available) return <p role="status">The original result is unavailable under the current source permissions.</p>;
  const reviewId = detail.review.attempt?.id ?? '';
  const acknowledged = new Set(acknowledgments?.reviewId === reviewId ? acknowledgments.ids : []);
  const accept = () => {
    const reviewer = detail.review.attempt;
    if (!reviewer?.result || !reviewCanBeAccepted(detail, acknowledged)) return;
    void state.run({ action: 'accept', input: { ...command(), reviewAttemptId: reviewer.id, reviewSha256: reviewer.result.file.sha256, acknowledgedFindingIds: [...acknowledged] } });
  };
  const review = <ConnectedReviewPanel detail={detail} snapshot={snapshot} busy={state.busy || !!state.pending} acknowledged={acknowledged}
    acknowledge={(id, checked) => { if (checked) acknowledged.add(id); else acknowledged.delete(id); setAcknowledgments({ reviewId, ids: [...acknowledged] }); }}
    start={(reviewerId, reviewerRevision) => void state.run({ action: 'review', input: { ...command(), reviewerId, reviewerRevision } })}/>;
  const sources = <ConnectedInputs inputs={detail.inputs}/>;
  const saved = detail.savedContentId;
  const pending = state.pending;
  const number = detail.attempt.connected?.number;
  return <section className="connected-result" aria-label="Review Result">
    <div className="connected-result-heading"><h2>Result {number}</h2>
      {detail.lineage.length > 1 && <label>Version<select value={attempt.id} onChange={event => choose(event.target.value)}>
        {detail.lineage.map(row => <option key={row.attemptId} value={row.attemptId}>Result {row.number}</option>)}
      </select></label>}
      <span className="metadata" role="status">{saved ? 'Saved To Content' : pending?.action === 'save' ? 'Save Confirmation Needed' : detail.acceptance ? 'Accepted' : detail.review.state === 'complete' ? 'Reviewed' : 'Ready To Review'}</span>
    </div>
    {detail.correction && <details><summary>Revision Instructions</summary><p>{detail.correction}</p>
      {detail.attempt.connected?.baseAttemptId && <button onClick={() => choose(detail.attempt.connected!.baseAttemptId!)}>Open Base Result</button>}</details>}
    <div className="compact-actions connected-panel-triggers">
      <button className="compact-action" onClick={() => setPanel('review')}>Review</button>
      <button className="compact-action" onClick={() => setPanel('sources')}>Sources</button>
    </div>
    <div className="connected-result-layout">
      <article className="connected-document" aria-label="Original Result Document"><pre>{detail.document}</pre></article>
      <aside className="connected-result-aside">{review}{sources}</aside>
    </div>
    {state.error && <p className="field-error" role="alert">{state.error}</p>}
    <div className="compact-actions connected-result-actions">
      {saved ? <button className="compact-action primary" onClick={() => openContent(saved)}>Open In Content</button>
        : pending ? <button className="compact-action primary" disabled={state.busy} onClick={() => void state.run(pending)}>{pending.action === 'save' ? 'Check Original Save' : 'Check Original ' + ({ review: 'Review', revise: 'Revision', accept: 'Acceptance' }[pending.action])}</button>
        : detail.acceptance ? <button className="compact-action primary" disabled={state.busy} onClick={() => void state.run({ action: 'save', input: command() })}>Save To Content</button>
        : <button className="compact-action primary" disabled={state.busy || !reviewCanBeAccepted(detail, acknowledged)} onClick={accept}>Accept And Save</button>}
      <button className="compact-action" disabled={state.busy || !!pending} onClick={() => setPanel('revision')}>Request Revision</button>
    </div>
    {panel && <Dialog title={panel === 'revision' ? 'Request Revision' : panel === 'review' ? 'Review Result ' + number : 'Inputs Used'} close={() => setPanel(null)}>
      {panel === 'revision' ? <><label>Correction For Result {number}<textarea value={correction} onChange={event => changeCorrection(event.target.value)}
        disabled={!writing.current.readable || state.busy} rows={6} maxLength={20000}/></label>
        {draftError && <p className="field-error" role="alert">{draftError}</p>}
        {state.error && <p role="alert">{state.error}</p>}
        <div className="compact-actions"><button onClick={() => setPanel(null)}>Keep Draft</button>
          <button className="primary" disabled={state.busy || !correction.trim() || !!draftError || !!pending} onClick={() => {
            setPanel(null); void state.run({ action: 'revise', input: { ...command(), correction } });
          }}>Request Revision</button></div></> : <>{panel === 'review' ? review : sources}<button className="compact-action" onClick={() => setPanel(null)}>Back</button></>}
    </Dialog>}
  </section>;
}
