import { useEffect, useRef, useState } from 'react';
import type { AssistantPlan } from '../../../packages/domain/assistant-plan';
import { ApiError, readLocal, request, saveLocal } from './api';
import { ReplyMarkdown } from './dreamclaw/components/Chat/ReplyMarkdown';
import './plan-review.css';

export function PlanReviewCard({ item, epoch, ready, refresh, readOnly = false, onApproved }: { item: AssistantPlan; epoch: string; ready: boolean; refresh: () => Promise<void>; readOnly?: boolean; onApproved?: () => void }) {
  const key = `e3:plan-amendment:${epoch}:${item.id}`;
  const [amending, setAmending] = useState(false), [text, setText] = useState(() => readLocal<string>(key) ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const identity = `${epoch}:${item.id}`, scope = useRef({ identity, alive: true, text });
  scope.current = { ...scope.current, identity, text };
  useEffect(() => { scope.current.alive = true; return () => { scope.current.alive = false; }; }, []);
  useEffect(() => { setText(readLocal<string>(key) ?? ''); setAmending(false); setBusy(false); setError(''); }, [key]);
  const version = item.versions.find(v => v.version === item.version)!, proposal = version.proposal;
  const editable = !readOnly && ready && !busy;
  const pendingAmendment = readLocal<{ requestId: string; signature: string }>(`${key}:${item.revision}:amend`);
  const pendingApproval = readLocal<{ requestId: string; signature: string }>(`${key}:${item.revision}:approve`);
  const pendingAction = pendingAmendment ? 'amend' : pendingApproval ? 'approve' : undefined;
  const act = async (action: 'approve' | 'amend', retryOriginal = false) => {
    if (!editable || action === 'amend' && !text.trim() && !retryOriginal) return;
    setBusy(true); setError('');
    const actionIdentity = identity;
    const currentView = () => scope.current.alive && scope.current.identity === actionIdentity;
    // Retain exactly this decision's identity after a lost response.
    const decisionKey = `${key}:${item.revision}:${action}`;
    const prior = readLocal<{ requestId: string; signature: string }>(decisionKey);
    const signature = retryOriginal && prior ? prior.signature : action === 'amend' ? text.trim() : 'approve';
    const submittedText = retryOriginal ? signature : text;
    if (retryOriginal && !prior || pendingAction && pendingAction !== action || prior && prior.signature !== signature) { setError('Check the original decision before submitting different changes. Your writing is kept.'); setBusy(false); return; }
    const requestId = prior?.requestId ?? crypto.randomUUID();
    if (!saveLocal(decisionKey, { requestId, signature })) { setError('Your decision could not be saved safely. Free browser storage before continuing; your writing is kept.'); setBusy(false); return; }
    try {
      await request(`assistant/plan/${action}`, { requestId, epoch, id: item.id, expectedRevision: item.revision, version: item.version, digest: item.reviewDigest ?? version.digest, ...(action === 'amend' ? { text: signature } : {}) });
      if (currentView() && action === 'amend' && scope.current.text === submittedText) { setText(''); saveLocal(key, ''); setAmending(false); }
      if (currentView() && action === 'approve') onApproved?.();
    } catch (reason) {
      // A service rejection before admission permits editing; transport failures
      // keep the exact original decision until its receipt is reconciled.
      if (reason instanceof ApiError && reason.status && [400, 403, 404, 409, 422].includes(reason.status) && reason.code !== 'request_reused') saveLocal(decisionKey, null);
      if (currentView()) setError(reason instanceof Error ? reason.message : 'The decision could not be confirmed. Refresh the plan before continuing.');
    }
    finally { try { await refresh(); } catch { if (currentView()) setError('The latest plan could not load. Reconnect before continuing.'); } if (currentView()) setBusy(false); }
  };
  const status = { drafting: 'Preparing your plan', ready: 'Ready for review', implementing: 'Implementing approved plan', completed: 'Approved work finished', failed: 'Plan needs attention', cancelled: 'Planning stopped', unknown: 'Checking the original work' }[item.state];
  if (item.state === 'drafting' && !proposal && !item.error) return null;
  return <section className="nova-plan-review" aria-label="Plan proposal">
    <div className="nova-plan-heading"><strong>{status}</strong><span>Version {item.version}</span></div>
    {proposal && <><h3>{proposal.title}</h3><ReplyMarkdown text={proposal.summary}/><ol>{proposal.steps.map((step, index) => <li key={index}>{step}</li>)}</ol><details><summary>Assumptions and checks</summary>{!!proposal.assumptions.length && <><strong>Assumptions</strong><ul>{proposal.assumptions.map((text, index) => <li key={index}>{text}</li>)}</ul></>}<strong>Verification</strong><ul>{proposal.verification.map((text, index) => <li key={index}>{text}</li>)}</ul></details></>}
    {item.error && <p role="status">{item.error}</p>}
    {!readOnly && !item.approval && ['ready', 'failed', 'cancelled'].includes(item.state) && <>
      {amending ? <form onSubmit={event => { event.preventDefault(); void act('amend'); }}><textarea aria-label="Changes to the plan" rows={2} maxLength={12000} placeholder="What would you like to change?" value={text} onChange={event => { setText(event.target.value); saveLocal(key, event.target.value); }}/><div className="nova-plan-actions"><button type="submit" className="primary" disabled={!editable || !text.trim()}>Revise plan</button><button type="button" onClick={() => setAmending(false)}>Keep writing later</button></div></form>
        : <div className="nova-plan-actions">{item.state === 'ready' && <button type="button" className="primary" disabled={!editable} onClick={() => void act('approve')}>Approve and start</button>}<button type="button" disabled={!editable} onClick={() => setAmending(true)}>Request changes</button></div>}
    </>}
    {item.versions.length > 1 && <details><summary>Earlier versions</summary>{item.versions.slice(0, -1).map(prior => <details key={prior.version}><summary>Version {prior.version}</summary><p>{prior.proposal?.summary ?? 'No completed proposal was saved.'}</p>{prior.proposal && <ol>{prior.proposal.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}</details>)}</details>}
    {error && <><p role="alert">{error}</p>{pendingAction && <div className="nova-plan-actions"><button type="button" disabled={!editable} onClick={() => void act(pendingAction, true)}>Retry original decision</button></div>}</>}
  </section>;
}
