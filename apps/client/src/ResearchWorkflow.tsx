import { useEffect, useState } from 'react';
import type { AssistantPlan } from '../../../packages/domain/assistant-plan';
import type { AssistantOperation } from '../../../packages/domain/assistant';
import { useResearchReview } from './research-review-state';
import { workPhaseLabel } from './WorkPhase';
import { activityLabel } from './ToolActivity';
import { Check, Square } from './icons';
import './research-workflow.css';

export function ResearchWorkflow({ item: supplied, operations, epoch, ready, readOnly, refresh, stop, update }: {
  item: AssistantPlan; operations: AssistantOperation[]; epoch: string; ready: boolean; readOnly?: boolean;
  refresh: () => Promise<void>; stop?: (id: string) => void; update?: (id: string) => void;
}) {
  const review = useResearchReview({ item: supplied, epoch, ready, readOnly, refresh });
  const { item, proposal } = review;
  const [now, setNow] = useState(Date.now);
  const operationId = item?.approval?.operationId ?? review.version?.operationId;
  const operation = operations.find(op => op.id === operationId && op.conversationId === item?.conversationId && op.context.researchWorkflow === 'chat-research-v1');
  const running = item?.state === 'implementing' && !!operation && ['prepared', 'dispatching', 'accepted', 'running'].includes(operation.state);
  const deadline = item?.state === 'ready' && item.autoStartAt ? Date.parse(item.autoStartAt) : NaN;
  useEffect(() => {
    if (!running && !Number.isFinite(deadline)) return;
    setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, deadline]);
  if (!item || item.state === 'completed' || item.approval && operation?.state === 'completed') return null;
  const seconds = Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1000)) : undefined;
  const steps = item.approval && operation?.plan?.length ? operation.plan : proposal?.steps.map((label, index) => ({ id: String(index), label, status: 'waiting' as const }));
  const actionable = ready && !readOnly && !review.busy;
  const live = running && !operation.cancelRequested;
  const measuredSteps = item.approval ? operation?.plan : undefined;
  const completedSteps = measuredSteps?.filter(step => step.status === 'complete').length ?? 0;
  const measured = !!measuredSteps?.length;
  const progressLabel = measured ? `${completedSteps} of ${measuredSteps.length} research steps complete` : 'Researching';
  const currentTool = live ? operation.tools?.findLast(tool => tool.state === 'running') : undefined;
  const observedInterruption = !!operation && ['unknown', 'failed', 'cancelled'].includes(operation.state);
  const status = observedInterruption ? workPhaseLabel(operation, false, now) : review.status;
  return <section className="research-workflow" aria-label="Research">
    <header><h3>{proposal?.title ?? 'Preparing your research plan'}</h3>{live && update && <button className="research-control" disabled={!actionable || !operation.nativeRunId} onClick={() => update(operation.id)}>Update</button>}</header>
    {steps?.length ? <ol className="research-steps">{steps.map(step => <li key={step.id} data-state={step.status === 'active' && live ? 'active' : step.status === 'complete' ? 'complete' : 'waiting'}><span className="research-step-mark" aria-hidden="true">{step.status === 'complete' && <Check size={12}/>}</span><span>{step.label}{step.status === 'active' && <span className="sr-only"> · {live ? 'In progress' : 'Last observed step'}</span>}</span></li>)}</ol> : <p className="research-status">{review.status}</p>}
    {review.editing && <form className="research-edit" onSubmit={event => { event.preventDefault(); void review.amend(); }}><label htmlFor={`research-edit-${item.id}`}>Changes to the research plan</label><textarea id={`research-edit-${item.id}`} rows={3} value={review.text} disabled={!actionable} onChange={event => review.setText(event.target.value)} maxLength={12000}/>{review.canStart && <button type="button" className="research-control" onClick={() => void review.start()}>Start original plan</button>}<button className="research-control research-start" disabled={!review.canAmend || !review.text.trim()}>Save changes</button></form>}
    {item.state === 'ready' && !review.editing && <footer><button className="research-control" disabled={!review.canHold} onClick={() => void review.hold()}>Edit</button><span className="research-controls-end"><button className="research-control" disabled={!review.canCancel} onClick={() => void review.cancel()}>Cancel</button><button className="research-control research-start" disabled={!review.canStart} onClick={() => void review.start()}>{seconds === 0 ? 'Starting…' : 'Start research'}{seconds !== undefined && seconds > 0 && <span className="research-countdown" aria-label={`Starts automatically in ${seconds} seconds`}>{seconds}</span>}</button></span></footer>}
    {review.editing && review.canCancel && <button className="research-control" onClick={() => void review.cancel()}>Cancel research</button>}
    {item.approval && <div className="research-progress-region"><div className={`research-progress${!measured && live ? ' research-progress--running' : ''}`} role="progressbar" aria-label="Research steps" aria-valuemin={0} aria-valuemax={measured ? measuredSteps.length : undefined} aria-valuenow={measured ? completedSteps : undefined} aria-valuetext={measured ? progressLabel : running ? 'Researching; step progress not yet reported' : 'Progress unconfirmed'}>{measured && <span className="research-progress-fill" style={{ width: `${completedSteps / measuredSteps.length * 100}%` }}/>}</div>{measured && <p className="research-progress-label">{progressLabel}</p>}</div>}
    {running && <><footer><span className="research-status" role="status">{workPhaseLabel(operation, true, now).replace('Working for', 'Researching for')}</span>{stop && <button className="research-control" disabled={!actionable || !operation.nativeRunId || !!operation.cancelRequested} onClick={() => stop(operation.id)}><Square size={13}/>{operation.cancelRequested ? 'Stopping…' : 'Stop'}</button>}</footer>{currentTool && <p className="research-current-tool">{currentTool.title ?? activityLabel(currentTool.name, true)}{currentTool.input && <span>{currentTool.input}</span>}</p>}</>}
    {!running && !['ready', 'drafting'].includes(item.state) && <p className="research-status" role="status">{status}</p>}
    {(review.error || item.error || item.autoStartError) && <p className="research-error" role="alert">{review.error || item.error || item.autoStartError}</p>}
    {item.autoStartHeld === 'restarted' && <p className="research-status">Ready when you are. Review the plan, then start research.</p>}
    {review.pendingAction && !review.accepted && <div className="research-recovery"><button className="research-control" disabled={!actionable} onClick={() => void review.check()}>Check status</button><button className="research-control" disabled={!actionable} onClick={() => void review.retry()}>Retry original decision</button></div>}
    {(item.state === 'unknown' || operation?.state === 'unknown') && !review.pendingAction && <button className="research-control" disabled={!actionable} onClick={() => void review.check()}>Check status</button>}
    {item.state === 'failed' && review.canHold && <button className="research-control" onClick={() => void review.hold()}>Revise research</button>}
  </section>;
}
