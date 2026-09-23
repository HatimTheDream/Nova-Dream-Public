import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { AssistantPlan, PlanProposal } from '../../../packages/domain/assistant-plan';
import type { PlanReviewController } from './plan-review-state';
import { ReplyMarkdown } from './dreamclaw/components/Chat/ReplyMarkdown';
import { ArrowRight, ArrowUp, ChevronDown, List, PanelRight, X } from './icons';
import { Edit3 } from './dreamclaw/components/icons';
import './plan-review.css';

function ProposalBody({ proposal, preview = false }: { proposal: PlanProposal; preview?: boolean }) {
  const shorten = (text: string, max: number) => text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
  return <><h3>{proposal.title}</h3><ReplyMarkdown text={preview ? shorten(proposal.summary, 420) : proposal.summary}/><ol>{(preview ? proposal.steps.slice(0, 3) : proposal.steps).map((step, index) => <li key={index}>{preview ? shorten(step, 180) : step}</li>)}</ol>{!preview && <>{!!proposal.assumptions.length && <><h4>Assumptions</h4><ul>{proposal.assumptions.map((text, index) => <li key={index}>{text}</li>)}</ul></>}<h4>Verification</h4><ul>{proposal.verification.map((text, index) => <li key={index}>{text}</li>)}</ul></>}</>;
}

/** Read-only document. Viewing a saved version never changes the approval target. */
export function PlanReviewDocument({ item }: { item: AssistantPlan }) {
  return <PlanDocument key={`${item.epoch}:${item.id}:${item.version}`} item={item}/>;
}
function PlanDocument({ item }: { item: AssistantPlan }) {
  const [selected, setSelected] = useState(item.version);
  const version = item.versions.find(value => value.version === selected), proposal = version?.proposal;
  return <article className="nova-plan-document" aria-label="Full plan">
    <div className="nova-plan-document-toolbar"><span>Plan</span>{item.versions.length > 1 ? <select aria-label="Plan version" value={selected} onChange={event => setSelected(Number(event.target.value))}>{[...item.versions].reverse().map(value => <option key={value.version} value={value.version}>Version {value.version}{value.version === item.version ? ' · Current' : ''}</option>)}</select> : <span>Version {item.version}</span>}</div>
    {selected !== item.version && <p className="nova-plan-state">Earlier version. The current proposal is version {item.version}.</p>}
    {proposal ? <ProposalBody proposal={proposal}/> : <p>No completed proposal was saved for this version.</p>}
  </article>;
}

/** The main conversation always contains the plan; a side pane is optional. */
export function PlanReviewCard({ review, onOpenPanel }: { review: PlanReviewController; onOpenPanel?: () => void }) {
  const identity = `${review.item?.epoch}:${review.item?.id}:${review.item?.version}`;
  const [expanded, setExpanded] = useState<string | null>(null), bodyId = useId();
  const open = expanded === identity, item = review.item;
  if (!item || item.state === 'drafting' && !review.proposal && !item.error) return null;
  return <section className="nova-plan-review" aria-label="Plan proposal">
    <div className="nova-plan-heading"><List size={16}/><span>Plan</span><span>Version {item.version}</span>{onOpenPanel && <button type="button" className="nova-plan-panel-button" aria-label="Open plan in side panel" title="Open in side panel" onClick={onOpenPanel}><PanelRight size={17}/></button>}</div>
    {review.proposal && <><div id={bodyId} className={open ? 'nova-plan-inline-document' : 'nova-plan-preview-content'}>{open ? <PlanReviewDocument item={item}/> : <ProposalBody proposal={review.proposal} preview/>}</div><button type="button" className="nova-plan-expand" aria-expanded={open} aria-controls={bodyId} onClick={() => setExpanded(open ? null : identity)}>{open ? 'Collapse plan' : 'Expand plan'}<ChevronDown size={15} className={open ? 'expanded' : ''}/></button></>}
    {(item.state !== 'ready' || review.accepted) && <p className="nova-plan-state" role="status">{review.status}</p>}
    {item.error && <p className="nova-plan-state" role="status">{item.error}</p>}
    {!review.decisionVisible && review.canReview && <button type="button" className="nova-plan-return" onClick={review.openDecision}>Review plan</button>}
  </section>;
}

/** One explicit answer action; typing changes is never approval. */
export function PlanReviewDecision({ review }: { review: PlanReviewController }) {
  const amendment = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = amendment.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [review.text, review.decisionVisible]);
  if (!review.decisionVisible) return null;
  const recover = !!review.pendingAction;
  const revisionOnly = review.item?.state !== 'ready';
  return <section className="nova-plan-decision" aria-label="Plan decision">
    <div className="nova-plan-decision-heading"><strong>{recover ? 'Check your plan decision' : revisionOnly ? 'Revise this plan?' : 'Implement this plan?'}</strong><button type="button" className="nova-plan-defer" aria-label="Defer plan decision" title="Review later" disabled={review.busy} onClick={review.skip}><X size={15}/></button></div>
    {!recover && !revisionOnly && <button type="button" className="nova-plan-yes" disabled={!review.canApprove} onClick={() => void review.approve()}><span className="nova-plan-answer-number" aria-hidden="true">1</span><span>Yes, implement this plan</span><ArrowRight size={17}/></button>}
    <form className="nova-plan-amendment" onSubmit={event => { event.preventDefault(); if (review.canAmend && review.text.trim()) void review.amend(); }}>
      <Edit3 size={15}/><textarea ref={amendment} aria-label="Changes to the plan" rows={1} maxLength={12000} placeholder={revisionOnly ? 'Tell Nova what to change…' : 'No, and tell Nova what to do differently'} value={review.text} disabled={review.busy || review.readOnly} onChange={event => review.setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && review.canAmend && review.text.trim()) { event.preventDefault(); void review.amend(); } }}/>
      {review.text.trim() && !recover ? <button type="submit" className="nova-plan-send" aria-label="Send plan changes" title="Send changes" disabled={!review.canAmend}><ArrowUp size={17}/></button> : <button type="button" className="nova-plan-skip" disabled={review.busy} onClick={review.skip}>Skip</button>}
    </form>
    {!review.ready && <p className="nova-plan-state" role="status">Reconnect to answer. Your changes are kept.</p>}
    {review.busy && <p className="nova-plan-state" role="status">Confirming your decision…</p>}
    {recover && !review.busy && <><p className="nova-plan-state" role="status">Your original decision is unconfirmed. Check its status or retry that same decision; your writing is kept.</p><div className="nova-plan-recovery"><button type="button" disabled={!review.ready} onClick={() => void review.check()}>Check status</button><button type="button" disabled={!review.ready} onClick={() => void review.retry()}>Retry original decision</button></div></>}
    {review.error && <p className="nova-plan-state" role="alert">{review.error}</p>}
  </section>;
}
