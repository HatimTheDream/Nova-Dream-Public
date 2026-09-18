import { useEffect, useRef, useState } from 'react';
import type { TeamAttempt, TeamHandoff, TeamStep, TeamWork } from '../../../packages/domain/team-work';
import { request } from './api';
import { emptyHandoffRead, TeamHandoffReader } from './team-handoff-reader';

export type TeamAction = 'pause' | 'resume' | 'stop' | 'skip' | 'retry';
const stageLabels: Record<TeamStep['state'], string> = { waiting: 'Waiting', running: 'Working', complete: 'Handoff returned', failed: 'Failed', cancelled: 'Stopped', unknown: 'Outcome unconfirmed', skipped: 'Skipped by you' };
const runLabels: Record<TeamWork['state'], string> = { running: 'In progress', paused: 'Paused', stopping: 'Stop requested', complete: 'Stages finished', cancelled: 'Stopped', attention: 'Needs your review' };
const roleLabels: Record<TeamStep['role'], string> = { research: 'Research & plan', build: 'Implement', review: 'Review' };

export function teamActions(run: TeamWork): TeamAction[] {
  const step = run.steps[run.next], recoverable = ['paused', 'attention'].includes(run.state);
  return [
    ...(run.state === 'running' ? ['pause' as const] : []),
    ...(recoverable && step && !['failed', 'cancelled', 'unknown'].includes(step.state) ? ['resume' as const] : []),
    ...(recoverable && step?.state === 'failed' && !!step.operationId ? ['retry' as const] : []),
    ...(recoverable && step && ['failed', 'cancelled'].includes(step.state) ? ['skip' as const] : []),
    ...(!['complete', 'cancelled', 'stopping'].includes(run.state) ? ['stop' as const] : []),
  ];
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
  return <div className="team-workflow-details">
    <div className="section-heading"><strong>{run.projectName}</strong><span>{runLabels[run.state]}</span></div>
    <p className="metadata">{finished} of {run.steps.length} stages finished{next ? ` · Current stage ${run.next + 1}: ${roleLabels[next.role]}` : ''}</p>
    <p role="status" className="metadata">{run.message}</p>
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
      {(step.attempt ?? 1) > 1 && <p className="metadata">Attempt {step.attempt}</p>}
      {step.message && <p className="metadata">{step.message}</p>}
      {step.conversationId && <button type="button" onClick={() => openConversation(step.conversationId!)}>Open conversation</button>}
      <TeamHandoffPreview teamId={run.id} attempt={step}/>
      {!!step.attempts?.length && <details className="team-attempts"><summary>Previous attempts ({step.attempts.length})</summary>{step.attempts.map(attempt => <article key={attempt.attempt}>
        <strong>Attempt {attempt.attempt} · {stageLabels[attempt.state]}</strong>
        {attempt.message && <p className="metadata">{attempt.message}</p>}
        {attempt.conversationId && <button type="button" onClick={() => openConversation(attempt.conversationId!)}>Open attempt {attempt.attempt} conversation</button>}
        <TeamHandoffPreview teamId={run.id} attempt={attempt}/>
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
