import { useEffect, useState } from 'react';
import { briefFromTask, latestAttemptForPlan, planValueFromTask } from '../../../packages/domain/task-work';
import { ApiError, commit, request } from './api';
import { Dialog } from './ui';
import type { Entity, Snapshot, Task } from '../../../packages/domain/contracts';
import type { AgentDesign, Assignment } from '../../../packages/domain/workspace-records';
import type { AssignmentAttempt, AssignmentState } from '../../../packages/domain/assignments';

const attemptLabels: Record<AssignmentAttempt['state'], string> = {
  prepared: 'Preparing', dispatching: 'Starting', running: 'Working', stopping: 'Stopping',
  returned: 'Ready for review', failed: 'Ended with an error', cancelled: 'Stopped', unknown: 'Needs reconciliation',
};
const timeLimits = [1, 2, 3, 5, 10];

export function TaskAssistantWork({ taskId, taskRevision, value, snapshot, dirty, saved, openOrigin, onOriginChange, onReview }: {
  taskId: string; taskRevision: number; value: Task; snapshot: Snapshot; dirty: boolean; saved: boolean;
  openOrigin?: (origin: NonNullable<Task['origin']>) => void;
  onOriginChange: (origin: NonNullable<Task['origin']>) => void;
  onReview: (attemptId: string) => void;
}) {
  const origin = value.origin?.kind === 'assignment' ? value.origin : undefined;
  const [runState, setRunState] = useState<AssignmentState>();
  const [readError, setReadError] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [startNotice, setStartNotice] = useState('');
  useEffect(() => {
    if (!origin) return;
    const controller = new AbortController();
    void request<AssignmentState>(`assignments/state?assignmentId=${encodeURIComponent(origin.id)}`, undefined, controller.signal)
      .then(next => { if (!controller.signal.aborted) { setRunState(next); setReadError(''); } })
      .catch(reason => { if (!controller.signal.aborted) setReadError(reason instanceof Error ? reason.message : 'Assistant work status could not load.'); });
    return () => controller.abort();
  }, [origin?.id]);

  if (origin) {
    const plan = snapshot.records?.assignment.find(record => record.id === origin.id);
    const latest = latestAttemptForPlan(runState?.attempts ?? [], origin.id);
    return <section className="task-assistant-work" aria-label="Assistant work">
      <div className="section-heading"><h3>Assistant work</h3></div>
      {startNotice && <p className="notice">{startNotice}</p>}
      {readError && <p className="notice warning" role="alert">{readError}</p>}
      {plan ? <>
        <p><strong>{plan.value.title || 'Untitled plan'}</strong> <span className="metadata">plan {plan.value.state} · version {plan.revision}</span></p>
        {latest ? <>
          <p>{attemptLabels[latest.state]} · {latest.message}</p>
          <p className="metadata">{new Date(latest.createdAt).toLocaleString()}</p>
        </> : <p className="metadata">No runs yet.</p>}
      </> : <p className="notice">The linked plan is unavailable.</p>}
      <div className="button-row">
        {openOrigin && <button type="button" onClick={() => openOrigin(origin)}>Open in Agents</button>}
        {latest?.result && <button type="button" onClick={() => onReview(latest.id)}>Review result</button>}
      </div>
    </section>;
  }

  if (!saved || value.trashed) return null;
  const agents = snapshot.records?.agent.filter(agent => !agent.value.archived) ?? [];
  return <>
    {startNotice && <p className="notice">{startNotice}</p>}
    <div className="task-assistant-work">
      <button type="button" disabled={dirty} onClick={() => setDialogOpen(true)}>Start assistant work</button>
      {dirty && <p className="metadata">Save the task first, then start assistant work.</p>}
    </div>
    {dialogOpen && <StartAssistantDialog taskId={taskId} taskRevision={taskRevision} value={value} snapshot={snapshot} agents={agents}
      close={() => setDialogOpen(false)} onOriginChange={onOriginChange} onStartNotice={setStartNotice} />}
  </>;
}

function StartAssistantDialog({ taskId, taskRevision, value, snapshot, agents, close, onOriginChange, onStartNotice }: {
  taskId: string; taskRevision: number; value: Task; snapshot: Snapshot; agents: Entity<AgentDesign>[];
  close: () => void; onOriginChange: (origin: NonNullable<Task['origin']>) => void; onStartNotice: (notice: string) => void;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [brief, setBrief] = useState(() => briefFromTask(value));
  const [expectedOutput, setExpectedOutput] = useState('');
  const [maxMinutes, setMaxMinutes] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const confirm = async () => {
    if (busy) return;
    const agent = agents.find(candidate => candidate.id === agentId);
    if (!agent) { setError('Choose an agent before starting.'); return; }
    setBusy(true); setError('');
    try {
      const planValue = { ...planValueFromTask(value, agent), brief, expectedOutput, maxMinutes };
      const plan = await commit<Assignment>({
        kind: 'assignment' as const, entityId: `assignment:${crypto.randomUUID()}`,
        requestId: crypto.randomUUID(), epoch: snapshot.epoch, expectedRevision: 0, payload: planValue,
      });
      try {
        await commit<Task>({
          kind: 'task' as const, entityId: taskId,
          requestId: crypto.randomUUID(), epoch: snapshot.epoch, expectedRevision: taskRevision,
          payload: { ...value, origin: { kind: 'assignment', id: plan.id, revision: plan.revision } },
        });
      } catch (reason) {
        if (reason instanceof ApiError && reason.code === 'revision_conflict') {
          throw new Error('The task was saved on the host after you opened this dialog. The plan was created but could not be linked. Close this dialog, refresh the task, and try again.');
        }
        throw reason;
      }
      onOriginChange({ kind: 'assignment', id: plan.id, revision: plan.revision });
      close();
      try {
        await request('assignments/start', {
          requestId: crypto.randomUUID(), epoch: snapshot.epoch,
          assignmentId: plan.id, revision: plan.revision, projectRevision: null,
        });
      } catch (reason) {
        onStartNotice(`Plan created and linked. The assistant could not start it (${reason instanceof Error ? reason.message : 'no confirmation'}). Start it from Agents when ready.`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The plan could not be created.');
      setBusy(false);
    }
  };
  return <Dialog title="Start assistant work" close={close}>
    {error && <p className="notice warning" role="alert">{error}</p>}
    {!agents.length && <p className="metadata">No agents are available. Create one in Agents first.</p>}
    <label>Agent<select value={agentId} onChange={event => setAgentId(event.target.value)}>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.value.name}</option>)}</select></label>
    <label>Brief<textarea rows={4} value={brief} onChange={event => setBrief(event.target.value)} /></label>
    <label>Expected output<input value={expectedOutput} onChange={event => setExpectedOutput(event.target.value)} placeholder="Optional" /></label>
    <label>Time limit<select value={maxMinutes} onChange={event => setMaxMinutes(Number(event.target.value))}>{timeLimits.map(minutes => <option key={minutes} value={minutes}>{minutes}</option>)}</select><small>minutes before requesting stop</small></label>
    <div className="dialog-footer">
      <button type="button" className="quiet" disabled={busy} onClick={close}>Cancel</button>
      <button type="button" className="primary" disabled={busy || !agentId} onClick={() => void confirm()}>{busy ? 'Starting…' : 'Create and start'}</button>
    </div>
  </Dialog>;
}
