import { useState, type ReactNode } from 'react';
import { ConnectedOriginalInputs } from './ConnectedOriginalInputs';
import type { AssignmentAttempt } from '../../../packages/domain/assignments';
import { assignmentTerminal } from '../../../packages/domain/assignments';
import type { Snapshot } from '../../../packages/domain/contracts';
import { ConnectedResult } from './ConnectedResult';
import { useLibraryWorkRoutes } from './LibraryWorkNavigation';
import { assignmentStatusLabels } from './assignment-status';

type Props = {
  attempts: AssignmentAttempt[]; snapshot: Snapshot; assignmentId: string; refresh: () => Promise<void>;
  openContent: (id: string) => void; error: string; busy: boolean; loading: boolean;
  hasMore: boolean; more: () => void; retry: () => void;
  act: (attempt: AssignmentAttempt, action: 'check' | 'stop') => void;
  approvals: (attempt: AssignmentAttempt) => ReactNode;
};
export function ConnectedAttempts(props: Props) {
  const routes = useLibraryWorkRoutes();
  const [inputs, setInputs] = useState(false);
  const choose = (id: string) => routes?.openWork(props.assignmentId, id);
  const results = props.attempts.filter(item => item.connected?.role === 'result');
  const current = results[0];
  const reviewer = props.attempts.find(item => item.connected?.role === 'review');
  if (!current) return <section>
    <p role="status">{props.error || (props.loading ? 'Opening the original work…' : reviewer ? 'Review of an assignment result.' : 'No confirmed result is available for this assignment yet.')}</p>
    {reviewer?.connected?.subjectAttemptId && <button onClick={() => choose(reviewer.connected!.subjectAttemptId!)}>Open Reviewed Result</button>}
    {props.error && <button onClick={props.retry}>Check Original Work</button>}
    {props.hasMore && <button onClick={props.more}>Earlier Work</button>}
  </section>;
  return <>
    {props.error && <p className="field-error" role="alert">{props.error}</p>}
    {current.state === 'returned' && current.result?.disposition === 'visible'
      ? <ConnectedResult key={current.id} attempt={current} snapshot={props.snapshot} refresh={props.refresh} openContent={props.openContent} choose={choose}/>
      : <section className="connected-progress" aria-label="Work Progress">
        <h2>{current.state === 'unknown' ? 'Status Unknown' : assignmentStatusLabels[current.state]}</h2>
        <p role="status">{current.message}</p>
        <button className="compact-action" onClick={() => setInputs(true)}>Inputs Used</button>
        {inputs && <ConnectedOriginalInputs attemptId={current.id} assignmentId={current.assignmentId} close={() => setInputs(false)}/>}
        {props.approvals(current)}
        {!assignmentTerminal(current.state) && <div className="compact-actions">
          <button className="compact-action" disabled={props.busy} onClick={() => props.act(current, 'check')}>Check Original Run</button>
          <button className="compact-action" disabled={props.busy} onClick={() => props.act(current, 'stop')}>{current.stopReason ? 'Check Stop Request' : 'Stop Work'}</button>
        </div>}
        {current.connected?.baseAttemptId && <button className="compact-action" onClick={() => choose(current.connected!.baseAttemptId!)}>Open Base Result</button>}
      </section>}
  </>;
}
