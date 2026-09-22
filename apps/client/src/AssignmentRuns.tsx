import { useEffect, useRef, useState } from 'react';
import type { Entity, Snapshot } from '../../../packages/domain/contracts';
import type { Assignment } from '../../../packages/domain/workspace-records';
import { assignmentHoldsSlot, assignmentTerminal, type AssignmentAttempt, type AssignmentStart, type AssignmentState } from '../../../packages/domain/assignments';
import { ApiError, readLocal, request, saveLocal } from './api';
import { retainedWindowId } from './useWorkspace';
import { AssignmentReview } from './AssignmentReview';
import { UseAssignmentInContent } from './ContentOutputs';
import { Dialog } from './ui';
import { AssignmentApprovalTray, useAssignmentApprovals } from './AssignmentApprovalTray';
import { assignmentNeedsApproval } from '../../../packages/domain/assignment-approvals';
import { ModuleActionTray } from './ModuleActionTray';
import { useDeadline } from './useDeadline';

function AssignmentTime({ attempt }: { attempt: AssignmentAttempt }) {
  const active = !assignmentTerminal(attempt.state) && !attempt.stopReason;
  const clock = useDeadline(attempt.deadlineAt, active);
  if (!active) return null;
  return <p className="metadata">{clock.expired ? 'The time limit has elapsed; waiting for the confirmed outcome.' : <>Time before requesting stop: <time dateTime={new Date(attempt.deadlineAt).toISOString()}>{clock.remaining}</time>. Approval waiting is included.</>}</p>;
}

const labels: Record<AssignmentAttempt['state'], string> = { prepared: 'Preparing', dispatching: 'Starting', running: 'Working', stopping: 'Stopping', returned: 'Ready for review', failed: 'Ended with an error', cancelled: 'Stopped', unknown: 'Needs reconciliation' };
export function AssignmentRuns({ entity, snapshot, dirty, refresh, openContent }: { entity: Entity<Assignment>; snapshot: Snapshot; dirty: boolean; refresh: () => Promise<void>; openContent?: (id: string) => void }) {
  const key = `e3:assignment-start:${snapshot.deviceId}:${snapshot.epoch}:${entity.id}:${retainedWindowId}`;
  const [pending, setPending] = useState<AssignmentStart | undefined>(() => readLocal(key));
  const [state, setState] = useState<AssignmentState>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [rejected, setRejected] = useState(false);
  const [detail, setDetail] = useState<string>();
  const [unresolved, setUnresolved] = useState<AssignmentAttempt>();
  const [older, setOlder] = useState<AssignmentAttempt[]>([]), [olderCursor, setOlderCursor] = useState<string | null>();
  const mounted = useRef(true), flight = useRef(false), sequence = useRef(0);
  const load = async () => {
    const id = ++sequence.current;
    const next = await request<AssignmentState>(`assignments/state?assignmentId=${encodeURIComponent(entity.id)}`);
    if (mounted.current && id === sequence.current) setState(next);
    return next;
  };
  useEffect(() => {
    mounted.current = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await load(); } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'Assignment status could not load.'); }
      finally { if (mounted.current) timer = setTimeout(() => void poll(), 3000); }
    };
    void poll(); return () => { mounted.current = false; sequence.current++; clearTimeout(timer); };
  }, [key]);
  const start = async () => {
    if (flight.current) return;
    const command: AssignmentStart = pending ?? readLocal<AssignmentStart>(key) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, assignmentId: entity.id, revision: entity.revision, projectRevision: snapshot.projects.find(p => p.id === entity.value.projectId)?.revision ?? null };
    if (!saveLocal(key, command)) { setError('Free browser storage before starting. Your saved plan is kept.'); return; }
    setPending(command); setBusy(true); flight.current = true; setError('');
    try {
      await request<AssignmentAttempt>('assignments/start', command);
      if (saveLocal(key, null) && mounted.current) setPending(undefined);
      await load();
    } catch (reason) {
      if (mounted.current) { setError(reason instanceof Error ? reason.message : 'Start was not confirmed. Reconcile the same request.'); setRejected(reason instanceof ApiError && ['assignment_changed', 'project_changed', 'agent_changed', 'assignment_source_changed', 'assignment_file_changed', 'assignment_file_unsupported', 'assignment_input_large', 'assignment_unavailable', 'assignment_quota', 'epoch_changed', 'validation'].includes(reason.code)); }
    } finally { flight.current = false; if (mounted.current) setBusy(false); }
  };
  const act = async (attempt: AssignmentAttempt, action: 'check' | 'stop' | 'acknowledge') => {
    if (flight.current) return;
    setBusy(true); flight.current = true; setError('');
    try {
      if (action !== 'check') {
        const actionKey = `e3:assignment-${action}:${snapshot.deviceId}:${snapshot.epoch}:${attempt.id}`;
        const command = readLocal(actionKey) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, attemptId: attempt.id, ...(action === 'acknowledge' ? { understandUnconfirmed: true } : {}) };
        if (!saveLocal(actionKey, command)) throw new Error('Free browser storage before continuing this request.');
        await request(`assignments/${action}`, command);
      } else await request(`assignments/check/${attempt.id}`);
      await load();
      if (mounted.current && action === 'acknowledge') setUnresolved(undefined);
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'The attempt remains available for reconciliation.'); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  };
  const recent = state?.attempts.filter(attempt => attempt.assignmentId === entity.id) ?? [];
  const attempts = [...recent, ...older.filter(attempt => !recent.some(item => item.id === attempt.id))];
  const approvals = useAssignmentApprovals(key, attempts.some(a => !!a.nativeTools?.length), attempts.some(a => !!a.nativeTools?.length && !assignmentTerminal(a.state)));
  const nextCursor = olderCursor === undefined ? state?.nextCursor : olderCursor;
  const loadOlder = async () => {
    if (!nextCursor || flight.current) return;
    flight.current = true; setBusy(true);
    try { const page = await request<AssignmentState>(`assignments/state?assignmentId=${encodeURIComponent(entity.id)}&before=${nextCursor}`); if (mounted.current) { setOlder(current => [...current, ...page.attempts.filter(attempt => attempt.assignmentId === entity.id && !current.some(item => item.id === attempt.id))]); setOlderCursor(page.nextCursor); } }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'Earlier attempts could not load.'); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  };
  const activeElsewhere = state?.attempts.find(attempt => attempt.assignmentId !== entity.id && assignmentHoldsSlot(attempt));
  const canReview = (attempt: AssignmentAttempt) => !attempt.unresolvedReview && !!attempt.stopReason && ['unknown', 'stopping'].includes(attempt.state);
  return <section className="record-connections assignment-runs" aria-label="Assignment execution">
    <div className="section-heading"><h3>Work with this agent</h3><button className="primary" disabled={busy || rejected || (!pending && (!state?.canStart || entity.value.archived || entity.value.state !== 'planned' || dirty))} onClick={() => void start()}>{busy ? 'Updating…' : pending ? 'Reconcile start' : `Run saved version ${entity.revision}`}</button></div>
    <p className="metadata">The agent uses the saved design and selected source versions, then returns a result for your review. Selected app capabilities are enforced for this run. Proposed changes appear below for your review. A stop is requested after {entity.value.maxMinutes ?? 5} minute{(entity.value.maxMinutes ?? 5) === 1 ? "" : "s"}, including time spent waiting for your approval.</p>
    {dirty && <p className="notice">Save or discard your plan edits before starting a new attempt.</p>}
    {!state?.canStart && <p role="status" className="metadata">{state?.reason ?? 'Connecting to assignment status…'}</p>}
    {activeElsewhere && <article className="assignment-attempt"><strong>{activeElsewhere.title} · {labels[activeElsewhere.state]}</strong><p>{activeElsewhere.message}</p><AssignmentTime attempt={activeElsewhere}/><div className="button-row"><button disabled={busy} onClick={() => void act(activeElsewhere, 'check')}>Check current assignment</button><button disabled={busy} onClick={() => void act(activeElsewhere, 'stop')}>Stop current assignment</button>{canReview(activeElsewhere) && <button disabled={busy} onClick={() => setUnresolved(activeElsewhere)}>Review unresolved attempt</button>}</div></article>}
    {error && <p role="alert" className="field-error">{error}</p>}
    {(approvals.error || approvals.state?.message) && <p role="status">{approvals.error || approvals.state?.message}</p>}
    {rejected && <button disabled={busy} onClick={() => { if (saveLocal(key, null)) { setPending(undefined); setRejected(false); setError(''); void load().catch(() => undefined); } }}>Review current plan</button>}
    {!attempts.length && <p className="metadata">No attempts yet. Each run keeps its own saved inputs and result.</p>}
    {attempts.map(attempt => <article key={attempt.id} className="assignment-attempt"><div className="section-heading"><strong>{assignmentNeedsApproval(attempt, approvals.state?.items ?? []) ? 'Needs approval' : labels[attempt.state]}</strong><span className="metadata">{new Date(attempt.createdAt).toLocaleString()}</span></div><p className="metadata">Plan v{attempt.assignmentRevision} · {attempt.agentName} v{attempt.agentRevision}{attempt.terminal ? ` · ${attempt.terminal.model}` : ''}</p><p role="status">{attempt.message}</p><AssignmentTime attempt={attempt}/>
      <AssignmentApprovalTray attempt={attempt} epoch={snapshot.epoch} state={approvals.state} refresh={approvals.refresh}/><ModuleActionTray assignmentId={attempt.id} epoch={snapshot.epoch} refreshWorkspace={refresh} working={!assignmentTerminal(attempt.state) && !attempt.stopReason}/>{attempt.result && <><pre className="assignment-result">{attempt.result.preview || (attempt.result.disposition === 'silent' ? 'The agent returned no visible reply.' : 'No text was returned.')}</pre>{attempt.result.previewTruncated && <p className="metadata">Preview shortened. The download contains the complete result.</p>}</>}
      {attempt.unresolvedReview && !assignmentTerminal(attempt.state) && <p className="notice">Kept unresolved after your review. You can start another assignment; check this original attempt again to recover any later result.</p>}
      <div className="button-row"><button onClick={() => setDetail(attempt.id)}>Review saved inputs</button>{attempt.result && <a className="output-download" href={`/api/attachments/${attempt.result.file.id}`}>Download full result</a>}{openContent && attempt.state === "returned" && attempt.result?.disposition === "visible" && !!attempt.result.file.size && <UseAssignmentInContent attempt={attempt} snapshot={snapshot} refresh={refresh} openContent={openContent}/>}{!assignmentTerminal(attempt.state) && <><button disabled={busy} onClick={() => void act(attempt, 'check')}>Check status</button><button disabled={busy} onClick={() => void act(attempt, 'stop')}>{attempt.stopReason ? 'Reconcile stop' : 'Stop assignment'}</button>{canReview(attempt) && <button disabled={busy} onClick={() => setUnresolved(attempt)}>Review unresolved attempt</button>}</>}</div>
    </article>)}
    {nextCursor && <button disabled={busy} onClick={() => void loadOlder()}>Load earlier attempts</button>}
    {detail && <AssignmentReview key={detail} id={detail} close={() => setDetail(undefined)}/>}
    {unresolved && <Dialog title="Unresolved attempt" close={() => { if (!busy) setUnresolved(undefined); }}><h3>{unresolved.title}</h3><p>Its result or stop could not be confirmed. The original attempt stays in history so you can check it again.</p><p>Starting another assignment may repeat work if this one is still running. This choice does not mark it completed or start another run.</p>{error && <p role="alert">{error}</p>}<div className="button-row"><button disabled={busy} onClick={() => setUnresolved(undefined)}>Keep waiting</button><button className="primary" disabled={busy} onClick={() => void act(unresolved, 'acknowledge')}>{busy ? 'Saving your review…' : 'Keep unresolved and allow another'}</button></div></Dialog>}
  </section>;
}
