import { useEffect, useMemo, useRef, useState } from 'react';
import { attemptsForPlan, briefFromTask } from '../../../packages/domain/task-work';
import { assignmentTerminal, type AssignmentState } from '../../../packages/domain/assignments';
import { commit, mayPoll, request, saveLocal } from './api';
import { pollReader } from './polling';
import { RefreshReader } from './refresh-reader';
import { assignmentStatusLabels as attemptLabels } from './assignment-status';
import { createTaskAssistantLaunch, readTaskAssistantLaunch, resumeTaskAssistantLaunch, taskAssistantLaunchFailure, type TaskAssistantLaunchJournal, type TaskAssistantLaunchScope } from './task-assistant-launch';
import { Dialog } from './ui';
import type { Entity, Snapshot, Task } from '../../../packages/domain/contracts';

const timeLimits = [1, 2, 3, 5, 10];
const message = (reason: unknown) => reason instanceof Error ? reason.message : 'Request not confirmed.';

function loadLaunch(key: string, scope: TaskAssistantLaunchScope) {
  // An unreadable journal must never authorize a replacement execution.
  const raw = localStorage.getItem(key);
  if (raw === null) return undefined;
  const value: unknown = JSON.parse(raw);
  if (value === null) throw new Error('Saved request is incomplete.');
  return readTaskAssistantLaunch(value, scope);
}

export function TaskAssistantWork({ taskId, taskRevision, value, snapshot, dirty, saved, blocked, openOrigin, onTaskConfirmed, onPendingChange, onReview }: {
  taskId: string; taskRevision: number; value: Task; snapshot: Snapshot; dirty: boolean; saved: boolean; blocked: boolean;
  openOrigin?: (origin: NonNullable<Task['origin']>) => void;
  onTaskConfirmed: (task: Entity<Task>, captured: Entity<Task>) => boolean;
  onPendingChange: (pending: boolean) => void;
  onReview: (attemptId: string) => void;
}) {
  const scope = useMemo(() => ({ taskId, deviceId: snapshot.deviceId, epoch: snapshot.epoch }), [taskId, snapshot.deviceId, snapshot.epoch]);
  const key = `e3:task-assistant-launch:${scope.deviceId}:${scope.epoch}:${taskId}`;
  const [kept, setKept] = useState(() => {
    try { return { journal: loadLaunch(key, scope), error: '' }; }
    catch { return { journal: undefined as TaskAssistantLaunchJournal | undefined, error: 'Cannot read the saved request. Keep browser data; new work is blocked.' }; }
  });
  const journal = kept.journal;
  const [dialogOpen, setDialogOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [failure, setFailure] = useState<ReturnType<typeof taskAssistantLaunchFailure>>();
  const [runState, setRunState] = useState<AssignmentState>(), [readError, setReadError] = useState('');
  const flight = useRef(false), alive = useRef(true), reader = useRef<RefreshReader<AssignmentState> | undefined>(undefined);
  const callbacks = useRef({ onTaskConfirmed, onPendingChange }); callbacks.current = { onTaskConfirmed, onPendingChange };
  const origin = value.origin?.kind === 'assignment' ? value.origin : journal?.plan ? { kind: 'assignment' as const, id: journal.plan.id, revision: journal.plan.revision } : undefined;
  const pending = !!journal && !journal.attempt && !journal.linkRefusal;
  const taskWritesBlocked = pending && !journal?.task;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    callbacks.current.onPendingChange(taskWritesBlocked || !!kept.error || busy);
    if (journal?.task) callbacks.current.onTaskConfirmed(journal.task, journal.capturedTask);
  }, [taskWritesBlocked, kept.error, busy, journal?.task?.revision]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key !== key || flight.current) return;
      try { setKept({ journal: loadLaunch(key, scope), error: '' }); }
      catch { setKept(current => ({ ...current, error: 'Cannot read the saved request. Keep browser data; new work is blocked.' })); }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [key, scope]);
  useEffect(() => {
    setRunState(undefined); setReadError('');
    if (!origin) return;
    const path = `assignments/state?assignmentId=${encodeURIComponent(origin.id)}`;
    const next = new RefreshReader<AssignmentState>({
      identity: () => `${key}:${origin.id}`, read: signal => request(path, undefined, signal), mayPoll: () => mayPoll(path),
      accept: state => { setRunState(state); setReadError(''); }, fail: reason => setReadError(message(reason)),
    });
    reader.current = next;
    const stop = pollReader(next, () => 3000, 30000);
    return () => { stop(); next.cancel(); if (reader.current === next) reader.current = undefined; };
  }, [key, origin?.id]);
  useEffect(() => { if (journal?.attempt) void reader.current?.refresh(); }, [journal?.attempt?.id]);

  const launch = async (input?: { agentId: string; brief: string; expectedOutput: string; maxMinutes: number }) => {
    if (flight.current || blocked || kept.error || !saved) return;
    flight.current = true; setBusy(true); setError(''); setFailure(undefined); callbacks.current.onPendingChange(true);
    try {
      if (!navigator.locks) throw new Error('This browser cannot coordinate work across windows. Update or switch browsers.');
      await navigator.locks.request(key, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('Another window is checking this task. Please wait.');
        let current = loadLaunch(key, scope) ?? journal;
        if (!current) {
          if (!input || dirty) throw new Error('Save this task before starting work.');
          const agent = snapshot.records?.agent.find(item => item.id === input.agentId && !item.value.archived);
          if (!agent) throw new Error('Choose an agent.');
          current = createTaskAssistantLaunch({ scope, task: { id: taskId, revision: taskRevision, value, deviceId: scope.deviceId, updatedAt: '' }, agent,
            projectRevision: snapshot.projects.find(item => item.id === value.projectId)?.revision ?? null, ...input });
        }
        const ownRequest = current.planCommand.requestId;
        const save = (next: TaskAssistantLaunchJournal) => {
          if (!alive.current) return false;
          const existing = loadLaunch(key, scope);
          if (existing && existing.planCommand.requestId !== ownRequest) throw new Error('Another request is kept. Reopen this task.');
          if (!saveLocal(key, next)) return false;
          setKept({ journal: next, error: '' });
          return !next.task || callbacks.current.onTaskConfirmed(next.task, next.capturedTask);
        };
        if (current.attempt || current.linkRefusal) {
          if (!alive.current) return;
          setKept({ journal: current, error: '' });
          if (current.task) callbacks.current.onTaskConfirmed(current.task, current.capturedTask);
        } else await resumeTaskAssistantLaunch(current, scope, { commit, start: input => request('assignments/start', input), save });
        if (alive.current) { setDialogOpen(false); void reader.current?.refresh(); }
      });
    } catch (reason) {
      if (alive.current) {
        setError(message(reason)); setFailure(taskAssistantLaunchFailure(reason));
        // A confirmed linking refusal is terminal for this request. Show the
        // retained plan and editable task instead of offering another launch.
        try { if (loadLaunch(key, scope)?.linkRefusal) setDialogOpen(false); } catch { /* keep the recovery message */ }
      }
    } finally {
      flight.current = false;
      if (alive.current) {
        setBusy(false);
        try { const current = loadLaunch(key, scope); callbacks.current.onPendingChange(!!current && !current.task && !current.linkRefusal); }
        catch { callbacks.current.onPendingChange(true); }
      }
    }
  };
  const plan = origin ? snapshot.records?.assignment.find(item => item.id === origin.id) ?? journal?.plan : undefined;
  const attempts = origin ? attemptsForPlan(runState?.attempts ?? (journal?.attempt ? [journal.attempt] : []), origin.id) : [];
  const latest = attempts[0];
  if (!saved) return null;
  return <>
    <section className="task-assistant-work" aria-label="Assistant work">
      {origin && <div className="section-heading"><h3>Assistant work</h3><button type="button" className="quiet" onClick={() => void reader.current?.refresh()}>Refresh status</button></div>}
      {(kept.error || error) && <p className="notice warning" role="alert">{kept.error || error}</p>}
      {journal?.linkRefusal && <p className="notice" role="status">The task changed. Its plan is kept in Agents. You can edit the task; no run started.</p>}
      {pending && <p className="notice" role="status">{failure === 'conflict' || failure === 'rejected' ? 'The host needs review. Your original request is kept.' : 'Check the original request to continue without duplicating work.'}</p>}
      {origin && <>
        {value.origin?.kind !== 'assignment' && <p className="metadata">Plan kept on this device; source preserved.</p>}
        <p><strong>{plan?.value.title || 'Saved plan'}</strong></p>
        {readError && <p className="notice warning" role="status">Status unavailable. {readError} Retrying.</p>}
        {latest ? <><p role="status">{attemptLabels[latest.state]} · {latest.message}</p><p className="metadata">{new Date(latest.createdAt).toLocaleString()}{!assignmentTerminal(latest.state) && ' · updates automatically'}</p></> : <p className="metadata" role="status">{runState ? pending ? 'Checking original request.' : 'No runs yet.' : 'Loading Assistant work…'}</p>}
        {attempts.length > 1 && <details className="attempt-history"><summary>Earlier runs ({attempts.length - 1})</summary><ul>{attempts.slice(1).map(attempt => <li key={attempt.id}><span>{attemptLabels[attempt.state]} · {new Date(attempt.createdAt).toLocaleString()}</span>{attempt.result && <button type="button" className="quiet" disabled={pending || busy} onClick={() => onReview(attempt.id)}>Review</button>}</li>)}</ul></details>}
        <div className="button-row">
          {openOrigin && <button type="button" disabled={busy} onClick={() => openOrigin(origin)}>Open plan in Agents</button>}
          {latest?.result && <button type="button" disabled={pending || busy || blocked} onClick={() => onReview(latest.id)}>Review result</button>}
        </div>
      </>}
      {pending ? <button type="button" disabled={busy || blocked || !!kept.error} onClick={() => void launch()}>{busy ? 'Checking original request…' : 'Check original request'}</button>
        : !origin && <button type="button" disabled={dirty || blocked || !!kept.error || busy} onClick={() => setDialogOpen(true)}>Start assistant work</button>}
      {!origin && dirty && <p className="metadata">Save this task before starting work.</p>}
    </section>
    {dialogOpen && <StartAssistantDialog value={value} snapshot={snapshot} busy={busy} pending={pending} error={error} close={() => { if (!flight.current) setDialogOpen(false); }} start={launch} />}
  </>;
}

function StartAssistantDialog({ value, snapshot, busy, pending, error, close, start }: {
  value: Task; snapshot: Snapshot; busy: boolean; pending: boolean; error: string; close: () => void;
  start: (input?: { agentId: string; brief: string; expectedOutput: string; maxMinutes: number }) => Promise<void>;
}) {
  const agents = snapshot.records?.agent.filter(agent => !agent.value.archived) ?? [];
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [brief, setBrief] = useState(() => briefFromTask(value, snapshot.projects.find(project => project.id === value.projectId)));
  const [expectedOutput, setExpectedOutput] = useState(''), [maxMinutes, setMaxMinutes] = useState(5);
  return <Dialog title="Start assistant work" close={close}>
    {error && <p className="notice warning" role="alert">{error}</p>}
    {pending && <p role="status">Request and brief kept. Check original request to continue.</p>}
    {!agents.length && <p className="metadata">Create an agent in Agents.</p>}
    <fieldset disabled={busy || pending}>
      <label>Agent<select value={agentId} onChange={event => setAgentId(event.target.value)}>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.value.name}</option>)}</select></label>
      <label>Brief<textarea rows={4} maxLength={20000} value={brief} onChange={event => setBrief(event.target.value)} /></label>
      <label>Expected output<input maxLength={10000} value={expectedOutput} onChange={event => setExpectedOutput(event.target.value)} placeholder="Optional" /></label>
      <label>Time limit<select value={maxMinutes} onChange={event => setMaxMinutes(Number(event.target.value))}>{timeLimits.map(minutes => <option key={minutes} value={minutes}>{minutes}</option>)}</select><small>minutes before requesting stop</small></label>
    </fieldset>
    <div className="dialog-footer"><button type="button" className="quiet" disabled={busy} onClick={close}>{pending ? 'Keep for later' : 'Cancel'}</button><button type="button" className="primary" disabled={busy || (!pending && !agentId)} onClick={() => void start(pending ? undefined : { agentId, brief, expectedOutput, maxMinutes })}>{busy ? 'Checking…' : pending ? 'Check original request' : 'Create and start'}</button></div>
  </Dialog>;
}
