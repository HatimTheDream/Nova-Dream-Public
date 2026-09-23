import { Target, ChevronDown } from './icons';
import { useEffect, useRef, useState } from 'react';
import type { Conversation } from '../../../packages/domain/assistant';
import { goalElapsedMs, goalElapsedLabel, type ChatGoal } from '../../../packages/domain/chat-goal';
import { ApiError, readLocal, request, saveLocal } from './api';
import { startPolling } from './polling';
export function ChatGoalControl({ conversation, epoch, refresh, activityKey }: { conversation: Conversation; epoch: string; refresh(): Promise<void>; activityKey?: string }) {
  const key = `e3:chat-goal:${epoch}:${conversation.id}`;
  const [goal, setGoal] = useState<ChatGoal | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  useEffect(() => { setNow(Date.now()); if (goal?.status !== 'active' || goal.createdAt === undefined) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [goal?.id, goal?.status, goal?.createdAt]);
  const [pending, setPending] = useState<any>(() => readLocal(key));
  const [retry, setRetry] = useState(0), [checking, setChecking] = useState(false), [readError, setReadError] = useState('');
  const identity = `${key}:${conversation.nativeId}`;
  const currentView = useRef({ identity, live: true, busy: false });
  if (currentView.current.identity !== identity) {
    currentView.current.live = false; currentView.current = { identity, live: true, busy: false };
    setGoal(null); setPending(readLocal(key)); setBusy(false); setError(''); setReadError(''); setChecking(false);
  }
  const view = currentView.current;
  useEffect(() => {
    view.live = true;
    return () => { view.live = false; };
  }, [view, key]);
  useEffect(() => {
    if (busy) return;
    let live = true, needsUpdates = !!pending || goal?.status === 'active';
    const abort = new AbortController();
    const stop = startPolling({
      read: async () => {
        setChecking(true);
        try {
          const result = await request<{ goal: ChatGoal | null }>(`assistant/goal/${conversation.id}`, undefined, abort.signal);
          if (!live || !view.live || view.busy) return;
          needsUpdates = result.goal?.status === 'active' || !!pending;
          setGoal(result.goal); setReadError('');
          return true;
        } catch (reason) {
          if (live && view.live && !view.busy) setReadError(reason instanceof Error ? reason.message : 'Goal status could not be checked.');
          return false;
        } finally { if (live && view.live && !view.busy) setChecking(false); }
      },
      // One read discovers a goal. Empty, paused and completed chats have no recurring timer.
      // Focus and actual Goal operation transitions still refresh this view.
      interval: () => needsUpdates ? 15000 : null,
    });
    return () => { live = false; abort.abort(); stop(); };
  }, [epoch, conversation.id, conversation.nativeId, activityKey, retry, pending?.requestId, busy, view]);
  const act = async (action: 'pause' | 'resume' | 'complete' | 'clear') => {
    if ((!goal && !pending) || !view.live || view.busy) return;
    const intent = pending ?? { requestId: crypto.randomUUID(), epoch, conversationId: conversation.id, nativeId: conversation.nativeId, goalId: goal!.id, issuedAtMs: Date.now(), action };
    if (!saveLocal(key, intent)) { setError('Free browser storage before changing the goal.'); return; }
    view.busy = true; setPending(intent); setBusy(true); setError('');
    try {
      const result = await request<{ goal: ChatGoal | null }>('assistant/goal', intent);
      localStorage.removeItem(key);
      if (!view.live) return;
      setGoal(result.goal); setPending(undefined);
      try { await refresh(); } catch { if (view.live) setError('Goal updated. Refresh the conversation to check its latest reply.'); }
    } catch (reason) {
      const rejected = reason instanceof ApiError && ['goal_session_changed', 'epoch_changed', 'goal_changed', 'goal_missing'].includes(reason.code);
      if (rejected) localStorage.removeItem(key);
      if (view.live) { if (rejected) setPending(undefined); setError(reason instanceof Error ? reason.message : 'Goal change not confirmed. Retry this same change.'); }
    } finally { view.busy = false; if (view.live) setBusy(false); }
  };
  if (!goal && !pending) return readError ? <div className="metadata goal-read-status" role="status"><span>Goal status unavailable.</span><button className="text-button" disabled={checking} onClick={() => setRetry(n => n + 1)}>{checking ? 'Checking…' : 'Retry'}</button></div> : checking && activityKey ? <p className="metadata" role="status">Checking goal…</p> : null;
  const elapsed = goal ? goalElapsedMs(goal, now) : undefined;
  const objective = goal?.displayObjective ?? goal?.objective ?? '';
  const status = readError ? 'Goal status unconfirmed' : goal?.status === 'active' ? 'Pursuing goal' : goal?.status === 'complete' ? 'Goal complete' : goal?.status === 'paused' ? 'Goal paused' : goal ? `Goal · ${goal.status.replace(/_/g, ' ')}` : 'Checking goal';
  return <details className="chat-goal"><summary><Target size={16}/><span className="goal-status">{status}</span><span className="goal-objective" title={objective}>{objective}</span><span className="goal-elapsed" aria-label="Goal elapsed time" title={elapsed === undefined ? "Elapsed time unavailable" : "Elapsed time"}>{elapsed === undefined ? "—" : goalElapsedLabel(elapsed)}</span><ChevronDown size={14}/></summary><div className="chat-goal-content">{goal && <p className="preserve-lines">{goal.displayObjective ?? goal.objective}</p>}{readError && <p role="status">{readError} <button className="text-button" disabled={checking || busy} onClick={() => setRetry(n => n + 1)}>Check status</button></p>}{error && <p role="status">{error}</p>}<div className="button-row">{pending ? <button disabled={busy || checking} onClick={() => void act(pending.action)}>Retry goal change</button> : goal?.status === 'active' ? <button disabled={busy || checking} onClick={() => void act('pause')}>Pause goal</button> : goal?.status !== 'complete' ? <button disabled={busy || checking} onClick={() => void act('resume')}>Resume goal</button> : null}{goal && !pending && goal.status !== 'active' && <button disabled={busy || checking} onClick={() => void act('clear')}>Clear goal</button>}</div></div></details>;
}
