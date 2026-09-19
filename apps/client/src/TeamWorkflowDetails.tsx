import { useEffect, useRef, useState } from 'react';
import type { TeamAttempt, TeamHandoff, TeamStep, TeamWork } from '../../../packages/domain/team-work';
import type { TeamReviewReport } from '../../../packages/domain/team-review';
import { request } from './api';
import { emptyHandoffRead, TeamHandoffReader } from './team-handoff-reader';

export type TeamAction = 'pause' | 'resume' | 'stop' | 'skip' | 'retry' | 'apply_findings';
const stageLabels: Record<TeamStep['state'], string> = { waiting: 'Waiting', running: 'Working', complete: 'Handoff returned', failed: 'Failed', cancelled: 'Stopped', unknown: 'Outcome unconfirmed', skipped: 'Skipped by you' };
const runLabels: Record<TeamWork['state'], string> = { running: 'In progress', paused: 'Paused', stopping: 'Stop requested', complete: 'Stages finished', cancelled: 'Stopped', attention: 'Needs your review' };
const roleLabels: Record<TeamStep['role'], string> = { research: 'Research & plan', build: 'Implement', review: 'Review' };

export function teamActions(run: TeamWork): TeamAction[] {
  const step = run.steps[run.next], recoverable = ['paused', 'attention'].includes(run.state);
  return [
    ...(run.state === 'complete' && run.applyFindings?.available ? ['apply_findings' as const] : []),
    ...(run.state === 'running' ? ['pause' as const] : []),
    ...(recoverable && step && !['failed', 'cancelled', 'unknown'].includes(step.state) ? ['resume' as const] : []),
    ...(recoverable && step?.state === 'failed' && !!step.operationId ? ['retry' as const] : []),
    ...(recoverable && step?.operationId && ['failed', 'cancelled'].includes(step.state) ? ['skip' as const] : []),
    ...(!['complete', 'cancelled', 'stopping'].includes(run.state) ? ['stop' as const] : []),
  ];
}

const reviewLabels = { needs_changes: 'Needs changes', ready_for_review: 'Ready for your review' };
const checkLabels = { passed: 'Passed', failed: 'Failed', not_run: 'Not run' };
const priorityLabels = { high: 'High priority', medium: 'Medium priority', low: 'Low priority' };
export function TeamReviewDetails({ review }: { review: TeamReviewReport }) {
  return <div className="team-review-report">
    <p className="preserve-lines">{review.summary}</p>
    {!!review.findings.length && <div className="team-review-findings" role="list" aria-label="Review findings">{review.findings.map(finding => <article role="listitem" key={finding.id}>
      <div className="section-heading"><strong>{finding.title}</strong><small>{priorityLabels[finding.priority]}</small></div>
      {finding.location && <p className="metadata team-review-location">{finding.location}</p>}
      <p className="preserve-lines">{finding.detail}</p>
    </article>)}</div>}
    <details className="team-review-checks"><summary>Reviewer-reported checks ({review.checks.length})</summary><div role="list" aria-label="Reviewer-reported checks">{review.checks.map((check, index) => <article role="listitem" key={index}>
      <div className="section-heading"><strong>{check.name}</strong><small>{checkLabels[check.outcome]}</small></div>
      <p className="metadata preserve-lines">{check.detail}</p>
    </article>)}</div></details>
  </div>;
}

function SavedReview({ review }: { review: TeamReviewReport }) {
  return <details className="team-saved-review"><summary>Review report · {reviewLabels[review.verdict]}</summary><TeamReviewDetails review={review}/></details>;
}

function CompleteHandoff({ teamId, handoff }: { teamId: string; handoff: TeamHandoff }) {
  const [state, setState] = useState(emptyHandoffRead), reader = useRef<TeamHandoffReader>(undefined);
  useEffect(() => {
    const current = new TeamHandoffReader(handoff, (offset, signal) => request(`work/team/handoff?teamId=${encodeURIComponent(teamId)}&id=${encodeURIComponent(handoff.id)}&offset=${offset}&limit=12000`, undefined, signal), setState);
    reader.current = current;
    return () => { current.close(); if (reader.current === current) reader.current = undefined; };
  }, [teamId, handoff.id, handoff.sha256, handoff.characters]);
  return <div className="team-handoff-reader">
    {state.text && <pre className="team-handoff-text" tabIndex={0} aria-label="Full handoff text">{state.text}</pre>}
    {state.complete ? <p className="metadata">Complete saved output · {state.loaded.toLocaleString()} characters{!state.loaded ? ' · No text was returned.' : ''}</p> : <>
      {state.loaded > 0 && <p className="metadata">Showing {state.loaded.toLocaleString()} of {handoff.characters.toLocaleString()} characters. More of this handoff remains.</p>}
      <button type="button" disabled={state.loading} onClick={() => void reader.current?.load()}>{state.loading ? 'Reading handoff…' : state.error ? 'Retry reading handoff' : state.loaded ? 'Read more of this handoff' : 'Read complete handoff'}</button>
    </>}
    {state.error && <p role="alert" className="field-error">{state.error}</p>}
  </div>;
}

export function TeamHandoffPreview({ teamId, attempt }: { teamId: string; attempt: Pick<TeamAttempt, 'result' | 'handoff'> }) {
  if (attempt.result === undefined && !attempt.handoff) return null;
  const shortened = !!attempt.handoff && Array.from(attempt.result ?? '').length < attempt.handoff.characters;
  return <details className="team-handoff"><summary>{attempt.handoff ? shortened ? 'Handoff excerpt' : 'Saved output' : 'Earlier saved excerpt'}</summary>
    <p className="preserve-lines" tabIndex={0} aria-label="Saved handoff excerpt">{attempt.result || 'No text was returned.'}</p>
    {attempt.handoff ? <>
      {shortened && <p className="metadata">This excerpt is shortened. The complete output is kept separately.</p>}
      {attempt.handoff.state !== 'completed' && <p className="metadata">Output from a {attempt.handoff.state === 'failed' ? 'failed' : 'stopped'} attempt; it does not confirm this stage finished.</p>}
      {shortened && <CompleteHandoff key={`${teamId}:${attempt.handoff.id}:${attempt.handoff.sha256}`} teamId={teamId} handoff={attempt.handoff}/>}
    </> : <p className="metadata">Completeness is unavailable for this older excerpt. Inspect its original conversation for any remaining output.</p>}
  </details>;
}

type Props = { run: TeamWork; blocked: boolean; control: (action: TeamAction) => void; openConversation: (id: string) => void; refresh: () => void };
export function TeamWorkflowDetails({ run, blocked, control, openConversation, refresh }: Props) {
  const actions = teamActions(run), next = run.steps[run.next], finished = run.steps.filter(step => ['complete', 'skipped'].includes(step.state)).length;
  const latestReview = run.steps.findLast(step => step.role === 'review' && step.state === 'complete' && step.review)?.review;
  const outcome = run.state === 'complete' ? run.reviewOutcome ?? 'unreported' : undefined;
  const reviewCurrent = !!outcome && outcome !== 'unreported' && latestReview?.verdict === outcome;
  return <div className="team-workflow-details">
    <div className="section-heading"><strong>{run.projectName}</strong><span>{runLabels[run.state]}</span></div>
    <p className="metadata">{finished} of {run.steps.length} stages finished{next ? ` · Current stage ${run.next + 1}: ${roleLabels[next.role]}` : ''}</p>
    <p role="status" className="metadata">{run.message}</p>
    {(run.reviewRound ?? 0) > 0 && <p className="metadata">Fix round {run.reviewRound}{run.applyFindings ? ` of ${run.applyFindings.limit}` : ''} · Earlier work and reviews remain below.</p>}
    {outcome === 'unreported' && <section className="team-review-summary" aria-label="Review outcome"><strong>Review report unavailable</strong><p className="metadata">No confirmed structured review is available. Read the saved handoffs and original conversations before deciding whether the work is ready.</p></section>}
    {latestReview && <section className="team-review-summary" aria-label={reviewCurrent ? 'Review outcome' : 'Earlier review'}>
      <div className="section-heading"><strong>{reviewCurrent ? reviewLabels[latestReview.verdict] : 'Earlier review'}</strong>{!reviewCurrent && <small>{reviewLabels[latestReview.verdict]}</small>}</div>
      <TeamReviewDetails review={latestReview}/>
      {reviewCurrent && latestReview.verdict === 'ready_for_review' && <p className="metadata">The reviewer reported no outstanding findings. Check the changes and reported checks before accepting or publishing.</p>}
      {reviewCurrent && latestReview.verdict === 'needs_changes' && <div className="team-review-action">
        {actions.includes('apply_findings') ? <><p className="metadata">Send these findings to the builder, then have the reviewer check the fixes. Starts fix round {(run.reviewRound ?? 0) + 1} of {run.applyFindings!.limit}. Your existing file changes and earlier results stay in place.</p><button className="primary" disabled={blocked} onClick={() => control('apply_findings')}>Apply findings</button></> : <p className="metadata">{run.applyFindings?.reason ?? 'Review the findings and workflow status before starting another fix round.'}</p>}
      </div>}
    </section>}
    {run.state === 'complete' && <p className="metadata">Review the results and actual changes. Finished stages do not mean the changes have been accepted or published.</p>}
    {run.state === 'stopping' && <p className="metadata">The stop is not confirmed yet. Check the original conversation; no further stage will start.</p>}
    {next?.state === 'unknown' && <p className="metadata">Check the original conversation to reconcile its outcome. Retrying or skipping is unavailable while it may still be running.</p>}
    {run.state === 'paused' && next?.state === 'running' && <p className="metadata">The current stage may still be working. Pausing prevents the next stage from starting.</p>}
    <div className="button-row">
      {actions.includes('pause') && <button disabled={blocked} onClick={() => control('pause')}>Pause after stage</button>}
      {actions.includes('resume') && <button disabled={blocked} onClick={() => control('resume')}>Resume</button>}
      {actions.includes('stop') && <button disabled={blocked} onClick={() => control('stop')}>Stop team</button>}
      <button type="button" onClick={refresh}>Check status</button>
    </div>
    <ol className="team-stages">{run.steps.map((step, index) => <li key={index}>
      <div className="section-heading"><strong>{index + 1}. {step.agentName} · {roleLabels[step.role]}</strong><small>{stageLabels[step.state]}</small></div>
      {!!step.reviewRound && <p className="metadata">Fix round {step.reviewRound}{step.role === 'review' ? ' · Re-review' : ''}</p>}
      {(step.attempt ?? 1) > 1 && <p className="metadata">Attempt {step.attempt}</p>}
      {step.message && <p className="metadata">{step.message}</p>}
      {step.conversationId && <button type="button" onClick={() => openConversation(step.conversationId!)}>Open conversation</button>}
      <TeamHandoffPreview teamId={run.id} attempt={step}/>
      {step.review && <SavedReview review={step.review}/>}
      {!!step.attempts?.length && <details className="team-attempts"><summary>Previous attempts ({step.attempts.length})</summary>{step.attempts.map(attempt => <article key={attempt.attempt}>
        <strong>Attempt {attempt.attempt} · {stageLabels[attempt.state]}</strong>
        {attempt.message && <p className="metadata">{attempt.message}</p>}
        {attempt.conversationId && <button type="button" onClick={() => openConversation(attempt.conversationId!)}>Open attempt {attempt.attempt} conversation</button>}
        <TeamHandoffPreview teamId={run.id} attempt={attempt}/>
        {attempt.review && <SavedReview review={attempt.review}/>}
      </article>)}</details>}
      {index === run.next && actions.includes('retry') && <div className="team-retry">
        <p className="metadata">Retry creates a new attempt with this member’s captured instructions and access in the same checkout. Existing file changes remain.</p>
        <p className="metadata preserve-lines">Checkout: {run.folder}</p>
        <button disabled={blocked} onClick={() => control('retry')}>Retry failed stage</button>
      </div>}
      {index === run.next && actions.includes('skip') && <button disabled={blocked} onClick={() => control('skip')}>Skip this stage</button>}
    </li>)}</ol>
  </div>;
}
