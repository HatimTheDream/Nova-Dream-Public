import { useEffect, useRef, useState } from 'react';
import type { AssignmentAttempt } from '../../../packages/domain/assignments';
import type { ConnectedResultDetail } from '../../../packages/domain/connected-work';
import type { Entity, Snapshot } from '../../../packages/domain/contracts';
import type { Content } from '../../../packages/domain/workspace-records';
import { ApiError, request } from './api';
import { clearResultCommand, pendingResultCommand, resultJournalKey, type ResultCommand } from './connected-result-draft';

export function useConnectedResult(attempt: AssignmentAttempt, snapshot: Snapshot, refresh: () => Promise<void>, openWork: (id: string, attemptId: string) => void) {
  const sha256 = attempt.result?.file.sha256 ?? '';
  const subject = { epoch: snapshot.epoch, attemptId: attempt.id, sha256 };
  const key = resultJournalKey(snapshot.deviceId, subject.epoch, subject.attemptId, sha256);
  const [detail, setDetail] = useState<ConnectedResultDetail>();
  const [readError, setReadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<ResultCommand | null>(null);
  const [revision, reload] = useState(0);
  const mounted = useRef(true), flight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      const signal = controller.signal;
      try {
        const next = await request<ConnectedResultDetail>('assignments/connected/' + encodeURIComponent(attempt.id), undefined, signal);
        if (signal.aborted) return;
        if (next.attempt.id !== attempt.id || next.attempt.assignmentId !== attempt.assignmentId || next.attempt.epoch !== snapshot.epoch ||
          (next.available && next.attempt.result?.file.sha256 !== sha256)) throw Error('The saved result could not be matched to this revision.');
        setDetail(next); setReadError('');
        if (next.available && next.savedContentId && next.acceptance?.sha256 === sha256 && next.savedContentId === next.acceptance.contentId) {
          const original = pendingResultCommand(localStorage, key, subject);
          if (original?.action === 'save') {
            clearResultCommand(localStorage, key, original);
            setPending(pendingResultCommand(localStorage, key, subject));
          }
        }
        // Only an in-progress review needs polling. Reopening or refocusing checks current access again.
        if (next.review.state === 'running') timer = setTimeout(read, 3000);
      } catch (reason) {
        if (!signal.aborted) { setDetail(undefined); setReadError(reason instanceof Error ? reason.message : 'The result could not be opened.'); }
      }
    }
    const recheck = () => {
      clearTimeout(timer); controller.abort(); controller = new AbortController();
      void read();
    };
    void read();
    window.addEventListener('focus', recheck);
    return () => { clearTimeout(timer); controller.abort(); window.removeEventListener('focus', recheck); };
  }, [key, revision, attempt.connectedStatus, snapshot.cursor]);
  useEffect(() => {
    try { setPending(pendingResultCommand(localStorage, key, subject)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The original pending action is unreadable.'); }
  }, [key]);

  async function send(command: ResultCommand): Promise<void> {
    const prior = pendingResultCommand(localStorage, key, subject);
    if (prior && JSON.stringify(prior) !== JSON.stringify(command)) throw Error('Check the original pending action before making another change.');
    localStorage.setItem(key, JSON.stringify(command));
    if (mounted.current) setPending(command);
    const route = 'assignments/connected/' + command.action;
    try {
      if (command.action === 'accept') {
        const accepted = await request<ConnectedResultDetail>(route, command.input);
        if (accepted.attempt.id !== attempt.id || accepted.acceptance?.sha256 !== sha256) throw Error('Acceptance has not been confirmed.');
        clearResultCommand(localStorage, key, command);
        if (mounted.current) { setPending(null); setDetail(accepted); }
        // Continue the original owner's explicit Accept And Save even if the view just closed.
        return await send({ action: 'save', input: { ...subject, requestId: crypto.randomUUID() } });
      }
      if (command.action === 'save') {
        const saved = await request<Entity<Content>>(route, command.input);
        const source = saved.value.source;
        if (source?.kind !== 'assignment' || source.attemptId !== attempt.id || source.sha256 !== sha256) throw Error('The saved Content draft could not be matched.');
        clearResultCommand(localStorage, key, command);
        if (mounted.current) { setPending(null); setDetail(current => current && ({ ...current, savedContentId: saved.id })); }
        await refresh();
      } else {
        const result = await request<AssignmentAttempt>(route, command.input);
        const linkedId = command.action === 'revise' ? result.connected?.baseAttemptId : result.connected?.subjectAttemptId;
        if (result.assignmentId !== attempt.assignmentId || result.epoch !== snapshot.epoch || linkedId !== attempt.id) throw Error('The new work could not be matched to the original result.');
        clearResultCommand(localStorage, key, command);
        if (mounted.current) setPending(null);
        if (mounted.current && command.action === 'revise') openWork(result.assignmentId, result.id);
      }
    } catch (reason) {
      // A definite refusal has no pending effect. An uncertain transport keeps its original command.
      if (reason instanceof ApiError && [400, 403, 404, 409, 422].includes(reason.status ?? 0)) {
        clearResultCommand(localStorage, key, command);
        if (mounted.current) setPending(pendingResultCommand(localStorage, key, subject));
      }
      throw reason;
    }
  }
  async function run(command: ResultCommand) {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError('');
    try { await send(command); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'The action has not been confirmed.'); }
    finally { flight.current = false; if (mounted.current) { setBusy(false); reload(value => value + 1); } }
  }
  return { detail, readError, error, busy, pending, run, reload: () => reload(n => n + 1), key, subject };
}
