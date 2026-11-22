import { useState } from 'react';
import type { ConnectedResultDetail } from '../../../packages/domain/connected-work';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { WorkSourceInspection } from '../../../packages/domain/work-sources';

export function ConnectedReviewPanel({ detail, snapshot, busy, acknowledged, acknowledge, start }: {
  detail: ConnectedResultDetail; snapshot: Snapshot; busy: boolean; acknowledged: ReadonlySet<string>;
  acknowledge: (id: string, checked: boolean) => void; start: (id: string, revision: number) => void;
}) {
  const { review } = detail;
  const eligible = (snapshot.records?.agent ?? []).filter(agent => !agent.value.archived && agent.id !== detail.attempt.agentId);
  const [choice, setChoice] = useState('');
  const selected = eligible.find(agent => agent.id === (choice || (eligible.length === 1 ? eligible[0].id : '')));
  return <section className="connected-review-notes" aria-label="Review Findings">
    <h3>Review</h3>
    {!review.available && <p role="status">The reviewer no longer has access to the captured inputs. This review is unavailable.</p>}
    {review.available && review.attempt && <p className="metadata">{review.attempt.agentName}</p>}
    {review.available && (review.report ? <>
      <p>{review.report.summary}</p>
      {review.report.findings.length === 0 && <p className="metadata">No open findings.</p>}
      {review.report.findings.map(finding => <div key={finding.id} className="connected-finding">
        <strong>{finding.severity === 'blocking' ? 'Blocking Finding' : 'Open Finding'}</strong><p>{finding.detail}</p>
        {finding.severity === 'advisory' && <label><input type="checkbox" checked={!!detail.acceptance || acknowledged.has(finding.id)}
          disabled={busy || !!detail.acceptance} onChange={event => acknowledge(finding.id, event.target.checked)}/> Acknowledge Open Finding</label>}
      </div>)}
    </> : <>
      <p role="status">{review.state === 'running' ? 'The reviewer is reading this result.' : review.state === 'unknown' ? 'Review status is unknown. Check the existing review before starting another.' : review.state === 'invalid' ? 'The reviewer returned an unreadable review.' : review.state === 'failed' ? 'The review did not complete.' : 'Choose an independent reviewer for this result.'}</p>
      {['needed', 'failed', 'invalid'].includes(review.state) && (eligible.length ? <>
        <label>Reviewer<select value={selected?.id ?? ''} onChange={event => setChoice(event.target.value)}>
          <option value="">Choose A Reviewer</option>{eligible.map(row => <option key={row.id} value={row.id}>{row.value.name}</option>)}
        </select></label>
        <button type="button" className="compact-action" disabled={busy || !selected || !detail.available}
          onClick={() => selected && start(selected.id, selected.revision)}>Request Review</button>
      </> : <p className="metadata">Add an independent reviewer in Agents → Team to review this result.</p>)}
    </>)}
  </section>;
}

export function ConnectedInputs({ inputs }: { inputs: WorkSourceInspection[] }) {
  return <section className="connected-inputs" aria-label="Captured Inputs">
    <h3>Inputs Used <span className="metadata">{inputs.length}</span></h3>
    {inputs.map((source, index) => <details key={source.reference.kind + ':' + source.reference.id}>
      <summary>{source.accessible && source.material ? source.material.title : 'Unavailable Source'} <span className="metadata">· Version {source.reference.revision}</span></summary>
      {source.accessible && source.material ? <>
        <p className="metadata">Input {index + 1} · {source.material.representation === 'reference-only' ? 'Reference Details Only' : source.material.representation === 'result-text' ? 'Saved Result' : 'Saved Text'}</p>
        {source.material.text && <pre>{source.material.text}</pre>}
        {source.material.url && <p className="metadata">{source.material.url}</p>}
        {source.material.omissions.map(text => <p className="metadata" key={text}>{text}</p>)}
      </> : <p>This captured source is no longer accessible.</p>}
    </details>)}
  </section>;
}
