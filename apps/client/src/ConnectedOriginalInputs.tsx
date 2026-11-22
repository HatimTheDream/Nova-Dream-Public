import { useEffect, useState } from 'react';
import type { ConnectedResultDetail } from '../../../packages/domain/connected-work';
import type { ContentAssignmentSource } from '../../../packages/domain/workspace-records';
import { request } from './api';
import { ConnectedInputs } from './ConnectedReviewPanel';
import { Dialog } from './ui';

export function ConnectedOriginalInputs({ attemptId, assignmentId, expected, close }: {
  attemptId: string; assignmentId: string; expected?: ContentAssignmentSource; close: () => void;
}) {
  const [detail, setDetail] = useState<ConnectedResultDetail>();
  const [error, setError] = useState('');
  useEffect(() => {
    let controller = new AbortController();
    function read() {
      controller.abort(); controller = new AbortController();
      const signal = controller.signal;
      setError('');
      void request<ConnectedResultDetail>('assignments/connected/' + encodeURIComponent(attemptId), undefined, signal).then(value => {
      if (signal.aborted) return;
      const attempt = value.attempt;
      if (attempt.id !== attemptId || attempt.assignmentId !== assignmentId || (expected && (attempt.assignmentRevision !== expected.assignmentRevision ||
        attempt.agentId !== expected.agentId || attempt.agentRevision !== expected.agentRevision || attempt.runId !== expected.runId ||
        attempt.nativeSessionId !== expected.nativeId || (value.available && (attempt.terminal?.turnId !== expected.turnId ||
        attempt.result?.file.id !== expected.fileId || attempt.result.file.sha256 !== expected.sha256))))) throw Error('The captured inputs could not be matched to the original assignment.');
      setDetail(value);
    }).catch(reason => { if (!signal.aborted) { setDetail(undefined); setError(reason instanceof Error ? reason.message : 'Inputs are unavailable.'); } });
    }
    read(); window.addEventListener('focus', read);
    return () => { controller.abort(); window.removeEventListener('focus', read); };
  }, [attemptId, assignmentId, expected]);
  return <Dialog title="Inputs Used" close={close}>
    {detail ? <ConnectedInputs inputs={detail.inputs}/> : <p role={error ? 'alert' : 'status'}>{error || 'Opening the captured inputs…'}</p>}
    <button className="compact-action" onClick={close}>Back</button>
  </Dialog>;
}
