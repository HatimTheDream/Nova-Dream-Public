import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalState } from '../../../packages/domain/approvals';
import { assignmentTerminal, type AssignmentAttempt } from '../../../packages/domain/assignments';
import { ApprovalCard } from './ApprovalTray';
import { request } from './api';

export function useAssignmentApprovals(key: string, enabled: boolean, polling: boolean) {
  const [saved, setSaved] = useState<{ key: string; state: ApprovalState }>();
  const [error, setError] = useState('');
  const current = useRef(key), mounted = useRef(false), sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!mounted.current || current.current !== key) return;
    const id = ++sequence.current, state = await request<ApprovalState>('assignments/approvals');
    if (mounted.current && current.current === key && id === sequence.current) { setSaved({ key, state }); setError(''); }
  }, [key]);
  useEffect(() => {
    current.current = key; mounted.current = true; setError('');
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(); }
      catch (reason) { if (alive) setError(reason instanceof Error ? reason.message : 'Approvals could not load.'); }
      finally { if (alive && polling) timer = setTimeout(() => void poll(), 2500); }
    };
    if (enabled) void poll();
    return () => { alive = false; mounted.current = false; sequence.current++; clearTimeout(timer); };
  }, [key, enabled, polling, refresh]);
  return { state: enabled && saved?.key === key ? saved.state : undefined, error, refresh };
}

export function AssignmentApprovalTray({ attempt, epoch, state, refresh }: { attempt: AssignmentAttempt; epoch: string; state?: ApprovalState; refresh: () => Promise<void> }) {
  if (!attempt.nativeTools?.length) return null;
  const readOnly = assignmentTerminal(attempt.state) || !!attempt.stopReason || Date.now() >= attempt.deadlineAt;
  const items = state?.items.filter(item => item.conversationId === attempt.id) ?? [];
  return <div aria-label="Agent action approvals">{items.filter(item => item.snapshot.status === 'pending' || item.action?.state === 'unknown').map(item => <ApprovalCard key={item.id} item={item} epoch={epoch} ready={state?.state === 'ready'} readOnly={readOnly} deadlineAt={attempt.deadlineAt} refresh={refresh}/>)}</div>;
}
