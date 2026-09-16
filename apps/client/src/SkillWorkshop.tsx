import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { ProposalEvents, ProposalList, ProposalView, SavedProposal, SavedProposalSummary } from '../../../packages/domain/skill-workshop';
import { ApiError, readLocal, request, saveLocal } from './api';
import { retainedWindowId } from './useWorkspace';
import { Empty } from './ui';
import { SkillControlPanel, SkillReviewActions, useSkillControl, type SkillControl } from './SkillManagementControls';
import './skill-workshop.css';

type Selection = { source: 'native' | 'saved'; id: string } | null;
const message = (error: unknown) => error instanceof Error ? error.message : 'This review could not load.';
export default function SkillWorkshop({ snapshot }: { snapshot: Snapshot }) {
  const key = `e3:skill-workshop:${snapshot.deviceId}:${snapshot.epoch}:${retainedWindowId}`;
  const [selection, setSelection] = useState<Selection>(() => readLocal<Selection>(key) ?? null);
  const [list, setList] = useState<ProposalList>(), [saved, setSaved] = useState<SavedProposalSummary[]>([]);
  const [error, setError] = useState(''), [savedError, setSavedError] = useState(''), [navigationError, setNavigationError] = useState('');
  const [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0), [query, setQuery] = useState(''), [filter, setFilter] = useState('pending');
  const [showSaved, setShowSaved] = useState(selection?.source === 'saved'), [page, setPage] = useState(0);
  const results = useRef<HTMLDivElement>(null), selectedButton = useRef<HTMLButtonElement | null>(null);
  const control = useSkillControl(snapshot, id => { select({ source: 'native', id }); setShowSaved(false); setFilter('all'); setRefresh(r => r + 1); });
  useEffect(() => {
    const controller = new AbortController(); setBusy(true);
    void Promise.allSettled([request<ProposalList>('agent-skills/proposals', undefined, controller.signal), request<SavedProposalSummary[]>('agent-skills/reviews', undefined, controller.signal)]).then(([native, copies]) => {
      if (controller.signal.aborted) return;
      if (native.status === 'fulfilled') { setList(native.value); setError(''); } else setError(message(native.reason));
      if (copies.status === 'fulfilled') { setSaved(copies.value); setSavedError(''); } else setSavedError(message(copies.reason));
      setBusy(false);
    });
    return () => controller.abort();
  }, [refresh]);
  const select = (next: Selection, button?: HTMLButtonElement) => {
    if (!saveLocal(key, next)) { setNavigationError('This selection cannot be kept on this device. Free browser storage before leaving your review.'); return; }
    setNavigationError(''); if (button) selectedButton.current = button;
    const focus = selectedButton.current?.isConnected ? selectedButton.current : results.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? results.current;
    setSelection(next); if (!next) focus?.focus();
  };
  const proposals = (list?.proposals ?? []).filter(p => (filter === 'all' || p.status === filter) && `${p.title} ${p.description} ${p.skillName}`.toLowerCase().includes(query.toLowerCase()));
  const copies = saved.filter(p => p.title.toLowerCase().includes(query.toLowerCase()));
  const total = showSaved ? copies.length : proposals.length;
  useEffect(() => setPage(0), [query, filter, showSaved]);
  const turn = (next: number) => { setPage(next); results.current?.focus(); results.current?.scrollIntoView({ block: 'start' }); };
  return <section className="skill-workshop" aria-label="Skill proposals"><div className="record-toolbar"><div><h2>Proposals & reviews</h2><p className="metadata">Inspect proposed changes and keep exact review copies, including their support files. Saving a copy does not apply the skill.</p></div><button disabled={busy} onClick={() => setRefresh(r => r + 1)}>{busy ? 'Reading proposals…' : 'Refresh proposals'}</button></div>
    <SkillControlPanel control={control} saved={saved}/>
    <div className="record-tabs" aria-label="Proposal sources"><button aria-pressed={!showSaved} onClick={() => setShowSaved(false)}>Host proposals</button><button aria-pressed={showSaved} onClick={() => setShowSaved(true)}>Saved reviews · {saved.length}</button></div>
    <div className="record-filters"><label>Find a proposal<input type="search" value={query} placeholder="Skill name or description" onChange={e => setQuery(e.target.value)}/></label>{!showSaved && <label>Status<select value={filter} onChange={e => setFilter(e.target.value)}>{['pending', 'all', 'applied', 'rejected', 'quarantined', 'stale'].map(v => <option key={v} value={v}>{v === 'all' ? 'All proposals' : v[0].toUpperCase() + v.slice(1)}</option>)}</select></label>}</div>
    {error && !showSaved && <p role="alert" className="field-error">{error}{list ? ' These are the last observed proposals; their current status is unconfirmed.' : ''}</p>}
    {savedError && <p role="alert" className="field-error">Saved reviews: {savedError}</p>}{navigationError && <p role="alert" className="field-error">{navigationError}</p>}
    <div className="workshop-layout"><div><div ref={results} role="group" aria-label="Proposal results" tabIndex={-1} className="workshop-results">
      {showSaved ? copies.slice(page * 40, page * 40 + 40).map(p => <button className="card record-list-item" key={p.savedId} aria-pressed={selection?.source === 'saved' && selection.id === p.savedId} onClick={e => select({ source: 'saved', id: p.savedId }, e.currentTarget)}><span><strong>{p.title}</strong><small>{p.proposedVersion} · saved {new Date(p.savedAt).toLocaleString()}</small><small>Historical review copy</small></span></button>) : proposals.slice(page * 40, page * 40 + 40).map(p => <button className="card record-list-item" key={p.id} aria-pressed={selection?.source === 'native' && selection.id === p.id} onClick={e => select({ source: 'native', id: p.id }, e.currentTarget)}><span><strong>{p.title}</strong><small>{p.description}</small><small>{error ? 'Status unconfirmed' : p.status} · scan {p.scanState}{p.degradedState ? ' · draft missing' : ''}</small></span></button>)}
      {!total && (!busy || showSaved) && <div className="card"><Empty title={showSaved ? 'No saved reviews match.' : 'No proposals match.'}>{showSaved ? 'Open a host proposal and keep a review copy to retain its full contents.' : 'Proposals created on this Assistant host appear here. Try a different status or search.'}</Empty></div>}
    </div>{total > 40 && <nav className="button-row skill-pages" aria-label="Proposal pages"><button disabled={!page} onClick={() => turn(page - 1)}>Previous</button><span>{page * 40 + 1}–{Math.min(total, page * 40 + 40)} of {total}</span><button disabled={(page + 1) * 40 >= total} onClick={() => turn(page + 1)}>Next</button></nav>}</div>
      {selection && <ProposalReader key={`${key}:${selection.source}:${selection.id}`} selection={selection} refresh={refresh} snapshot={snapshot} control={control} close={() => select(null)} onSaved={copy => setSaved(items => [{ savedId: copy.savedId, savedAt: copy.savedAt, epoch: copy.epoch, generation: copy.generation, revisionHash: copy.revisionHash, proposalId: copy.record.id, title: copy.record.title, proposedVersion: copy.record.proposedVersion, status: copy.record.status }, ...items.filter(item => item.savedId !== copy.savedId)])}/>}
    </div>
  </section>;
}

function ProposalReader({ selection, refresh, snapshot, control, close, onSaved }: { selection: Exclude<Selection, null>; refresh: number; snapshot: Snapshot; control: SkillControl; close: () => void; onSaved: (copy: SavedProposal) => void }) {
  const pendingKey = `e3:skill-review-request:${snapshot.deviceId}:${snapshot.epoch}:${selection.id}:${retainedWindowId}`;
  const fileKey = pendingKey + ':file';
  const [view, setView] = useState<ProposalView | SavedProposal>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [reviewCopy, setReviewCopy] = useState<SavedProposal>();
  const [file, setFile] = useState(() => readLocal<string>(fileKey) ?? 'PROPOSAL.md'), [keepError, setKeepError] = useState(''), [kept, setKept] = useState(false), [keeping, setKeeping] = useState(false);
  const header = useRef<HTMLHeadingElement>(null), keepingController = useRef<AbortController | null>(null);
  const [pending, setPending] = useState<Record<string, string> | undefined>(() => readLocal(pendingKey));
  useEffect(() => { header.current?.focus(); return () => keepingController.current?.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true);
    const url = selection.source === 'saved' ? `agent-skills/reviews?savedId=${encodeURIComponent(selection.id)}` : `agent-skills/proposal?proposalId=${encodeURIComponent(selection.id)}`;
    void request<ProposalView | SavedProposal>(url, undefined, controller.signal).then(next => { if (!controller.signal.aborted) { setView(next); setReviewCopy(copy => copy && copy.revisionHash === next.revisionHash && copy.targetFingerprint === next.targetFingerprint && copy.generation === next.generation ? copy : undefined); setError(''); setKept(false); } }).catch(reason => { if (!controller.signal.aborted) setError(message(reason)); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [refresh, selection.id, selection.source]);
  useEffect(() => { if (view && file !== 'PROPOSAL.md' && !view.supportFiles.some(f => f.path === file)) setFile('PROPOSAL.md'); }, [view, file]);
  const keep = async () => {
    if (!view && !pending) return;
    const cmd = pending ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, generation: view!.generation, proposalId: view!.record.id, revisionHash: view!.revisionHash, targetFingerprint: view!.targetFingerprint };
    if (!saveLocal(pendingKey, cmd)) { setKeepError('Free browser storage before saving this review copy. Its original request must be retained.'); return; }
    setPending(cmd); setKeeping(true); setKeepError(''); const controller = new AbortController(); keepingController.current = controller;
    try {
      const copy = await request<SavedProposal>('agent-skills/keep-review', cmd, controller.signal);
      if (!controller.signal.aborted) { onSaved(copy); setReviewCopy(copy); setView(current => current ?? copy); if (!view) setError(''); setKept(!view || view.revisionHash === copy.revisionHash && view.targetFingerprint === copy.targetFingerprint && view.generation === copy.generation); setPending(undefined); saveLocal(pendingKey, null); }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setKeepError(message(reason));
        // A rejected stale-copy request made no native mutation. Let a newly
        // inspected version get its own request instead of trapping this review.
        if (reason instanceof ApiError && reason.code === 'workshop_revision') { setPending(undefined); saveLocal(pendingKey, null); }
      }
    }
    finally { if (!controller.signal.aborted) setKeeping(false); }
  };
  const saved = view && 'savedId' in view, content = file === 'PROPOSAL.md' ? view?.content : view?.supportFiles.find(f => f.path === file)?.content;
  return <aside className="card workshop-reader" aria-label="Proposal inspection" onKeyDown={e => { if (e.key === 'Escape') close(); }}>
    <div className="record-toolbar"><h3 tabIndex={-1} ref={header}>{view?.record.title ?? 'Proposal inspection'}</h3><button onClick={close}>Close review</button></div>
    {busy && <p role="status">Reading this version…</p>}{error && <p role="alert" className="field-error">{error}{view ? ' The contents below are the previous observation.' : ''}</p>}
    {view && <><p className="metadata">{view.record.proposedVersion} · {saved ? `historical copy kept ${new Date((view as SavedProposal).savedAt).toLocaleString()}` : `observed ${new Date(view.observedAt).toLocaleString()}`}</p>
      <p><strong>{saved ? 'Status when inspected' : error ? 'Previously observed status' : 'Observed status'}:</strong> {view.record.status}</p><p className="metadata">Skill: {view.record.skillName} · {view.record.source ?? 'Source unreported'}</p>
      {view.record.statusReason && <p>{view.record.statusReason}</p>}{view.record.goal && <details><summary>Purpose</summary><p>{view.record.goal}</p></details>}{view.record.evidence && <details><summary>Supporting evidence</summary><p>{view.record.evidence}</p></details>}
      <details><summary>Scan & evaluation</summary><p>Static scan: {view.record.scan.state}. {view.record.scan.critical} critical, {view.record.scan.warn} warnings, {view.record.scan.info} informational findings.</p><p className="metadata">A clean scan does not establish that a skill is correct or useful.</p>
        {view.record.scan.findings.map((f, i) => <div className="workshop-finding" key={i}><strong>{f.severity} · {f.ruleId}</strong><p>{f.message}</p><small>{f.file}{f.line ? `:${f.line}` : ''}</small>{f.evidence && <pre>{f.evidence}</pre>}</div>)}
        {!view.record.evaluation ? <p>No evaluator run reported for this proposal.</p> : <><p>Evaluation of {view.record.evaluation.proposedVersion}, completed {new Date(view.record.evaluation.completedAt).toLocaleString()}.</p>{!view.record.evaluation.outcomes.length && <p>No evaluator outcomes were reported.</p>}{view.record.evaluation.outcomes.map((outcome, i) => <div className="workshop-finding" key={i}><strong>{outcome.evaluatorId} · {outcome.status}</strong>{outcome.error && <p>{outcome.error}</p>}{outcome.result && <><p>{outcome.result.decision ?? 'No decision'}{outcome.result.decisionReason ? ` · ${outcome.result.decisionReason}` : ''}</p><p>{outcome.result.summary}</p>{outcome.result.findings?.map((f, j) => <p key={j}>{f.severity}: {f.message} ({f.file}{f.line ? `:${f.line}` : ''})</p>)}</>}</div>)}</>}
      </details>
      <label className="workshop-file">Review file<select value={file} onChange={e => { setFile(e.target.value); saveLocal(fileKey, e.target.value); }}><option value="PROPOSAL.md">PROPOSAL.md · skill instructions</option>{view.supportFiles.map(f => <option key={f.path} value={f.path}>{f.path} · {f.sizeBytes.toLocaleString()} bytes</option>)}</select></label>
      <pre className="workshop-content" tabIndex={0} aria-label={`Contents of ${file}`}>{content}</pre><p className="metadata">Complete draft and {view.supportFiles.length} support {view.supportFiles.length === 1 ? 'file' : 'files'} verified against the host’s recorded hashes. These instructions are shown for review.</p>
      <details><summary>Version identity</summary><dl><dt>Native revision</dt><dd>{view.revisionHash}</dd><dt>Destination fingerprint</dt><dd>{view.targetFingerprint}</dd></dl></details>
      {selection.source === 'native' && !saved && <ProposalHistory proposalId={view.record.id} generation={view.generation} refresh={refresh}/>}
    </>}
    {selection.source === 'native' && (view || pending) && <><div className="button-row"><button disabled={keeping || kept || (!pending && (busy || !!error))} onClick={() => void keep()}>{keeping ? 'Keeping review…' : kept ? 'Review copy kept' : pending ? 'Confirm original saved copy' : 'Keep this review copy'}</button></div>{pending && !keeping && <p className="metadata">The original save request is retained until its outcome is confirmed. It refers to revision {pending.revisionHash?.slice(0, 12)}.</p>}{keepError && <p role="alert" className="field-error">{keepError}</p>}{kept && <p role="status">The exact review copy is available under Saved reviews.</p>}</>}
    {(saved || reviewCopy && view && reviewCopy.revisionHash === view.revisionHash && reviewCopy.targetFingerprint === view.targetFingerprint && reviewCopy.generation === view.generation) && <SkillReviewActions key={(saved ? (view as SavedProposal) : reviewCopy!).savedId} copy={saved ? view as SavedProposal : reviewCopy!} control={control} allowUpdate={view?.record.status === 'applied'} allowDecision={!!saved || !error && !busy && view?.record.status === 'pending'}/>}
  </aside>;
}
function ProposalHistory({ proposalId, generation, refresh }: { proposalId: string; generation: string; refresh: number }) {
  const [page, setPage] = useState<ProposalEvents>(), [cursor, setCursor] = useState(0), [previous, setPrevious] = useState<number[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true);
    void request<ProposalEvents>(`agent-skills/proposal-events?proposalId=${encodeURIComponent(proposalId)}&afterSequence=${cursor}`, undefined, controller.signal).then(next => { if (controller.signal.aborted) return; if (next.generation !== generation) throw new Error('The Assistant host changed. Refresh the proposal before reading its history.'); setPage(next); setError(''); }).catch(reason => { if (!controller.signal.aborted) setError(message(reason)); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [proposalId, generation, cursor, refresh]);
  return <details className="workshop-history"><summary>Host proposal history</summary>{error && <p className="field-error" role="alert">{error}</p>}{busy && <p role="status">Reading history…</p>}{page?.events.map(event => <p key={event.eventId}><strong>{event.type.replaceAll('_', ' ')} · {event.proposedVersion}</strong><br/><small>{new Date(event.occurredAt).toLocaleString()} · {event.actor.type}</small></p>)}{page && !page.events.length && <p>No native history events reported.</p>}<div className="button-row"><button disabled={busy || !previous.length} onClick={() => { setCursor(previous.at(-1)!); setPrevious(v => v.slice(0, -1)); }}>Earlier events</button><button disabled={busy || !!error || !page?.nextSequence} onClick={() => { setPrevious(v => [...v, cursor]); setCursor(page!.nextSequence!); }}>Later events</button></div></details>;
}
