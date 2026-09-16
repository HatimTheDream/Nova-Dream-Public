import { useEffect, useRef, useState } from 'react';
import type { Snapshot, Task } from '../../../packages/domain/contracts';
import { suggestionTerminal, type SuggestionRequest, type SubtaskSuggestion } from '../../../packages/domain/subtask-suggestions';
import { syncTaskSubtasks } from '../../../packages/domain/task-subtasks';
import { ApiError, readLocal, request, saveLocal } from './api';
import { Check, Plus, Sparkles, X } from './icons';
type Kept = { command: SuggestionRequest; result?: SubtaskSuggestion; items?: { id: string; text: string; selected: boolean }[]; applied?: boolean; dismissed?: boolean; rejected?: boolean; stop?: { requestId: string; epoch: string; id: string } };

export function SubtaskFields({ owner, value: savedValue, change, snapshot, inline = false, disabled = false }: { owner: string; value: Task; change(patch: Partial<Task>): void | Promise<boolean>; snapshot: Snapshot; inline?: boolean; disabled?: boolean }) {
  const [optimistic, setOptimistic] = useState<Task | null>(null), [saving, setSaving] = useState(false);
  const value = optimistic ?? savedValue, locked = disabled || saving;
  const draftKey = `e3:inline-subtask:${snapshot.epoch}:${snapshot.deviceId}:${owner}`;
  const blank = () => ({ id: crypto.randomUUID(), text: '' });
  const [draft, setDraft] = useState(() => readLocal<{ id: string; text: string }>(draftKey) ?? blank()), [adding, setAdding] = useState(false);
  const savingRef = useRef(false), addButton = useRef<HTMLButtonElement>(null), generateButton = useRef<HTMLButtonElement>(null);
  const writeDraft = (next: typeof draft) => { setDraft(next); if (!saveLocal(draftKey, next)) setError('Free browser storage before adding this subtask.'); };
  useEffect(() => { if (inline && savedValue.checklist?.some(item => item.id === draft.id)) writeDraft(blank()); }, [savedValue.checklist]);
  const commit = async (patch: Partial<Task>) => {
    if (disabled || savingRef.current) return false;
    savingRef.current = true; setSaving(true);
    if (inline) setOptimistic(syncTaskSubtasks({ ...value, ...patch }, value));
    try { return await change(patch) !== false; }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'Your subtask save is not confirmed.'); return false; }
    finally { savingRef.current = false; if (mounted.current) { setSaving(false); setOptimistic(null); } }
  };
  const addManual = async () => {
    if (!draft.text.trim() || locked) return;
    if (!saveLocal(draftKey, draft)) { setError('Free browser storage before adding this subtask.'); return; }
    const current = value.checklist ?? [], captured = draft;
    if (current.length >= 500) return;
    if (await commit({ checklist: [...current.filter(item => item.id !== captured.id), { ...captured, text: captured.text.trim(), done: false }] })) {
      if (readLocal<typeof draft>(draftKey)?.id === captured.id) saveLocal(draftKey, blank());
      if (mounted.current) { setDraft(readLocal<typeof draft>(draftKey) ?? blank()); setAdding(false); addButton.current?.focus(); }
    }
  };
  const key = `e3:subtask-suggestions:${snapshot.epoch}:${snapshot.deviceId}:${owner}`;
  const [kept, setKept] = useState<Kept | undefined>(() => readLocal<Kept>(key)), keptRef = useRef(kept); keptRef.current = kept;
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const mounted = useRef(true), flight = useRef(false);
  const persist = (next: Kept) => { if (!saveLocal(key, next)) { if (mounted.current) setError('Free browser storage to keep these suggestions.'); return false; } keptRef.current = next; if (mounted.current) setKept(next); return true; };
  const active = !!kept && !kept.rejected && (!kept.result || !suggestionTerminal(kept.result.state));
  const receive = (original: Kept, result: SubtaskSuggestion) => {
    if (!mounted.current || keptRef.current?.command.requestId !== original.command.requestId) return;
    if (result.owner !== owner || (original.result && result.id !== original.result.id)) throw Error('The suggestion response belongs to different work.');
    persist({ ...keptRef.current, result, ...(result.steps && !keptRef.current.items ? { items: result.steps.map(text => ({ id: crypto.randomUUID(), text, selected: true })) } : {}) });
  };
  const check = async (original = keptRef.current) => {
    if (!original || flight.current) return;
    flight.current = true; setBusy(true); setError('');
    try { receive(original, original.stop ? await request<SubtaskSuggestion>('tasks/suggestions/stop', original.stop) : original.result ? await request<SubtaskSuggestion>(`tasks/suggestions/${original.result.id}`) : await request<SubtaskSuggestion>('tasks/suggestions', original.command)); }
    catch (reason) {
      if (mounted.current && keptRef.current?.command.requestId === original.command.requestId) {
        if (!original.result && reason instanceof ApiError && reason.status && reason.status < 500 && ![408, 429].includes(reason.status)) persist({ ...original, rejected: true });
        setError(reason instanceof Error ? reason.message : 'Suggestions are not confirmed. Check the original request.');
      }
    }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  };
  useEffect(() => { mounted.current = true; if (keptRef.current && !keptRef.current.rejected && (!keptRef.current.result || !suggestionTerminal(keptRef.current.result.state))) void check(); return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!active) return; const timer = window.setInterval(() => void check(), 3000); return () => clearInterval(timer); }, [active]);
  const generate = () => {
    if (locked || active || flight.current || !value.title.trim()) return;
    const next: Kept = { command: { requestId: crypto.randomUUID(), epoch: snapshot.epoch, owner, title: value.title.trim().slice(0, 300), notes: value.notes.slice(0, 10000), existing: (value.checklist ?? []).map(item => item.text) } };
    if (persist(next)) void check(next);
  };
  const dismiss = () => {
    const current = keptRef.current;
    if (savingRef.current || active || !current) return;
    if (persist({ ...current, dismissed: true })) generateButton.current?.focus();
  };
  const add = async () => {
    const original = keptRef.current; if (!original || locked) return;
    const current = value.checklist ?? [], seen = new Set(current.map(item => item.text.trim().toLocaleLowerCase()));
    const additions = (kept?.items ?? []).filter(item => item.selected && !current.some(c => c.id === item.id) && !seen.has(item.text.trim().toLocaleLowerCase())).map(({ id, text }) => ({ id, text, done: false }));
    if (current.length + additions.length > 500) { setError('This task has room for ' + (500 - current.length) + ' more subtasks. Select fewer suggestions.'); return; }
    if (await commit({ checklist: [...current, ...additions] }) && keptRef.current?.command.requestId === original.command.requestId) persist({ ...keptRef.current, applied: true });
  };
  return <section className={`subtask-fields${inline ? ' inline-subtasks' : ''}`} aria-label={`Subtasks for ${value.title}`}>
    {!inline && <>
    <label className="task-parent-completion"><input type="checkbox" checked={value.status === 'done'} onChange={e => change({ status: e.target.checked ? 'done' : 'open' })}/>Complete task</label>
    <div className="task-section-label"><strong>Subtasks</strong><span className="metadata">{value.checklist?.filter(i => i.done).length ?? 0}/{value.checklist?.length ?? 0}</span></div>
    <p className="metadata">Finish every subtask to complete the whole task.</p>
    <div className="task-checklist">{(value.checklist ?? []).map((item, index) => <div className="checklist-edit" key={item.id}><label className="checklist-toggle"><input type="checkbox" aria-label={`Complete subtask ${index + 1}`} checked={item.done} onChange={e => change({ checklist: value.checklist!.map(i => i.id === item.id ? { ...i, done: e.target.checked } : i) })}/></label><input autoFocus={!item.text} aria-label={`Subtask ${index + 1}`} placeholder="A small, clear next step" maxLength={300} required value={item.text} onChange={e => change({ checklist: value.checklist!.map(i => i.id === item.id ? { ...i, text: e.target.value } : i) })}/><button type="button" aria-label={`Remove subtask ${index + 1}`} onClick={() => change({ checklist: value.checklist!.filter(i => i.id !== item.id) })}><X size={17}/></button></div>)}</div>
    </>}
    {inline && <><ul className="task-subtask-items">{(value.checklist ?? []).map(item => <li key={item.id}><label><input type="checkbox" checked={item.done} disabled={locked} onChange={e => void commit({ checklist: value.checklist!.map(i => i.id === item.id ? { ...i, done: e.target.checked } : i) })}/><span className={item.done ? 'subtask-done' : ''}>{item.text}</span></label></li>)}</ul>{adding && <form className="inline-subtask-add" onSubmit={e => { e.preventDefault(); void addManual(); }}><input autoFocus aria-label="New subtask" placeholder="A small, clear next step" maxLength={300} value={draft.text} disabled={locked} onChange={e => writeDraft({ ...draft, text: e.target.value })} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setAdding(false); addButton.current?.focus(); } }}/><button type="submit" disabled={locked || !draft.text.trim()}>Add</button><button type="button" aria-label="Close new subtask" disabled={saving} onClick={() => { setAdding(false); addButton.current?.focus(); }}><X size={16}/></button></form>}</>}
    <div className="subtask-create-actions"><button ref={addButton} type="button" disabled={locked || (value.checklist?.length ?? 0) >= 500} onClick={() => inline ? setAdding(true) : change({ checklist: [...(value.checklist ?? []), { id: crypto.randomUUID(), text: '', done: false }] })}><Plus size={16}/>Add subtask</button><button ref={generateButton} type="button" disabled={locked || active || busy || !value.title.trim() || (value.checklist?.length ?? 0) >= 500} onClick={generate}><Sparkles size={16}/>{kept?.result && suggestionTerminal(kept.result.state) ? 'Generate again' : 'Generate subtasks'}</button></div>
    {active && <div className="subtask-generation" role="status"><span>{kept?.result?.message ?? 'Starting your Assistant…'}</span>{kept?.result && <button type="button" disabled={busy} onClick={() => { const next = { ...kept, stop: kept.stop ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, id: kept.result!.id } }; if (persist(next)) void check(next); }}>Cancel</button>}</div>}
    {error && <p role="alert" className="notice warning">{error}{kept && !kept.rejected && <button type="button" disabled={busy} onClick={() => void check()}>Check generation</button>}</p>}
    {kept?.result && !active && kept.result.state !== 'completed' && <p className="metadata" role="status">{kept.result.message}</p>}
    {!!kept?.items?.length && !kept.applied && !kept.dismissed && <div className="subtask-suggestions" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); } }}><strong>Suggested steps</strong><p className="metadata">For {kept.command.title}. Add the steps you want, then edit them freely.</p>{kept.items.map(item => <label key={item.id}><input type="checkbox" checked={item.selected} disabled={locked} onChange={e => persist({ ...kept, items: kept.items!.map(i => i.id === item.id ? { ...i, selected: e.target.checked } : i) })}/><span>{item.text}</span></label>)}<div className="subtask-suggestion-actions"><button type="button" disabled={locked || !kept.items.some(item => item.selected)} onClick={() => void add()}><Plus size={16}/>Add selected subtasks</button><button type="button" disabled={saving} onClick={dismiss}>Cancel</button></div></div>}
    {kept?.applied && <p className="metadata" role="status"><Check size={14}/>Suggestions added to your checklist.</p>}
  </section>;
}
