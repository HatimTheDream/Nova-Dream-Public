import { useEffect, useState } from 'react';
import type { AssistantPlan } from '../../../packages/domain/assistant-plan';
import type { AssistantOperation } from '../../../packages/domain/assistant';
import type { AssistantQuestion } from '../../../packages/domain/questions';
import { matchingResearchOperation, researchProgress } from '../../../packages/domain/research-progress';
import { useResearchReview } from './research-review-state';
import { ToolActivity } from './ToolActivity';
import { Check, ChevronDown, Square } from './icons';
import './research-workflow.css';

export function ResearchWorkflow({ item: supplied, operations, epoch, ready, connected, connectionGeneration, questions, readOnly, refresh, stop, update }: {
  item: AssistantPlan; operations: AssistantOperation[]; epoch: string; ready: boolean; readOnly?: boolean;
  connected: boolean; connectionGeneration?: string; questions?: AssistantQuestion[];
  refresh: () => Promise<void>; stop?: (id: string) => void; update?: (id: string) => void;
}) {
  const review = useResearchReview({ item: supplied, epoch, ready, readOnly, refresh });
  const { item, proposal } = review;
  const [now, setNow] = useState(Date.now);
  // Preparation and implementation are separate runs. Only the saved approval
  // may bind live research activity to this card.
  const operation = item && matchingResearchOperation(item, operations.find(op => op.id === item.approval?.operationId));
  const running = item?.state === 'implementing' && !!operation && ['prepared', 'dispatching', 'accepted', 'running'].includes(operation.state);
  const deadline = item?.state === 'ready' && item.autoStartAt ? Date.parse(item.autoStartAt) : NaN;
  useEffect(() => {
    if (!Number.isFinite(deadline)) return;
    setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  if (!item || item.state === 'completed') return null;
  const progress = researchProgress({ item, operation, connected: connected && (!connectionGeneration || !operation || operation.connectionGeneration === connectionGeneration), questions });
  if (progress.state === 'completed') return null;
  const seconds = Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1000)) : undefined;
  const { steps, live, status } = progress;
  const actionable = ready && !readOnly && !review.busy;
  const hasActivity = operation?.tools?.some(tool => !['progress_card', 'update_plan', 'nova_research_progress'].includes(tool.name.split(/__|\./).at(-1) ?? tool.name));
  const estimatePercent = progress.fraction === null ? undefined : Math.floor(progress.fraction * 1000) / 10;
  const progressLabel = `${status} ${estimatePercent === undefined ? 'Waiting for a research workload estimate.' : `Estimated research progress: ${estimatePercent} percent, based on completed and remaining work. The estimate may change as the scope develops.`}`;
  const hasPlanDetails = steps.some(step => step.label !== step.detail);
  return <section className="research-workflow" aria-label="Research">
    <header><h3>{proposal?.title ?? 'Preparing your research plan'}</h3>{live && operation && update && <button className="research-control research-update" disabled={!actionable || !operation.nativeRunId} onClick={() => update(operation.id)}>Update</button>}</header>
    {steps.length ? <ol className="research-steps">{steps.map(step => <li key={step.id} data-state={step.status === 'active' && live ? 'active' : step.status === 'complete' ? 'complete' : 'waiting'}><span className="research-step-mark" aria-hidden="true">{step.status === 'complete' && <Check size={12}/>}</span><span>{step.label}{step.status !== 'waiting' && <span className="sr-only"> · {step.status === 'complete' ? 'Reported complete' : live ? 'In progress' : 'Last observed step'}</span>}</span></li>)}</ol> : <p className="research-status">{review.status}</p>}
    {hasPlanDetails && <details className="research-plan-details"><summary>Plan details</summary><ol>{steps.map(step => <li key={step.id}>{step.detail}</li>)}</ol></details>}
    {review.editing && <form className="research-edit" onSubmit={event => { event.preventDefault(); void review.amend(); }}><label htmlFor={`research-edit-${item.id}`}>Changes to the research plan</label><textarea id={`research-edit-${item.id}`} rows={3} value={review.text} disabled={!actionable} onChange={event => review.setText(event.target.value)} maxLength={12000}/>{review.canStart && <button type="button" className="research-control" onClick={() => void review.start()}>Start original plan</button>}<button className="research-control research-start" disabled={!review.canAmend || !review.text.trim()}>Save changes</button></form>}
    {item.state === 'ready' && !review.editing && <footer><button className="research-control" disabled={!review.canHold} onClick={() => void review.hold()}>Edit</button><span className="research-controls-end"><button className="research-control" disabled={!review.canCancel} onClick={() => void review.cancel()}>Cancel</button><button className="research-control research-start" disabled={!review.canStart} onClick={() => void review.start()}>{seconds === 0 ? 'Starting…' : 'Start research'}{seconds !== undefined && seconds > 0 && <span className="research-countdown" aria-label={`Starts automatically in ${seconds} seconds`}>{seconds}</span>}</button></span></footer>}
    {review.editing && review.canCancel && <button className="research-control" onClick={() => void review.cancel()}>Cancel research</button>}
    {item.approval && <div className="research-progress-region">
      {hasActivity && operation ? <details className="research-current-activity" key={operation.id}>
        <summary title="View research activity"><span className="research-status" role="status">{status}</span><ChevronDown size={13}/></summary>
        <div className="research-activity-details" role="region" aria-label="Research activity"><ToolActivity operation={operation} paused={!live}/></div>
      </details> : <p className="research-status" role="status">{status}</p>}
      <div className="research-progress-row">
        <div className={`research-progress${live ? ' research-progress--running' : ''}`} role="progressbar" aria-label="Estimated research progress" title="Estimated research progress · updated as work and remaining scope change" aria-valuemin={0} aria-valuemax={100} aria-valuenow={estimatePercent} aria-valuetext={progressLabel}><span className="research-progress-fill" style={{ width: `${(progress.fraction ?? 0) * 100}%` }}/></div>
        {running && stop && <button className="research-control research-stop" aria-label={operation.cancelRequested ? 'Stopping research' : 'Stop research'} title={operation.cancelRequested ? 'Stopping research' : 'Stop research'} disabled={!actionable || !operation.nativeRunId || !!operation.cancelRequested} onClick={() => stop(operation.id)}><Square size={11}/></button>}
      </div>
    </div>}
    {!item.approval && !['ready', 'drafting'].includes(item.state) && <p className="research-status" role="status">{status}</p>}
    {(review.error || item.error || item.autoStartError) && <p className="research-error" role="alert">{review.error || item.error || item.autoStartError}</p>}
    {item.autoStartHeld === 'restarted' && <p className="research-status">Ready when you are. Review the plan, then start research.</p>}
    {review.pendingAction && !review.accepted && <div className="research-recovery"><button className="research-control" disabled={!actionable} onClick={() => void review.check()}>Check status</button><button className="research-control" disabled={!actionable} onClick={() => void review.retry()}>Retry original decision</button></div>}
    {(item.state === 'unknown' || operation?.state === 'unknown') && !review.pendingAction && <button className="research-control" disabled={!actionable} onClick={() => void review.check()}>Check status</button>}
    {item.state === 'failed' && review.canHold && <button className="research-control" onClick={() => void review.hold()}>Revise research</button>}
  </section>;
}
