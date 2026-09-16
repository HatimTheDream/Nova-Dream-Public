import { Target, ChevronDown } from './icons';
import { useEffect, useState } from 'react';
import type { Conversation } from '../../../packages/domain/assistant';
import { goalElapsedMs, goalElapsedLabel, type ChatGoal } from '../../../packages/domain/chat-goal';
import { ApiError, readLocal, request, saveLocal } from './api';
export function ChatGoalControl({ conversation, epoch, refresh }: { conversation: Conversation; epoch: string; refresh(): Promise<void> }) {
  const key = `e3:chat-goal:${epoch}:${conversation.id}`;
  const [goal, setGoal] = useState<ChatGoal | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  useEffect(() => { setNow(Date.now()); if (goal?.status !== 'active' || goal.createdAt === undefined) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [goal?.id, goal?.status, goal?.createdAt]);
  const [pending, setPending] = useState<any>(() => readLocal(key));
  useEffect(() => {
    let live = true, loading = false;
    const read = async () => { if (loading) return; loading = true; try { const result = await request<{ goal: ChatGoal | null }>(`assistant/goal/${conversation.id}`); if (live) setGoal(result.goal); } catch { /* Chat connection owns reconnect feedback. */ } finally { loading = false; } };
    void read(); const timer = setInterval(() => { if (document.visibilityState === 'visible') void read(); }, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [conversation.id]);
  const act = async (action: 'pause' | 'resume' | 'complete' | 'clear') => {
    if ((!goal && !pending) || busy) return;
    const intent = pending ?? { requestId: crypto.randomUUID(), epoch, conversationId: conversation.id, nativeId: conversation.nativeId, goalId: goal!.id, issuedAtMs: Date.now(), action };
    if (!saveLocal(key, intent)) { setError('Free browser storage before changing the goal.'); return; }
    setPending(intent); setBusy(true); setError('');
    try { const result = await request<{ goal: ChatGoal | null }>('assistant/goal', intent); setGoal(result.goal); localStorage.removeItem(key); setPending(undefined); await refresh(); }
    catch (reason) { if (reason instanceof ApiError && ['goal_session_changed', 'epoch_changed', 'goal_changed', 'goal_missing'].includes(reason.code)) { localStorage.removeItem(key); setPending(undefined); } setError(reason instanceof Error ? reason.message : 'Goal change not confirmed. Retry this same change.'); }
    finally { setBusy(false); }
  };
  if (!goal && !pending) return null;
  const elapsed = goal ? goalElapsedMs(goal, now) : undefined;
  const objective = goal?.displayObjective ?? goal?.objective ?? '';
  const status = goal?.status === 'active' ? 'Pursuing goal' : goal?.status === 'complete' ? 'Goal complete' : goal?.status === 'paused' ? 'Goal paused' : goal ? `Goal · ${goal.status.replace(/_/g, ' ')}` : 'Checking goal';
  return <details className="chat-goal"><summary><Target size={16}/><span className="goal-status">{status}</span><span className="goal-objective" title={objective}>{objective}</span><span className="goal-elapsed" aria-label="Goal elapsed time" title={elapsed === undefined ? "Elapsed time unavailable" : "Elapsed time"}>{elapsed === undefined ? "—" : goalElapsedLabel(elapsed)}</span><ChevronDown size={14}/></summary><div className="chat-goal-content">{goal && <p className="preserve-lines">{goal.displayObjective ?? goal.objective}</p>}{error && <p role="status">{error}</p>}<div className="button-row">{pending ? <button disabled={busy} onClick={() => void act(pending.action)}>Retry goal change</button> : goal?.status === 'active' ? <button disabled={busy} onClick={() => void act('pause')}>Pause goal</button> : goal?.status !== 'complete' ? <button disabled={busy} onClick={() => void act('resume')}>Resume goal</button> : null}{goal && !pending && goal.status !== 'active' && <button disabled={busy} onClick={() => void act('clear')}>Clear goal</button>}</div></div></details>;
}
