import { useCallback, useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { SkillCommand, SkillDraft, SkillIntent, SkillManagementState, SkillOperation } from '../../../packages/domain/skill-management';
import type { SavedProposal, SavedProposalSummary } from '../../../packages/domain/skill-workshop';
import { ApiError, readLocal, request, saveLocal } from './api';
import { retainedWindowId } from './useWorkspace';
import './skill-management.css';
const message = (value: unknown) => value instanceof Error ? value.message : 'The skill request could not be confirmed.';
type Draft = { id: string; action: 'create' | 'update' | 'revise'; value: SkillDraft; reviewId?: string; sourceReviewId?: string; operationId?: string; pendingRequestId?: string };
type Index = { drafts: string[]; selected: string | null; operation: string | null };
export function useSkillControl(snapshot: Snapshot, openProposal: (id: string) => void) {
  const key = `e3:skill-control:${snapshot.deviceId}:${snapshot.epoch}:${retainedWindowId}`;
  const [state, setState] = useState<SkillManagementState>(), [error, setError] = useState('');
  const [index, setIndex] = useState<Index>(() => readLocal(key) ?? { drafts: [], selected: null, operation: null });
  const indexRef = useRef(index), draftTrigger = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState<Record<string, SkillCommand>>(() => readLocal(key + ':pending') ?? {}), pendingRef = useRef(pending);
  const [accessPending, setAccessPending] = useState<{ requestId: string; epoch: string; generation: string; enabled: boolean } | null>(() => readLocal(key + ':access') ?? null), [accessBusy, setAccessBusy] = useState(false);
  const active = useRef(true), reader = useRef<AbortController | null>(null), sending = useRef(new Set<string>()), accessRunning = useRef(false);
  const refresh = useCallback(async () => {
    reader.current?.abort(); const controller = new AbortController(); reader.current = controller;
    try { const next = await request<SkillManagementState>('agent-skills/management', undefined, controller.signal); if (!controller.signal.aborted && active.current) { setState(next); setPending(readLocal(key + ':pending') ?? {}); setAccessPending(readLocal(key + ':access') ?? null); setError(''); } }
    catch (reason) { if (!controller.signal.aborted && active.current) setError(message(reason)); }
  }, []);
  useEffect(() => { active.current = true; void refresh(); const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5000); return () => { active.current = false; clearInterval(timer); reader.current?.abort(); }; }, [refresh]);
  const keepIndex = (next: Index) => { if (!saveLocal(key, next)) { setError('Free browser storage before leaving this skill draft.'); return false; } indexRef.current = next; setIndex(next); return true; };
  const keepPending = (next: Record<string, SkillCommand>) => { if (!saveLocal(key + ':pending', next)) throw new Error('Free browser storage before sending this request. Its exact contents must be retained first.'); pendingRef.current = next; if (active.current) setPending(next); };
  const send = async (cmd: SkillCommand) => {
    if (sending.current.has(cmd.requestId)) throw new Error('This original request is already being checked.');
    keepPending({ ...(readLocal<Record<string, SkillCommand>>(key + ':pending') ?? pendingRef.current), [cmd.requestId]: cmd }); sending.current.add(cmd.requestId);
    try {
      const op = await request<SkillOperation>('agent-skills/operation', cmd);
      const next = { ...(readLocal<Record<string, SkillCommand>>(key + ':pending') ?? pendingRef.current) }; delete next[cmd.requestId]; keepPending(next);
      if (active.current) { keepIndex({ ...indexRef.current, operation: op.id }); void refresh(); } return op;
    } catch (reason) {
      if (reason instanceof ApiError && [400, 401, 403, 409, 501, 507].includes(reason.status ?? 0)) { const next = { ...(readLocal<Record<string, SkillCommand>>(key + ':pending') ?? pendingRef.current) }; delete next[cmd.requestId]; keepPending(next); }
      throw reason;
    } finally { sending.current.delete(cmd.requestId); }
  };
  const changeAccess = async (enabled: boolean) => {
    if (accessRunning.current || !state?.generation) return;
    const cmd = accessPending ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, generation: state.generation, enabled };
    if (!saveLocal(key + ':access', cmd)) { setError('Free browser storage before changing skill-management access.'); return; }
    setAccessPending(cmd); setAccessBusy(true); accessRunning.current = true;
    try { const next = await request<SkillManagementState>('agent-skills/management/access', cmd); if (readLocal<{ requestId: string }>(key + ':access')?.requestId === cmd.requestId) saveLocal(key + ':access', null); if (active.current) { setState(next); setAccessPending(null); setError(''); } }
    catch (reason) { if (active.current) setError(message(reason)); }
    finally { accessRunning.current = false; if (active.current) setAccessBusy(false); }
  };
  const draftKey = (id: string) => key + ':draft:' + id;
  const newDraft = (source?: SavedProposal, action: Draft['action'] = 'create', existing?: SkillDraft) => {
    const id = crypto.randomUUID(), value: Draft = { id, action, value: existing ?? (source ? { name: source.record.skillKey, description: source.record.description, content: source.content, supportFiles: source.supportFiles.map(f => ({ path: f.path, content: f.content })), goal: source.record.goal, evidence: source.record.evidence } : { name: '', description: '', content: '', supportFiles: [] }), ...(source ? action === 'revise' ? { reviewId: source.savedId } : { sourceReviewId: source.savedId } : {}) };
    if (!saveLocal(draftKey(id), value)) { setError('Free browser storage before opening another skill draft.'); return; }
    keepIndex({ ...indexRef.current, drafts: [...indexRef.current.drafts, id], selected: id });
  };
  const closeDraft = () => { if (keepIndex({ ...indexRef.current, selected: null })) draftTrigger.current?.focus(); };
  const ready = !!state && !error && state.connection === 'ready';
  return { key, snapshot, state, error, index, pending, accessPending, accessBusy, ready, refresh, send, changeAccess, draftKey, newDraft, keepIndex, closeDraft, draftTrigger, openProposal };
}
export type SkillControl = ReturnType<typeof useSkillControl>;

export function SkillControlPanel({ control, saved }: { control: SkillControl; saved: SavedProposalSummary[] }) {
  const { state, index } = control;
  return <div className="skill-controls"><details className="skill-access"><summary>Skill management · {state?.connection ?? 'reading status'}</summary><p>{state?.message ?? 'Reading skill-management access…'}</p><p className="metadata">This enables proposal changes from this device on the connected Assistant host. Applying a skill still requires its exact reviewed version.</p>{state?.pairingRequestId && <p className="metadata">OpenClaw device request: {state.pairingRequestId}</p>}<div className="button-row"><button disabled={control.accessBusy || (!control.accessPending && !state?.canConnect)} onClick={() => void control.changeAccess(true)}>{control.accessBusy ? 'Checking access…' : control.accessPending ? 'Confirm original access request' : state?.enabled ? 'Reconnect skill management' : 'Enable skill management'}</button>{state?.enabled && <button disabled={control.accessBusy || !!control.accessPending} onClick={() => void control.changeAccess(false)}>Disable for this device</button>}</div></details>
    {control.error && <p className="field-error" role="alert">{control.error} Current management status is unconfirmed.</p>}
    <div className="button-row skill-author-tools"><button ref={control.draftTrigger} onClick={() => control.newDraft()}>New skill proposal</button>{index.drafts.length > 0 && <label>Kept drafts<select value={index.selected ?? ''} onChange={e => control.keepIndex({ ...index, selected: e.target.value || null })}><option value="">Choose a draft</option>{index.drafts.map((id, i) => <option key={id} value={id}>{i + 1}. {readLocal<Draft>(control.draftKey(id))?.value.name || 'Untitled skill'}</option>)}</select></label>}</div>
    {index.selected && <SkillDraftEditor key={index.selected} id={index.selected} control={control}/>}
    {Object.values(control.pending).length > 0 && <details open className="skill-pending"><summary>Unconfirmed request receipts · {Object.values(control.pending).length}</summary><p className="metadata">Check the retained original request before sending a separate change.</p>{Object.values(control.pending).map(cmd => <PendingRequest key={cmd.requestId} cmd={cmd} control={control}/>)}</details>}
    {!!state?.operations.length && <details className="skill-operation-history" open={!!index.operation}><summary>Operation history · {state.operations.length}</summary><label>Saved operation<select value={index.operation ?? ''} onChange={e => control.keepIndex({ ...index, operation: e.target.value || null })}><option value="">Choose an operation</option>{state.operations.map(op => <option key={op.id} value={op.id}>{op.action} · {op.skillKey} · {op.state} · {new Date(op.createdAt).toLocaleString()}</option>)}</select></label>{index.operation && <OperationReader key={index.operation} id={index.operation} control={control} saved={saved}/>}</details>}
  </div>;
}
function PendingRequest({ cmd, control }: { cmd: SkillCommand; control: SkillControl }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <div className="skill-pending-row"><span>{cmd.action} · {'draft' in cmd ? cmd.draft.name : 'reviewed proposal'}</span><button disabled={busy} onClick={() => { setBusy(true); void control.send(cmd).catch(e => setError(message(e))).finally(() => setBusy(false)); }}>{busy ? 'Checking…' : 'Check original request'}</button>{error && <p className="field-error" role="alert">{error}</p>}</div>;
}
function SkillDraftEditor({ id, control }: { id: string; control: SkillControl }) {
  const [draft, setDraft] = useState<Draft | undefined>(() => readLocal(control.draftKey(id))), [error, setError] = useState(''), [busy, setBusy] = useState(false), [file, setFile] = useState(-1);
  const sending = useRef(false), title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, []);
  useEffect(() => {
    if (draft?.pendingRequestId && control.state?.operations.some(op => op.id === draft.pendingRequestId)) {
      const next = { ...draft, operationId: draft.pendingRequestId }; delete next.pendingRequestId;
      if (saveLocal(control.draftKey(id), next)) setDraft(next);
      else setError('The submitted request is retained in operation history, but this draft could not save its receipt.');
    }
  }, [draft?.pendingRequestId, control.state?.operations]);
  if (!draft) return <p className="field-error" role="alert">This local draft could not be read. Its prior native requests remain in operation history.</p>;
  const pending = Object.values(control.pending).find(cmd => 'draft' in cmd && cmd.draft.name === draft.value.name), frozen = busy || !!pending || !!draft.operationId || !!draft.pendingRequestId;
  const keep = (next: Draft) => { setDraft(next); if (!saveLocal(control.draftKey(id), next)) { setError('Your writing is kept in this editor only. Free browser storage before sending or leaving.'); return false; } setError(''); return true; };
  const update = (patch: Partial<SkillDraft>) => keep({ ...draft, value: { ...draft.value, ...patch } });
  const submit = async () => {
    if (sending.current || !control.state?.generation) return;
    const requestId = crypto.randomUUID();
    if (!keep({ ...draft, pendingRequestId: requestId })) return;
    sending.current = true; setBusy(true);
    const intent: SkillIntent = draft.action === 'revise' ? { action: 'revise', draft: draft.value, reviewId: draft.reviewId! } : { action: draft.action, draft: draft.value, sourceReviewId: draft.sourceReviewId };
    try { const op = await control.send({ ...intent, requestId, epoch: control.snapshot.epoch, generation: control.state.generation }); keep({ ...draft, operationId: op.id }); }
    catch (reason) { if (!readLocal<Record<string, SkillCommand>>(control.key + ':pending')?.[requestId] || reason instanceof ApiError && [400, 401, 403, 409, 501, 507].includes(reason.status ?? 0)) keep(draft); setError(message(reason)); }
    finally { sending.current = false; setBusy(false); }
  };
  return <section className="card skill-draft" aria-label="Skill proposal editor" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); control.closeDraft(); } }}><div className="record-toolbar"><h3 ref={title} tabIndex={-1}>{draft.action === 'revise' ? 'Revise the reviewed proposal' : 'Draft a skill proposal'}</h3><button onClick={control.closeDraft}>Close editor</button></div>
    <div className="record-filters"><label>Proposal type<select disabled={frozen || draft.action === 'revise' || !!draft.sourceReviewId} value={draft.action} onChange={e => keep({ ...draft, action: e.target.value as Draft['action'] })}><option value="create">New skill</option><option value="update">Update an installed skill</option>{draft.action === 'revise' && <option value="revise">Revise this proposal</option>}</select></label><label>{draft.action === 'create' ? 'New skill name' : 'Existing skill key'}<input disabled={frozen || draft.action === 'revise' || !!draft.sourceReviewId} value={draft.value.name} placeholder="writing-review" onChange={e => update({ name: e.target.value })}/></label></div>
    {draft.sourceReviewId && !draft.operationId && <div className="button-row"><p className="metadata">This update keeps the reviewed skill identity.</p><button disabled={frozen} onClick={() => control.newDraft(undefined, 'create', { ...draft.value, name: '' })}>Copy into a separate draft</button></div>}
    <label>Description<textarea disabled={frozen} rows={2} value={draft.value.description} onChange={e => update({ description: e.target.value })}/></label>
    <label>File to edit<select value={file} onChange={e => setFile(Number(e.target.value))}><option value={-1}>Skill instructions</option>{draft.value.supportFiles.map((f, i) => <option key={i} value={i}>{f.path || `Support file ${i + 1}`}</option>)}</select></label>
    {file < 0 ? <label>Skill instructions<textarea className="skill-instructions" disabled={frozen} rows={12} value={draft.value.content} placeholder="Describe when to use this skill and the steps it should follow." onChange={e => update({ content: e.target.value })}/></label> : draft.value.supportFiles[file] && <><label>Relative support-file path<input disabled={frozen} value={draft.value.supportFiles[file].path} placeholder="references/checklist.md" onChange={e => update({ supportFiles: draft.value.supportFiles.map((f, i) => i === file ? { ...f, path: e.target.value } : f) })}/></label><label>Support-file text<textarea className="skill-instructions" rows={10} disabled={frozen} value={draft.value.supportFiles[file].content} onChange={e => update({ supportFiles: draft.value.supportFiles.map((f, i) => i === file ? { ...f, content: e.target.value } : f) })}/></label><button disabled={frozen} onClick={() => { update({ supportFiles: draft.value.supportFiles.filter((_, i) => i !== file) }); setFile(-1); }}>Remove file from proposal</button></>}
    <button disabled={frozen || draft.value.supportFiles.length >= 64} onClick={() => { const next = draft.value.supportFiles.length; update({ supportFiles: [...draft.value.supportFiles, { path: '', content: '' }] }); setFile(next); }}>Add support file</button>
    <p className="metadata">For updates, installed files outside this proposal are retained. Removing a file here does not delete an installed file.</p>
    <details><summary>Purpose & evidence</summary><label>Purpose<textarea disabled={frozen} rows={2} value={draft.value.goal ?? ''} onChange={e => update({ goal: e.target.value })}/></label><label>Evidence<textarea disabled={frozen} rows={2} value={draft.value.evidence ?? ''} onChange={e => update({ evidence: e.target.value })}/></label></details>
    {error && <p className="field-error" role="alert">{error}</p>}{!control.ready && <p className="metadata">Enable or reconnect Skill management above before submitting.</p>}
    <div className="button-row">{draft.operationId ? <><button onClick={() => control.keepIndex({ ...control.index, operation: draft.operationId! })}>Open submitted request</button><button onClick={() => control.newDraft(undefined, 'create', { ...draft.value, name: '' })}>Copy into a new skill draft</button></> : <button disabled={frozen || !control.ready || !control.state?.methods.includes(`skills.proposals.${draft.action}`) || !draft.value.name.trim() || !draft.value.description.trim() || !draft.value.content.trim()} onClick={() => void submit()}>{busy ? 'Retaining request…' : draft.action === 'revise' ? 'Submit revised proposal' : 'Create proposal for review'}</button>}</div>
  </section>;
}

export function SkillReviewActions({ copy, control, allowUpdate, allowDecision }: { copy: SavedProposal; control: SkillControl; allowUpdate: boolean; allowDecision: boolean }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [operationId, setOperationId] = useState<string>(); const sending = useRef(false);
  const current = control.state?.operations.find(op => op.id === operationId);
  const decide = async (action: 'apply' | 'reject') => {
    if (sending.current || !control.state?.generation) return;
    sending.current = true; setBusy(true); setError('');
    try { const op = await control.send({ requestId: crypto.randomUUID(), epoch: control.snapshot.epoch, generation: control.state.generation, action, reviewId: copy.savedId, reason: action === 'apply' ? 'Apply this exact reviewed skill proposal.' : 'Reject this exact reviewed skill proposal.' }); setOperationId(op.id); }
    catch (reason) { setError(message(reason)); } finally { sending.current = false; setBusy(false); }
  };
  const blocked = busy || !allowDecision || copy.generation !== control.state?.generation || copy.epoch !== control.snapshot.epoch || !control.ready || !!current && ['preparing', 'dispatched', 'unknown', 'confirmed'].includes(current.state);
  return <div className="skill-review-actions"><p className="metadata">Decisions use saved {copy.record.proposedVersion}. The host must still match this complete review and its destinations.</p><div className="button-row">{copy.record.status === 'pending' && <><button disabled={blocked || !control.state?.methods.includes('skills.proposals.apply')} onClick={() => void decide('apply')}>Apply reviewed version</button><button disabled={blocked || !control.state?.methods.includes('skills.proposals.reject')} onClick={() => void decide('reject')}>Reject proposal</button><button disabled={busy || !allowDecision} onClick={() => control.newDraft(copy, 'revise')}>Edit a revision</button></>}{allowUpdate && <button onClick={() => control.newDraft(copy, 'update')}>Propose update from this version</button>}</div>{!control.ready && copy.record.status === 'pending' && <p className="metadata">Open Skill management above to enable changes on this device.</p>}{current && <p role="status">{current.message}</p>}{error && <p className="field-error" role="alert">{error}</p>}</div>;
}
type ResolutionCommand = { requestId: string; epoch: string; operationId: string; reason: string; reviewId?: string; acknowledgeUnconfirmed: true };
type ResolutionDraft = { reason: string; reviewId: string; pending?: ResolutionCommand };
function OperationReader({ id, control, saved }: { id: string; control: SkillControl; saved: SavedProposalSummary[] }) {
  const key = control.key + ':resolution:' + id;
  const [operation, setOperation] = useState<SkillOperation>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ResolutionDraft>(() => readLocal(key) ?? { reason: '', reviewId: '' });
  const active = useRef(true), writing = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const keepNote = (next: ResolutionDraft) => { setNote(next); if (!saveLocal(key, next)) { setError('Free browser storage before leaving or submitting this review note.'); return false; } setError(''); return true; };
  const state = control.state?.operations.find(op => op.id === id);
  useEffect(() => { const controller = new AbortController(); void request<SkillOperation>(`agent-skills/operation?id=${id}`, undefined, controller.signal).then(op => { if (!controller.signal.aborted) { setOperation(op); setError(''); } }).catch(e => { if (!controller.signal.aborted) setError(message(e)); }); return () => controller.abort(); }, [id, state?.updatedAt]);
  const check = async () => { setBusy(true); try { const next = await request<SkillOperation>('agent-skills/operation/check', { id }); if (active.current) { setOperation(next); setError(''); void control.refresh(); } } catch (e) { if (active.current) setError(message(e)); } finally { if (active.current) setBusy(false); } };
  const resolve = async () => {
    if (writing.current) return;
    const cmd: ResolutionCommand = note.pending ?? { requestId: crypto.randomUUID(), epoch: control.snapshot.epoch, operationId: id, reason: note.reason, ...(note.reviewId ? { reviewId: note.reviewId } : {}), acknowledgeUnconfirmed: true };
    if (!keepNote({ ...note, pending: cmd })) return;
    writing.current = true; setBusy(true);
    try {
      const next = await request<SkillOperation>('agent-skills/operation/resolve', cmd);
      const retained = readLocal<ResolutionDraft>(key);
      if (retained?.pending?.requestId === cmd.requestId) { delete retained.pending; if (!saveLocal(key, retained)) throw new Error('The recorded review is saved on the host. Free browser storage before confirming its local receipt.'); if (active.current) setNote(retained); }
      if (active.current) { setOperation(next); setError(''); void control.refresh(); }
    } catch (e) {
      if (e instanceof ApiError && [400, 401, 403, 409, 501, 507].includes(e.status ?? 0)) { const retained = readLocal<ResolutionDraft>(key); if (retained?.pending?.requestId === cmd.requestId) { delete retained.pending; if (saveLocal(key, retained) && active.current) setNote(retained); } }
      if (active.current) setError(message(e));
    } finally { writing.current = false; if (active.current) setBusy(false); }
  };
  return <div className="skill-operation-reader">{error && <p role="alert" className="field-error">{error}</p>}{operation && <><p><strong>{operation.action} · {operation.skillKey}</strong></p>{operation.skillName && operation.skillName !== operation.skillKey && <p className="metadata">Installed skill: {operation.skillName}</p>}<p role="status">{operation.message}</p>{operation.proposedVersion && <p className="metadata">Recorded result: {operation.proposedVersion} · {operation.resultStatus}</p>}<div className="button-row">{operation.proposalId && <button onClick={() => control.openProposal(operation.proposalId!)}>Inspect host proposal</button>}{operation.state === 'unknown' && <button disabled={busy} onClick={() => void check()}>{busy ? 'Checking…' : 'Check original outcome'}</button>}</div><details><summary>Exact original request</summary><pre>{JSON.stringify(operation.intent, null, 2)}</pre></details>{(operation.state === 'unknown' || note.pending) && <details open={!!note.pending}><summary>Review an unconfirmed outcome</summary><p>The native operation may have happened. Review its host proposals and history before allowing a separate new change. This does not retry the original request.</p><label>Matching saved review (optional)<select disabled={busy || !!note.pending} value={note.reviewId} onChange={e => keepNote({ ...note, reviewId: e.target.value })}><option value="">Keep unconfirmed without an association</option>{saved.filter(s => s.generation === operation.generation && (!operation.proposalId || s.proposalId === operation.proposalId)).map(s => <option key={s.savedId} value={s.savedId}>{s.title} · {s.proposedVersion} · {new Date(s.savedAt).toLocaleString()}</option>)}</select></label><label>What you checked<textarea rows={3} disabled={busy || !!note.pending} value={note.reason} onChange={e => keepNote({ ...note, reason: e.target.value })}/></label><button disabled={busy || !note.reason.trim()} onClick={() => void resolve()}>{busy ? 'Recording review…' : note.pending ? 'Confirm original recorded review' : 'Record review and keep outcome unconfirmed'}</button></details>}{operation.resolutionReason && <p className="metadata">Review note: {operation.resolutionReason}</p>}</>}</div>;
}
