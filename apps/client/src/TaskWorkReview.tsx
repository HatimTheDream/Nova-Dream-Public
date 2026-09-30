import { LoadingRing } from './ModuleLoading';
import { useEffect, useState } from 'react';
import { canAcceptAttempt, workResultPayload } from '../../../packages/domain/task-work';
import { commit, request, ApiError } from './api';
import { Dialog } from './ui';
import { AssignmentReview } from './AssignmentReview';
import type { Entity, Snapshot, Task } from '../../../packages/domain/contracts';
import type { AssignmentAttempt } from '../../../packages/domain/assignments';

type Reading = { fileId: string; name: string; page: number; pages: number; view: 'text' | 'image'; truncated: boolean; at: string };
type Detail = { attempt: AssignmentAttempt; readings?: Reading[] };

const stateLabels: Record<AssignmentAttempt['state'], string> = {
  prepared: 'Prepared', dispatching: 'Starting', running: 'Working', stopping: 'Stopping',
  returned: 'Returned', failed: 'Failed', cancelled: 'Stopped', unknown: 'Needs check',
};

export function TaskWorkReview({ taskId, draftValue, draftRevision, attemptId, snapshot, close, accepted }: {
  taskId: string; draftValue: Task; draftRevision: number; attemptId: string; snapshot: Snapshot;
  close: () => void; accepted: (entity: Entity<Task>) => void;
}) {
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState('');
  const [showInputs, setShowInputs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [acceptError, setAcceptError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void request<Detail>(`assignments/attempt/${attemptId}`, undefined, controller.signal).then(result => {
      if (!controller.signal.aborted) setDetail(result);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'The attempt could not load.');
    });
    return () => controller.abort();
  }, [attemptId]);
  if (showInputs) return <AssignmentReview id={attemptId} close={() => setShowInputs(false)} />;
  const attempt = detail?.attempt;
  const alreadyLinked = draftValue.workResult?.attemptId === attemptId;
  const accept = async () => {
    if (!attempt || busy) return;
    setBusy(true); setAcceptError('');
    try {
      const entity = await commit<Task>({
        kind: 'task', entityId: taskId, requestId: crypto.randomUUID(), epoch: snapshot.epoch,
        expectedRevision: draftRevision,
        payload: { ...draftValue, workResult: workResultPayload(attempt, Date.now()) },
      });
      accepted(entity);
    } catch (reason) {
      if (reason instanceof ApiError && (reason.code === 'revision_conflict' || reason.code === 'epoch_changed')) {
        setAcceptError('The task changed while reviewing. Close and try again.');
      } else {
        setAcceptError(reason instanceof Error ? reason.message : 'Accepting the result failed.');
      }
      setBusy(false);
    }
  };
  return <Dialog title="Review assistant work" close={close}>
    {error && <p role="alert">{error}</p>}
    {detail && attempt ? <>
      <h3>{attempt.title} · {stateLabels[attempt.state]}</h3>
      <p role="status">{attempt.message}</p>
      <p className="metadata">Plan v{attempt.assignmentRevision} · {attempt.agentName} v{attempt.agentRevision} · {new Date(attempt.createdAt).toLocaleString()}</p>
      <h3>Result</h3>
      {attempt.result ? <>
        <pre className="assignment-result">{attempt.result.preview || '(no visible text)'}</pre>
        {attempt.result.previewTruncated && <p className="metadata">Preview shortened. The download contains the complete result.</p>}
        <a className="output-download" href={`/api/attachments/${attempt.result.file.id}`}>Download full result</a>
      </> : <p className="notice">No result was returned for this attempt.</p>}
      <h3>Checks performed</h3>
      {attempt.terminal && <p className="metadata">Provider {attempt.terminal.provider} · model {attempt.terminal.model} · turn {attempt.terminal.turnId} · status {attempt.terminal.status}</p>}
      {detail.readings?.length ? <ul>{detail.readings.map(reading => <li key={`${reading.fileId}:${reading.page}:${reading.view}`}>{reading.name} · page {reading.page} of {reading.pages} · {reading.view === 'image' ? 'image pixels' : 'text'}{reading.truncated ? ' · incomplete excerpt' : ''}</li>)}</ul> : <p className="metadata">No source-tool reading was recorded.</p>}
      {attempt.stopReason && <p className="metadata">Stop requested ({attempt.stopReason}).</p>}
      {attempt.failedExecution && <p className="metadata">The run ended without a confirmed result.</p>}
      {attempt.state === 'unknown' && <p className="notice">The outcome could not be confirmed. Check the original attempt again before acting on any partial output.</p>}
      {attempt.state === 'failed' && attempt.message && <p className="notice">{attempt.message}</p>}
      {attempt.state === 'cancelled' && <p className="notice">Stopped before it finished. Anything it produced is saved above.</p>}
      {attempt.unresolvedReview && <p className="notice">You kept this unresolved earlier. Nothing here is marked complete.</p>}
      <h3>Saved inputs</h3>
      <div className="button-row"><button type="button" onClick={() => setShowInputs(true)}>View saved inputs</button></div>
      <p className="metadata">The exact plan, agent design and sources captured when this run started.</p>
      <div className="dialog-footer">
        {alreadyLinked ? <>
          <span className="metadata">Result accepted · linked to this task.</span>
          <div className="button-row"><button type="button" className="quiet" onClick={close}>Done</button></div>
        </> : canAcceptAttempt(attempt) ? <>
          {acceptError && <p role="alert">{acceptError}</p>}
          <div className="button-row">
            <button type="button" className="primary" disabled={busy} onClick={() => void accept()}>{busy ? 'Accepting…' : 'Accept result'}</button>
            <button type="button" className="quiet" disabled={busy} onClick={close}>Reject</button>
          </div>
          <p className="metadata">Reject closes without linking. The attempt stays in history.</p>
        </> : <div className="button-row"><button type="button" onClick={close}>Done</button></div>}
      </div>
    </> : !error && <LoadingRing label="Loading attempt…" />}
  </Dialog>;
}
