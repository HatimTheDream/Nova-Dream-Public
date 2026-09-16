import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import { agentRoutineSchema, type AgentRoutine, type AgentRoutineSave, type AgentRoutineState, type AgentRoutineValue } from '../../../packages/domain/agent-routines';
import { ApiError, readLocal, request, saveLocal } from './api';
import { retainedWindowId } from './useWorkspace';
import { Empty } from './ui';
import { Plus } from './icons';
import { AssignmentReview } from './AssignmentReview';
import { intervalClock, routineWithClock, type RoutineClock } from './agent-routine-clock';
import { dayInZone } from '../../../packages/domain/tasks';
import './agent-routines.css';

const dateLabel = (at: number, zone: string) => new Intl.DateTimeFormat(undefined, { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(at);
type Index = { selected: string | null; drafts: string[] };
type Draft = { value: AgentRoutineValue; base: AgentRoutineValue; revision: number; pending?: AgentRoutineSave; intervalStart?: RoutineClock };
export function AgentRoutines({ snapshot, openPlan }: { snapshot: Snapshot; openPlan: (id: string) => void }) {
  const indexKey = `e3:agent-routines:${snapshot.deviceId}:${snapshot.epoch}:${retainedWindowId}`;
  const [index, setIndex] = useState<Index>(() => readLocal(indexKey) ?? { selected: null, drafts: [] });
  const [state, setState] = useState<AgentRoutineState>(), [error, setError] = useState(''), [archived, setArchived] = useState(false), [detail, setDetail] = useState<string>();
  const [older, setOlder] = useState<AgentRoutineState['history']>([]), [cursor, setCursor] = useState<string | null>();
  const mounted = useRef(true), sequence = useRef(0), selection = useRef(index.selected); selection.current = index.selected;
  const load = async () => {
    const id = ++sequence.current, selected = selection.current, next = await request<AgentRoutineState>(`agent-routines/state${selected ? `?routineId=${selected}` : ''}`);
    if (mounted.current && id === sequence.current && selected === selection.current) { setState(next); setError(''); } return next;
  };
  useEffect(() => {
    mounted.current = true; let cancelled = false, timer: ReturnType<typeof setTimeout>; setOlder([]); setCursor(undefined); setState(undefined);
    const poll = async () => { try { if (!cancelled && !document.hidden) await load(); } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Routines could not load.'); } finally { if (!cancelled) timer = setTimeout(() => void poll(), 5000); } };
    void poll(); return () => { cancelled = true; mounted.current = false; sequence.current++; clearTimeout(timer); };
  }, [index.selected, indexKey]);
  const keep = (next: Index) => { if (!saveLocal(indexKey, next)) { setError('Free browser storage before changing this selection. Your writing is kept in this window.'); return; } setIndex(next); };
  const create = () => { const id = crypto.randomUUID(); keep({ selected: id, drafts: [...index.drafts, id] }); };
  const entity = state?.routines.find(r => r.id === index.selected), drafts = index.drafts.filter(id => !state?.routines.some(r => r.id === id));
  const nextCursor = cursor === undefined ? state?.nextCursor : cursor;
  const history = [...(state?.history ?? []), ...older.filter(item => !state?.history.some(current => current.id === item.id))];
  const olderHistory = async () => {
    if (!nextCursor) return; const selected = index.selected, seq = sequence.current;
    try { const next = await request<AgentRoutineState>(`agent-routines/state?before=${nextCursor}${selected ? `&routineId=${selected}` : ''}`); if (mounted.current && sequence.current === seq) { setOlder(current => [...current, ...next.history.filter(item => !current.some(old => old.id === item.id))]); setCursor(next.nextCursor); } }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'Earlier history could not load.'); }
  };
  return <><div className="record-toolbar"><p className="metadata">Recurring work uses saved assignment plans. This host must be awake and the Assistant connected.</p><button className="primary" onClick={create}><Plus size={18}/>New routine</button></div>
    <div className="record-filters"><label>Show<select value={archived ? 'archived' : 'active'} onChange={e => setArchived(e.target.value === 'archived')}><option value="active">Active routines</option><option value="archived">Archived routines</option></select></label></div>
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className={`record-workspace${index.selected ? ' has-selection' : ''}`}><section className="record-list" aria-label="Routines">
      {drafts.map((id, n) => <button className="card record-list-item" key={id} aria-pressed={index.selected === id} onClick={() => keep({ ...index, selected: id })}><span><strong>Unfinished routine {n + 1}</strong><small>Kept on this device</small></span></button>)}
      {state?.routines.filter(r => r.value.archived === archived).map(r => <button className="card record-list-item" key={r.id} aria-pressed={index.selected === r.id} onClick={() => keep({ ...index, selected: r.id })}><span><strong>{r.value.name}</strong><small>{snapshot.records?.agent.find(a => a.id === r.agentId)?.value.name ?? 'Saved agent'}</small><small>{r.attention ? 'Needs review' : !r.value.enabled ? 'Paused' : r.nextAt ? `Next · ${dateLabel(r.nextAt, r.value.timezone)}` : 'Schedule finished'} · {r.value.timezone}</small></span></button>)}
      {state && !state.routines.some(r => r.value.archived === archived) && !drafts.length && <div className="card"><Empty title={archived ? 'No archived routines.' : 'Give useful work a rhythm.'}>Choose a saved assignment and a schedule. Each result stays available for review.</Empty></div>}
    </section>{index.selected && state && (entity || drafts.includes(index.selected)) && <RoutineEditor key={`${indexKey}:${index.selected}`} id={index.selected} entity={entity} snapshot={snapshot} reload={load} close={() => keep({ ...index, selected: null })} openPlan={openPlan}/>}</div>
    <section className="card routine-history"><div className="section-heading"><h2>{index.selected ? 'Routine history' : 'Recent routine activity'}</h2>{index.selected && <button onClick={() => keep({ ...index, selected: null })}>All activity</button>}</div>
      {history.length ? history.map(item => <article key={item.id}><div><strong>{state?.routines.find(r => r.id === item.routineId)?.value.name ?? 'Saved routine'}</strong><p className="metadata">{new Date(item.scheduledAt).toLocaleString()} · schedule version {item.routineRevision}{item.throughAt && item.throughAt > item.scheduledAt ? ` · elapsed window through ${new Date(item.throughAt).toLocaleString()}` : ''}</p><p>{item.attempt ? item.attempt.state === 'returned' ? 'Result ready for review' : item.attempt.message : item.message}</p></div>{item.attempt && <div className="button-row"><button onClick={() => openPlan(item.attempt!.assignmentId)}>Open assignment & result</button><button onClick={() => setDetail(item.attemptId)}>Saved inputs</button>{item.attempt.result && <a className="output-download" href={`/api/attachments/${item.attempt.result.file.id}`}>Download full result</a>}</div>}</article>) : <Empty title="No scheduled runs yet.">Starts, skipped times, and outcomes will appear here.</Empty>}
      {nextCursor && <button onClick={() => void olderHistory()}>Earlier activity</button>}
    </section>{detail && <AssignmentReview id={detail} close={() => setDetail(undefined)}/>}</>;
}

function RoutineEditor({ id, entity, snapshot, reload, close, openPlan }: { id: string; entity?: AgentRoutine; snapshot: Snapshot; reload: () => Promise<unknown>; close: () => void; openPlan: (id: string) => void }) {
  const key = `e3:agent-routine-draft:${snapshot.deviceId}:${snapshot.epoch}:${id}:${retainedWindowId}`;
  const [draft, setDraft] = useState<Draft>(() => { const initial: AgentRoutineValue = entity?.value ?? { name: '', assignmentId: '', assignmentRevision: 1, projectRevision: null, schedule: { kind: 'cron', expression: '0 9 * * *' }, timezone: snapshot.layout?.value.timezone ?? 'UTC', missed: 'skip', enabled: false, archived: false }; return readLocal(key) ?? { value: initial, base: initial, revision: entity?.revision ?? 0 }; });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [times, setTimes] = useState<number[]>();
  const [conflict, setConflict] = useState<AgentRoutine>(); const flight = useRef(false), alive = useRef(true), previewSequence = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const dirty = !!draft.intervalStart || JSON.stringify(draft.value) !== JSON.stringify(draft.base);
  const keep = (next: Draft) => { setDraft(next); if (!saveLocal(key, next)) { setError('Your writing is kept in this window only. Free browser storage before saving or leaving.'); return false; } return true; };
  useEffect(() => { if (entity && entity.revision !== draft.revision && !dirty && !draft.pending && !busy) { previewSequence.current++; setTimes(undefined); keep({ value: entity.value, base: entity.value, revision: entity.revision }); } }, [entity?.revision]);
  const change = (patch: Partial<AgentRoutineValue>) => {
    previewSequence.current++; setTimes(undefined);
    const intervalStart = patch.schedule && patch.schedule.kind !== draft.value.schedule.kind ? undefined
      : patch.timezone !== undefined && draft.value.schedule.kind === 'every' ? draft.intervalStart ?? intervalClock(draft.value) : draft.intervalStart;
    keep({ ...draft, value: { ...draft.value, ...patch }, intervalStart });
  };
  const value = draft.value, plan = snapshot.records?.assignment.find(p => p.id === value.assignmentId);
  const clock = draft.intervalStart ?? intervalClock(value);
  const changeClock = (patch: Partial<RoutineClock>) => { previewSequence.current++; setTimes(undefined); keep({ ...draft, intervalStart: { ...clock, ...patch } }); };
  const usePlan = (planId: string) => { const selected = snapshot.records?.assignment.find(p => p.id === planId); if (selected) change({ assignmentId: planId, assignmentRevision: selected.revision, projectRevision: snapshot.projects.find(p => p.id === selected.value.projectId)?.revision ?? null }); };
  const preview = async () => {
    const sequence = ++previewSequence.current;
    try { const parsed = agentRoutineSchema.parse(routineWithClock(value, draft.intervalStart)); const next = await request<{ times: number[] }>('agent-routines/preview', parsed); if (alive.current && sequence === previewSequence.current) { setTimes(next.times); setError(''); } }
    catch (reason) { if (alive.current && sequence === previewSequence.current) setError(reason instanceof Error ? reason.message : 'Schedule could not be checked.'); }
  };
  const save = async (proposal = value) => {
    if (flight.current) return;
    if (!draft.pending) { try { proposal = routineWithClock(proposal, draft.intervalStart); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Review the first run time.'); return; } }
    const parsed = agentRoutineSchema.safeParse(proposal); if (!draft.pending && !parsed.success) { setError(parsed.error.issues.map(i => i.message).join(' ')); return; }
    const pending = draft.pending ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, id, expectedRevision: draft.revision, value: parsed.success ? parsed.data : proposal };
    if (!keep({ ...draft, value: pending.value, pending })) return;
    flight.current = true; setBusy(true); setError('');
    try {
      const saved = await request<AgentRoutine>('agent-routines/save', pending), next = { value: saved.value, base: saved.value, revision: saved.revision };
      if (saveLocal(key, next) && alive.current) setDraft(next);
      await reload();
    } catch (reason) {
      if (alive.current) {
        setError(reason instanceof Error ? reason.message : 'Save is unconfirmed. Reconcile the same request.');
        if (reason instanceof ApiError && [400, 409, 507].includes(reason.status ?? 0)) { keep({ ...draft, value: pending.value, pending: undefined }); if (reason.code === 'routine_changed') setConflict(reason.current as unknown as AgentRoutine); }
      }
    } finally { flight.current = false; if (alive.current) setBusy(false); }
  };
  // An unconfirmed save can itself have advanced the host revision. Its exact
  // retained receipt remains retryable even while a newer snapshot is visible.
  const stale = !draft.pending && entity && entity.revision !== draft.revision;
  return <section className="card record-editor" aria-label="Routine editor"><div className="section-heading"><div><span className="eyebrow">{entity ? `Routine · version ${entity.revision}` : 'New routine'}</span><h2>{value.name || 'A steady rhythm'}</h2></div><button onClick={close}>Keep & close</button></div>
    {entity?.attention && <p role="status" className="field-error">{entity.attention}</p>}
    <form onSubmit={e => { e.preventDefault(); void save(); }}><fieldset disabled={busy || !!draft.pending || value.archived}>
      <label>Name<input required maxLength={240} value={value.name} onChange={e => change({ name: e.target.value })}/></label>
      <label>Saved assignment<select value={value.assignmentId} onChange={e => usePlan(e.target.value)} required><option value="">Choose an assignment</option>{snapshot.records?.assignment.filter(p => !p.value.archived && p.value.state === 'planned' || p.id === value.assignmentId).map(p => <option value={p.id} key={p.id}>{p.value.title} · version {p.revision}</option>)}</select></label>
      {plan && <div className="button-row"><button type="button" onClick={() => openPlan(plan.id)}>Review assignment</button><span className="metadata">Uses saved version {value.assignmentRevision}; Project version {value.projectRevision ?? 'none'}.</span><button type="button" onClick={() => usePlan(plan.id)}>Use current saved versions</button></div>}
      <div className="record-field-grid"><label>Schedule<select value={value.schedule.kind} onChange={e => change({ schedule: e.target.value === 'once' ? { kind: 'once', date: (() => { try { return dayInZone(value.timezone, Date.now() + 86400000); } catch { return ''; } })(), time: '09:00' } : e.target.value === 'every' ? { kind: 'every', minutes: 60, anchor: new Date(Math.ceil((Date.now() + 3600000) / 60000) * 60000).toISOString() } : { kind: 'cron', expression: '0 9 * * *' } })}><option value="cron">Daily or custom cron</option><option value="every">Every interval</option><option value="once">One time</option></select></label><label>Timezone<input required value={value.timezone} onChange={e => change({ timezone: e.target.value })}/></label></div>
      {value.schedule.kind === 'cron' && <label>Cron expression<input required maxLength={200} value={value.schedule.expression} onChange={e => change({ schedule: { kind: 'cron', expression: e.target.value } })}/><small className="metadata">Minute · hour · day · month · weekday. For example, 0 9 * * 1-5 runs at 9:00 on weekdays.</small></label>}
      {value.schedule.kind === 'every' && <div className="record-field-grid"><label>Every (minutes)<input type="number" min={1} max={525600} value={value.schedule.minutes} onChange={e => change({ schedule: { ...value.schedule as Extract<AgentRoutineValue['schedule'], { kind: 'every' }>, minutes: Number(e.target.value) } })}/></label><label>First date<input type="date" required value={clock.date} onChange={e => changeClock({ date: e.target.value, overlap: undefined })}/></label><label>First time<input type="time" required value={clock.time} onChange={e => changeClock({ time: e.target.value, overlap: undefined })}/></label><label>If the clock repeats this time<select value={clock.overlap ?? ''} onChange={e => changeClock({ overlap: e.target.value ? e.target.value as 'earlier' | 'later' : undefined })}><option value="">Require a choice</option><option value="earlier">Earlier occurrence</option><option value="later">Later occurrence</option></select></label><p className="metadata">The first time uses the timezone above. Later runs repeat by elapsed minutes, including when the clocks change.</p></div>}
      {value.schedule.kind === 'once' && <div className="record-field-grid"><label>Date<input type="date" required value={value.schedule.date} onChange={e => change({ schedule: { ...value.schedule as Extract<AgentRoutineValue['schedule'], { kind: 'once' }>, date: e.target.value } })}/></label><label>Time<input type="time" required value={value.schedule.time} onChange={e => change({ schedule: { ...value.schedule as Extract<AgentRoutineValue['schedule'], { kind: 'once' }>, time: e.target.value } })}/></label><label>If the clock repeats this time<select value={value.schedule.overlap ?? ''} onChange={e => change({ schedule: { ...value.schedule as Extract<AgentRoutineValue['schedule'], { kind: 'once' }>, overlap: e.target.value ? e.target.value as 'earlier' | 'later' : undefined } })}><option value="">Require a choice</option><option value="earlier">Earlier occurrence</option><option value="later">Later occurrence</option></select></label></div>}
      <label>When this host misses a run<select value={value.missed} onChange={e => change({ missed: e.target.value as AgentRoutineValue['missed'] })}><option value="skip">Skip missed times</option><option value="latest">Run only the latest missed occurrence</option><option value="review">Pause for my review</option></select></label>
      <p className="metadata">Overlapping work and disconnected Assistant sessions are skipped. Results stay here for review. These assignments have no tools or external delivery.</p>
      <label className="routine-enable"><input type="checkbox" checked={value.enabled} onChange={e => change({ enabled: e.target.checked })}/>Enable scheduled assignment runs on this host</label>
      <button type="button" onClick={() => void preview()}>Preview upcoming times</button>{times && <ol className="metadata">{times.map(at => <li key={at}>{dateLabel(at, value.timezone)} · {value.timezone}</li>)}{!times.length && <li>No future occurrence.</li>}</ol>}
    </fieldset>{error && <p role="alert" className="field-error">{error}</p>}
    {(conflict || stale) && <div className="routine-conflict"><p>The saved routine changed. Your edits are kept.</p><button type="button" onClick={() => { const current = conflict ?? entity!; keep({ ...draft, base: current.value, revision: current.revision }); setConflict(undefined); setError('Review your edits against the current saved versions, then save.'); }}>Review my edits against the saved version</button><pre>{JSON.stringify((conflict ?? entity)?.value, null, 2)}</pre></div>}
    <div className="record-editor-footer"><span className="metadata">{draft.pending ? 'Save unconfirmed · same request kept' : dirty ? 'Edits kept on this device' : !entity ? 'New routine · not saved yet' : entity.nextAt ? `Next · ${dateLabel(entity.nextAt, entity.value.timezone)}` : 'Saved schedule is paused or finished'}</span><div className="button-row"><button type="button" disabled={busy || !!draft.pending} onClick={() => { previewSequence.current++; setTimes(undefined); if (entity) keep({ value: entity.value, base: entity.value, revision: entity.revision }); else keep({ value: draft.base, base: draft.base, revision: draft.revision }); setConflict(undefined); setError(''); }}>Discard edits</button><button className="primary" disabled={busy || !!conflict || !!stale || (!draft.pending && value.archived)}>{busy ? 'Saving…' : draft.pending ? 'Reconcile save' : value.enabled ? 'Save & enable' : 'Save paused'}</button></div></div></form>
    {entity && <div className="record-archive-row"><button disabled={busy || !!draft.pending || dirty} onClick={() => void save({ ...value, enabled: false, archived: !value.archived })}>{value.archived ? 'Restore paused' : 'Archive routine'}</button><span className="metadata">Archiving keeps history and results. Stop a running attempt from its assignment.</span></div>}
  </section>;
}
